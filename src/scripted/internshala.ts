// Scripted Internshala mode: plain Playwright drives the site and the model is called only
// to score a page of listings (one cheap call) and to write the answers for each form (one call).

import { chromium, type Page, type Locator } from 'playwright-core';
import { mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { log } from '../core/logger.js';
import {
  hasApplied, wasJobSeen, recordSeenJob, recordApplication, countApplicationsToday, appliedToCompanyToday,
} from '../core/database.js';
import { getTotalCost } from '../core/token-tracker.js';
import { isBlocked } from '../filters/blocklist.js';
import { scoreJob } from '../filters/job-score.js';
import { callJson } from './llm.js';
import { candidateSheet, scoringPrompt, answersPrompt, SCORING_SCHEMA, ANSWERS_SCHEMA } from './prompts.js';
import type { AppConfig, Answers, Profile, Site } from '../types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = path.resolve(__dirname, '..', '..', 'screenshots');
const PLATFORM = 'Internshala';
const MAX_PAGES = 3;
const MAX_DESCRIPTION_CHARS = 3500;

interface Listing {
  id: number;
  url: string;
  title: string;
  company: string;
  location: string;
  salary: string;
  experience: string;
  skills: string[];
  summary: string;
}

export interface FormQuestion {
  i: number;
  kind: 'radio' | 'checkbox' | 'select' | 'text' | 'rich';
  text: string;
  options: string[];
  required: boolean;
  inputType?: string;
}

interface ApplicationForm {
  hasAvailability: boolean;
  hasCoverLetter: boolean;
  coverLetterPrompt: string;
  questions: FormQuestion[];
  unsupported: string[];
}

interface GeneratedAnswers {
  skip_reason: string;
  cover_letter: string;
  answers: Array<{ q: number; answer: string }>;
}

interface Submitted { company: string; title: string; score: number; url: string; dryRun: boolean }

interface RunContext {
  page: Page;
  profile: Profile;
  config: AppConfig;
  sheet: string;
  problems: string[];
}

type Outcome = 'applied' | 'dry-run' | 'skipped';

export function isInternshalaSite(site: Site): boolean {
  return site.searchUrls.some(u => /(^|\.)internshala\.com$/i.test(safeHost(u)));
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Matches a model answer to one of the form's options: exact, then an option that starts with
 * the answer, then the LONGEST option the answer starts with (so "No, I am on notice" never
 * lands on a bare "No"), then substring.
 */
export function matchOption(options: string[], answer: string): string | undefined {
  const a = norm(answer);
  if (!a) return undefined;
  const byLengthDesc = [...options].sort((x, y) => y.length - x.length);
  return options.find(o => norm(o) === a)
    ?? options.find(o => norm(o).startsWith(a))
    ?? byLengthDesc.find(o => norm(o) && a.startsWith(norm(o)))
    ?? options.find(o => norm(o).includes(a));
}

function humanPause(config: AppConfig): Promise<void> {
  const ms = config.delayMinMs + Math.random() * Math.max(0, config.delayMaxMs - config.delayMinMs);
  return new Promise(r => setTimeout(r, ms));
}

// ========== PAGE READING ==========

async function readListings(page: Page): Promise<Omit<Listing, 'id'>[]> {
  return page.$$eval('.individual_internship[internshipid]', cards => cards.map(card => {
    const text = (sel: string) => (card.querySelector(sel) as HTMLElement | null)?.innerText.trim() ?? '';
    const link = card.querySelector('a.job-title-href') as HTMLAnchorElement | null;
    const rows = [...card.querySelectorAll('.detail-row-1 .row-1-item')].map(r => (r as HTMLElement).innerText.trim());
    return {
      url: link?.href ?? '',
      title: link?.innerText.trim() ?? '',
      company: text('.company-name'),
      location: text('.locations'),
      salary: rows.find(r => r.includes('₹')) ?? '',
      experience: rows.find(r => /year|fresher/i.test(r)) ?? '',
      skills: [...card.querySelectorAll('.job_skill')].map(s => (s as HTMLElement).innerText.trim()),
      summary: text('.about_job .text'),
    };
  }).filter(l => l.url));
}

async function openApplicationForm(page: Page): Promise<boolean> {
  const applyButton = page.locator('#top_easy_apply_button');
  if (!(await applyButton.count()) || !(await applyButton.isVisible())) return false;
  await applyButton.click();

  const proceed = page.locator('button:has-text("Proceed to application")');
  for (let t = 0; t < 20; t++) {
    if (await page.locator('#application-form').isVisible().catch(() => false)) return true;
    if (await proceed.first().isVisible().catch(() => false)) await proceed.first().click();
    await page.waitForTimeout(500);
  }
  return page.locator('#application-form').isVisible().catch(() => false);
}

/** Reads the form and tags each question group with data-bot-q so it can be filled later. */
async function readApplicationForm(page: Page): Promise<ApplicationForm> {
  return page.evaluate(() => {
    const form = document.querySelector('#application-form') as HTMLElement;
    const labelOf = (input: Element) => {
      const el = input as HTMLInputElement;
      const label = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) as HTMLElement | null : null;
      return (label?.innerText ?? el.value ?? '').replace(/\s+/g, ' ').trim();
    };
    const result = {
      hasAvailability: !!form.querySelector('input[name=confirm_availability]'),
      hasCoverLetter: false,
      coverLetterPrompt: '',
      questions: [] as Array<Record<string, unknown>>,
      unsupported: [] as string[],
    };

    // The cover letter is a Quill editor backed by a hidden textarea.
    const cover = form.querySelector('textarea[name=cover_letter]');
    if (cover) {
      result.hasCoverLetter = true;
      let holder = cover.parentElement;
      for (let k = 0; k < 5 && holder && !holder.querySelector('.ql-editor'); k++) holder = holder.parentElement;
      holder?.querySelector('.ql-editor')?.setAttribute('data-bot-cover', '1');
      result.coverLetterPrompt = ((holder ?? cover.parentElement) as HTMLElement | null)?.innerText.replace(/\s+/g, ' ').trim().slice(0, 200) ?? '';
    }

    [...form.querySelectorAll('.additional_question')].forEach((group, i) => {
      if (group.querySelector('textarea[name=cover_letter]')) return;
      group.setAttribute('data-bot-q', String(i));
      const text = ((group.querySelector('.assessment_question') as HTMLElement | null)?.innerText ?? (group as HTMLElement).innerText)
        .replace(/\s+/g, ' ').trim().slice(0, 400);
      const radios = [...group.querySelectorAll('input[type=radio]')];
      const checkboxes = [...group.querySelectorAll('input[type=checkbox]')];
      const select = group.querySelector('select') as HTMLSelectElement | null;
      const rich = group.querySelector('.ql-editor');
      const input = group.querySelector('textarea, input[type=text]:not(.chosen-search-input), input[type=number], input[type=url], input[type=email], input[type=tel]') as HTMLInputElement | null;
      const required = !!group.querySelector('[aria-required=true], [required]');

      let kind = '';
      let options: string[] = [];
      if (radios.length) { kind = 'radio'; options = radios.map(labelOf); }
      else if (checkboxes.length) { kind = 'checkbox'; options = checkboxes.map(labelOf); }
      else if (select) { kind = 'select'; options = [...select.options].filter(o => !o.disabled && o.value !== '').map(o => o.text.trim()); }
      else if (rich) kind = 'rich';
      else if (input) kind = 'text';

      if (!kind) result.unsupported.push(text);
      else result.questions.push({ i, kind, text, options, required, inputType: input?.type });
    });

    form.querySelectorAll('input[type=file][required], input[type=file][aria-required=true]').forEach(f => {
      if ((f as HTMLInputElement).name !== 'custom_resume') result.unsupported.push(`file upload: ${(f as HTMLInputElement).name}`);
    });
    return result as unknown as {
      hasAvailability: boolean; hasCoverLetter: boolean; coverLetterPrompt: string;
      questions: FormQuestion[]; unsupported: string[];
    };
  });
}

// ========== FORM FILLING ==========

async function clickOption(group: Locator, inputType: 'radio' | 'checkbox', optionText: string): Promise<boolean> {
  const id = await group.evaluate((g, args) => {
    const n = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
    for (const input of g.querySelectorAll(`input[type=${args.inputType}]`)) {
      const el = input as HTMLInputElement;
      const label = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) as HTMLElement | null : null;
      if (n(label?.innerText ?? el.value) === n(args.optionText)) return el.id;
    }
    return null;
  }, { inputType, optionText });
  if (!id) return false;

  const label = group.locator(`label[for="${id}"]`);
  if (await label.count()) await label.first().click();
  else await group.locator(`[id="${id}"]`).check({ force: true });
  return group.locator(`[id="${id}"]`).isChecked();
}

/** Fills the form. Returns null on success, or a reason why the job should be skipped. */
async function fillForm(page: Page, form: ApplicationForm, coverLetter: string, answers: Map<number, string>): Promise<string | null> {
  if (form.hasAvailability && !(await page.locator('#radio1').isChecked())) {
    await page.locator('label[for="radio1"]').click();
  }

  if (form.hasCoverLetter) {
    if (!coverLetter.trim()) return 'cover letter required but empty';
    const editor = page.locator('#application-form [data-bot-cover="1"]');
    if (await editor.count()) {
      await editor.click();
      await editor.fill(coverLetter);
    }
    const synced = await page.evaluate((text) => {
      const textarea = document.querySelector('#application-form textarea[name=cover_letter]') as HTMLTextAreaElement | null;
      if (!textarea) return false;
      if (textarea.value.trim().length < 30) textarea.value = text;
      return textarea.value.trim().length >= 30;
    }, coverLetter);
    if (!synced) return 'could not fill the cover letter';
  }

  for (const q of form.questions) {
    const group = page.locator(`#application-form [data-bot-q="${q.i}"]`);
    const answer = answers.get(q.i)?.trim() ?? '';
    if (!answer) {
      if (q.required) return `no answer for required question: ${q.text}`;
      continue;
    }

    if (q.kind === 'radio') {
      const option = matchOption(q.options, answer);
      if (!option || !(await clickOption(group, 'radio', option))) return `radio option not found: "${answer}" for "${q.text}"`;
    } else if (q.kind === 'checkbox') {
      for (const part of answer.split('|').map(s => s.trim()).filter(Boolean)) {
        const option = matchOption(q.options, part);
        if (!option || !(await clickOption(group, 'checkbox', option))) return `checkbox option not found: "${part}" for "${q.text}"`;
      }
    } else if (q.kind === 'select') {
      const option = matchOption(q.options, answer);
      if (!option) return `select option not found: "${answer}" for "${q.text}"`;
      // Internshala uses jQuery "chosen" dropdowns over a hidden <select>.
      const set = await group.evaluate((g, text) => {
        const select = g.querySelector('select') as HTMLSelectElement;
        const opt = [...select.options].find(o => o.text.trim() === text);
        if (!opt) return false;
        select.value = opt.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        const jq = (window as unknown as { jQuery?: (el: Element) => { trigger: (e: string) => unknown } }).jQuery;
        if (jq) { jq(select).trigger('change'); jq(select).trigger('chosen:updated'); }
        return select.value === opt.value;
      }, option);
      if (!set) return `could not set the dropdown for "${q.text}"`;
    } else if (q.kind === 'rich') {
      const editor = group.locator('.ql-editor').first();
      await editor.click();
      await editor.fill(answer);
    } else {
      const field = group.locator('textarea, input[type=text]:not(.chosen-search-input), input[type=number], input[type=url], input[type=email], input[type=tel]').first();
      const value = q.inputType === 'number' ? answer.replace(/[^\d.]/g, '') : answer;
      if (!value) return `not a number for "${q.text}"`;
      await field.fill(value);
    }
  }
  return null;
}

async function submitAndVerify(page: Page, jobUrl: string): Promise<{ ok: boolean; detail: string }> {
  await page.locator('#application-form #submit').click();
  for (let t = 0; t < 20; t++) {
    await page.waitForTimeout(500);
    const errors = await page.$$eval('#application-form .form-error, #application-form .help-block.form-error',
      els => els.filter(e => (e as HTMLElement).offsetParent && (e as HTMLElement).innerText.trim())
        .map(e => (e as HTMLElement).innerText.trim()));
    if (errors.length) return { ok: false, detail: `form validation: ${errors.join('; ').slice(0, 200)}` };
    if (!page.url().startsWith(jobUrl.split('?')[0])) break;
    if (!(await page.locator('#application-form').isVisible().catch(() => false))) break;
  }

  // Require a positive signal: after a reload Internshala shows a disabled "Already applied" button.
  // A missing "Apply now" alone proves nothing (closed job, expired session, error page, slow load).
  try {
    await page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.locator('.detail_view').first().waitFor({ state: 'visible', timeout: 10000 });
  } catch {
    return { ok: false, detail: 'could not reload the job page to verify the submission' };
  }
  const applied = await page.locator('.detail_view').getByText(/already applied/i).first().isVisible().catch(() => false);
  return applied
    ? { ok: true, detail: 'verified: job page shows "Already applied"' }
    : { ok: false, detail: 'no "Already applied" marker after reload; submission not confirmed' };
}

async function closeForm(page: Page): Promise<void> {
  await page.locator('#easy_apply_modal_close').click({ timeout: 2000 }).catch(() => {});
}

// ========== DECISIONS ==========

function skip(job: Listing, score: number, reason: string): Outcome {
  recordSeenJob({ url: job.url, jobTitle: job.title, company: job.company, platform: PLATFORM, score, skipReason: reason });
  log('SCRIPT', `  skipped: ${reason}`);
  return 'skipped';
}

/** Hard rules that hold no matter what the model scored: blocklist and deal breakers. */
function hardRuleViolation(job: Listing, profile: Profile, config: AppConfig): string | null {
  const block = isBlocked(job.company, job.title, profile.blockedCompanies, profile.blockedTitleTerms);
  if (block.blocked) return block.reason;

  const workMode = /work from home|remote/i.test(job.location) ? 'remote' : /hybrid/i.test(job.location) ? 'hybrid' : 'onsite';
  const rules = scoreJob(
    { requiredTech: job.skills.join(', '), location: job.location, workMode },
    { coreStack: profile.coreStack, city: profile.city, acceptedWorkModes: profile.workModes, englishLevel: profile.englishLevel },
    config.minScore,
  );
  return rules.dealBreakers.length ? rules.dealBreakers.join('; ') : null;
}

async function scoreListings(listings: Listing[], config: AppConfig, sheet: string): Promise<Map<number, { score: number; reason: string }>> {
  const compact = listings.map(l => ({
    id: l.id, title: l.title, company: l.company, location: l.location,
    experience: l.experience, skills: l.skills.join(', '), summary: l.summary,
  }));
  const result = await callJson<{ results: Array<{ id: number; score: number; reason: string }> }>({
    model: config.scoringModel,
    system: scoringPrompt(sheet),
    user: `Score these listings:\n${JSON.stringify(compact, null, 1)}`,
    schema: SCORING_SCHEMA,
    effort: 'low',
    context: 'scoring',
  });
  return new Map(result.results.map(r => [r.id, { score: r.score, reason: r.reason }]));
}

async function processJob(ctx: RunContext, job: Listing, score: number): Promise<Outcome> {
  const { page, config, sheet } = ctx;

  await humanPause(config);
  await page.goto(job.url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  const description = await page.evaluate(() =>
    ((document.querySelector('.detail_view') as HTMLElement | null)?.innerText ?? '').replace(/\n{2,}/g, '\n'));

  if (!(await openApplicationForm(page))) return skip(job, score, 'no easy-apply form');

  const form = await readApplicationForm(page);
  if (form.unsupported.length) {
    await closeForm(page);
    const reason = `unsupported fields: ${form.unsupported.join(' / ').slice(0, 150)}`;
    ctx.problems.push(`${job.company}: ${reason}`);
    return skip(job, score, reason);
  }

  const generated = await callJson<GeneratedAnswers>({
    model: config.agentModel,
    system: answersPrompt(sheet),
    user: `<job>
Title: ${job.title}
Company: ${job.company}
Location: ${job.location}
Salary: ${job.salary}
Experience: ${job.experience}
Description:
${description.slice(0, MAX_DESCRIPTION_CHARS)}
</job>

<form>
Has cover letter field: ${form.hasCoverLetter ? `yes ("${form.coverLetterPrompt}")` : 'no'}
Questions:
${JSON.stringify(form.questions.map(q => ({
  q: q.i,
  type: q.kind === 'text' && q.inputType === 'number' ? 'number' : q.kind,
  question: q.text,
  options: q.options.length ? q.options : undefined,
  required: q.required,
})), null, 1)}
</form>`,
    schema: ANSWERS_SCHEMA,
    effort: 'medium',
    context: 'answers',
  });

  if (generated.skip_reason.trim()) {
    await closeForm(page);
    return skip(job, score, `writer: ${generated.skip_reason}`);
  }

  log('SCRIPT', `  cover letter: ${generated.cover_letter || '(none)'}`);
  for (const a of generated.answers) {
    log('SCRIPT', `  Q: ${form.questions.find(q => q.i === a.q)?.text ?? a.q} -> ${a.answer}`);
  }

  const fillError = await fillForm(page, form, generated.cover_letter, new Map(generated.answers.map(a => [a.q, a.answer])));
  if (fillError) {
    await closeForm(page);
    ctx.problems.push(`${job.company}: ${fillError}`);
    return skip(job, score, `fill failed: ${fillError}`);
  }

  await humanPause(config);
  const shotName = `${new Date().toISOString().replace(/[:.]/g, '-')}_${job.company.replace(/[^\w]+/g, '_').slice(0, 40)}.png`;
  const screenshotPath = path.join(SCREENSHOT_DIR, shotName);
  await page.screenshot({ path: screenshotPath }).catch(() => {});

  if (config.dryRun) {
    await closeForm(page);
    recordApplication({ platform: PLATFORM, jobTitle: job.title, company: job.company, url: job.url, messageSent: 0, status: 'dry-run', score, screenshotPath });
    log('SCRIPT', '  DRY-RUN: form filled, not submitted');
    return 'dry-run';
  }

  const result = await submitAndVerify(page, job.url);
  if (!result.ok) {
    ctx.problems.push(`${job.company}: ${result.detail}`);
    log('ERROR', `  NOT applied: ${result.detail}`);
    return skip(job, score, result.detail);
  }

  if (!recordApplication({ platform: PLATFORM, jobTitle: job.title, company: job.company, url: job.url, messageSent: 0, status: 'applied', score, screenshotPath })) {
    ctx.problems.push(`${job.company}: applied, but saving it to the database failed`);
  }
  log('SCRIPT', `  APPLIED (${result.detail})`);
  return 'applied';
}

// ========== RUN ==========

export async function runInternshala(profile: Profile, answers: Answers, site: Site, config: AppConfig): Promise<string> {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const sheet = candidateSheet(profile, answers);
  const browser = await chromium.connectOverCDP(config.cdpEndpoint);

  const submitted: Submitted[] = [];
  const problems: string[] = [];
  const seenThisRun = new Set<string>();
  let opened = 0;
  let stopReason = 'all search pages checked';

  const canContinue = (): boolean => {
    if (submitted.length >= config.maxPerRun) { stopReason = `run limit reached (${config.maxPerRun})`; return false; }
    if (countApplicationsToday() >= config.dailyLimit) { stopReason = `daily limit reached (${config.dailyLimit})`; return false; }
    if (config.maxCostUsd > 0 && getTotalCost() > config.maxCostUsd) { stopReason = `cost cap reached ($${config.maxCostUsd})`; return false; }
    return true;
  };

  try {
    const page = await browser.contexts()[0].newPage();
    page.setDefaultTimeout(10000);
    // tsx/esbuild wraps named functions in __name(); functions sent to the page need a no-op shim.
    await page.addInitScript('window.__name = window.__name || ((f) => f);');
    const ctx: RunContext = { page, profile, config, sheet, problems };

    search: for (const baseUrl of site.searchUrls) {
      for (let pageNo = 1; pageNo <= MAX_PAGES; pageNo++) {
        if (!canContinue()) break search;
        const listUrl = pageNo === 1 ? baseUrl : `${baseUrl.replace(/\/$/, '')}/page-${pageNo}/`;
        log('SCRIPT', `Listing: ${listUrl}`);
        try {
          await page.goto(listUrl, { waitUntil: 'domcontentloaded' });
          await page.waitForTimeout(2000);
        } catch (e) {
          problems.push(`could not open ${listUrl}: ${(e as Error).message.split('\n')[0]}`);
          break;
        }

        const raw = await readListings(page);
        if (!raw.length) break;

        const fresh: Listing[] = [];
        for (const r of raw) {
          if (seenThisRun.has(r.url) || hasApplied(r.url) || wasJobSeen(r.url)) continue;
          seenThisRun.add(r.url);
          const listing = { ...r, id: fresh.length };
          const violation = hardRuleViolation(listing, profile, config);
          if (violation) { skip(listing, 0, violation); continue; }
          fresh.push(listing);
        }
        log('SCRIPT', `${raw.length} listings, ${fresh.length} new`);
        if (!fresh.length) continue;

        let scores: Map<number, { score: number; reason: string }>;
        try {
          scores = await scoreListings(fresh, config, sheet);
        } catch (e) {
          problems.push(`scoring failed on ${listUrl}: ${(e as Error).message}`);
          log('ERROR', `Scoring failed: ${(e as Error).message}`);
          continue;
        }

        const ranked = fresh
          .map(job => ({ job, s: scores.get(job.id) ?? { score: 0, reason: 'not scored' } }))
          .sort((a, b) => b.s.score - a.s.score);

        for (const { job, s } of ranked) {
          if (s.score < config.minScore) {
            recordSeenJob({ url: job.url, jobTitle: job.title, company: job.company, platform: PLATFORM, score: s.score, skipReason: s.reason });
            continue;
          }
          if (!canContinue()) break search;
          if (appliedToCompanyToday(job.company)) {
            log('SCRIPT', `  skipped ${job.title} @ ${job.company}: already applied to this company today`);
            continue;
          }
          opened++;
          log('SCRIPT', `[${s.score}/10] ${job.title} @ ${job.company}: ${s.reason}`);

          try {
            const outcome = await processJob(ctx, job, s.score);
            if (outcome !== 'skipped') {
              submitted.push({ company: job.company, title: job.title, score: s.score, url: job.url, dryRun: outcome === 'dry-run' });
            }
          } catch (e) {
            // One flaky page must not end the whole run; the job stays eligible for a later run.
            const msg = (e as Error).message.split('\n')[0];
            problems.push(`${job.company}: ${msg}`);
            log('ERROR', `  error on ${job.url}: ${msg}`);
            await closeForm(page);
          }
        }
      }
    }
    await page.close().catch(() => {});
  } finally {
    // For CDP connections this only disconnects; the user's Chrome keeps running.
    await browser.close().catch(() => {});
  }

  const label = config.dryRun ? 'Filled (dry-run, not submitted)' : 'Applied';
  const lines = [
    `${label}: ${submitted.length} (stopped: ${stopReason}). Jobs opened: ${opened}.`,
    ...submitted.map(s => `- ${s.title} @ ${s.company} (score ${s.score})${s.dryRun ? ' [dry-run]' : ''}`),
  ];
  if (problems.length) lines.push('Problems:', ...problems.map(p => `- ${p}`));
  return lines.join('\n');
}

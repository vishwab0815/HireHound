import { readFileSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  hasApplied,
  recordApplication,
  countApplicationsToday,
  listApplications,
  recordSeenJob,
  wasJobSeen,
  updateScreenshot,
  findCachedAnswer,
  findCacheCandidates,
  saveCachedAnswer,
  normalizeQuestion,
  wasRecruiterContacted,
  recordRecruiterMessage,
  countMessagesToday,
} from '../core/database.js';
import { log } from '../core/logger.js';
import { isPermanentFailure, isRetryableFailure, backoffMs, MAX_ATTEMPTS } from '../core/errors.js';
import { notifyApplication, askHumanToSolveCaptcha } from '../notify/telegram.js';
import { generateTailoredResume } from '../writing/tailored-resume.js';
import { generateCoverLetter } from '../writing/cover-letter.js';
import { generateRecruiterMessage } from '../writing/recruiter-message.js';
import { scoreJob } from '../filters/job-score.js';
import { isBlocked } from '../filters/blocklist.js';
import type { Profile, Answers, AppConfig } from '../types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const MAX_RECRUITER_MESSAGES_PER_DAY = 5;

interface ToolDeclaration {
  name: string;
  description: string;
  input_schema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
}

/**
 * Registrable domain of a URL (portal.gupy.io -> gupy.io, www.vagas.com.br -> vagas.com.br).
 * Used to group URLs of the same portal so a portal that blocks us can be dropped entirely.
 */
export function registrableDomain(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) return host;
    const parts = host.split('.');
    if (parts.length <= 2) return host;
    // Two-level TLDs (co.in, com.br, ...): keep three labels when the second-to-last is a known SLD.
    const slds = new Set(['com', 'net', 'org', 'gov', 'edu', 'co']);
    return slds.has(parts[parts.length - 2]) ? parts.slice(-3).join('.') : parts.slice(-2).join('.');
  } catch {
    return '';
  }
}

interface ResumeEntry {
  id: string;
  file: string;
  focus: string;
  useWhen: string;
  keywords?: string[];
}

interface ResumesConfig {
  fallback: ResumeEntry;
  resumes: ResumeEntry[];
}

function loadResumes(): ResumesConfig {
  return JSON.parse(readFileSync(path.join(ROOT, 'config', 'resumes.json'), 'utf-8'));
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const prop = (description: string, type: 'string' | 'number' | 'boolean' = 'string') => ({ type, description });

// ========== TOOL DECLARATIONS ==========

export const agentToolDeclarations: ToolDeclaration[] = [
  {
    name: 'get_candidate_profile',
    description: 'Returns all of the candidate\'s personal and professional data, for filling forms and writing answers.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'check_already_applied',
    description: 'Checks the database for an existing application to this job URL.',
    input_schema: { type: 'object', properties: { url: prop('Full job URL') }, required: ['url'] },
  },
  {
    name: 'record_application',
    description: 'Records a completed application. Call AFTER the form was filled and submitted.',
    input_schema: {
      type: 'object',
      properties: {
        platform: prop('Platform name, e.g. LinkedIn, Naukri, Internshala'),
        job_title: prop('Job title'),
        company: prop('Company name'),
        url: prop('Job URL'),
        message_sent: prop('Whether a personal message was sent to the recruiter', 'boolean'),
        score: prop('Job score (1-10) from score_job. Always include it; the dashboard uses it.', 'number'),
      },
      required: ['platform', 'job_title', 'company', 'url'],
    },
  },
  {
    name: 'confirm_submit',
    description: 'REQUIRED right before ANY final submit click (Apply/Submit/Send/Finish, or sending a recruiter invite). In dry-run mode the system BLOCKS the submit: do not click, record the application and move on. In live mode it allows the click.',
    input_schema: {
      type: 'object',
      properties: {
        job_url: prop('URL of the page where the submit would happen'),
        action: prop('What is being sent, e.g. "application" or "recruiter message"'),
      },
      required: ['job_url'],
    },
  },
  {
    name: 'count_applications_today',
    description: 'Returns how many applications were made today. Use it to check the daily limit.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'list_recent_applications',
    description: 'Lists recent applications, to avoid duplicates.',
    input_schema: { type: 'object', properties: { limit: prop('How many to return (default 20)', 'number') } },
  },
  {
    name: 'score_job',
    description: 'Scores how well a job matches the candidate (1-10). ALWAYS call it before deciding to apply. If the verdict is SKIP, skip the job.',
    input_schema: {
      type: 'object',
      properties: {
        job_title: prop('Job title'),
        company: prop('Company name'),
        required_tech: prop('Technologies / requirements the job asks for'),
        seniority: prop('Seniority asked for (fresher, junior, mid, senior, ...)'),
        work_mode: prop('Work mode (remote, hybrid, on-site)'),
        location: prop('Job city/region'),
        required_english: prop('English level the job REQUIRES if stated: none, basic, intermediate, advanced or fluent. Leave empty if not stated.'),
      },
      required: ['job_title', 'required_tech'],
    },
  },
  {
    name: 'choose_resume',
    description: 'Picks the best resume file for the job. Returns the PDF path to upload. Use it BEFORE uploading a resume.',
    input_schema: {
      type: 'object',
      properties: { job_description: prop('Summary of the job (tech, type of role, domain)') },
      required: ['job_description'],
    },
  },
  {
    name: 'wait',
    description: 'Waits a random amount of time between actions, like a person would. Use it between navigation steps.',
    input_schema: {
      type: 'object',
      properties: {
        min_ms: prop('Minimum milliseconds (default DELAY_MIN)', 'number'),
        max_ms: prop('Maximum milliseconds (default DELAY_MAX)', 'number'),
      },
    },
  },
  {
    name: 'save_screenshot',
    description: 'Saves a screenshot as proof of the application. Use AFTER submitting (or after the dry-run block). Pass the base64 data from browser_take_screenshot.',
    input_schema: {
      type: 'object',
      properties: {
        job_url: prop('Job URL to attach the screenshot to'),
        screenshot_base64: prop('Base64 screenshot data'),
        company: prop('Company name (used in the file name)'),
      },
      required: ['job_url', 'screenshot_base64', 'company'],
    },
  },
  {
    name: 'check_job_seen',
    description: 'Checks whether a job was already looked at before (even if not applied). Use BEFORE analysing a job in detail.',
    input_schema: { type: 'object', properties: { url: prop('Job URL') }, required: ['url'] },
  },
  {
    name: 'record_seen_job',
    description: 'Marks a job as seen. Use for jobs you SKIPPED (low score, wrong location, ...) so they are not analysed again.',
    input_schema: {
      type: 'object',
      properties: {
        url: prop('Job URL'),
        job_title: prop('Job title'),
        company: prop('Company name'),
        platform: prop('Platform'),
        score: prop('Job score', 'number'),
        skip_reason: prop('Why the job was skipped'),
      },
      required: ['url'],
    },
  },
  {
    name: 'get_prepared_answers',
    description: 'Returns the candidate\'s prepared answers to common form questions (salary, availability, strengths, ...). Use them as a base and vary the wording.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'generate_tailored_resume',
    description: 'Builds a PDF resume rewritten for this specific job, using ONLY the candidate\'s real data. If it fails, use choose_resume.',
    input_schema: {
      type: 'object',
      properties: {
        job_description: prop('FULL job description (requirements, responsibilities, tech, seniority)'),
        job_title: prop('Job title'),
        company: prop('Company name'),
      },
      required: ['job_description'],
    },
  },
  {
    name: 'generate_cover_letter',
    description: 'Writes a cover letter for the job, ready to paste. Use when the form asks for a cover letter, "why should we hire you", "why do you want to work here" (long field) or "introduce yourself".',
    input_schema: {
      type: 'object',
      properties: {
        job_description: prop('Job description'),
        job_title: prop('Job title'),
        company: prop('Company name'),
      },
      required: ['job_description', 'company', 'job_title'],
    },
  },
  {
    name: 'find_cached_answer',
    description: 'Looks up whether this form question was answered before. Use BEFORE writing a new answer; on a hit, reuse it (you may vary the wording slightly).',
    input_schema: {
      type: 'object',
      properties: {
        question: prop('Question text / field label'),
        field_type: prop('Field type: textbox, numeric, dropdown, radio, date, textarea'),
      },
      required: ['question', 'field_type'],
    },
  },
  {
    name: 'save_cached_answer',
    description: 'Saves an answer for reuse in future forms. Use AFTER filling a field with a newly written answer. Do NOT save cover letters, answers that mention the company, or date fields.',
    input_schema: {
      type: 'object',
      properties: {
        question: prop('Question text / field label'),
        field_type: prop('Field type: textbox, numeric, dropdown, radio, date, textarea'),
        answer: prop('Answer that was used'),
        current_company: prop('Company of the current job (answers mentioning it are not cached)'),
      },
      required: ['question', 'field_type', 'answer'],
    },
  },
  {
    name: 'report_failure',
    description: 'Reports a problem during an application. It is classified as PERMANENT (never retry) or RETRYABLE. Permanent codes: job_expired, captcha, session_expired, location_ineligible, already_applied, account_required, not_a_job, sso_required, site_blocked, cloudflare, portal_blocked (blocked on the search page: drop the whole portal), unsupported_form, internal_only, language_mismatch. Retryable codes: timeout, network_error, page_not_loaded, server_error, element_not_found, upload_error, mcp_error.',
    input_schema: {
      type: 'object',
      properties: {
        job_url: prop('URL where it happened'),
        failure_code: prop('Failure code, e.g. job_expired, captcha, timeout'),
        description: prop('What happened'),
        job_title: prop('Job title, if known'),
        company: prop('Company, if known'),
        platform: prop('Platform'),
      },
      required: ['job_url', 'failure_code', 'description'],
    },
  },
  {
    name: 'solve_captcha_via_telegram',
    description: 'Sends a CAPTCHA screenshot to Telegram and asks the user to solve it BY HAND in the open Chrome window, replying OK or SKIP. Returns SOLVED / SKIP / TIMEOUT (never a text answer). After SOLVED, check the page again with browser_snapshot. Needs Telegram configured. Times out after 5 minutes.',
    input_schema: {
      type: 'object',
      properties: {
        screenshot_base64: prop('Base64 screenshot of the CAPTCHA'),
        job_url: prop('Page URL where the CAPTCHA appeared'),
      },
      required: ['screenshot_base64', 'job_url'],
    },
  },
  {
    name: 'generate_recruiter_message',
    description: 'Writes a LinkedIn connection note (max 280 chars) to the job\'s recruiter. Use ONLY when the job scores 8 or more, you found the recruiter on the page, and they were not contacted before.',
    input_schema: {
      type: 'object',
      properties: {
        recruiter_name: prop('Recruiter / hiring manager name'),
        recruiter_title: prop('Their title (Recruiter, HR Manager, Tech Lead, ...)'),
        company: prop('Company name'),
        job_title: prop('Job title'),
        job_description: prop('Job description'),
      },
      required: ['recruiter_name', 'company', 'job_title', 'job_description'],
    },
  },
  {
    name: 'check_recruiter_contacted',
    description: 'Checks whether this recruiter (LinkedIn profile URL) was already messaged.',
    input_schema: { type: 'object', properties: { profile_url: prop('Recruiter LinkedIn profile URL') }, required: ['profile_url'] },
  },
  {
    name: 'record_recruiter_message',
    description: 'Records that a message was sent to a recruiter. Use AFTER the LinkedIn invite was sent.',
    input_schema: {
      type: 'object',
      properties: {
        recruiter_name: prop('Recruiter name'),
        recruiter_title: prop('Recruiter title'),
        company: prop('Company name'),
        profile_url: prop('Recruiter LinkedIn profile URL'),
        job_url: prop('Related job URL'),
        job_title: prop('Job title'),
        message: prop('Message that was sent'),
        job_score: prop('Job score (1-10)', 'number'),
      },
      required: ['recruiter_name', 'company', 'profile_url', 'message'],
    },
  },
];

// ========== TOOL EXECUTOR ==========

export function createToolExecutor(profile: Profile, config: AppConfig) {
  // Per-run state: recreated on every run so scheduled runs start clean.
  const attemptsByUrl = new Map<string, number>();
  let confirmedSubmits = 0;
  const blockedPortals = new Set<string>();

  return async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
    switch (name) {
      case 'get_candidate_profile':
        return JSON.stringify(profile, null, 2);

      case 'check_already_applied':
        return hasApplied(str(args.url))
          ? 'ALREADY_APPLIED: the candidate already applied to this job. Move on.'
          : 'NEW_JOB: no application yet. Go ahead.';

      case 'record_application': {
        const score = Number(args.score) || 0;
        const company = str(args.company);
        const jobTitle = str(args.job_title);

        const block = isBlocked(company, jobTitle, profile.blockedCompanies, profile.blockedTitleTerms);
        if (block.blocked) {
          log('AGENT', `Application BLOCKED (blocklist): ${jobTitle} - ${company}`);
          return JSON.stringify({ recorded: false, reason: 'BLOCKLIST', message: `${block.reason}. Not recorded. Move on.` });
        }

        // Enforced in code: jobs below the minimum score are never recorded, whatever the model decides.
        if (score < config.minScore) {
          log('AGENT', `Application BLOCKED (score ${score} < minimum ${config.minScore}): ${jobTitle} - ${company}`);
          return JSON.stringify({
            recorded: false,
            reason: 'SCORE_BELOW_MINIMUM',
            message: `Score ${score} is below the minimum ${config.minScore}. Not recorded. If you haven't scored the job with score_job yet, do that; otherwise move on.`,
          });
        }

        const ok = recordApplication({
          platform: str(args.platform),
          jobTitle,
          company,
          url: str(args.url),
          messageSent: args.message_sent ? 1 : 0,
          status: config.dryRun ? 'dry-run' : 'applied',
          score,
        });
        if (ok) {
          log('AGENT', `Application recorded: ${jobTitle} - ${company} (score ${score})`);
          notifyApplication(company, jobTitle, score, config.dryRun).catch(() => {});
        }
        return ok ? 'RECORDED: application saved.' : 'ERROR: could not record the application (probably a duplicate).';
      }

      case 'confirm_submit': {
        const jobUrl = str(args.job_url);
        const action = str(args.action) || 'submit';

        // Cooperative checkpoint: the click itself is an MCP browser tool the model controls, so
        // this lowers risk and counts submits but is not a hard barrier. That is one reason the
        // scripted mode exists for Internshala, where code owns the submit click.
        if (config.dryRun) {
          log('AGENT', `DRY-RUN: submit blocked (${action}) - ${jobUrl}`);
          return JSON.stringify({
            allowed: false,
            mode: 'dry-run',
            message: `DRY-RUN: the ${action} was BLOCKED. Do NOT click the final submit button. Record it with record_application (saved as dry-run) and move to the next job.`,
          });
        }

        if (confirmedSubmits >= config.maxPerRun) {
          log('AGENT', `Run limit reached (${config.maxPerRun}). Submit blocked - ${jobUrl}`);
          return JSON.stringify({
            allowed: false,
            mode: 'live',
            reason: 'RUN_LIMIT',
            message: `The limit of ${config.maxPerRun} submits per run is reached. Do not submit anything else. Finish with a summary.`,
          });
        }

        confirmedSubmits += 1;
        log('AGENT', `Submit allowed (${action}) ${confirmedSubmits}/${config.maxPerRun} - ${jobUrl}`);
        return JSON.stringify({ allowed: true, mode: 'live', message: 'OK_TO_SUBMIT: you may click the final submit button now.' });
      }

      case 'count_applications_today':
        return `Applications today: ${countApplicationsToday()}`;

      case 'list_recent_applications':
        return JSON.stringify(listApplications(Number(args.limit) || 20), null, 2);

      case 'score_job': {
        const result = scoreJob(
          {
            requiredTech: str(args.required_tech),
            seniority: str(args.seniority),
            location: str(args.location),
            workMode: str(args.work_mode),
            requiredEnglish: str(args.required_english),
          },
          { coreStack: profile.coreStack, city: profile.city, acceptedWorkModes: profile.workModes, englishLevel: profile.englishLevel },
          config.minScore,
        );
        const block = isBlocked(str(args.company), str(args.job_title), profile.blockedCompanies, profile.blockedTitleTerms);
        if (block.blocked) {
          return JSON.stringify({ score: result.score, verdict: 'SKIP', reason: block.reason, dealBreakers: [block.reason] });
        }
        return JSON.stringify(result);
      }

      case 'choose_resume': {
        const description = str(args.job_description).toLowerCase();
        const resumes = loadResumes();

        let best: ResumeEntry | null = null;
        let bestHits = 0;
        for (const r of resumes.resumes) {
          const hits = (r.keywords ?? []).filter(k => description.includes(k.toLowerCase())).length;
          if (hits > bestHits) {
            best = r;
            bestHits = hits;
          }
        }
        const chosen = best ?? resumes.fallback;
        return JSON.stringify({
          resume: chosen.id,
          focus: chosen.focus,
          path: path.resolve(ROOT, chosen.file),
          reason: best ? `Matched ${bestHits} keyword(s) for "${chosen.focus}".` : 'No specific resume matched; using the default one.',
        });
      }

      case 'wait': {
        const min = Number(args.min_ms) || config.delayMinMs;
        const max = Number(args.max_ms) || config.delayMaxMs;
        const ms = Math.floor(Math.random() * (max - min + 1)) + min;
        await new Promise(r => setTimeout(r, ms));
        return `Waited ${ms}ms.`;
      }

      case 'save_screenshot': {
        const dir = path.join(ROOT, 'screenshots');
        mkdirSync(dir, { recursive: true });
        const company = str(args.company).replace(/[^a-zA-Z0-9]/g, '_').slice(0, 30);
        const fileName = `${new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-')}_${company}.png`;
        const fullPath = path.join(dir, fileName);
        try {
          writeFileSync(fullPath, Buffer.from(str(args.screenshot_base64), 'base64'));
          updateScreenshot(str(args.job_url), fullPath);
          log('TOOL', `Screenshot saved: ${fileName}`);
          return `Screenshot saved to ${fullPath}`;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log('ERROR', `Could not save screenshot: ${msg}`);
          return `ERROR saving screenshot: ${msg}`;
        }
      }

      case 'check_job_seen':
        return wasJobSeen(str(args.url))
          ? 'ALREADY_SEEN: this job was analysed before. Move on.'
          : 'NEW: not seen yet. Go ahead.';

      case 'record_seen_job':
        return recordSeenJob({
          url: str(args.url),
          jobTitle: str(args.job_title) || undefined,
          company: str(args.company) || undefined,
          platform: str(args.platform) || undefined,
          score: Number(args.score) || undefined,
          skipReason: str(args.skip_reason) || undefined,
        }) ? 'RECORDED: job marked as seen.' : 'ERROR: could not mark the job as seen.';

      case 'get_prepared_answers': {
        try {
          const answers = JSON.parse(readFileSync(path.join(ROOT, 'config', 'answers.json'), 'utf-8')) as Answers;
          const usable = Object.fromEntries(Object.entries(answers).filter(([k]) => !k.startsWith('_')));
          return JSON.stringify(usable, null, 2);
        } catch {
          return 'ERROR: config/answers.json not found.';
        }
      }

      case 'find_cached_answer': {
        const question = str(args.question);
        const fieldType = str(args.field_type);

        const hit = findCachedAnswer(question, fieldType);
        if (hit) {
          log('TOOL', `Answer cache HIT: "${question.slice(0, 50)}..." (used ${hit.timesUsed}x)`);
          return JSON.stringify({ found: true, answer: hit.answer, timesUsed: hit.timesUsed, instruction: 'Use this answer. You may vary the wording but keep the content.' });
        }

        const candidates = findCacheCandidates(question);
        if (candidates.length) {
          return JSON.stringify({
            found: false,
            candidates: candidates.map(c => ({ question: c.question, answer: c.answer, type: c.fieldType })),
            instruction: 'No exact match. If one candidate means the same thing, reuse its answer (reworded). Otherwise write a new answer and save it.',
          });
        }
        return JSON.stringify({ found: false, candidates: [], instruction: 'Nothing cached. Write a new answer and save it after filling the field.' });
      }

      case 'save_cached_answer': {
        const question = str(args.question);
        const answer = str(args.answer);
        const company = str(args.current_company);

        // Answers that name the company are too specific to reuse elsewhere.
        if (company && answer.toLowerCase().includes(company.toLowerCase())) {
          return 'NOT_CACHED: the answer mentions the company, so it is too specific to reuse.';
        }
        if (saveCachedAnswer(question, str(args.field_type), answer)) {
          log('TOOL', `Answer cached: "${normalizeQuestion(question).slice(0, 50)}..."`);
          return 'CACHED: answer saved for reuse.';
        }
        return 'ALREADY_CACHED: this question is already in the cache.';
      }

      case 'report_failure': {
        const jobUrl = str(args.job_url);
        const code = str(args.failure_code);
        const description = str(args.description);
        const domain = registrableDomain(jobUrl);
        const seen = (skipReason: string) => recordSeenJob({
          url: jobUrl,
          jobTitle: str(args.job_title) || undefined,
          company: str(args.company) || undefined,
          platform: str(args.platform) || undefined,
          skipReason,
        });

        if (domain && blockedPortals.has(domain)) {
          return JSON.stringify({ type: 'PORTAL_BLOCKED', action: 'SKIP_PORTAL', message: `${domain} already blocked us this run. Go straight to the NEXT SITE.` });
        }

        if (code === 'portal_blocked') {
          if (domain) blockedPortals.add(domain);
          log('FAIL', `PORTAL BLOCKED: ${domain || jobUrl}, dropping it for this run`);
          if (!config.dryRun) await new Promise(r => setTimeout(r, 30_000));
          return JSON.stringify({ type: 'PORTAL_BLOCKED', action: 'SKIP_PORTAL', message: `Blocked at the entrance of ${domain || jobUrl}. Do not try other URLs or pages here. Go to the NEXT SITE.` });
        }

        // Anti-bot signal on a single job: pause in live mode to protect the account,
        // without dropping the whole portal (avoids false positives).
        if (!config.dryRun && (code === 'cloudflare' || code === 'site_blocked')) {
          await new Promise(r => setTimeout(r, 30_000));
        }

        if (isPermanentFailure(code)) {
          seen(`PERMANENT:${code} - ${description}`);
          attemptsByUrl.delete(jobUrl);
          log('FAIL', `PERMANENT [${code}]: ${description} - ${jobUrl}`);
          return JSON.stringify({ type: 'PERMANENT', action: 'SKIP', code, message: `Permanent failure (${code}). The job is marked as seen and won't be retried. Move on.` });
        }

        if (isRetryableFailure(code)) {
          const attempt = (attemptsByUrl.get(jobUrl) ?? 0) + 1;
          attemptsByUrl.set(jobUrl, attempt);

          if (attempt >= MAX_ATTEMPTS) {
            seen(`EXHAUSTED:${code} - ${attempt} attempts - ${description}`);
            attemptsByUrl.delete(jobUrl);
            log('FAIL', `EXHAUSTED [${code}]: ${attempt}/${MAX_ATTEMPTS} attempts - ${jobUrl}`);
            return JSON.stringify({ type: 'EXHAUSTED', action: 'SKIP', code, attempts: attempt, message: `Gave up after ${MAX_ATTEMPTS} attempts. Move on.` });
          }

          const wait = backoffMs(attempt);
          log('FAIL', `RETRYABLE [${code}]: attempt ${attempt}/${MAX_ATTEMPTS}, waiting ${wait}ms - ${jobUrl}`);
          await new Promise(r => setTimeout(r, wait));
          return JSON.stringify({ type: 'RETRYABLE', action: 'RETRY', code, attempt, maxAttempts: MAX_ATTEMPTS, message: `Retryable failure (${code}), attempt ${attempt}/${MAX_ATTEMPTS}. Waited ${Math.round(wait / 1000)}s already. Try again now.` });
        }

        log('FAIL', `UNKNOWN [${code}]: ${description} - ${jobUrl}`);
        seen(`UNKNOWN:${code} - ${description}`);
        return JSON.stringify({ type: 'UNKNOWN', action: 'SKIP', code, message: `Unknown failure code (${code}). Skipping this job to be safe.` });
      }

      case 'generate_recruiter_message': {
        const sentToday = countMessagesToday();
        if (sentToday >= MAX_RECRUITER_MESSAGES_PER_DAY) {
          return JSON.stringify({ ok: false, reason: 'DAILY_LIMIT', message: `Daily recruiter message limit reached (${sentToday}/${MAX_RECRUITER_MESSAGES_PER_DAY}).` });
        }
        try {
          const result = await generateRecruiterMessage(
            profile, str(args.recruiter_name), str(args.recruiter_title), str(args.company), str(args.job_title), str(args.job_description),
          );
          return JSON.stringify({
            ok: true,
            text: result.text,
            characters: result.text.length,
            instruction: 'Use this as the note on a LinkedIn connection request: open the recruiter profile, click Connect, Add a note, paste it with browser_type, Send. Then call record_recruiter_message.',
          });
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          log('ERROR', `Recruiter message failed: ${msg}`);
          return `ERROR: ${msg}. Skip messaging this recruiter.`;
        }
      }

      case 'check_recruiter_contacted':
        return wasRecruiterContacted(str(args.profile_url))
          ? 'ALREADY_CONTACTED: this recruiter already got a message. Skip.'
          : 'NEW: not contacted yet. Go ahead.';

      case 'record_recruiter_message': {
        const ok = recordRecruiterMessage({
          recruiterName: str(args.recruiter_name),
          recruiterTitle: str(args.recruiter_title) || undefined,
          company: str(args.company),
          profileUrl: str(args.profile_url),
          jobUrl: str(args.job_url) || undefined,
          jobTitle: str(args.job_title) || undefined,
          message: str(args.message),
          jobScore: Number(args.job_score) || undefined,
        });
        if (ok) log('AGENT', `Recruiter message recorded: ${str(args.recruiter_name)} - ${str(args.company)}`);
        return ok ? 'RECORDED: recruiter message saved.' : 'ERROR: could not record it (recruiter probably already contacted).';
      }

      case 'solve_captcha_via_telegram': {
        const pageUrl = str(args.job_url);
        log('FAIL', `CAPTCHA on ${pageUrl}. Asking for manual help on Telegram...`);
        try {
          const status = await askHumanToSolveCaptcha(str(args.screenshot_base64), pageUrl);
          if (status === 'solved') {
            return JSON.stringify({ status: 'SOLVED', instruction: 'The user solved it by hand. Check the page with browser_snapshot: if the challenge is gone, carry on. If still blocked, use report_failure (captcha, or portal_blocked on a listing page).' });
          }
          return JSON.stringify({ status: status === 'skip' ? 'SKIP' : 'TIMEOUT', instruction: 'Not solved. Use report_failure with code "captcha" (or "portal_blocked" on a search page) to skip.' });
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return JSON.stringify({ status: 'ERROR', reason: msg, instruction: 'Could not ask for help. Use report_failure with code "captcha" to skip this job.' });
        }
      }

      case 'generate_cover_letter': {
        try {
          const result = await generateCoverLetter(profile, str(args.job_description), str(args.company), str(args.job_title));
          return JSON.stringify({ ok: true, text: result.text, instruction: 'Paste this into the cover letter field. Small tone tweaks are fine.' });
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          log('ERROR', `Cover letter failed: ${msg}`);
          return `ERROR: ${msg}. Write a short answer from the candidate profile instead.`;
        }
      }

      case 'generate_tailored_resume': {
        try {
          const result = await generateTailoredResume(profile, str(args.job_description));
          return JSON.stringify({ ok: true, path: result.pdfPath, htmlPath: result.htmlPath, source: result.source });
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          log('ERROR', `Tailored resume failed: ${msg}`);
          return `ERROR: ${msg}. Use choose_resume instead.`;
        }
      }

      default:
        return `ERROR: unknown tool "${name}".`;
    }
  };
}

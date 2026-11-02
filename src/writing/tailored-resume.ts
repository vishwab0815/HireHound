import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { log } from '../core/logger.js';
import { generateText } from '../llm/helper-llm.js';
import { anonymizeProfile, deanonymize, hasLeftoverPlaceholder } from '../llm/anonymize.js';
import { findFabricatedSkills, stripCodeFences, profileSkills, profileText } from '../llm/skill-check.js';
import type { Profile } from '../types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TAILORED_DIR = path.resolve(__dirname, '..', '..', 'resumes', '_tailored');

const cache = new Map<string, string>();

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function buildBaseResumeHtml(profile: Profile): string {
  const experienceHtml = (profile.experience ?? []).map(exp => `
    <h3>${escapeHtml(exp.company)} - ${escapeHtml(exp.role)} <span class="period">(${escapeHtml(exp.period)})</span></h3>
    <ul>
      ${exp.description.split('. ').filter(Boolean).map(item => `<li>${escapeHtml(item.trim().replace(/\.$/, ''))}.</li>`).join('\n      ')}
    </ul>`).join('\n');

  const skillLines = [
    `<p class="skills"><strong>Core stack:</strong> ${escapeHtml(profile.coreStack.join(', '))}</p>`,
    profile.databases?.length ? `<p class="skills"><strong>Databases:</strong> ${escapeHtml(profile.databases.join(', '))}</p>` : '',
    profile.methodologies?.length ? `<p class="skills"><strong>Methodologies:</strong> ${escapeHtml(profile.methodologies.join(', '))}</p>` : '',
  ].filter(Boolean).join('\n');

  const extras = profile.extras ?? {};
  const contactLinks = [
    profile.linkedin && `<a href="${profile.linkedin}">LinkedIn</a>`,
    profile.github && `<a href="${profile.github}">GitHub</a>`,
    profile.portfolio && `<a href="${profile.portfolio}">Portfolio</a>`,
  ].filter(Boolean).join(' | ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  @page { margin: 18mm 18mm 14mm 18mm; size: A4; }
  body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #222; line-height: 1.5; margin: 0; padding: 28px 36px; max-width: 800px; }
  h1 { font-size: 26px; margin-bottom: 2px; color: #111; }
  .contact { font-size: 13px; color: #444; margin-bottom: 2px; }
  .contact a { color: #1a73e8; text-decoration: none; }
  h2 { font-size: 15px; margin: 14px 0 6px 0; color: #111; border-bottom: 1px solid #ccc; padding-bottom: 3px; text-transform: uppercase; letter-spacing: 0.5px; }
  h3 { font-size: 14px; margin: 10px 0 4px 0; color: #222; }
  .period { color: #555; font-weight: normal; font-size: 13px; }
  p { margin: 4px 0; font-size: 13.5px; }
  ul { margin: 4px 0 8px 18px; padding: 0; }
  li { font-size: 13px; margin-bottom: 3px; }
  .skills { font-size: 13px; margin: 3px 0; }
</style>
</head>
<body>
<h1>${escapeHtml(profile.name)}</h1>
<div class="contact">${escapeHtml(profile.phone)} | ${escapeHtml(profile.email)}</div>
<div class="contact">${contactLinks}</div>

<h2>Summary</h2>
<p>${escapeHtml(profile.summary)}</p>

<h2>Experience</h2>
${experienceHtml}

<h2>Skills</h2>
${skillLines}
${extras.education ? `\n<h2>Education</h2>\n<p>${escapeHtml(extras.education)}</p>` : ''}
${extras.languages ? `\n<h2>Languages</h2>\n<p>${escapeHtml(extras.languages)}</p>` : ''}
</body>
</html>`;
}

function buildPrompt(baseHtml: string, jobDescription: string, profile: Profile): string {
  return `You optimise resumes for applicant tracking systems (ATS).

You get an HTML resume and a job description. Reorganise the resume so it matches the job as well as it truthfully can.

Hard rules (breaking any of them is a failure):
1. Use only information from the candidate profile below. Invent nothing.
2. Do not add technologies, frameworks, tools or skills the candidate doesn't have.
3. Do not change dates, company names or job titles.
4. Do not exaggerate responsibilities or invent projects, certifications or courses.

You may:
1. Rewrite the summary to stress what matters for this job, using only real facts.
2. Reorder and reword experience bullets so the most relevant come first, without changing their meaning.
3. Reorder skill groups by relevance.
4. Drop irrelevant bullets, keeping at least 3 per job.

Candidate profile (source of truth):
Skills: ${profile.coreStack.join(', ')}
Databases: ${(profile.databases ?? []).join(', ')}
Methodologies: ${(profile.methodologies ?? []).join(', ')}
Years of experience: ${profile.yearsOfExperience}
Experience:
${(profile.experience ?? []).map(e => `- ${e.company} (${e.role}, ${e.period}): ${e.description}`).join('\n')}

Job description:
${jobDescription}

Current resume HTML:
${baseHtml}

Return only the complete optimised HTML, starting with <!DOCTYPE html> and ending with </html>. No explanations, no markdown.`;
}

/** Finds a Chrome/Chromium binary for headless PDF printing on Windows, macOS or Linux. */
function findChrome(): string {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;

  const absolute = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  const found = absolute.find(p => p && existsSync(p));
  if (found) return found;

  const lookup = process.platform === 'win32' ? 'where' : 'which';
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium-browser', 'chromium', 'chrome']) {
    try {
      execFileSync(lookup, [name], { stdio: 'pipe' });
      return name;
    } catch {
      // try the next one
    }
  }
  return 'google-chrome';
}

export async function generateTailoredResume(
  profile: Profile,
  jobDescription: string,
): Promise<{ pdfPath: string; htmlPath: string; source: 'generated' | 'cache' }> {
  const hash = createHash('md5').update(jobDescription.slice(0, 500)).digest('hex').slice(0, 12);
  const cachedPdf = cache.get(hash);
  if (cachedPdf) return { pdfPath: cachedPdf, htmlPath: cachedPdf.replace(/\.pdf$/, '.html'), source: 'cache' };

  mkdirSync(TAILORED_DIR, { recursive: true });
  const pdfPath = path.join(TAILORED_DIR, `resume_${hash}.pdf`);
  const htmlPath = path.join(TAILORED_DIR, `resume_${hash}.html`);
  if (existsSync(pdfPath)) {
    cache.set(hash, pdfPath);
    return { pdfPath, htmlPath, source: 'cache' };
  }

  const { anonymousProfile, map } = anonymizeProfile(profile);
  const baseHtml = buildBaseResumeHtml(anonymousProfile);
  log('TOOL', `Tailoring resume for job ${hash}...`);

  const response = await generateText(buildPrompt(baseHtml, jobDescription, anonymousProfile), 'tailored_resume');
  let html = stripCodeFences(response.text);
  if (!html.includes('<!DOCTYPE html') && !html.includes('<html')) {
    throw new Error('The model did not return valid HTML');
  }
  html = deanonymize(html, map);

  const fabricated = findFabricatedSkills(html, profileSkills(profile), profileText(profile));
  if (fabricated.length) {
    log('WARN', `Tailored resume rejected (made-up skills: ${fabricated.join(', ')}). Using the untailored resume instead.`);
    html = deanonymize(baseHtml, map);
  }
  if (hasLeftoverPlaceholder(html)) {
    log('WARN', 'Resume still contains placeholders after restoring contact details. Check it before sending.');
  }

  writeFileSync(htmlPath, html);

  try {
    execFileSync(findChrome(), [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      `--print-to-pdf=${pdfPath}`,
      '--no-pdf-header-footer',
      pathToFileURL(htmlPath).href,
    ], { timeout: 20000, stdio: 'pipe' });
  } catch (error) {
    log('ERROR', `HTML to PDF failed: ${error instanceof Error ? error.message : String(error)}`);
    throw new Error(`PDF conversion failed. The HTML is at ${htmlPath}. Set CHROME_PATH if Chrome is installed somewhere unusual.`);
  }

  log('TOOL', `Tailored resume ready: ${path.basename(pdfPath)}`);
  cache.set(hash, pdfPath);
  return { pdfPath, htmlPath, source: 'generated' };
}

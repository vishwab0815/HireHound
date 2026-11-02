import { createHash } from 'crypto';
import { log } from '../core/logger.js';
import { generateText } from '../llm/helper-llm.js';
import { anonymizeProfile, deanonymize } from '../llm/anonymize.js';
import { findFabricatedSkills, stripCodeFences, profileSkills, profileText } from '../llm/skill-check.js';
import type { Profile } from '../types.js';

// Avoid generating the same letter twice in one run.
const cache = new Map<string, string>();

function buildPrompt(profile: Profile, jobDescription: string, company: string, jobTitle: string): string {
  return `You write short, natural cover letters for job applications.

Write a cover letter for the job below.

Rules:
1. Use only facts from the candidate profile. Never invent experience, projects or skills.
2. 3 to 5 short paragraphs, 150 words at most.
3. Write in English. Professional but human; no cliches like "I am passionate about technology" or "seeking new challenges".
4. Don't repeat the whole resume. Pick the 2-3 points most relevant to THIS job.
5. Mention the company and the role so it is clearly written for them.
6. End by offering to talk, without flattery.
7. If the job asks for a technology the candidate doesn't have, don't mention it. Focus on the overlap.

Candidate profile:
Name: ${profile.name}
Title: ${profile.title}
Experience: ${profile.yearsOfExperience} year(s)
Stack: ${profile.coreStack.join(', ')}
Databases: ${(profile.databases ?? []).join(', ')}
Summary: ${profile.summary}
Experience:
${(profile.experience ?? []).map(e => `- ${e.company} (${e.role}, ${e.period}): ${e.description}`).join('\n')}

Job:
Company: ${company}
Role: ${jobTitle}
Description:
${jobDescription}

Return only the letter body, ready to paste into a form field: no "Dear ...", no sign-off.`;
}

export async function generateCoverLetter(
  profile: Profile,
  jobDescription: string,
  company: string,
  jobTitle: string,
): Promise<{ text: string; source: 'generated' | 'cache' }> {
  const key = createHash('md5').update(`${company}|${jobTitle}|${jobDescription.slice(0, 300)}`).digest('hex').slice(0, 12);
  const cached = cache.get(key);
  if (cached) return { text: cached, source: 'cache' };

  log('TOOL', `Writing cover letter for ${jobTitle} at ${company}...`);
  const { anonymousProfile, map } = anonymizeProfile(profile);
  const prompt = buildPrompt(anonymousProfile, jobDescription, company, jobTitle);

  let text = stripCodeFences(deanonymize((await generateText(prompt, 'cover_letter')).text, map));
  if (text.length < 50) throw new Error('Cover letter came back empty or too short');

  const fabricated = findFabricatedSkills(text, profileSkills(profile), profileText(profile));
  if (fabricated.length) {
    log('WARN', `Cover letter mentioned skills the candidate doesn't have (${fabricated.join(', ')}). Retrying...`);
    const retry = await generateText(
      `${prompt}\n\nYour previous attempt mentioned technologies the candidate does NOT have. Only use: ${profile.coreStack.join(', ')}`,
      'cover_letter_retry',
    );
    text = stripCodeFences(deanonymize(retry.text, map));
  }

  cache.set(key, text);
  log('TOOL', `Cover letter ready (${text.length} chars)`);
  return { text, source: 'generated' };
}

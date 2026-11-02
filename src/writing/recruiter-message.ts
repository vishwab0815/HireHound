// Short personalised notes for LinkedIn connection requests to recruiters.
// LinkedIn caps connection notes at 300 characters; we aim for 280.

import { createHash } from 'crypto';
import { log } from '../core/logger.js';
import { generateText } from '../llm/helper-llm.js';
import { anonymizeProfile, deanonymize } from '../llm/anonymize.js';
import { findFabricatedSkills, stripCodeFences, profileSkills, profileText } from '../llm/skill-check.js';
import type { Profile } from '../types.js';

const MAX_CHARS = 280;
const cache = new Map<string, string>();

function buildPrompt(
  profile: Profile,
  recruiterName: string,
  recruiterTitle: string,
  company: string,
  jobTitle: string,
  jobDescription: string,
): string {
  return `You write short LinkedIn connection notes to recruiters and hiring managers.

Rules:
1. At most ${MAX_CHARS} characters.
2. Use only facts from the candidate profile. Invent nothing.
3. English, professional and direct.
4. Use the recruiter's name if you have it, and name the specific role so it doesn't read as spam.
5. Highlight 1-2 skills that match the job. Skip technologies the candidate doesn't have.
6. End with interest in a chat, without flattery. No emojis, no formal greetings, no sign-off.
7. Sound like a real person networking, not a bot.

Candidate:
Name: ${profile.name}
Title: ${profile.title}
Experience: ${profile.yearsOfExperience} year(s)
Stack: ${profile.coreStack.join(', ')}
Summary: ${profile.summary}

Recruiter: ${recruiterName || 'unknown'} (${recruiterTitle || 'unknown title'}) at ${company}

Job: ${jobTitle}
${jobDescription.slice(0, 500)}

Example tone:
- "Hi, I saw the Backend Engineer opening at Acme. I've spent the last year building Python APIs with FastAPI and Postgres. Would be glad to chat about the role."

Return only the note text: no quotes, no explanation.`;
}

function trimToLimit(text: string): string {
  if (text.length <= MAX_CHARS) return text;
  const cut = text.slice(0, MAX_CHARS);
  const lastStop = Math.max(cut.lastIndexOf('.'), cut.lastIndexOf('!'), cut.lastIndexOf('?'));
  return lastStop > 200 ? cut.slice(0, lastStop + 1) : cut;
}

export async function generateRecruiterMessage(
  profile: Profile,
  recruiterName: string,
  recruiterTitle: string,
  company: string,
  jobTitle: string,
  jobDescription: string,
): Promise<{ text: string; source: 'generated' | 'cache' }> {
  const key = createHash('md5').update(`msg|${recruiterName}|${company}|${jobTitle}`).digest('hex').slice(0, 12);
  const cached = cache.get(key);
  if (cached) return { text: cached, source: 'cache' };

  log('TOOL', `Writing note for recruiter ${recruiterName || '(no name)'} at ${company}...`);
  const { anonymousProfile, map } = anonymizeProfile(profile);
  const prompt = buildPrompt(anonymousProfile, recruiterName, recruiterTitle, company, jobTitle, jobDescription);

  let text = stripCodeFences(deanonymize((await generateText(prompt, 'recruiter_message')).text, map));
  if (/^(["']).*\1$/s.test(text)) text = text.slice(1, -1);
  if (text.length < 20) throw new Error('Recruiter note came back empty or too short');
  text = trimToLimit(text);

  const fabricated = findFabricatedSkills(text, profileSkills(profile), profileText(profile));
  if (fabricated.length) {
    log('WARN', `Recruiter note mentioned skills the candidate doesn't have (${fabricated.join(', ')}). Retrying...`);
    const retry = await generateText(
      `${prompt}\n\nYou mentioned technologies the candidate does NOT have. Only use: ${profile.coreStack.join(', ')}. At most ${MAX_CHARS} characters.`,
      'recruiter_message_retry',
    );
    text = trimToLimit(stripCodeFences(deanonymize(retry.text, map)));
  }

  cache.set(key, text);
  log('TOOL', `Recruiter note ready (${text.length} chars)`);
  return { text, source: 'generated' };
}

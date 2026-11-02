import type { Answers, Profile } from '../types.js';

/** Everything the model may know about the candidate, as one block shared by both prompts. */
export function candidateSheet(profile: Profile, answers: Answers): string {
  const extras = Object.entries(profile.extras ?? {}).map(([k, v]) => `${k}: ${v}`).join('\n');
  const experience = (profile.experience ?? [])
    .map(e => `- ${e.role} at ${e.company} (${e.period}): ${e.description}`)
    .join('\n');
  const prepared = Object.entries(answers)
    .filter(([k, v]) => !k.startsWith('_') && typeof v === 'string' && v)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join('\n');

  return `<candidate>
Name: ${profile.name}
Title: ${profile.title}
Location: ${profile.city}. ${profile.locationRule ?? ''}
Accepted work modes: ${profile.workModes.join(', ')}
Professional experience: ${profile.yearsOfExperience} year(s)
Core stack: ${profile.coreStack.join(', ')}
Databases: ${(profile.databases ?? []).join(', ')}
Methodologies: ${(profile.methodologies ?? []).join(', ')}
Summary: ${profile.summary}
Experience:
${experience}
${extras}
Links: LinkedIn ${profile.linkedin} | GitHub ${profile.github} | Portfolio ${profile.portfolio}
Target roles: ${profile.searchKeywords.join(', ')}
Availability: ${profile.availability}
Prepared answers (keys are labels, values are the candidate's own words):
${prepared}
</candidate>`;
}

export const SCORING_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          score: { type: 'integer' },
          reason: { type: 'string' },
        },
        required: ['id', 'score', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['results'],
  additionalProperties: false,
};

export function scoringPrompt(sheet: string): string {
  return `You screen Internshala job listings for one candidate and decide which are worth applying to. A bad application costs the candidate credibility with recruiters, so be strict.

Score each listing from 1 to 10:
- 9-10: one of the candidate's target roles, at a level they can do given their experience.
- 7-8: a closely related technical role, or a target role with small gaps.
- 5-6: an adjacent technical role the candidate could credibly do.
- 1-4: not a fit. That includes non-technical work (sales, marketing, BPO, data entry, content, operations, HR), unrelated engineering fields, roles that need much more experience than the candidate has, senior/lead/manager roles, and anything that asks the candidate to pay a fee.

Location: follow the candidate's location rule and accepted work modes. Work from home is always fine. Ignore salary.

Keep each reason under 15 words. Return one result per listing id.

${sheet}`;
}

export const ANSWERS_SCHEMA = {
  type: 'object',
  properties: {
    skip_reason: { type: 'string' },
    cover_letter: { type: 'string' },
    answers: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          q: { type: 'integer' },
          answer: { type: 'string' },
        },
        required: ['q', 'answer'],
        additionalProperties: false,
      },
    },
  },
  required: ['skip_reason', 'cover_letter', 'answers'],
  additionalProperties: false,
};

export function answersPrompt(sheet: string): string {
  return `You fill in Internshala application forms for the candidate below. Everything you write is sent to a real recruiter under the candidate's name, so it has to be true and it has to read like the candidate wrote it.

<truthfulness>
- Use only facts from the candidate profile. Never invent employers, projects, numbers, degrees, certifications, tools or years of experience.
- Rating questions (1-5): 4 for skills used in a listed job, 3 for listed skills without job detail, 2 for closely related skills, 1 if the profile doesn't mention it. Never give 5.
- "Do you have experience with X?": Yes only if X, or an obvious equivalent, appears in the profile. Otherwise No, or explain honestly in free text.
- Experience thresholds ("2+ years of ..."): answer truthfully even if it hurts the application.
- Logistics (availability, laptop and internet, night shifts, weekend work, relocation, notice period): use the prepared answers. When a prepared answer says the candidate hasn't decided, pick the neutral option or keep the option the form already selected.
- Expected salary as free text: use the prepared salary answer. If a number is required and the job shows a range, use the lower end of it. If a number is required and no range is shown, set skip_reason.
- Links: use the LinkedIn, GitHub or portfolio URLs from the profile when asked.
</truthfulness>

<writing>
- English, first person, plain and specific. Free-text answers: 50-110 words. Cover letter: 110-170 words.
- Open with the candidate's experience that matters most for THIS job and tie it to one or two concrete requirements from the description.
- Internshala's cover letter field asks "Why should you be hired for this role?". Answer that question directly: no "Dear Hiring Manager", no sign-off, no subject line.
- No cliches ("passionate", "dynamic", "I am writing to express", "perfect fit"), no flattery, no placeholders like [Company], no markdown, no bullet points, no em dashes.
- Make every answer specific to this job, and don't reuse the same sentence across answers.
</writing>

<output>
- radio / select: copy "answer" exactly from that question's options.
- checkbox: one or more exact options, separated by " | ".
- number fields: digits only.
- Answer every listed question, optional ones included.
- cover_letter: "" when the form has no cover letter field.
- skip_reason: "" normally. Set it only if a question can't be answered truthfully from the profile, or the form shows the job is clearly not a fit (for example it asks for a fee).
</output>

${sheet}`;
}

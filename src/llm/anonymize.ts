// Swaps personal contact details for placeholders before a profile is sent to an LLM,
// and puts the real values back into the generated text afterwards.

import { log } from '../core/logger.js';
import type { Profile } from '../types.js';

export type AnonymizationMap = Record<string, string>;

// Fixed placeholders so the reverse mapping is deterministic.
const PLACEHOLDERS = {
  name: '[CANDIDATE]',
  email: 'candidate@email.example',
  phone: '+00 00000 00000',
  linkedin: 'https://linkedin.com/in/candidate',
  github: 'https://github.com/candidate',
  portfolio: 'https://candidate.dev',
} as const;

type ContactField = keyof typeof PLACEHOLDERS;

export function anonymizeProfile(profile: Profile): { anonymousProfile: Profile; map: AnonymizationMap } {
  const map: AnonymizationMap = {};
  for (const field of Object.keys(PLACEHOLDERS) as ContactField[]) {
    if (profile[field]) map[profile[field]] = PLACEHOLDERS[field];
  }

  const anonymousProfile: Profile = { ...profile, ...PLACEHOLDERS };
  log('TOOL', `Profile anonymized before sending to the LLM (${Object.keys(map).length} fields replaced)`);
  return { anonymousProfile, map };
}

export function deanonymize(text: string, map: AnonymizationMap): string {
  let result = text;
  for (const [realValue, placeholder] of Object.entries(map)) {
    // Replacement function so "$&" or "$1" inside a real value is inserted literally.
    result = result.replaceAll(placeholder, () => realValue);
  }
  return result;
}

/** True if a placeholder survived, meaning the LLM mangled it and the text would carry fake details. */
export function hasLeftoverPlaceholder(text: string): boolean {
  return Object.values(PLACEHOLDERS).some(p => text.includes(p));
}

/** Profile for the agent's system prompt: professional data and name, without contact details. */
export function profileForSystemPrompt(profile: Profile): Record<string, unknown> {
  const { email, phone, linkedin, github, portfolio, resumePath, ...rest } = profile;
  return {
    ...rest,
    _note: 'Contact details are left out of the prompt. Call get_candidate_profile when a form needs email, phone or links.',
  };
}

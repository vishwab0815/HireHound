// Catches LLM output that claims skills the candidate doesn't have, plus small text cleanups.

import type { Profile } from '../types.js';

// Technologies an LLM likes to sprinkle in. Mentioning one that isn't backed by the
// profile counts as fabrication.
const WATCHED_TECH = [
  'python', 'django', 'flask', 'fastapi',
  'golang', 'go lang', 'rust',
  'c#', 'c sharp', '.net', 'asp.net',
  'angular', 'vue.js', 'vuejs', 'svelte',
  'kubernetes', 'k8s', 'terraform', 'ansible',
  'aws certified', 'azure certified', 'gcp certified',
  'machine learning', 'deep learning', 'tensorflow', 'pytorch',
  'scala', 'kotlin', 'swift', 'objective-c',
  'php', 'laravel', 'symfony',
  'ruby', 'rails',
  'elasticsearch', 'redis', 'kafka', 'rabbitmq',
  'graphql',
  'spring boot', 'spring cloud', 'spring security',
  'microservices architecture', 'event-driven architecture',
  'clean architecture', 'hexagonal architecture', 'ddd',
];

/** Listed skills: core stack, databases and methodologies. */
export function profileSkills(profile: Profile): string[] {
  return [...profile.coreStack, ...(profile.databases ?? []), ...(profile.methodologies ?? [])];
}

/** Free text in the profile that can also back a skill (summary and experience descriptions). */
export function profileText(profile: Profile): string {
  return [
    profile.summary,
    ...(profile.experience ?? []).map(e => `${e.role} ${e.description}`),
    ...Object.values(profile.extras ?? {}),
  ].join(' ');
}

/**
 * Returns watched technologies that appear in `text` but are not backed by the profile.
 * A skill is backed if it matches a listed skill (both directions, so "Spring" covers
 * "spring boot") or is mentioned anywhere in the profile's own text.
 */
export function findFabricatedSkills(text: string, realSkills: string[], backingText = ''): string[] {
  const lower = text.toLowerCase();
  const backing = backingText.toLowerCase();
  const real = realSkills.map(s => s.toLowerCase()).filter(Boolean);

  return WATCHED_TECH.filter(tech => {
    if (!lower.includes(tech)) return false;
    const backed = real.some(s => s.includes(tech) || tech.includes(s)) || backing.includes(tech);
    return !backed;
  });
}

/** Removes markdown code fences (```html ... ```) that models sometimes add. */
export function stripCodeFences(text: string): string {
  let t = text.trim();
  if (t.startsWith('```')) t = t.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '').trim();
  return t;
}

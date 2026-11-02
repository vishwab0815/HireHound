import { describe, it, expect } from 'vitest';
import { anonymizeProfile, deanonymize, hasLeftoverPlaceholder, profileForSystemPrompt } from '../src/llm/anonymize';
import type { Profile } from '../src/types';

function fakeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    name: 'Test User',
    email: 'test@example.com',
    phone: '+91 98765 43210',
    linkedin: 'https://linkedin.com/in/test-user',
    github: 'https://github.com/test-user',
    portfolio: 'https://test-user.dev',
    resumePath: './assets/cv.pdf',
    title: 'Backend Developer',
    yearsOfExperience: 3,
    coreStack: ['Python', 'FastAPI'],
    summary: 'Professional summary without contact details.',
    salaryExpectation: 'Negotiable',
    workModes: ['remote'],
    city: 'Bengaluru, India',
    availability: 'Immediate',
    searchKeywords: ['Backend'],
    ...overrides,
  };
}

describe('anonymizeProfile', () => {
  it('replaces contact details with placeholders and keeps the rest', () => {
    const { anonymousProfile } = anonymizeProfile(fakeProfile());

    expect(anonymousProfile.name).toBe('[CANDIDATE]');
    expect(anonymousProfile.email).toBe('candidate@email.example');
    expect(anonymousProfile.phone).toBe('+00 00000 00000');
    expect(anonymousProfile.coreStack).toEqual(['Python', 'FastAPI']);
    expect(anonymousProfile.summary).toBe('Professional summary without contact details.');
  });

  it('does not map empty fields', () => {
    const { map } = anonymizeProfile(fakeProfile({ portfolio: '' }));
    expect(Object.keys(map)).not.toContain('');
  });
});

describe('deanonymize', () => {
  it('restores the real details from the placeholders', () => {
    const { map } = anonymizeProfile(fakeProfile());

    const restored = deanonymize('Contact: [CANDIDATE], candidate@email.example, +00 00000 00000', map);

    expect(restored).toContain('Test User');
    expect(restored).toContain('test@example.com');
    expect(restored).toContain('+91 98765 43210');
    expect(hasLeftoverPlaceholder(restored)).toBe(false);
  });

  it('inserts "$&" and "$1" in real values literally', () => {
    const restored = deanonymize('Company: [CANDIDATE]', { 'Cash $& Co $1': '[CANDIDATE]' });
    expect(restored).toBe('Company: Cash $& Co $1');
  });
});

describe('hasLeftoverPlaceholder', () => {
  it('spots a placeholder that survived', () => {
    expect(hasLeftoverPlaceholder('Regards, [CANDIDATE]')).toBe(true);
  });

  it('is false for fully restored text', () => {
    expect(hasLeftoverPlaceholder('Regards, Test User')).toBe(false);
  });
});

describe('profileForSystemPrompt', () => {
  it('leaves contact details out of the agent prompt', () => {
    const reduced = profileForSystemPrompt(fakeProfile());

    expect(reduced.email).toBeUndefined();
    expect(reduced.phone).toBeUndefined();
    expect(reduced.linkedin).toBeUndefined();
    expect(reduced.coreStack).toEqual(['Python', 'FastAPI']);
  });
});

import { describe, it, expect } from 'vitest';
import { matchOption, isInternshalaSite } from '../src/scripted/internshala';
import type { Site } from '../src/types';

describe('matchOption', () => {
  const options = ['Yes', 'No', 'Yes, I am available to join immediately', '6 months-1 year'];

  it('prefers an exact match, ignoring case and spacing', () => {
    expect(matchOption(options, '  yes ')).toBe('Yes');
    expect(matchOption(options, 'NO')).toBe('No');
  });

  it('falls back to prefix and substring matches', () => {
    expect(matchOption(options, 'Yes, I am available')).toBe('Yes, I am available to join immediately');
    expect(matchOption(options, '6 months')).toBe('6 months-1 year');
  });

  it('returns undefined for no match or an empty answer', () => {
    expect(matchOption(options, 'Maybe later')).toBeUndefined();
    expect(matchOption(options, '')).toBeUndefined();
  });
});

describe('isInternshalaSite', () => {
  const site = (searchUrls: string[]): Site => ({ name: 'x', searchUrls, type: 'job_board', instructions: '', enabled: true });

  it('recognises Internshala search URLs', () => {
    expect(isInternshalaSite(site(['https://internshala.com/jobs/ai-engineer-jobs/']))).toBe(true);
  });

  it('ignores other sites and look-alike domains', () => {
    expect(isInternshalaSite(site(['https://www.naukri.com/ai-engineer-jobs']))).toBe(false);
    expect(isInternshalaSite(site(['https://internshala.com.evil.example/jobs']))).toBe(false);
  });
});

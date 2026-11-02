import { describe, it, expect } from 'vitest';
import { isBlocked } from '../src/filters/blocklist';

describe('isBlocked', () => {
  it('blocks a listed company, ignoring case', () => {
    const r = isBlocked('ACME Corp', 'Backend Developer', ['acme corp'], []);
    expect(r.blocked).toBe(true);
    expect(r.reason).toMatch(/acme/i);
  });

  it('matches whole words only', () => {
    expect(isBlocked('Globant', 'Dev', ['Globo'], []).blocked).toBe(false);
  });

  it('blocks a title containing a blocked term, ignoring accents', () => {
    const r = isBlocked('Company X', 'Sénior Data Engineer', [], ['senior']);
    expect(r.blocked).toBe(true);
    expect(r.reason).toMatch(/senior/i);
  });

  it('handles terms with symbols (c++, .net)', () => {
    expect(isBlocked('X', 'C++ Developer', [], ['c++']).blocked).toBe(true);
    expect(isBlocked('X', '.NET Developer', [], ['.net']).blocked).toBe(true);
    expect(isBlocked('X', 'Java Developer', [], ['c++']).blocked).toBe(false);
  });

  it('blocks nothing when the lists are empty', () => {
    expect(isBlocked('Any', 'Any Job', [], []).blocked).toBe(false);
    expect(isBlocked('Any', 'Any Job').blocked).toBe(false);
  });
});

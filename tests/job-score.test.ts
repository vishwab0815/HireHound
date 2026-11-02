import { describe, it, expect } from 'vitest';
import { scoreJob, type CandidateFit } from '../src/filters/job-score';

// Accepts every work mode by default so each test isolates one rule.
function fit(over: Partial<CandidateFit> = {}): CandidateFit {
  return { coreStack: [], city: 'Bengaluru, India', acceptedWorkModes: ['remote', 'hybrid', 'onsite'], ...over };
}

describe('scoreJob: match score', () => {
  it('adds 1 per candidate skill the job asks for', () => {
    const r = scoreJob({ requiredTech: 'Python, FastAPI, React' }, fit({ coreStack: ['Python', 'React', 'Go'] }), 6);
    expect(r.score).toBe(7);
    expect(r.verdict).toBe('APPLY');
    expect(r.dealBreakers).toEqual([]);
  });

  it('takes 2 off for senior roles', () => {
    const r = scoreJob({ requiredTech: 'php', seniority: 'Senior' }, fit({ coreStack: ['Python'] }), 6);
    expect(r.score).toBe(3);
    expect(r.verdict).toBe('SKIP');
  });

  it('uses the configured minimum score', () => {
    const job = { requiredTech: 'python' };
    const f = fit({ coreStack: ['Python'] });
    expect(scoreJob(job, f, 6).verdict).toBe('APPLY');
    expect(scoreJob(job, f, 8).verdict).toBe('SKIP');
  });

  it('is fine with an on-site job in the candidate\'s city', () => {
    const r = scoreJob({ requiredTech: 'x', location: 'Bengaluru', workMode: 'onsite' }, fit(), 6);
    expect(r.score).toBe(6);
    expect(r.dealBreakers).toEqual([]);
  });

  it('penalises on-site jobs elsewhere when the candidate accepts on-site', () => {
    const r = scoreJob({ requiredTech: 'x', location: 'Mumbai', workMode: 'onsite' }, fit(), 6);
    expect(r.score).toBe(2);
    expect(r.dealBreakers).toEqual([]);
    expect(r.verdict).toBe('SKIP');
  });

  it('adds 1 for remote work', () => {
    expect(scoreJob({ requiredTech: 'x', workMode: 'Work from home' }, fit(), 6).score).toBe(6);
  });

  it('copes with missing fields', () => {
    expect(scoreJob({}, fit({ coreStack: ['Python'] }), 6).score).toBe(5);
  });

  it('keeps the score between 1 and 10', () => {
    const r = scoreJob({ requiredTech: 'a b c d e f g h', workMode: 'remote' }, fit({ coreStack: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] }), 6);
    expect(r.score).toBeLessThanOrEqual(10);
    expect(r.score).toBeGreaterThanOrEqual(1);
  });
});

describe('scoreJob: deal breakers', () => {
  it('skips a job that needs more English than the candidate has', () => {
    const r = scoreJob(
      { requiredTech: 'Python, React', requiredEnglish: 'fluent' },
      fit({ coreStack: ['Python', 'React'], englishLevel: 'intermediate' }),
      6,
    );
    expect(r.dealBreakers.length).toBeGreaterThan(0);
    expect(r.verdict).toBe('SKIP');
    expect(r.reason.toLowerCase()).toContain('english');
  });

  it('does not eliminate when the candidate meets the English level', () => {
    const r = scoreJob({ requiredTech: 'Python', requiredEnglish: 'advanced' }, fit({ coreStack: ['Python'], englishLevel: 'fluent' }), 6);
    expect(r.dealBreakers).toEqual([]);
  });

  it('does not eliminate when the candidate\'s English level is unknown', () => {
    const r = scoreJob({ requiredTech: 'Python', requiredEnglish: 'fluent' }, fit({ coreStack: ['Python'] }), 6);
    expect(r.dealBreakers).toEqual([]);
  });

  it('skips an on-site job elsewhere when the candidate only accepts remote', () => {
    const r = scoreJob(
      { requiredTech: 'Python', location: 'Mumbai', workMode: 'onsite' },
      fit({ coreStack: ['Python'], acceptedWorkModes: ['remote'] }),
      6,
    );
    expect(r.dealBreakers.length).toBeGreaterThan(0);
    expect(r.verdict).toBe('SKIP');
  });
});

// Rule-based job match score (1-10) plus deal breakers.
//
// Pure and deterministic. On top of the additive score it applies DEAL BREAKERS
// (English level and location) that make an application pointless no matter how
// well the stack matches.

import type { EnglishLevel } from '../types.js';

export interface JobFacts {
  requiredTech?: string;
  seniority?: string;
  location?: string;
  workMode?: string;
  /** English level the job requires, as extracted from the description. */
  requiredEnglish?: string;
}

export interface CandidateFit {
  coreStack: string[];
  city: string;
  /** Work modes the candidate accepts, e.g. ['remote']. */
  acceptedWorkModes: string[];
  englishLevel?: EnglishLevel;
}

export interface JobScore {
  score: number;
  verdict: 'APPLY' | 'SKIP';
  reason: string;
  /** If any are present the verdict is always SKIP. */
  dealBreakers: string[];
}

/** Lowercases and strips accents ("Bengalūru" -> "bengaluru"). */
function normalize(s: string): string {
  return (s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

/** City part of the profile location ("Bengaluru, India" -> "bengaluru"). */
function baseCity(city: string): string {
  return normalize((city ?? '').split(',')[0] ?? '');
}

const isRemote = (s: string) => /remote|work from home|wfh/.test(s);
const isOnsiteOrHybrid = (s: string) => /on-?site|in-?office|office|hybrid/.test(s);

/** Maps an English level to an ordinal. -1 = unknown (never eliminates). */
function englishOrdinal(level?: string): number {
  const n = normalize(level ?? '');
  if (!n || n.includes('none')) return 0;
  if (n.includes('basic')) return 1;
  if (n.includes('intermediate')) return 2;
  if (n.includes('advanced')) return 3;
  if (n.includes('fluent') || n.includes('native')) return 4;
  return -1;
}

export function scoreJob(job: JobFacts, fit: CandidateFit, minScore: number): JobScore {
  const tech = normalize(job.requiredTech ?? '');
  const seniority = normalize(job.seniority ?? '');
  const location = normalize(job.location ?? '');
  const mode = normalize(job.workMode ?? '');

  let score = 5;

  for (const skill of fit.coreStack) {
    const s = normalize(skill);
    if (s && tech.includes(s)) score += 1;
  }

  if (seniority.includes('senior') || seniority.includes('lead')) score -= 2;
  if (/junior|fresher|entry|mid/.test(seniority)) score += 1;

  const city = baseCity(fit.city);
  const inCity = !!city && location.includes(city);
  const onsiteOrHybrid = isOnsiteOrHybrid(mode);
  if (inCity) score += 1;
  else if (onsiteOrHybrid) score -= 3;
  if (isRemote(mode)) score += 1;

  score = Math.max(1, Math.min(10, score));

  const dealBreakers: string[] = [];

  // Needs both sides: without an English level on the profile there is no basis to eliminate.
  if (job.requiredEnglish && fit.englishLevel) {
    const required = englishOrdinal(job.requiredEnglish);
    const has = englishOrdinal(fit.englishLevel);
    if (required > 0 && has >= 0 && required > has) {
      dealBreakers.push(`Job requires ${job.requiredEnglish} English, candidate has ${fit.englishLevel}`);
    }
  }

  const acceptsOffice = fit.acceptedWorkModes.some(m => isOnsiteOrHybrid(normalize(m)));
  if (onsiteOrHybrid && !inCity && !acceptsOffice) {
    dealBreakers.push(`${job.workMode ?? 'On-site/hybrid'} job outside ${fit.city}; candidate only accepts: ${fit.acceptedWorkModes.join(', ')}`);
  }

  const apply = !dealBreakers.length && score >= minScore;
  const reason = dealBreakers.length
    ? `SKIP (deal breaker): ${dealBreakers.join('; ')}.`
    : apply
      ? `Score ${score}/10: good enough (minimum ${minScore}).`
      : `Score ${score}/10: below the minimum (${minScore}). Move on to the next job.`;

  return { score, verdict: apply ? 'APPLY' : 'SKIP', reason, dealBreakers };
}

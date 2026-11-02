// Companies and title terms the candidate never wants to apply to (e.g. a former employer).
// A hard rule in code is more reliable than asking the model to remember it.
// Matches whole words only, so "Globo" does not block "Globant".

function normalize(s: string): string {
  return (s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whole-word match that also works for terms with symbols (c++, .net, c#), where \b would fail. */
function containsWord(text: string, term: string): boolean {
  const t = normalize(term);
  if (!t) return false;
  return new RegExp(`(^|[^a-z0-9])${escapeRegex(t)}([^a-z0-9]|$)`).test(normalize(text));
}

export interface BlockResult {
  blocked: boolean;
  reason: string;
}

export function isBlocked(
  company: string,
  title: string,
  blockedCompanies: string[] = [],
  blockedTitleTerms: string[] = [],
): BlockResult {
  for (const c of blockedCompanies) {
    if (containsWord(company, c)) return { blocked: true, reason: `Company "${company}" is on the blocklist (rule: "${c}")` };
  }
  for (const term of blockedTitleTerms) {
    if (containsWord(title, term)) return { blocked: true, reason: `Title "${title}" contains blocked term "${term}"` };
  }
  return { blocked: false, reason: '' };
}

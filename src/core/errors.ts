// Failure classification with exponential backoff; permanent failures are recorded as seen jobs.

/** Never retry: the job or the situation is not going to change. */
export const PERMANENT_FAILURES = new Set([
  'job_expired',          // Job closed or gone
  'captcha',              // CAPTCHA that nobody solved
  'session_expired',      // Logged out, needs a fresh login
  'location_ineligible',  // On-site/hybrid outside the candidate's location rule
  'already_applied',      // Candidate already applied here
  'account_required',     // Needs an account on a separate platform
  'not_a_job',            // Page is not a job posting
  'sso_required',         // Requires Google/Microsoft/etc. SSO
  'site_blocked',         // Site blocked access (ban, IP block)
  'cloudflare',           // Anti-bot challenge
  'portal_blocked',       // Blocked at the portal entrance: abandon the whole portal
  'unsupported_form',     // Form the bot can't fill
  'internal_only',        // Internal candidates only
  'language_mismatch',    // Requires a language the candidate doesn't have
]);

/** Worth retrying: probably temporary. */
export const RETRYABLE_FAILURES = new Set([
  'timeout',
  'network_error',
  'page_not_loaded',
  'server_error',          // HTTP 5xx
  'element_not_found',     // Element vanished (race condition)
  'upload_error',
  'mcp_error',             // Playwright MCP communication error
]);

export const MAX_ATTEMPTS = 3;

export function isPermanentFailure(code: string): boolean {
  return PERMANENT_FAILURES.has(code);
}

export function isRetryableFailure(code: string): boolean {
  return RETRYABLE_FAILURES.has(code);
}

/** Tool retry backoff: 5s, 15s, 45s. */
export function backoffMs(attempt: number): number {
  return 5000 * Math.pow(3, attempt - 1);
}

export type ApiErrorKind = 'rate_limit' | 'network' | 'fatal';

export function classifyApiError(message: string): ApiErrorKind {
  const msg = message.toLowerCase();

  if (msg.includes('429') || msg.includes('rate_limit') || msg.includes('resource_exhausted')) {
    return 'rate_limit';
  }

  const networkHints = [
    'econnrefused', 'econnreset', 'etimedout', 'enotfound', 'fetch failed',
    'network', 'socket hang up', 'overloaded', '529', '503', '502', '504',
  ];
  if (networkHints.some(h => msg.includes(h))) return 'network';

  return 'fatal';
}

/** Rate-limit backoff: 30s, 60s, 120s. */
export function rateLimitBackoffMs(attempt: number): number {
  return 30000 * Math.pow(2, attempt - 1);
}

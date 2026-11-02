import { describe, it, expect } from 'vitest';
import {
  isPermanentFailure,
  isRetryableFailure,
  backoffMs,
  rateLimitBackoffMs,
  classifyApiError,
  MAX_ATTEMPTS,
} from '../src/core/errors';

describe('failure classification', () => {
  it('recognises permanent failures', () => {
    for (const code of ['captcha', 'job_expired', 'cloudflare', 'sso_required']) {
      expect(isPermanentFailure(code)).toBe(true);
    }
  });

  it('recognises retryable failures', () => {
    for (const code of ['timeout', 'network_error', 'server_error', 'mcp_error']) {
      expect(isRetryableFailure(code)).toBe(true);
      expect(isPermanentFailure(code)).toBe(false);
    }
  });

  it('treats an unknown code as neither', () => {
    expect(isPermanentFailure('made_up_code')).toBe(false);
    expect(isRetryableFailure('made_up_code')).toBe(false);
  });
});

describe('backoff', () => {
  it('tool retries wait 5s, 15s, 45s', () => {
    expect([1, 2, 3].map(backoffMs)).toEqual([5000, 15000, 45000]);
  });

  it('rate limits wait 30s, 60s, 120s', () => {
    expect([1, 2, 3].map(rateLimitBackoffMs)).toEqual([30000, 60000, 120000]);
  });

  it('allows 3 attempts', () => {
    expect(MAX_ATTEMPTS).toBe(3);
  });
});

describe('classifyApiError', () => {
  it('spots rate limits', () => {
    expect(classifyApiError('Error 429 Too Many Requests')).toBe('rate_limit');
    expect(classifyApiError('rate_limit_error: slow down')).toBe('rate_limit');
  });

  it('spots network problems and overload', () => {
    expect(classifyApiError('connect ECONNREFUSED 127.0.0.1')).toBe('network');
    expect(classifyApiError('socket hang up')).toBe('network');
    expect(classifyApiError('Service Unavailable 503')).toBe('network');
    expect(classifyApiError('529 overloaded_error')).toBe('network');
  });

  it('treats anything else as fatal', () => {
    expect(classifyApiError('TypeError: cannot read properties of undefined')).toBe('fatal');
  });
});

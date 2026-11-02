import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDatabase, closeDatabase, hasApplied } from '../src/core/database';
import { createToolExecutor, registrableDomain } from '../src/agent/tools';
import type { Profile, AppConfig } from '../src/types';

function fakeProfile(): Profile {
  return {
    name: 'Test User', email: 'a@example.com', phone: '+91 90000 00000',
    linkedin: 'https://linkedin.com/in/a', github: 'https://github.com/a', portfolio: '',
    resumePath: './cv.pdf', title: 'Developer', yearsOfExperience: 3,
    coreStack: ['Python', 'React'], summary: 'Summary.',
    salaryExpectation: 'Negotiable', workModes: ['remote'], city: 'Bengaluru, India',
    availability: 'Immediate', searchKeywords: ['Developer'],
  };
}

function fakeConfig(over: Partial<AppConfig> = {}): AppConfig {
  return {
    anthropicApiKey: 'fake', agentModel: 'claude-sonnet-5-5', scoringModel: 'claude-haiku-5-5', mode: 'agent',
    cdpEndpoint: 'http://localhost:9222', dailyLimit: 10, maxPerRun: 5, delayMinMs: 1, delayMaxMs: 2,
    dryRun: true, minScore: 6, maxCostUsd: 0, dashboardPort: 3000,
    telegramBotToken: '', telegramChatId: '', smtpHost: '', smtpPort: 587, smtpUser: '', smtpPass: '',
    emailRecipient: '', cronEnabled: false, cronTime: '09:00',
    auxProvider: 'anthropic', auxModel: 'claude-haiku-5-5', ollamaUrl: '', openaiApiKey: '', openaiBaseUrl: '',
    ...over,
  };
}

beforeAll(async () => {
  await initDatabase(':memory:');
});
afterAll(() => closeDatabase());

describe('record_application: score gate', () => {
  it('refuses to record a job below the minimum score', async () => {
    const run = createToolExecutor(fakeProfile(), fakeConfig({ minScore: 6 }));
    const reply = await run('record_application', { platform: 'Internshala', job_title: 'Dev', company: 'ACME', url: 'https://x/low', score: 3 });
    expect(reply).toMatch(/SCORE_BELOW_MINIMUM/);
    expect(hasApplied('https://x/low')).toBe(false);
  });

  it('records a job at or above the minimum score', async () => {
    // Live mode: dry-run rows intentionally don't count as "already applied".
    const run = createToolExecutor(fakeProfile(), fakeConfig({ minScore: 6, dryRun: false }));
    const reply = await run('record_application', { platform: 'Internshala', job_title: 'Dev', company: 'ACME', url: 'https://x/ok', score: 8 });
    expect(reply).toMatch(/RECORDED/);
    expect(hasApplied('https://x/ok')).toBe(true);
  });
});

describe('confirm_submit', () => {
  it('blocks the submit in dry-run mode', async () => {
    const run = createToolExecutor(fakeProfile(), fakeConfig({ dryRun: true }));
    const reply = await run('confirm_submit', { job_url: 'https://x/dry', action: 'application' });
    expect(reply).toMatch(/DRY-RUN/);
    expect(reply).not.toMatch(/OK_TO_SUBMIT/);
  });

  it('allows the submit in live mode', async () => {
    const run = createToolExecutor(fakeProfile(), fakeConfig({ dryRun: false }));
    expect(await run('confirm_submit', { job_url: 'https://x/live' })).toMatch(/OK_TO_SUBMIT/);
  });

  it('stops at the per-run limit', async () => {
    const run = createToolExecutor(fakeProfile(), fakeConfig({ dryRun: false, maxPerRun: 2 }));
    expect(await run('confirm_submit', { job_url: 'https://x/1' })).toMatch(/OK_TO_SUBMIT/);
    expect(await run('confirm_submit', { job_url: 'https://x/2' })).toMatch(/OK_TO_SUBMIT/);
    expect(await run('confirm_submit', { job_url: 'https://x/3' })).toMatch(/RUN_LIMIT/);
  });
});

describe('registrableDomain', () => {
  it('groups subdomains under the registrable domain', () => {
    expect(registrableDomain('https://portal.gupy.io/job/123')).toBe('gupy.io');
    expect(registrableDomain('https://www.vagas.com.br/vaga/1')).toBe('vagas.com.br');
    expect(registrableDomain('https://in.indeed.com/x')).toBe('indeed.com');
    expect(registrableDomain('https://internshala.com/jobs')).toBe('internshala.com');
  });

  it('returns an empty string for an invalid URL', () => {
    expect(registrableDomain('not-a-url')).toBe('');
  });

  it('returns the whole host for an IP address', () => {
    expect(registrableDomain('http://192.168.0.1/x')).toBe('192.168.0.1');
  });
});

describe('report_failure: blocked portal', () => {
  it('drops the whole portal and skips later jobs on the same domain', async () => {
    const run = createToolExecutor(fakeProfile(), fakeConfig({ dryRun: true }));
    const first = await run('report_failure', { job_url: 'https://portal.gupy.io/v1', failure_code: 'portal_blocked', description: 'Cloudflare on the listing' });
    const second = await run('report_failure', { job_url: 'https://portal.gupy.io/v2', failure_code: 'timeout', description: 'anything' });
    expect(first).toMatch(/SKIP_PORTAL/);
    expect(second).toMatch(/SKIP_PORTAL/);
  });
});

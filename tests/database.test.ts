import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import initSqlJs from 'sql.js';
import {
  initDatabase,
  closeDatabase,
  recordApplication,
  hasApplied,
  countApplicationsToday,
  appliedToCompanyToday,
  saveCachedAnswer,
  findCachedAnswer,
  normalizeQuestion,
  updateOutcome,
  listApplications,
} from '../src/core/database';

const testDir = path.join(tmpdir(), 'hirehound-test');
const testDb = path.join(testDir, 'data', 'applications.db');

const app = (url: string, overrides = {}) => ({
  platform: 'Internshala', jobTitle: 'Backend Developer', company: 'ACME', url,
  messageSent: 0, status: 'applied' as const, score: 7, ...overrides,
});

describe('database', () => {
  beforeAll(async () => {
    rmSync(testDir, { recursive: true, force: true });
    await initDatabase(testDb);
  });

  afterAll(() => {
    closeDatabase();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('creates the data directory on a fresh clone', () => {
    expect(existsSync(testDb)).toBe(true);
  });

  it('records an application and rejects a duplicate URL', () => {
    expect(recordApplication(app('https://example.com/job/1'))).toBe(true);
    expect(recordApplication(app('https://example.com/job/1'))).toBe(false);
    expect(hasApplied('https://example.com/job/1')).toBe(true);
    expect(countApplicationsToday()).toBeGreaterThanOrEqual(1);
    expect(appliedToCompanyToday('acme')).toBe(true);
  });

  it('does not treat a dry-run row as applied, and lets a real application replace it', () => {
    const url = 'https://example.com/job/dry';
    recordApplication(app(url, { status: 'dry-run', company: 'Dry Co' }));
    expect(hasApplied(url)).toBe(false);
    expect(appliedToCompanyToday('Dry Co')).toBe(false);
    expect(countApplicationsToday(true)).toBeGreaterThan(countApplicationsToday(false));

    expect(recordApplication(app(url, { company: 'Dry Co' }))).toBe(true);
    expect(hasApplied(url)).toBe(true);
  });

  it('saves and finds a cached answer', () => {
    saveCachedAnswer('What is your expected salary?', 'textbox', 'Negotiable');
    expect(findCachedAnswer('What is your expected salary?', 'textbox')?.answer).toBe('Negotiable');
  });

  it('normalizes questions', () => {
    expect(normalizeQuestion('  What   is your "expected" salary?  ')).toBe('what is your expected salary?');
  });

  it('updates the outcome of an application', () => {
    const url = 'https://example.com/job/outcome';
    recordApplication(app(url, { company: 'Beta' }));
    const id = listApplications(50).find(a => a.url === url)!.id as number;

    expect(updateOutcome(id, 'interview')).toBe(true);
    expect(listApplications(50).find(a => a.id === id)?.outcome).toBe('interview');
    expect(updateOutcome(id, 'not_an_outcome')).toBe(false);
    expect(updateOutcome(999999, 'interview')).toBe(false);
  });
});

describe('database: migration from the old schema', () => {
  const legacyDir = path.join(tmpdir(), 'hirehound-legacy-test');
  const legacyDb = path.join(legacyDir, 'old.db');

  afterAll(() => {
    closeDatabase();
    rmSync(legacyDir, { recursive: true, force: true });
  });

  it('moves rows from the Portuguese tables into the new ones', async () => {
    rmSync(legacyDir, { recursive: true, force: true });
    mkdirSync(legacyDir, { recursive: true });
    const SQL = await initSqlJs();
    const old = new SQL.Database();
    old.run(`CREATE TABLE candidaturas (id INTEGER PRIMARY KEY AUTOINCREMENT, plataforma TEXT, titulo_vaga TEXT, empresa TEXT,
      url TEXT UNIQUE, data_aplicacao TEXT DEFAULT (datetime('now','localtime')), mensagem_enviada INTEGER DEFAULT 0,
      status TEXT DEFAULT 'aplicado', score INTEGER DEFAULT 0, screenshot_path TEXT, resultado TEXT DEFAULT 'aguardando')`);
    old.run(`INSERT INTO candidaturas (plataforma, titulo_vaga, empresa, url, status, score, resultado)
      VALUES ('Internshala', 'AI Engineer', 'Old Co', 'https://example.com/old', 'aplicado', 8, 'entrevista')`);
    old.run(`CREATE TABLE vagas_vistas (id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT UNIQUE, titulo_vaga TEXT, empresa TEXT,
      plataforma TEXT, score INTEGER, motivo_pulo TEXT, data_vista TEXT DEFAULT (datetime('now','localtime')))`);
    writeFileSync(legacyDb, Buffer.from(old.export()));
    old.close();

    await initDatabase(legacyDb);

    const migrated = listApplications(10).find(a => a.url === 'https://example.com/old');
    expect(migrated?.company).toBe('Old Co');
    expect(migrated?.status).toBe('applied');
    expect(migrated?.outcome).toBe('interview');
    expect(hasApplied('https://example.com/old')).toBe(true);
  });
});

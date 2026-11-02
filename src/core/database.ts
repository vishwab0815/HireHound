import initSqlJs from 'sql.js';
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { log } from './logger.js';
import type { Application } from '../types.js';

type SqlJsDatabase = import('sql.js').Database;
type SqlJsStatic = import('sql.js').SqlJsStatic;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', '..', 'data');
const DEFAULT_DB_PATH = path.join(DATA_DIR, 'applications.db');
/** Database file used by older versions (Portuguese schema). Migrated on first start. */
const LEGACY_DB_PATH = path.join(DATA_DIR, 'candidaturas.db');

let SQL: SqlJsStatic;
let db: SqlJsDatabase;
let dbPath = DEFAULT_DB_PATH;
let lastSyncMs = 0;
let writing = false;

// ========== FILE SYNC ==========

// sql.js keeps the whole database in memory. Another process (e.g. `npm run result`)
// may have saved a newer file; pick it up before reading or writing so we never overwrite it.
function reloadIfChanged(): void {
  if (writing || dbPath === ':memory:' || !existsSync(dbPath)) return;
  const mtime = statSync(dbPath).mtimeMs;
  if (mtime <= lastSyncMs) return;
  db.close();
  db = new SQL.Database(readFileSync(dbPath));
  lastSyncMs = mtime;
}

// Write to a temp file and rename, so a crash mid-write can't corrupt the database.
// Throws on failure so callers can report it instead of claiming success.
function saveToDisk(): void {
  if (dbPath === ':memory:') return;
  const tmp = `${dbPath}.tmp`;
  writeFileSync(tmp, Buffer.from(db.export()));
  renameSync(tmp, dbPath);
  lastSyncMs = statSync(dbPath).mtimeMs;
}

function write<T>(fn: () => T): T {
  reloadIfChanged();
  writing = true;
  try {
    const result = fn();
    saveToDisk();
    return result;
  } finally {
    writing = false;
  }
}

function queryOne(sql: string, params: unknown[] = []): Record<string, unknown> | undefined {
  reloadIfChanged();
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const row = stmt.step() ? stmt.getAsObject() : undefined;
  stmt.free();
  return row;
}

function queryAll(sql: string, params: unknown[] = []): Record<string, unknown>[] {
  reloadIfChanged();
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows: Record<string, unknown>[] = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function exec(sql: string, params: unknown[] = []): number {
  db.run(sql, params);
  return (queryOne('SELECT changes() AS c') as { c: number } | undefined)?.c ?? 0;
}

function execAndSave(sql: string, params: unknown[] = []): number {
  return write(() => exec(sql, params));
}

function tableExists(name: string): boolean {
  return !!queryOne("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [name]);
}

// ========== SCHEMA ==========

function createSchema(): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS applications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      job_title TEXT NOT NULL,
      company TEXT NOT NULL,
      url TEXT UNIQUE NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      message_sent INTEGER DEFAULT 0,
      status TEXT DEFAULT 'applied',
      score INTEGER DEFAULT 0,
      screenshot_path TEXT,
      outcome TEXT DEFAULT 'waiting'
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS seen_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT UNIQUE NOT NULL,
      job_title TEXT,
      company TEXT,
      platform TEXT,
      score INTEGER DEFAULT 0,
      skip_reason TEXT,
      seen_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS answer_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      field_type TEXT NOT NULL,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      times_used INTEGER DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      last_used_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_answer_cache_question ON answer_cache(question)');
  db.run(`
    CREATE TABLE IF NOT EXISTS recruiter_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recruiter_name TEXT NOT NULL,
      recruiter_title TEXT,
      company TEXT NOT NULL,
      profile_url TEXT UNIQUE NOT NULL,
      job_url TEXT,
      job_title TEXT,
      message TEXT NOT NULL,
      platform TEXT DEFAULT 'linkedin',
      job_score INTEGER DEFAULT 0,
      sent_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ran_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      applications INTEGER DEFAULT 0,
      sites TEXT,
      errors TEXT
    )
  `);
}

/** Copies data from the old Portuguese tables into the new schema, then drops them. */
function migrateLegacyTables(): void {
  if (!tableExists('candidaturas')) return;
  log('INFO', 'Database: migrating data from the old schema...');

  for (const col of ['score INTEGER DEFAULT 0', 'screenshot_path TEXT', "resultado TEXT DEFAULT 'aguardando'"]) {
    try { db.run(`ALTER TABLE candidaturas ADD COLUMN ${col}`); } catch { /* column already there */ }
  }

  db.run('BEGIN');
  try {
    db.run(`
      INSERT OR IGNORE INTO applications
        (id, platform, job_title, company, url, applied_at, message_sent, status, score, screenshot_path, outcome)
      SELECT id, plataforma, titulo_vaga, empresa, url, data_aplicacao, mensagem_enviada,
        CASE status WHEN 'aplicado' THEN 'applied' ELSE status END,
        score, screenshot_path,
        CASE resultado
          WHEN 'respondido' THEN 'replied' WHEN 'entrevista' THEN 'interview' WHEN 'oferta' THEN 'offer'
          WHEN 'rejeitado' THEN 'rejected' WHEN 'sem_resposta' THEN 'no_response' ELSE 'waiting'
        END
      FROM candidaturas
    `);
    if (tableExists('vagas_vistas')) {
      db.run(`
        INSERT OR IGNORE INTO seen_jobs (url, job_title, company, platform, score, skip_reason, seen_at)
        SELECT url, titulo_vaga, empresa, plataforma, score, motivo_pulo, data_vista FROM vagas_vistas
      `);
    }
    if (tableExists('cache_respostas')) {
      db.run(`
        INSERT INTO answer_cache (field_type, question, answer, times_used, created_at, last_used_at)
        SELECT tipo_campo, pergunta_sanitizada, resposta, vezes_usada, data_criacao, data_ultimo_uso FROM cache_respostas
      `);
    }
    if (tableExists('mensagens_recrutadores')) {
      db.run(`
        INSERT OR IGNORE INTO recruiter_messages
          (recruiter_name, recruiter_title, company, profile_url, job_url, job_title, message, platform, job_score, sent_at)
        SELECT nome_recrutador, cargo_recrutador, empresa, url_perfil, url_vaga, titulo_vaga, mensagem, plataforma, score_vaga, data_envio
        FROM mensagens_recrutadores
      `);
    }
    if (tableExists('log_execucoes')) {
      db.run(`
        INSERT INTO runs (ran_at, applications, sites, errors)
        SELECT data_execucao, total_candidaturas, sites_processados, erros FROM log_execucoes
      `);
    }
    for (const t of ['candidaturas', 'vagas_vistas', 'cache_respostas', 'mensagens_recrutadores', 'log_execucoes']) {
      db.run(`DROP TABLE IF EXISTS ${t}`);
    }
    db.run('COMMIT');
  } catch (error) {
    db.run('ROLLBACK');
    throw error;
  }
}

export async function initDatabase(customPath: string = DEFAULT_DB_PATH): Promise<SqlJsDatabase> {
  dbPath = customPath;
  const inMemory = dbPath === ':memory:';
  if (!inMemory) mkdirSync(path.dirname(dbPath), { recursive: true });

  SQL = await initSqlJs();

  // First start after upgrading: load the old file. It is left on disk untouched as a backup.
  const source = existsSync(dbPath) ? dbPath
    : dbPath === DEFAULT_DB_PATH && existsSync(LEGACY_DB_PATH) ? LEGACY_DB_PATH
    : null;
  db = !inMemory && source ? new SQL.Database(readFileSync(source)) : new SQL.Database();
  lastSyncMs = source === dbPath ? statSync(dbPath).mtimeMs : 0;

  // Treat setup as one write, so the reload-on-change check can't swap the file back in
  // halfway through and throw away the tables just created.
  writing = true;
  try {
    createSchema();
    migrateLegacyTables();
    saveToDisk();
  } finally {
    writing = false;
  }
  return db;
}

export function closeDatabase(): void {
  if (!db) return;
  try {
    saveToDisk();
  } catch (error) {
    log('ERROR', `Could not save the database: ${error instanceof Error ? error.message : String(error)}`);
  }
  db.close();
}

// ========== APPLICATIONS ==========

const APPLICATION_COLUMNS = `
  id, platform, job_title AS jobTitle, company, url, applied_at AS appliedAt, message_sent AS messageSent,
  status, score, screenshot_path AS screenshotPath, outcome`;

/** True if a real (non dry-run) application exists for this URL. */
export function hasApplied(url: string): boolean {
  return !!queryOne("SELECT id FROM applications WHERE url = ? AND status != 'dry-run'", [url]);
}

export function recordApplication(app: Omit<Application, 'id' | 'appliedAt'>): boolean {
  try {
    const changes = write(() => {
      // A real application replaces an earlier dry-run row for the same job.
      if (app.status !== 'dry-run') {
        exec("DELETE FROM applications WHERE url = ? AND status = 'dry-run'", [app.url]);
      }
      return exec(`
        INSERT OR IGNORE INTO applications (platform, job_title, company, url, message_sent, status, score, screenshot_path)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [app.platform, app.jobTitle, app.company, app.url, app.messageSent, app.status, app.score ?? 0, app.screenshotPath ?? null]);
    });
    return changes > 0;
  } catch (error) {
    log('ERROR', `recordApplication failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

export function updateScreenshot(url: string, screenshotPath: string): void {
  execAndSave('UPDATE applications SET screenshot_path = ? WHERE url = ?', [screenshotPath, url]);
}

export const OUTCOMES = ['waiting', 'replied', 'interview', 'offer', 'rejected', 'no_response'] as const;
export type Outcome = (typeof OUTCOMES)[number];

export function updateOutcome(id: number, outcome: string): boolean {
  if (!OUTCOMES.includes(outcome as Outcome)) return false;
  try {
    return execAndSave('UPDATE applications SET outcome = ? WHERE id = ?', [outcome, id]) > 0;
  } catch (error) {
    log('ERROR', `updateOutcome failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

export function countApplicationsToday(includeDryRun = false): number {
  const row = queryOne(`
    SELECT COUNT(*) AS total FROM applications
    WHERE date(applied_at) = date('now', 'localtime') ${includeDryRun ? '' : "AND status != 'dry-run'"}
  `) as { total: number };
  return row.total;
}

export function appliedToCompanyToday(company: string): boolean {
  return !!queryOne(`
    SELECT id FROM applications
    WHERE lower(trim(company)) = lower(trim(?)) AND status != 'dry-run'
      AND date(applied_at) = date('now', 'localtime')
  `, [company]);
}

export function listApplications(limit = 50): Application[] {
  return queryAll(`SELECT ${APPLICATION_COLUMNS} FROM applications ORDER BY applied_at DESC, id DESC LIMIT ?`, [limit]) as unknown as Application[];
}

export function getStats() {
  const today = queryOne(`
    SELECT COUNT(*) AS total, AVG(score) AS avgScore
    FROM applications WHERE date(applied_at) = date('now', 'localtime')
  `) as { total: number; avgScore: number | null };
  const total = queryOne('SELECT COUNT(*) AS total FROM applications') as { total: number };
  const byPlatform = queryAll(`
    SELECT platform, COUNT(*) AS total, AVG(score) AS avgScore
    FROM applications GROUP BY platform ORDER BY total DESC
  `) as Array<{ platform: string; total: number; avgScore: number | null }>;
  const byStatus = queryAll('SELECT status, COUNT(*) AS total FROM applications GROUP BY status') as Array<{ status: string; total: number }>;
  const byOutcome = queryAll(`
    SELECT outcome, COUNT(*) AS total FROM applications WHERE status != 'dry-run' GROUP BY outcome
  `) as Array<{ outcome: string; total: number }>;
  return { today, total: total.total, byPlatform, byStatus, byOutcome };
}

export function recordRun(applications: number, sites: string[], errors: string[]): void {
  try {
    execAndSave('INSERT INTO runs (applications, sites, errors) VALUES (?, ?, ?)', [applications, JSON.stringify(sites), JSON.stringify(errors)]);
  } catch (error) {
    log('ERROR', `recordRun failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ========== SEEN JOBS ==========

export function recordSeenJob(job: {
  url: string;
  jobTitle?: string;
  company?: string;
  platform?: string;
  score?: number;
  skipReason?: string;
}): boolean {
  try {
    execAndSave(`
      INSERT OR IGNORE INTO seen_jobs (url, job_title, company, platform, score, skip_reason)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [job.url, job.jobTitle ?? null, job.company ?? null, job.platform ?? null, job.score ?? 0, job.skipReason ?? null]);
    return true;
  } catch (error) {
    log('ERROR', `recordSeenJob failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

export function wasJobSeen(url: string): boolean {
  return !!queryOne('SELECT id FROM seen_jobs WHERE url = ?', [url]);
}

// ========== RECRUITER MESSAGES ==========

export function wasRecruiterContacted(profileUrl: string): boolean {
  return !!queryOne('SELECT id FROM recruiter_messages WHERE profile_url = ?', [profileUrl]);
}

export function recordRecruiterMessage(msg: {
  recruiterName: string;
  recruiterTitle?: string;
  company: string;
  profileUrl: string;
  jobUrl?: string;
  jobTitle?: string;
  message: string;
  platform?: string;
  jobScore?: number;
}): boolean {
  try {
    return execAndSave(`
      INSERT OR IGNORE INTO recruiter_messages
        (recruiter_name, recruiter_title, company, profile_url, job_url, job_title, message, platform, job_score)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      msg.recruiterName, msg.recruiterTitle ?? null, msg.company, msg.profileUrl, msg.jobUrl ?? null,
      msg.jobTitle ?? null, msg.message, msg.platform ?? 'linkedin', msg.jobScore ?? 0,
    ]) > 0;
  } catch (error) {
    log('ERROR', `recordRecruiterMessage failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

export function countMessagesToday(): number {
  const row = queryOne(`
    SELECT COUNT(*) AS total FROM recruiter_messages WHERE date(sent_at) = date('now', 'localtime')
  `) as { total: number };
  return row.total;
}

// ========== ANSWER CACHE ==========

export interface CachedAnswer {
  id: number;
  fieldType: string;
  question: string;
  answer: string;
  timesUsed: number;
}

const CACHE_COLUMNS = 'id, field_type AS fieldType, question, answer, times_used AS timesUsed';

export function normalizeQuestion(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/['"\\]/g, '')
    .replace(/[\x00-\x1F\x7F]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/,\s*$/, '');
}

function bumpUsage(id: number): void {
  execAndSave(`UPDATE answer_cache SET times_used = times_used + 1, last_used_at = datetime('now', 'localtime') WHERE id = ?`, [id]);
}

export function findCachedAnswer(question: string, fieldType: string): CachedAnswer | null {
  const normalized = normalizeQuestion(question);

  const exact = queryOne(
    `SELECT ${CACHE_COLUMNS} FROM answer_cache WHERE question = ? AND field_type = ?`,
    [normalized, fieldType],
  ) as CachedAnswer | undefined;
  if (exact) {
    bumpUsage(exact.id);
    return exact;
  }

  // Dropdowns and radios have short, stable labels, so a substring match is safe enough.
  if (fieldType === 'dropdown' || fieldType === 'radio') {
    const all = queryAll(`SELECT ${CACHE_COLUMNS} FROM answer_cache WHERE field_type = ?`, [fieldType]) as unknown as CachedAnswer[];
    const hit = all.find(item => normalized.includes(item.question) || item.question.includes(normalized));
    if (hit) {
      bumpUsage(hit.id);
      return hit;
    }
  }
  return null;
}

export function findCacheCandidates(question: string, limit = 10): CachedAnswer[] {
  const words = normalizeQuestion(question).split(' ').filter(w => w.length > 3);
  if (!words.length) return [];
  const conditions = words.map(() => 'question LIKE ?').join(' OR ');
  return queryAll(
    `SELECT ${CACHE_COLUMNS} FROM answer_cache WHERE ${conditions} ORDER BY times_used DESC LIMIT ?`,
    [...words.map(w => `%${w}%`), limit],
  ) as unknown as CachedAnswer[];
}

export function saveCachedAnswer(question: string, fieldType: string, answer: string): boolean {
  const normalized = normalizeQuestion(question);
  if (queryOne('SELECT id FROM answer_cache WHERE question = ? AND field_type = ?', [normalized, fieldType])) return false;
  try {
    execAndSave('INSERT INTO answer_cache (field_type, question, answer) VALUES (?, ?, ?)', [fieldType, normalized, answer]);
    return true;
  } catch (error) {
    log('ERROR', `saveCachedAnswer failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

export function countCachedAnswers(): number {
  return (queryOne('SELECT COUNT(*) AS total FROM answer_cache') as { total: number }).total;
}

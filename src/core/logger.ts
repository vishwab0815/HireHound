import { appendFileSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = path.resolve(__dirname, '..', '..', 'logs');

export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'TOOL' | 'AGENT' | 'FAIL' | 'SCRIPT';

let logFilePath = '';

export function initLogger(): void {
  mkdirSync(LOGS_DIR, { recursive: true });
  const now = new Date();
  const stamp = `${now.toISOString().slice(0, 10)}_${now.toTimeString().slice(0, 8).replace(/:/g, '-')}`;
  logFilePath = path.join(LOGS_DIR, `run_${stamp}.log`);
  log('INFO', 'Logger ready');
}

export function log(level: LogLevel, message: string): void {
  const line = `[${new Date().toISOString()}] [${level}] ${message}\n`;

  if (level === 'ERROR' || level === 'FAIL') process.stderr.write(line);
  else process.stdout.write(line);

  if (logFilePath) {
    try {
      appendFileSync(logFilePath, line);
    } catch {
      // A failing log write should never break a run.
    }
  }
}

export function getLogPath(): string {
  return logFilePath;
}

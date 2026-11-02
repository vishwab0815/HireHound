import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { AppConfig, BotMode } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const CONFIG_DIR = path.resolve(__dirname, '..', 'config');

const LEGACY_NAMES: Record<string, string> = {
  'profile.json': 'perfil.json',
  'answers.json': 'respostas.json',
  'resumes.json': 'curriculos.json',
};

export function loadJsonConfig<T>(file: string): T {
  const fullPath = path.join(CONFIG_DIR, file);
  if (!existsSync(fullPath)) {
    const legacy = LEGACY_NAMES[file];
    if (legacy && existsSync(path.join(CONFIG_DIR, legacy))) {
      console.error(`\nERROR: config/${file} not found, but config/${legacy} (old format) exists.`);
      console.error('Convert it with: npm run migrate-config\n');
    } else {
      console.error(`\nERROR: config/${file} not found. Copy config/${file.replace('.json', '.example.json')} and fill it in.\n`);
    }
    process.exit(1);
  }
  try {
    return JSON.parse(readFileSync(fullPath, 'utf-8')) as T;
  } catch (error) {
    console.error(`\nERROR: config/${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

const int = (value: string | undefined, fallback: number) => {
  const n = parseInt(value ?? '', 10);
  return Number.isNaN(n) ? fallback : n;
};

export function loadEnv(): AppConfig {
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicApiKey) {
    console.error('\nERROR: ANTHROPIC_API_KEY is not set.');
    console.error('Copy .env.example to .env and add your Anthropic API key.\n');
    process.exit(1);
  }

  const auxProvider = process.env.LLM_AUX_PROVIDER || 'anthropic';
  const auxModel = process.env.LLM_AUX_MODEL || 'claude-haiku-5-5';
  const mode = (process.env.BOT_MODE || 'scripted') as BotMode;

  return {
    anthropicApiKey,
    agentModel: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
    // Scripted-mode scoring always goes through the Anthropic client, so it needs an Anthropic model
    // even when the helper LLM is Ollama or an OpenAI-compatible API.
    scoringModel: process.env.SCORING_MODEL || (auxProvider === 'anthropic' ? auxModel : 'claude-haiku-5-5'),
    mode: mode === 'agent' ? 'agent' : 'scripted',
    cdpEndpoint: process.env.CDP_ENDPOINT || 'http://localhost:9222',
    dailyLimit: int(process.env.DAILY_LIMIT, 10),
    maxPerRun: int(process.env.MAX_PER_RUN, 3),
    delayMinMs: int(process.env.DELAY_MIN, 2000),
    delayMaxMs: int(process.env.DELAY_MAX, 5000),
    dryRun: process.env.DRY_RUN === 'true',
    minScore: int(process.env.MIN_SCORE, 6),
    maxCostUsd: parseFloat(process.env.MAX_COST_USD || '0') || 0,
    dashboardPort: int(process.env.DASHBOARD_PORT, 3000),
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
    telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
    smtpHost: process.env.SMTP_HOST || '',
    smtpPort: int(process.env.SMTP_PORT, 587),
    smtpUser: process.env.SMTP_USER || '',
    smtpPass: process.env.SMTP_PASS || '',
    emailRecipient: process.env.EMAIL_RECIPIENT || '',
    cronEnabled: process.env.CRON_ENABLED === 'true',
    cronTime: process.env.CRON_TIME || '09:00',
    auxProvider,
    auxModel,
    ollamaUrl: process.env.OLLAMA_URL || 'http://localhost:11434',
    openaiApiKey: process.env.OPENAI_API_KEY || '',
    openaiBaseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  };
}

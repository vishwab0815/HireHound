export interface Experience {
  company: string;
  role: string;
  period: string;
  description: string;
}

/** Ordinal English proficiency scale used by the deal-breaker checks. */
export type EnglishLevel = 'none' | 'basic' | 'intermediate' | 'advanced' | 'fluent';

export type WorkMode = 'remote' | 'hybrid' | 'onsite';

export interface Profile {
  name: string;
  email: string;
  phone: string;
  linkedin: string;
  github: string;
  portfolio: string;
  resumePath: string;
  title: string;
  yearsOfExperience: number;
  coreStack: string[];
  summary: string;
  salaryExpectation: string;
  workModes: WorkMode[];
  city: string;
  availability: string;
  searchKeywords: string[];
  experience?: Experience[];
  databases?: string[];
  methodologies?: string[];
  /** Free-form extras such as education, languages, certifications, highlights. */
  extras?: Record<string, string>;
  locationRule?: string;
  englishLevel?: EnglishLevel;
  blockedCompanies?: string[];
  blockedTitleTerms?: string[];
}

/** Prepared answers to common form questions. Keys starting with "_" are notes. */
export type Answers = Record<string, string | Record<string, string>>;

export interface Site {
  name: string;
  searchUrls: string[];
  type: 'job_board' | 'linkedin' | 'company_site';
  instructions: string;
  enabled: boolean;
}

export interface SitesConfig {
  sites: Site[];
}

export interface Application {
  id?: number;
  platform: string;
  jobTitle: string;
  company: string;
  url: string;
  appliedAt: string;
  messageSent: number;
  status: 'applied' | 'dry-run';
  score?: number;
  screenshotPath?: string;
  outcome?: string;
}

export type BotMode = 'scripted' | 'agent';

export interface AppConfig {
  anthropicApiKey: string;
  agentModel: string;
  scoringModel: string;
  mode: BotMode;
  cdpEndpoint: string;
  dailyLimit: number;
  maxPerRun: number;
  delayMinMs: number;
  delayMaxMs: number;
  dryRun: boolean;
  minScore: number;
  /** Stop the run once spend passes this (0 = no cap). */
  maxCostUsd: number;
  dashboardPort: number;
  telegramBotToken: string;
  telegramChatId: string;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPass: string;
  emailRecipient: string;
  cronEnabled: boolean;
  cronTime: string;
  auxProvider: string;
  auxModel: string;
  ollamaUrl: string;
  openaiApiKey: string;
  openaiBaseUrl: string;
}

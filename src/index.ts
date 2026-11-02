import 'dotenv/config';
import { loadEnv, loadJsonConfig } from './config.js';
import { initLogger, log } from './core/logger.js';
import {
  initDatabase, closeDatabase, recordRun, countApplicationsToday, listApplications, getStats,
} from './core/database.js';
import { startScheduler, stopScheduler } from './core/scheduler.js';
import { printTokenSummary, getTotalCost, getTotalTokens, getCallCount, resetTracker } from './core/token-tracker.js';
import { configureHelperLlm } from './llm/helper-llm.js';
import { connectPlaywrightMcp, disconnectMcp } from './agent/mcp-client.js';
import { runAgent } from './agent/agent.js';
import { runInternshala, isInternshalaSite } from './scripted/internshala.js';
import { configureScriptedLlm } from './scripted/llm.js';
import { startDashboard, stopDashboard } from './dashboard/server.js';
import { configureTelegram, notifySummary, notifyError } from './notify/telegram.js';
import { configureEmail, sendEmailReport, buildReportHtml } from './notify/email.js';
import type { AppConfig, Answers, Profile, SitesConfig } from './types.js';

async function runOnce(config: AppConfig): Promise<void> {
  const profile = loadJsonConfig<Profile>('profile.json');
  log('INFO', `Profile: ${profile.name} (${profile.title})`);

  const sites = loadJsonConfig<SitesConfig>('sites.json');
  const enabledSites = sites.sites.filter(s => s.enabled);
  log('INFO', `Sites: ${enabledSites.length} enabled of ${sites.sites.length}`);

  await initDatabase();
  // In dry-run mode count dry-run rows too, so the summary shows what the run did.
  const countBefore = countApplicationsToday(config.dryRun);
  log('INFO', `Applications today: ${countBefore}/${config.dailyLimit}`);

  if (!config.dryRun && countBefore >= config.dailyLimit) {
    log('WARN', 'Daily limit already reached. Try again tomorrow.');
    closeDatabase();
    return;
  }

  startDashboard(config.dashboardPort);

  const scriptedSites = config.mode === 'scripted' ? enabledSites.filter(isInternshalaSite) : [];
  const agentSites = enabledSites.filter(s => !scriptedSites.includes(s));
  log('INFO', `Mode: ${config.mode} (scripted: ${scriptedSites.map(s => s.name).join(', ') || '-'}; agent: ${agentSites.map(s => s.name).join(', ') || '-'})`);

  const errors: string[] = [];
  let report = '';

  try {
    if (scriptedSites.length) {
      configureScriptedLlm(config.anthropicApiKey);
      const answers = loadJsonConfig<Answers>('answers.json');
      for (const site of scriptedSites) {
        report += `[${site.name}]\n${await runInternshala(profile, answers, site, config)}\n`;
      }
    }

    if (agentSites.length) {
      let mcp;
      try {
        mcp = await connectPlaywrightMcp(config.cdpEndpoint);
      } catch (error) {
        log('ERROR', `Could not connect to Chrome at ${config.cdpEndpoint}. Start Chrome with --remote-debugging-port.`);
        await notifyError('Could not connect to Chrome. Is remote debugging on?');
        throw error;
      }
      report += await runAgent(mcp, profile, { sites: agentSites }, config);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    errors.push(msg);
    log('ERROR', `Run failed: ${msg}`);
    await notifyError(msg);
  }

  const countAfter = countApplicationsToday(config.dryRun);
  const newApplications = countAfter - countBefore;
  recordRun(newApplications, enabledSites.map(s => s.name), errors);

  log('INFO', '='.repeat(60));
  log('INFO', config.dryRun ? '  RUN SUMMARY (DRY-RUN)' : '  RUN SUMMARY');
  log('INFO', '='.repeat(60));
  log('INFO', `  Mode:             ${config.dryRun ? 'dry-run (nothing submitted)' : 'live'}`);
  log('INFO', `  New applications: ${newApplications}`);
  log('INFO', `  Today:            ${countAfter}/${config.dailyLimit}`);
  log('INFO', `  Sites:            ${enabledSites.map(s => s.name).join(', ')}`);
  log('INFO', `  Errors:           ${errors.length ? errors.join('; ') : 'none'}`);
  log('INFO', `  Cost:             $${getTotalCost().toFixed(4)} (${getTotalTokens().toLocaleString('en-US')} tokens, ${getCallCount()} calls)`);
  log('INFO', `  Dashboard:        http://localhost:${config.dashboardPort}`);
  printTokenSummary();
  if (report) log('INFO', `Report:\n${report}`);

  await notifySummary(newApplications, errors.length, config.dryRun);

  const recent = newApplications > 0 ? listApplications(newApplications) : [];
  await sendEmailReport(
    `HireHound: ${newApplications} application(s)${config.dryRun ? ' (dry-run)' : ''}`,
    buildReportHtml({
      total: newApplications,
      companies: recent.map(a => `${a.company} - ${a.jobTitle} (score ${a.score ?? '-'})`),
      errors,
      dryRun: config.dryRun,
      avgScore: getStats().today.avgScore ?? 0,
    }),
  );

  await disconnectMcp();
  closeDatabase();
  log('INFO', 'Done.');
}

async function main(): Promise<void> {
  initLogger();
  log('INFO', '='.repeat(60));
  log('INFO', '  HIREHOUND');
  log('INFO', '='.repeat(60));

  const config = loadEnv();
  log('INFO', `Model: ${config.agentModel} | scoring: ${config.scoringModel} | CDP: ${config.cdpEndpoint}`);
  log('INFO', `Daily limit: ${config.dailyLimit} | per run: ${config.maxPerRun} | min score: ${config.minScore}/10`);
  if (config.dryRun) log('WARN', '*** DRY-RUN: forms are filled but nothing is submitted ***');

  configureTelegram(config.telegramBotToken, config.telegramChatId);
  configureEmail(config.smtpHost, config.smtpPort, config.smtpUser, config.smtpPass, config.emailRecipient);
  configureHelperLlm({
    provider: config.auxProvider,
    model: config.auxModel,
    anthropicApiKey: config.anthropicApiKey,
    ollamaUrl: config.ollamaUrl,
    openaiApiKey: config.openaiApiKey,
    openaiBaseUrl: config.openaiBaseUrl,
  });

  if (!config.cronEnabled) {
    await runOnce(config);
    stopDashboard();
    return;
  }

  log('INFO', `Scheduled mode: runs daily at ${config.cronTime}. Press Ctrl+C to stop.`);
  startScheduler(config.cronTime, () => {
    resetTracker();
    return runOnce(config);
  });
  process.on('SIGINT', () => {
    log('INFO', 'Stopping...');
    stopScheduler();
    stopDashboard();
    closeDatabase();
    process.exit(0);
  });
}

main().catch((error) => {
  log('ERROR', `Unexpected error: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  closeDatabase();
  process.exitCode = 1;
});

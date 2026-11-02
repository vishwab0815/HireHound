import Anthropic from '@anthropic-ai/sdk';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { agentToolDeclarations, createToolExecutor } from './tools.js';
import { pruneHistory } from './history.js';
import { log } from '../core/logger.js';
import { classifyApiError, rateLimitBackoffMs, MAX_ATTEMPTS } from '../core/errors.js';
import { recordTokenUsage, usageFromAnthropic, getTotalCost } from '../core/token-tracker.js';
import { profileForSystemPrompt } from '../llm/anonymize.js';
import type { AppConfig, Profile, SitesConfig } from '../types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAX_ITERATIONS = 100;
// Prune in big chunks so the history stays append-only (and therefore cacheable) between prunes.
const MAX_HISTORY = 40;
const HISTORY_AFTER_PRUNE = 20;
const OLD_TOOL_RESULT_CHARS = 2000;
const MAX_TOOL_RESULT_CHARS = 20000;
const RECOVERY_PATH = path.resolve(__dirname, '..', '..', 'data', 'recovery.json');

type Message = Anthropic.Messages.MessageParam;

function buildSystemPrompt(profile: Profile, sites: SitesConfig, config: AppConfig): string {
  const { dailyLimit, dryRun, maxPerRun } = config;
  return `You are a job application agent. You control the user's real Chrome window (already logged in to the job sites) through browser tools.
${dryRun ? '\n** DRY-RUN MODE: do everything normally but do NOT submit. confirm_submit will block the submit. Record the job with record_application (it is saved as dry-run). **\n' : ''}
## Workflow
For each site below, open its search URLs and take a snapshot. Then for each job:
1. check_job_seen + check_already_applied: skip if either says so.
2. count_applications_today: stop once the daily limit (${dailyLimit}) is reached.
3. Open the job and read the description.
4. score_job: SKIP means record_seen_job and move on; APPLY means continue.
5. get_candidate_profile for contact data, get_prepared_answers for common questions.
6. Fill the form (browser_fill_form / browser_type), using wait between actions.
7. Cover letter field: generate_cover_letter. Resume upload: choose_resume.
8. Call confirm_submit right BEFORE the final submit click. If it blocks, do NOT click.
9. After submitting, make sure the page shows a success / "applied" message, then save_screenshot and record_application.
10. Go through pagination (at most 5 pages per site), then the next site.

## Keep going
The target for this run is ${maxPerRun} submitted applications. After each one, go straight back to the job list. Only write the final summary when ${maxPerRun} are submitted, confirm_submit reports the run limit, the daily limit is reached, or every search URL and page has been checked.

## Rules
- Older messages are dropped as the run goes on, so you may not see earlier steps (including earlier confirm_submit calls). Before each new job, write one line: applications so far this run (company + title) and which search URL/page you are on. Trust check_already_applied and count_applications_today over your memory.
- Everything you write goes to real recruiters under the candidate's name: English only, real data only, nothing invented, a unique answer for every form, and it should sound like a person wrote it.
- Batch independent checks in one turn (e.g. check_job_seen + check_already_applied together).
- Keep browser_evaluate calls small; prefer browser_snapshot over dumping the whole page.

## Candidate (call get_candidate_profile for contact details)
${JSON.stringify(profileForSystemPrompt(profile), null, 2)}

## Sites
${JSON.stringify(sites.sites.filter(s => s.enabled).map(s => ({ name: s.name, searchUrls: s.searchUrls, instructions: s.instructions })), null, 2)}

## When finished
Summarise: how many applications, which companies, and any errors.`;
}

// Drops thinking blocks and empty text blocks (the API rejects empty text in history).
function cleanContent(content: Anthropic.Messages.ContentBlock[]): Anthropic.Messages.ContentBlock[] {
  return content.filter(b => b.type !== 'thinking' && !(b.type === 'text' && !b.text.trim()));
}

/** Shortens big tool outputs (page snapshots) in all but the last few messages. */
function trimOldToolResults(history: Message[]): Message[] {
  return history.map((msg, i) => {
    if (i >= history.length - 4 || msg.role !== 'user' || !Array.isArray(msg.content)) return msg;
    const content = msg.content.map(b => {
      if (b.type !== 'tool_result' || typeof b.content !== 'string' || b.content.length <= OLD_TOOL_RESULT_CHARS) return b;
      return { ...b, content: `${b.content.slice(0, OLD_TOOL_RESULT_CHARS)}...[trimmed]` };
    });
    return { role: 'user' as const, content };
  });
}

export async function runAgent(mcpClient: Client, profile: Profile, sites: SitesConfig, config: AppConfig): Promise<string> {
  const enabledSites = sites.sites.filter(s => s.enabled);
  if (!enabledSites.length) return 'No enabled sites in config/sites.json.';

  const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });
  const executeTool = createToolExecutor(profile, config);
  const systemPrompt = buildSystemPrompt(profile, sites, config);
  const customToolNames = new Set(agentToolDeclarations.map(t => t.name));

  const tools: Array<Record<string, unknown>> = agentToolDeclarations.map(t => ({ ...t }));
  const mcpToolNames = new Set<string>();
  try {
    const { tools: mcpTools } = await mcpClient.listTools();
    for (const t of mcpTools) {
      mcpToolNames.add(t.name);
      tools.push({ name: t.name, description: t.description ?? '', input_schema: t.inputSchema ?? { type: 'object', properties: {} } });
    }
    log('AGENT', `MCP tools loaded: ${mcpTools.length} (total: ${tools.length})`);
  } catch (err) {
    log('ERROR', `Could not list MCP tools: ${err}. Continuing with custom tools only.`);
  }
  // Cache breakpoint on the last tool: the tool list and system prompt are identical on every call.
  tools[tools.length - 1].cache_control = { type: 'ephemeral' };

  log('AGENT', `Sites: ${enabledSites.length}, daily limit: ${config.dailyLimit}, model: ${config.agentModel}`);

  const recovered = loadRecovery();
  const recoveryNote = recovered
    ? `\nNOTE: a previous run was interrupted (last site: ${recovered.lastSite}). Use check_job_seen and check_already_applied to skip jobs already handled.`
    : '';
  if (recovered) log('AGENT', `Found state from an interrupted run (${recovered.iteration} iterations)`);

  let history: Message[] = [{ role: 'user', content: `Start applying. Begin with the first site.${recoveryNote}` }];
  let iteration = 0;
  let finalText = '';
  let consecutiveErrors = 0;
  let fatal = false;

  while (iteration < MAX_ITERATIONS) {
    iteration++;
    log('AGENT', `Iteration ${iteration}/${MAX_ITERATIONS}`);

    try {
      const response = await anthropic.messages.create({
        model: config.agentModel,
        max_tokens: 16000,
        system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
        messages: history,
        tools: tools as unknown as Anthropic.Messages.Tool[],
        // The installed SDK types predate adaptive thinking, effort and top-level caching; the API accepts them.
        ...({
          thinking: { type: 'adaptive' },
          output_config: { effort: 'medium' },
          cache_control: { type: 'ephemeral' },
        } as object),
      }) as Anthropic.Messages.Message;

      consecutiveErrors = 0;
      const usage = usageFromAnthropic(response.usage);
      recordTokenUsage(config.agentModel, usage, 'agent');
      if (iteration <= 3 || iteration % 10 === 0) {
        log('AGENT', `Tokens: in=${usage.inputTokens} out=${usage.outputTokens} cache_read=${usage.cacheReadTokens} cache_write=${usage.cacheWriteTokens}`);
      }

      if (config.maxCostUsd > 0 && getTotalCost() > config.maxCostUsd) {
        finalText = `Run stopped: cost cap of $${config.maxCostUsd} reached ($${getTotalCost().toFixed(4)}).`;
        log('AGENT', finalText);
        break;
      }

      const stopReason = response.stop_reason as string;
      if (stopReason === 'refusal') {
        finalText = 'Run stopped: the model declined to continue.';
        log('AGENT', finalText);
        break;
      }

      let content = cleanContent(response.content);

      // A cut-off reply is not a final answer, and a tool call in it may be incomplete:
      // keep only the text and ask the model to carry on.
      if (stopReason === 'max_tokens') {
        content = content.filter(b => b.type === 'text');
        if (content.length) history.push({ role: 'assistant', content });
        history.push({ role: 'user', content: 'Your last reply was cut off. Continue with the next step.' });
        log('AGENT', 'Reply hit max_tokens; asking the model to continue.');
        continue;
      }

      if (!content.length) {
        history.push({ role: 'user', content: 'Continue with the next step.' });
        continue;
      }

      history.push({ role: 'assistant', content });

      const toolCalls = content.filter((b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use');
      if (!toolCalls.length) {
        finalText = content.filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text').map(b => b.text).join('\n');
        log('AGENT', `Final response:\n${finalText}`);
        clearRecovery();
        break;
      }

      log('AGENT', `Running ${toolCalls.length} tool(s)...`);
      const results: Anthropic.Messages.ToolResultBlockParam[] = [];
      for (const call of toolCalls) {
        const args = (call.input ?? {}) as Record<string, unknown>;
        log('TOOL', `${call.name}(${JSON.stringify(args).slice(0, 100)}...)`);

        let output: string;
        try {
          if (customToolNames.has(call.name)) {
            output = await executeTool(call.name, args);
          } else if (mcpToolNames.has(call.name)) {
            const result = await mcpClient.callTool({ name: call.name, arguments: args });
            const parts = result.content as Array<{ type: string; text?: string }> | undefined;
            output = parts?.map(c => (c.type === 'text' ? c.text : JSON.stringify(c))).join('\n') || 'OK';
          } else {
            output = `TOOL_ERROR: unknown tool "${call.name}".`;
            log('ERROR', output);
          }
        } catch (toolError) {
          output = `TOOL_ERROR: ${toolError instanceof Error ? toolError.message : String(toolError)}`;
          log('ERROR', `Tool ${call.name} failed: ${output}`);
        }

        if (output.length > MAX_TOOL_RESULT_CHARS) {
          output = `${output.slice(0, MAX_TOOL_RESULT_CHARS)}\n...[truncated: output too long. Use a narrower selector or browser_snapshot with a target.]`;
        }
        log('TOOL', `Result: ${output.slice(0, 150)}...`);
        results.push({ type: 'tool_result', tool_use_id: call.id, content: output });
      }
      history.push({ role: 'user', content: results });

      if (history.length > MAX_HISTORY) {
        const before = history.length;
        history = trimOldToolResults(pruneHistory(history, HISTORY_AFTER_PRUNE));
        log('AGENT', `History pruned: dropped ${before - history.length} old messages (now ${history.length})`);
      }

      if (iteration % 5 === 0) saveRecovery(iteration, enabledSites.map(s => s.name));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log('ERROR', `Iteration ${iteration} failed: ${message}`);
      const kind = classifyApiError(message);

      if (kind === 'rate_limit') {
        consecutiveErrors++;
        const wait = rateLimitBackoffMs(consecutiveErrors);
        log('AGENT', `Rate limited (${consecutiveErrors}x). Waiting ${Math.round(wait / 1000)}s...`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }

      if (kind === 'network') {
        consecutiveErrors++;
        if (consecutiveErrors <= MAX_ATTEMPTS) {
          const wait = 5000 * Math.pow(2, consecutiveErrors - 1);
          log('AGENT', `Network error (${consecutiveErrors}/${MAX_ATTEMPTS}). Retrying in ${Math.round(wait / 1000)}s...`);
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
        log('AGENT', `Network error persisted after ${consecutiveErrors} attempts. Stopping.`);
      }

      saveRecovery(iteration, enabledSites.map(s => s.name));
      finalText = `Run failed: ${message}`;
      fatal = true;
      break;
    }
  }

  if (iteration >= MAX_ITERATIONS) finalText = `Agent hit the ${MAX_ITERATIONS}-iteration limit.`;
  if (!fatal) clearRecovery();
  log('AGENT', `Finished after ${iteration} iterations.`);
  return finalText;
}

// ========== RECOVERY ==========

interface RecoveryState {
  iteration: number;
  lastSite: string;
  timestamp: string;
}

function saveRecovery(iteration: number, sites: string[]): void {
  try {
    const state: RecoveryState = { iteration, lastSite: sites[sites.length - 1] ?? '', timestamp: new Date().toISOString() };
    writeFileSync(RECOVERY_PATH, JSON.stringify(state, null, 2));
  } catch {
    // best effort
  }
}

function loadRecovery(): RecoveryState | null {
  try {
    return existsSync(RECOVERY_PATH) ? JSON.parse(readFileSync(RECOVERY_PATH, 'utf-8')) as RecoveryState : null;
  } catch {
    return null;
  }
}

function clearRecovery(): void {
  try {
    if (existsSync(RECOVERY_PATH)) unlinkSync(RECOVERY_PATH);
  } catch {
    // best effort
  }
}

// Tracks token usage and cost for every LLM call and prints a summary at the end of a run.
// Unknown models fall back to Sonnet pricing; Ollama runs locally and costs nothing.

import { log } from './logger.js';

interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
  cacheReadPer1M: number;
}

const PRICING: Record<string, ModelPricing> = {
  'claude-opus-5-5': { inputPer1M: 4.0, outputPer1M: 20.0, cacheReadPer1M: 0.2 },
  'claude-sonnet-5-5': { inputPer1M: 2.0, outputPer1M: 10.0, cacheReadPer1M: 0.2 },
  'claude-haiku-5-5': { inputPer1M: 0.1, outputPer1M: 0.5, cacheReadPer1M: 0.01 },
  ollama: { inputPer1M: 0, outputPer1M: 0, cacheReadPer1M: 0 },
};

const FALLBACK_PRICING: ModelPricing = PRICING['claude-sonnet-5-5'];

/** Cache writes are billed at 1.25x the normal input price. */
const CACHE_WRITE_MULTIPLIER = 1.25;

export interface TokenUsage {
  /** Uncached input tokens. */
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

interface UsageRecord {
  timestamp: string;
  model: string;
  context: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number;
}

const records: UsageRecord[] = [];
let totalCost = 0;
let totalTokens = 0;

function pricingFor(model: string): ModelPricing {
  if (PRICING[model]) return PRICING[model];
  for (const [key, pricing] of Object.entries(PRICING)) {
    if (model.startsWith(key)) return pricing;
  }
  return FALLBACK_PRICING;
}

export function costOf(model: string, usage: Required<TokenUsage>): number {
  const p = pricingFor(model);
  return (
    (usage.inputTokens / 1_000_000) * p.inputPer1M +
    (usage.cacheReadTokens / 1_000_000) * p.cacheReadPer1M +
    (usage.cacheWriteTokens / 1_000_000) * p.inputPer1M * CACHE_WRITE_MULTIPLIER +
    (usage.outputTokens / 1_000_000) * p.outputPer1M
  );
}

/** Builds TokenUsage from an Anthropic `response.usage` object. */
export function usageFromAnthropic(usage: unknown): TokenUsage {
  const u = usage as Record<string, number | undefined>;
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
  };
}

export function recordTokenUsage(model: string, usage: TokenUsage | undefined | null, context: string): void {
  if (!usage) return;

  const full: Required<TokenUsage> = {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
  };
  const tokens = full.inputTokens + full.outputTokens + full.cacheReadTokens + full.cacheWriteTokens;
  const costUsd = costOf(model, full);

  records.push({ timestamp: new Date().toISOString(), model, context, ...full, totalTokens: tokens, costUsd });
  totalCost += costUsd;
  totalTokens += tokens;
}

export function getTotalCost(): number {
  return totalCost;
}

export function getTotalTokens(): number {
  return totalTokens;
}

export function getCallCount(): number {
  return records.length;
}

export function getSummaryByContext(): Record<string, { calls: number; tokens: number; costUsd: number }> {
  const summary: Record<string, { calls: number; tokens: number; costUsd: number }> = {};
  for (const r of records) {
    const s = (summary[r.context] ??= { calls: 0, tokens: 0, costUsd: 0 });
    s.calls++;
    s.tokens += r.totalTokens;
    s.costUsd += r.costUsd;
  }
  return summary;
}

export function printTokenSummary(): void {
  if (!records.length) {
    log('INFO', 'Tokens: no LLM calls this run.');
    return;
  }
  const cacheRead = records.reduce((acc, r) => acc + r.cacheReadTokens, 0);
  log('INFO', '='.repeat(60));
  log('INFO', '  TOKEN COST');
  log('INFO', '='.repeat(60));
  log('INFO', `  Calls:        ${records.length}`);
  log('INFO', `  Tokens:       ${totalTokens.toLocaleString('en-US')}`);
  log('INFO', `  Cache reads:  ${cacheRead.toLocaleString('en-US')} (billed at ~10% of input price)`);
  log('INFO', `  Total cost:   $${totalCost.toFixed(4)} USD`);
  log('INFO', `  Per call:     $${(totalCost / records.length).toFixed(6)} USD`);
  log('INFO', '  By context:');
  for (const [ctx, s] of Object.entries(getSummaryByContext())) {
    log('INFO', `    ${ctx}: ${s.calls} call(s), ${s.tokens.toLocaleString('en-US')} tokens, $${s.costUsd.toFixed(4)}`);
  }
}

export function getRecords(): UsageRecord[] {
  return [...records];
}

/** Clears the tracker between scheduled runs. */
export function resetTracker(): void {
  records.length = 0;
  totalCost = 0;
  totalTokens = 0;
}

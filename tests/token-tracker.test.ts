import { describe, it, expect, beforeEach } from 'vitest';
import { recordTokenUsage, getTotalCost, getTotalTokens, resetTracker, usageFromAnthropic } from '../src/core/token-tracker';

describe('token tracker', () => {
  beforeEach(() => resetTracker());

  it('charges nothing for Ollama', () => {
    recordTokenUsage('ollama', { inputTokens: 1_000_000, outputTokens: 1_000_000 }, 'cover_letter');
    expect(getTotalCost()).toBe(0);
    expect(getTotalTokens()).toBe(2_000_000);
  });

  it('matches models by prefix', () => {
    recordTokenUsage('ollama:helper', { inputTokens: 500_000 }, 'resume');
    expect(getTotalCost()).toBe(0);
  });

  it('prices claude-sonnet-5-5 input and output', () => {
    recordTokenUsage('claude-sonnet-5-5', { inputTokens: 1_000_000, outputTokens: 1_000_000 }, 'agent');
    expect(getTotalCost()).toBeCloseTo(12, 5);
  });

  it('bills cache reads at the cached rate and cache writes at 1.25x input', () => {
    recordTokenUsage('claude-sonnet-5-5', { cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 }, 'agent');
    expect(getTotalCost()).toBeCloseTo(2.7, 5);
  });

  it('reads an Anthropic usage object', () => {
    expect(usageFromAnthropic({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 }))
      .toEqual({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 20 });
  });

  it('ignores calls without usage', () => {
    recordTokenUsage('claude-sonnet-5-5', undefined, 'agent');
    expect(getTotalCost()).toBe(0);
    expect(getTotalTokens()).toBe(0);
  });
});

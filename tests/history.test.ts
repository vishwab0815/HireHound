import { describe, it, expect } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { pruneHistory } from '../src/agent/history';

type Msg = Anthropic.Messages.MessageParam;

// Same shape as the real agent history:
// [user(text), assistant(tool_use), user(tool_result), assistant(...), user(...), ...]
const userText = (t: string): Msg => ({ role: 'user', content: t });
const assistantCall = (name: string): Msg => ({
  role: 'assistant',
  content: [{ type: 'tool_use', id: `id_${name}`, name, input: {} }],
});
const userResult = (name: string): Msg => ({
  role: 'user',
  content: [{ type: 'tool_result', tool_use_id: `id_${name}`, content: 'ok' }],
});

function buildHistory(rounds: number): Msg[] {
  const history: Msg[] = [userText('start')];
  for (let i = 0; i < rounds; i++) history.push(assistantCall(`t${i}`), userResult(`t${i}`));
  return history;
}

const blocks = (m: Msg) => (Array.isArray(m.content) ? m.content : []);
const hasToolResult = (m: Msg) => blocks(m).some(b => b.type === 'tool_result');
const hasToolUse = (m: Msg) => blocks(m).some(b => b.type === 'tool_use');

describe('pruneHistory', () => {
  it('leaves a short history untouched', () => {
    const history = [userText('start'), assistantCall('a'), userResult('a')];
    expect(pruneHistory(history, 30)).toEqual(history);
  });

  it('keeps the initial user message', () => {
    const result = pruneHistory(buildHistory(20), 30);
    expect(result[0]).toEqual(userText('start'));
    expect(result.length).toBeLessThanOrEqual(30);
  });

  it('continues with an assistant turn, never an orphan tool_result', () => {
    const history = buildHistory(25);
    for (const max of [8, 10, 15, 21, 30]) {
      const result = pruneHistory(history, max);
      expect(typeof result[0].content).toBe('string');
      if (result.length > 1) {
        expect(result[1].role).toBe('assistant');
        expect(hasToolResult(result[1])).toBe(false);
      }
    }
  });

  it('pairs every tool_result with the tool_use right before it', () => {
    const result = pruneHistory(buildHistory(18), 20);
    result.forEach((msg, i) => {
      if (hasToolResult(msg)) {
        expect(result[i - 1].role).toBe('assistant');
        expect(hasToolUse(result[i - 1])).toBe(true);
      }
    });
  });

  it('drops thinking blocks from the turns it keeps', () => {
    const history = buildHistory(20);
    history[history.length - 2] = {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'hmm', signature: 'sig' },
        { type: 'tool_use', id: 'id_last', name: 'last', input: {} },
      ],
    };
    const result = pruneHistory(history, 10);
    expect(result.flatMap(blocks).some(b => b.type === 'thinking')).toBe(false);
  });
});

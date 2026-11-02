import type Anthropic from '@anthropic-ai/sdk';

type Message = Anthropic.Messages.MessageParam;

function stripThinking(msg: Message): Message {
  if (msg.role !== 'assistant' || !Array.isArray(msg.content)) return msg;
  const kept = msg.content.filter(b => b.type !== 'thinking' && b.type !== 'redacted_thinking');
  if (kept.length === msg.content.length) return msg;
  return { role: 'assistant', content: kept.length ? kept : [{ type: 'text', text: '(continuing)' }] };
}

/**
 * Sliding window over the agent history. Keeps the initial user message and cuts so the
 * kept part starts on an assistant turn, which means no tool_result is ever left without
 * its tool_use. Thinking blocks are dropped from what remains, because they are bound to
 * the exact conversation prefix they were produced in.
 */
export function pruneHistory(history: Message[], max: number): Message[] {
  if (history.length <= max) return history.slice();

  const first = history[0];
  let cut = history.length - max + 1;
  while (cut < history.length && history[cut]?.role !== 'assistant') cut++;
  if (cut >= history.length) return [first];

  return [first, ...history.slice(cut)].map(stripThinking);
}

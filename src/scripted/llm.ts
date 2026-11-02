import Anthropic from '@anthropic-ai/sdk';
import { recordTokenUsage, usageFromAnthropic } from '../core/token-tracker.js';
import { log } from '../core/logger.js';

let client: Anthropic | null = null;

export function configureScriptedLlm(apiKey: string): void {
  client = new Anthropic({ apiKey });
}

interface JsonCall {
  model: string;
  system: string;
  user: string;
  schema: Record<string, unknown>;
  effort: 'low' | 'medium' | 'high';
  context: string;
  maxTokens?: number;
}

/** One structured-output call. Returns the parsed JSON or throws. */
export async function callJson<T>(c: JsonCall): Promise<T> {
  if (!client) throw new Error('Scripted-mode LLM not configured');

  const response = await client.messages.create({
    model: c.model,
    max_tokens: c.maxTokens ?? 6000,
    system: [{ type: 'text', text: c.system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: c.user }],
    // The installed SDK types predate these parameters; the API accepts them.
    ...({
      thinking: { type: 'adaptive' },
      output_config: { effort: c.effort, format: { type: 'json_schema', schema: c.schema } },
    } as object),
  }) as Anthropic.Messages.Message;

  recordTokenUsage(c.model, usageFromAnthropic(response.usage), c.context);

  if ((response.stop_reason as string) === 'refusal') throw new Error(`${c.context}: the model declined`);
  if (response.stop_reason === 'max_tokens') throw new Error(`${c.context}: output was cut off (max_tokens)`);

  const text = response.content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('');
  try {
    return JSON.parse(text) as T;
  } catch {
    log('ERROR', `${c.context}: invalid JSON: ${text.slice(0, 200)}`);
    throw new Error(`${c.context}: the model returned invalid JSON`);
  }
}

import Anthropic from '@anthropic-ai/sdk';
import { log } from '../core/logger.js';
import { recordTokenUsage, usageFromAnthropic, type TokenUsage } from '../core/token-tracker.js';

// The "helper" LLM writes cover letters, tailored resumes and recruiter notes.
// It can be an Anthropic model (default), a local Ollama model, or any OpenAI-compatible API.

export interface LlmResponse {
  text: string;
  usage?: TokenUsage;
}

interface LlmProvider {
  readonly name: string;
  /** Model name used for cost tracking. */
  readonly pricingModel: string;
  generate(prompt: string): Promise<LlmResponse>;
}

class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic';
  private client: Anthropic;

  constructor(apiKey: string, private model: string) {
    this.client = new Anthropic({ apiKey });
  }

  get pricingModel(): string {
    return this.model;
  }

  async generate(prompt: string): Promise<LlmResponse> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 8000,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text)
      .join('')
      .trim();
    return { text, usage: usageFromAnthropic(response.usage) };
  }
}

class OllamaProvider implements LlmProvider {
  readonly name = 'ollama';
  readonly pricingModel = 'ollama';

  constructor(private model: string, private baseUrl: string) {}

  async generate(prompt: string): Promise<LlmResponse> {
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, messages: [{ role: 'user', content: prompt }], stream: false }),
    });
    if (!response.ok) throw new Error(`Ollama error ${response.status}: ${await response.text()}`);

    const data = await response.json() as { message: { content: string }; prompt_eval_count?: number; eval_count?: number };
    return {
      text: data.message.content.trim(),
      usage: { inputTokens: data.prompt_eval_count ?? 0, outputTokens: data.eval_count ?? 0 },
    };
  }
}

class OpenAiCompatibleProvider implements LlmProvider {
  readonly name = 'openai';

  constructor(private model: string, private apiKey: string, private baseUrl: string) {}

  get pricingModel(): string {
    return this.model;
  }

  async generate(prompt: string): Promise<LlmResponse> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: this.model, messages: [{ role: 'user', content: prompt }], temperature: 0.4 }),
    });
    if (!response.ok) throw new Error(`OpenAI-compatible API error ${response.status}: ${await response.text()}`);

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    return {
      text: data.choices[0].message.content.trim(),
      usage: { inputTokens: data.usage?.prompt_tokens ?? 0, outputTokens: data.usage?.completion_tokens ?? 0 },
    };
  }
}

let provider: LlmProvider | null = null;
let fallback: LlmProvider | null = null;

export function configureHelperLlm(config: {
  provider: string;
  model: string;
  anthropicApiKey?: string;
  ollamaUrl?: string;
  openaiApiKey?: string;
  openaiBaseUrl?: string;
}): void {
  provider = createProvider(config);

  // When the helper is a local/third-party model, fall back to an Anthropic model if it fails.
  if (config.provider !== 'anthropic' && config.anthropicApiKey) {
    fallback = new AnthropicProvider(config.anthropicApiKey, 'claude-haiku-5-5');
  }

  log('INFO', `Helper LLM: ${provider.name} (${config.model})${fallback ? `, fallback: ${fallback.name}` : ''}`);
}

function createProvider(config: Parameters<typeof configureHelperLlm>[0]): LlmProvider {
  switch (config.provider) {
    case 'anthropic':
      if (!config.anthropicApiKey) throw new Error('ANTHROPIC_API_KEY is required for the anthropic provider');
      return new AnthropicProvider(config.anthropicApiKey, config.model);
    case 'ollama':
      return new OllamaProvider(config.model, config.ollamaUrl || 'http://localhost:11434');
    case 'openai':
      return new OpenAiCompatibleProvider(config.model, config.openaiApiKey || '', config.openaiBaseUrl || 'https://api.openai.com/v1');
    default:
      throw new Error(`Unknown LLM provider "${config.provider}". Use anthropic, ollama or openai.`);
  }
}

export async function generateText(prompt: string, context: string): Promise<LlmResponse> {
  if (!provider) throw new Error('Helper LLM not configured. Call configureHelperLlm() first.');

  try {
    const response = await provider.generate(prompt);
    recordTokenUsage(provider.pricingModel, response.usage, context);
    return response;
  } catch (error) {
    log('WARN', `Helper LLM (${provider.name}) failed: ${error instanceof Error ? error.message : String(error)}`);
    if (!fallback) throw error;

    log('INFO', `Trying fallback: ${fallback.name}...`);
    const response = await fallback.generate(prompt);
    recordTokenUsage(fallback.pricingModel, response.usage, `${context}_fallback`);
    return response;
  }
}

export function helperProviderName(): string {
  return provider?.name ?? 'not_configured';
}

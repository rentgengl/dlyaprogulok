/** Выбор модели по окружению: AI_PROVIDER или, если он не задан, по имеющемуся ключу. */
import type { AI } from './ai.ts';
import { createClaudeAI } from './ai-claude.ts';
import { createDeepSeekAI } from './ai-deepseek.ts';

export const AI_PROVIDERS = ['claude', 'deepseek'] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

export interface AiSetup {
  ai: AI | null;
  provider: AiProvider | null;
  model: string | null;
}

type Env = Record<string, string | undefined>;

const hasClaudeKey = (env: Env) => !!(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);

function chooseProvider(env: Env): AiProvider | null {
  const wanted = env.AI_PROVIDER?.trim().toLowerCase();
  if (wanted) {
    // Явный выбор нельзя молча подменять: без этой проверки опечатка незаметно отключила бы ИИ.
    if (!AI_PROVIDERS.includes(wanted as AiProvider)) {
      throw new Error(`AI_PROVIDER=${wanted}: допустимые значения ${AI_PROVIDERS.join(', ')}`);
    }
    if (wanted === 'claude' && !hasClaudeKey(env)) throw new Error('AI_PROVIDER=claude, но ANTHROPIC_API_KEY не задан');
    if (wanted === 'deepseek' && !env.DEEPSEEK_API_KEY) throw new Error('AI_PROVIDER=deepseek, но DEEPSEEK_API_KEY не задан');
    return wanted as AiProvider;
  }
  if (hasClaudeKey(env)) return 'claude';
  if (env.DEEPSEEK_API_KEY) return 'deepseek';
  return null;
}

export function createAiFromEnv(env: Env): AiSetup {
  const provider = chooseProvider(env);
  if (provider === 'claude') {
    const model = env.CLAUDE_MODEL || 'claude-opus-5-5';
    return { ai: createClaudeAI(model), provider, model };
  }
  if (provider === 'deepseek') {
    const model = env.DEEPSEEK_MODEL || 'deepseek-flash';
    const ai = createDeepSeekAI({
      apiKey: env.DEEPSEEK_API_KEY!,
      model,
      baseUrl: env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    });
    return { ai, provider, model };
  }
  return { ai: null, provider: null, model: null };
}

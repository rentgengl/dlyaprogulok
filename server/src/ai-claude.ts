/** Адаптер Claude: структурированный ответ по схеме через официальный SDK. */
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import {
  buildSelectPrompt,
  buildStoryPrompt,
  SELECT_SYSTEM,
  SelectionSchema,
  storySystem,
  toStopSelection,
  type AI,
} from './ai.ts';

export function createClaudeAI(model: string): AI {
  const client = new Anthropic({ timeout: 120_000 });
  const common = {
    model,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default' as const,
  };

  return {
    async selectStops(input) {
      const res = await client.beta.messages.parse({
        ...common,
        max_tokens: 16000,
        system: SELECT_SYSTEM,
        output_config: { effort: 'medium', format: betaZodOutputFormat(SelectionSchema) },
        messages: [{ role: 'user', content: buildSelectPrompt(input) }],
      });
      ensureComplete(res.stop_reason);
      const out = res.parsed_output;
      if (!out) throw new Error('Claude вернул ответ не по схеме');
      return toStopSelection(out);
    },

    async writeStory(input) {
      const res = await client.beta.messages.create({
        ...common,
        max_tokens: 16000,
        system: storySystem(input.style),
        output_config: { effort: 'medium' },
        messages: [{ role: 'user', content: buildStoryPrompt(input) }],
      });
      ensureComplete(res.stop_reason);
      const text = res.content
        .flatMap((b) => (b.type === 'text' ? [b.text] : []))
        .join('')
        .trim();
      if (!text) throw new Error('Claude вернул пустой текст');
      return text;
    },
  };
}

function ensureComplete(stopReason: string | null) {
  if (stopReason === 'refusal') throw new Error('Claude отказался обрабатывать запрос');
  if (stopReason === 'max_tokens') throw new Error('Ответ Claude обрезан по лимиту токенов');
}

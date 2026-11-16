/**
 * Адаптер DeepSeek (OpenAI-совместимый /chat/completions).
 * Схемы на стороне API нет, только json_object, поэтому ответ проверяется здесь.
 */
import {
  buildSelectPrompt,
  buildStoryPrompt,
  SELECT_SYSTEM,
  SelectionSchema,
  storySystem,
  toStopSelection,
  type AI,
  type StopSelection,
} from './ai.ts';

export interface DeepSeekOptions {
  apiKey: string;
  model: string;
  baseUrl: string;
  fetch?: typeof fetch;
}

const TIMEOUT_MS = 120_000;
const RETRY_DELAY_MS = 500;
const MAX_ATTEMPTS = 2;
/** Перегрузка и сбои сервера проходят сами. 401 и 402 (нет денег на счёте) повтором не лечатся. */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503]);

/** json_object требует упоминания JSON в промпте и примера структуры. */
const SELECT_JSON_SYSTEM = `${SELECT_SYSTEM}

Ответь одним объектом JSON такого вида, без пояснений вокруг него:
{"title": "Заголовок", "description": "Описание", "stops": [{"candidate_id": "id из списка", "teaser": "Фраза"}]}`;

function parseSelection(content: string): StopSelection | null {
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    return null;
  }
  const parsed = SelectionSchema.safeParse(json);
  return parsed.success ? toStopSelection(parsed.data) : null;
}

export function createDeepSeekAI(options: DeepSeekOptions): AI {
  const { apiKey, model } = options;
  const url = `${options.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const doFetch = options.fetch ?? fetch;

  async function complete(body: Record<string, unknown>): Promise<string> {
    for (let attempt = 1; ; attempt++) {
      const res = await doFetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, max_tokens: 16000, ...body }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        if (RETRYABLE_STATUS.has(res.status) && attempt < MAX_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
          continue;
        }
        const detail = await res.json().then((d: any) => d?.error?.message, () => undefined);
        throw new Error(`DeepSeek ответил ${res.status}${detail ? `: ${detail}` : ''}`);
      }
      const data: any = await res.json();
      const choice = data?.choices?.[0];
      if (choice?.finish_reason === 'length') throw new Error('Ответ DeepSeek обрезан по лимиту токенов');
      if (choice?.finish_reason === 'content_filter') throw new Error('DeepSeek скрыл ответ фильтром контента');
      if (choice?.finish_reason !== 'stop') {
        throw new Error(`DeepSeek прервал ответ: ${choice?.finish_reason ?? 'нет данных'}`);
      }
      return String(choice.message?.content ?? '').trim();
    }
  }

  return {
    async selectStops(input) {
      // Нераспознанный JSON API заменяет пробелами при finish_reason=stop: документация советует повторить запрос.
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const content = await complete({
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: SELECT_JSON_SYSTEM },
            { role: 'user', content: buildSelectPrompt(input) },
          ],
        });
        const selection = parseSelection(content);
        if (selection) return selection;
      }
      throw new Error('DeepSeek вернул ответ не по схеме');
    },

    async writeStory(input) {
      const text = await complete({
        messages: [
          { role: 'system', content: storySystem(input.style) },
          { role: 'user', content: buildStoryPrompt(input) },
        ],
      });
      if (!text) throw new Error('DeepSeek вернул пустой текст');
      return text;
    },
  };
}

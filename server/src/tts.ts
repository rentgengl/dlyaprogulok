/**
 * Озвучка в mp3. Два варианта:
 * - Yandex AI Studio SpeechKit (API v3, стандартные голоса);
 * - OpenAI-совместимый /audio/speech: облачный сервис или локальный контейнер Piper.
 */
export interface TTS {
  /** Для лога при запуске: какой сервис и голос озвучивают. */
  name: string;
  synthesize(text: string): Promise<Buffer>;
}

export interface TtsConfig {
  /** Локальному контейнеру ключ не нужен. */
  apiKey?: string;
  baseUrl: string;
  model: string;
  voice: string;
  fetch?: typeof fetch;
}

const TIMEOUT_MS = 120_000;

export function createTts(cfg: TtsConfig): TTS {
  const doFetch = cfg.fetch ?? fetch;
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/audio/speech`;
  return {
    name: `${cfg.baseUrl}, голос ${cfg.voice}`,
    async synthesize(text) {
      const res = await doFetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: cfg.model, voice: cfg.voice, input: text, response_format: 'mp3' }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        const detail = await res.json().then((d: any) => d?.error?.message, () => undefined);
        throw new Error(`TTS ответил ${res.status}${detail ? `: ${detail}` : ''}`);
      }
      return nonEmpty(Buffer.from(await res.arrayBuffer()), 'TTS');
    },
  };
}

export interface YandexTtsConfig {
  apiKey: string;
  voice: string;
  /** Амплуа голоса: good, neutral, friendly и т. п.; набор зависит от голоса. */
  role?: string;
  /** От 0.1 до 3, по умолчанию 1. */
  speed?: number;
  /** Сдвиг высоты голоса в герцах, от -1000 до 1000. */
  pitchShift?: number;
  /** Каталог Yandex Cloud; с API-ключом сервисного аккаунта необязателен. */
  folderId?: string;
  url?: string;
  fetch?: typeof fetch;
}

/** В unsafeMode API v3 принимает длинный текст; 4800 символов проверены на живом API. */
export const YANDEX_MAX_CHARS = 4800;

/**
 * Yandex AI Studio, SpeechKit API v3 (utteranceSynthesis) — то же, что делает Python-SDK
 * `sdk.speechkit.text_to_speech(...)`. Ответ — поток JSON-объектов, по одному на строку,
 * в каждом кусок mp3 в base64; вместе они образуют один файл.
 */
export function createYandexTts(cfg: YandexTtsConfig): TTS {
  const doFetch = cfg.fetch ?? fetch;
  const url = cfg.url ?? 'https://tts.api.cloud.yandex.net/tts/v3/utteranceSynthesis';

  async function once(text: string): Promise<Buffer> {
    const hints: Record<string, unknown>[] = [{ voice: cfg.voice }];
    if (cfg.role) hints.push({ role: cfg.role });
    if (cfg.speed !== undefined) hints.push({ speed: cfg.speed });
    if (cfg.pitchShift) hints.push({ pitchShift: cfg.pitchShift });
    const res = await doFetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Api-Key ${cfg.apiKey}`,
        'Content-Type': 'application/json',
        ...(cfg.folderId ? { 'x-folder-id': cfg.folderId } : {}),
      },
      body: JSON.stringify({
        text,
        hints,
        outputAudioSpec: { containerAudio: { containerAudioType: 'MP3' } },
        loudnessNormalizationType: 'LUFS',
        // Без него API отвергает текст длиннее примерно 250 символов («Too long text»).
        unsafeMode: true,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`SpeechKit ответил ${res.status}${errorText(body)}`);
    const chunks: Buffer[] = [];
    for (const line of body.split('\n')) {
      if (!line.trim()) continue;
      let item: any;
      try {
        item = JSON.parse(line);
      } catch {
        throw new Error('SpeechKit вернул ответ, который не удалось разобрать');
      }
      if (item.error) throw new Error(`SpeechKit прервал синтез${errorText(line)}`);
      const data = item.result?.audioChunk?.data;
      if (data) chunks.push(Buffer.from(data, 'base64'));
    }
    return nonEmpty(Buffer.concat(chunks), 'SpeechKit');
  }

  return {
    name: `Yandex SpeechKit v3, голос ${cfg.voice}${cfg.role ? ` (${cfg.role})` : ''}`,
    async synthesize(text) {
      const parts = splitText(text, YANDEX_MAX_CHARS);
      const audio: Buffer[] = [];
      for (const [i, part] of parts.entries()) {
        const chunk = await once(part);
        // Кадры MP3 можно склеивать подряд; теги ID3 в середине файла некоторые плееры читают как шум.
        audio.push(i === 0 ? chunk : stripId3(chunk));
      }
      return Buffer.concat(audio);
    },
  };
}

/** Сообщение из {"error": {"message": ...}} без служебных идентификаторов запроса. */
function errorText(body: string): string {
  try {
    const message = JSON.parse(body)?.error?.message;
    if (typeof message === 'string' && message) return `: ${message.split(/,\s*internal_id=/)[0]}`;
  } catch {
    // не JSON
  }
  return '';
}

/** Режет длинный текст по предложениям, а слишком длинное предложение — по словам. */
export function splitText(text: string, max: number): string[] {
  const clean = text.trim();
  if (clean.length <= max) return [clean];
  const sentences = clean.match(/[^.!?…]+[.!?…]*\s*/g) ?? [clean];
  const parts: string[] = [];
  let current = '';
  const push = () => {
    if (current.trim()) parts.push(current.trim());
    current = '';
  };
  for (const sentence of sentences) {
    if (sentence.length > max) {
      push();
      for (const word of sentence.split(/(\s+)/)) {
        if ((current + word).length > max) push();
        current += word.length > max ? word.slice(0, max) : word;
      }
      continue;
    }
    if ((current + sentence).length > max) push();
    current += sentence;
  }
  push();
  return parts;
}

/** Убирает ID3v2 в начале фрагмента: 10 байт заголовка, размер — syncsafe-число. */
export function stripId3(buf: Buffer): Buffer {
  if (buf.length < 10 || buf.toString('latin1', 0, 3) !== 'ID3') return buf;
  const size = ((buf[6]! & 0x7f) << 21) | ((buf[7]! & 0x7f) << 14) | ((buf[8]! & 0x7f) << 7) | (buf[9]! & 0x7f);
  const footer = buf[5]! & 0x10 ? 10 : 0;
  return buf.subarray(Math.min(buf.length, 10 + size + footer));
}

function nonEmpty(audio: Buffer, service: string): Buffer {
  if (audio.length === 0) throw new Error(`${service} вернул пустой файл`);
  return audio;
}

type Env = Record<string, string | undefined>;

function optionalNumber(env: Env, key: string, min: number, max: number): number | undefined {
  const raw = env[key]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!(value >= min && value <= max)) throw new Error(`${key}=${raw}: нужно число от ${min} до ${max}`);
  return value;
}

const TTS_PROVIDERS = ['yandex', 'openai'] as const;

/**
 * TTS_PROVIDER выбирает сервис явно. Без него: SpeechKit, если задан YANDEX_API_KEY,
 * иначе OpenAI-совместимый сервис, если задан его ключ или адрес. Иначе озвучка выключена.
 */
export function createTtsFromEnv(env: Env): TTS | null {
  const provider = env.TTS_PROVIDER?.trim().toLowerCase();
  if (provider && !(TTS_PROVIDERS as readonly string[]).includes(provider)) {
    throw new Error(`TTS_PROVIDER=${env.TTS_PROVIDER}: допустимо ${TTS_PROVIDERS.join(' или ')}`);
  }

  if (provider === 'yandex' || (!provider && env.YANDEX_API_KEY)) {
    if (!env.YANDEX_API_KEY) throw new Error('TTS_PROVIDER=yandex, но YANDEX_API_KEY не задан');
    const speed = optionalNumber(env, 'YANDEX_TTS_SPEED', 0.1, 3);
    const pitchShift = optionalNumber(env, 'YANDEX_TTS_PITCH', -1000, 1000);
    return createYandexTts({
      apiKey: env.YANDEX_API_KEY,
      voice: env.YANDEX_TTS_VOICE || 'alexander',
      // Роль good есть у голоса по умолчанию; у других голосов набор ролей свой, поэтому без явной настройки её нет.
      role: env.YANDEX_TTS_ROLE ?? (env.YANDEX_TTS_VOICE ? undefined : 'good'),
      speed: speed ?? 1,
      pitchShift,
      folderId: env.YANDEX_FOLDER_ID || undefined,
    });
  }

  if (provider === 'openai' && !env.TTS_API_KEY && !env.TTS_BASE_URL) {
    throw new Error('TTS_PROVIDER=openai, но не заданы ни TTS_API_KEY, ни TTS_BASE_URL');
  }
  if (!env.TTS_API_KEY && !env.TTS_BASE_URL) return null;
  return createTts({
    apiKey: env.TTS_API_KEY || undefined,
    baseUrl: env.TTS_BASE_URL || 'https://api.openai.com/v1',
    model: env.TTS_MODEL || 'gpt-4o-mini-tts',
    voice: env.TTS_VOICE || 'alloy',
  });
}

// Битрейты (кбит/с) по индексу: [MPEG-1 слой I, II, III], [MPEG-2/2.5 слой I, II/III].
const BITRATES_V1 = [
  [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
];
const BITRATES_V2 = [
  [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
];
const SAMPLE_RATES: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

/**
 * Длительность mp3 в секундах по MPEG-кадрам (без зависимостей): нужна, чтобы считать цену озвучки
 * по факту. ID3v2 в начале пропускается; мусор между кадрами — пропускается побайтно.
 * 0 — кадров не нашлось (не mp3).
 */
export function mp3DurationSec(buf: Buffer): number {
  let i = 0;
  if (buf.length >= 10 && buf.toString('latin1', 0, 3) === 'ID3') {
    const size = ((buf[6]! & 0x7f) << 21) | ((buf[7]! & 0x7f) << 14) | ((buf[8]! & 0x7f) << 7) | (buf[9]! & 0x7f);
    i = 10 + size + (buf[5]! & 0x10 ? 10 : 0);
  }
  let seconds = 0;
  while (i + 4 <= buf.length) {
    const b1 = buf[i + 1]!;
    const b2 = buf[i + 2]!;
    if (buf[i] !== 0xff || (b1 & 0xe0) !== 0xe0) {
      i++;
      continue;
    }
    const version = (b1 >> 3) & 3; // 3 — MPEG-1, 2 — MPEG-2, 0 — MPEG-2.5, 1 — зарезервировано
    const layer = (b1 >> 1) & 3; // 3 — слой I, 2 — II, 1 — III
    const bitrateIdx = b2 >> 4;
    const rateIdx = (b2 >> 2) & 3;
    const padding = (b2 >> 1) & 1;
    if (version === 1 || layer === 0 || bitrateIdx === 0 || bitrateIdx === 15 || rateIdx === 3) {
      i++;
      continue;
    }
    const v1 = version === 3;
    const layerNo = 4 - layer; // 1, 2, 3
    const kbps = v1 ? BITRATES_V1[layerNo - 1]![bitrateIdx]! : BITRATES_V2[layerNo === 1 ? 0 : 1]![bitrateIdx]!;
    const rate = SAMPLE_RATES[version]![rateIdx]!;
    const samples = layerNo === 1 ? 384 : layerNo === 3 && !v1 ? 576 : 1152;
    const length =
      layerNo === 1
        ? (Math.floor((12 * kbps * 1000) / rate) + padding) * 4
        : Math.floor(((samples / 8) * kbps * 1000) / rate) + padding;
    if (length < 4) {
      i++;
      continue;
    }
    seconds += samples / rate;
    i += length;
  }
  return seconds;
}

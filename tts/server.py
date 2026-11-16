"""Озвучка на Piper с OpenAI-совместимым API: POST /v1/audio/speech.

Только стандартная библиотека плюс piper-tts; mp3 кодирует ffmpeg.
Текст рассказа в лог не пишется.
"""

import hmac
import io
import json
import logging
import os
import subprocess
import threading
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from piper import PiperVoice, SynthesisConfig

VOICES_DIR = os.environ.get("VOICES_DIR", "/voices")
DEFAULT_VOICE = os.environ.get("DEFAULT_VOICE", "denis")
API_KEY = os.environ.get("API_KEY", "")
MAX_CHARS = int(os.environ.get("MAX_CHARS", "8000"))
MAX_BODY = 256 * 1024
PORT = int(os.environ.get("PORT", "8880"))

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("tts")


def load_voices() -> dict:
    """Короткое имя голоса — середина имени файла: ru_RU-denis-medium.onnx → denis."""
    voices = {}
    for file in sorted(os.listdir(VOICES_DIR)):
        if not file.endswith(".onnx"):
            continue
        full = file[: -len(".onnx")]
        parts = full.split("-")
        short = parts[1] if len(parts) == 3 else full
        # Модель Piper не рассчитана на параллельный вызов, поэтому у каждой свой замок.
        voices[short] = (PiperVoice.load(os.path.join(VOICES_DIR, file)), threading.Lock())
        log.info("голос %s (%s)", short, full)
    if not voices:
        raise SystemExit(f"в {VOICES_DIR} нет голосов")
    return voices


VOICES = load_voices()
if DEFAULT_VOICE not in VOICES:
    raise SystemExit(f"DEFAULT_VOICE={DEFAULT_VOICE}, а есть только {', '.join(VOICES)}")


def synthesize_wav(voice_name: str, text: str, speed: float) -> bytes:
    voice, lock = VOICES[voice_name]
    buf = io.BytesIO()
    with lock, wave.open(buf, "wb") as wav:
        voice.synthesize_wav(text, wav, syn_config=SynthesisConfig(length_scale=1 / speed))
    return buf.getvalue()


def to_mp3(wav: bytes) -> bytes:
    res = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "wav", "-i", "pipe:0",
         "-codec:a", "libmp3lame", "-q:a", "4", "-f", "mp3", "pipe:1"],
        input=wav, capture_output=True, timeout=120, check=False,
    )
    if res.returncode != 0:
        raise RuntimeError(f"ffmpeg: {res.stderr.decode(errors='replace')[:200]}")
    return res.stdout


class BadRequest(Exception):
    pass


def parse_request(body: dict) -> tuple[str, str, float, str]:
    text = body.get("input")
    if not isinstance(text, str) or not text.strip():
        raise BadRequest("input: нужен непустой текст")
    if len(text) > MAX_CHARS:
        raise BadRequest(f"input: не больше {MAX_CHARS} символов")
    # Без голоса берётся голос по умолчанию; неизвестный голос — ошибка, а не тихая подмена.
    voice = body.get("voice") or DEFAULT_VOICE
    if voice not in VOICES:
        raise BadRequest(f"voice: неизвестный голос {voice}, есть {', '.join(VOICES)}")
    speed = body.get("speed", 1.0)
    if not isinstance(speed, (int, float)) or not 0.5 <= speed <= 2.0:
        raise BadRequest("speed: число от 0.5 до 2.0")
    fmt = body.get("response_format", "mp3")
    if fmt not in ("mp3", "wav"):
        raise BadRequest("response_format: поддерживаются mp3 и wav")
    return text, voice, float(speed), fmt


class Handler(BaseHTTPRequestHandler):
    server_version = "rasskazhi-tts"

    def log_message(self, fmt, *args):  # путь и код без тела запроса
        log.info("%s %s", self.address_string(), fmt % args)

    def send(self, status: int, body: bytes, content_type: str):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def error(self, status: int, message: str):
        self.send(status, json.dumps({"error": {"message": message}}, ensure_ascii=False).encode(), "application/json")

    def do_GET(self):
        if self.path == "/health":
            self.send(200, b'{"ok":true}', "application/json")
        elif self.path == "/v1/audio/voices":
            self.send(200, json.dumps({"voices": list(VOICES), "default": DEFAULT_VOICE}).encode(), "application/json")
        else:
            self.error(404, "нет такого пути")

    def do_POST(self):
        if self.path != "/v1/audio/speech":
            return self.error(404, "нет такого пути")
        if API_KEY:
            given = self.headers.get("Authorization", "")
            if not hmac.compare_digest(given.encode(), f"Bearer {API_KEY}".encode()):
                return self.error(401, "неверный ключ")
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return self.error(400, "неверный Content-Length")
        if length <= 0 or length > MAX_BODY:
            return self.error(413 if length > MAX_BODY else 400, "тело запроса пустое или слишком большое")
        try:
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise BadRequest("ожидается объект JSON")
            text, voice, speed, fmt = parse_request(body)
        except (json.JSONDecodeError, UnicodeDecodeError):
            return self.error(400, "тело не JSON")
        except BadRequest as err:
            return self.error(400, str(err))
        try:
            wav = synthesize_wav(voice, text, speed)
            audio = to_mp3(wav) if fmt == "mp3" else wav
        except Exception:
            log.exception("синтез не удался")
            return self.error(500, "синтез не удался")
        self.send(200, audio, "audio/mpeg" if fmt == "mp3" else "audio/wav")


if __name__ == "__main__":
    log.info("слушаю :%d, голос по умолчанию %s", PORT, DEFAULT_VOICE)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()

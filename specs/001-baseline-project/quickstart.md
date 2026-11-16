# Quickstart для разработки Rasskazhi

Инструкция составлена по README и package manifests из архива. Перед выполнением команд проверьте, что используете доверенную копию репозитория.

## Требования

- Node.js 24 или новее.
- npm.
- Для мобильной разработки — Expo-compatible simulator/device.
- Для локальной серверной озвучки — Docker и Docker Compose (необязательно).

## Установка и запуск backend

Из корня репозитория:

```bash
cd server
npm install
cp .env.example .env
```

Заполните необходимые ключи в `server/.env`. Не коммитьте `.env`.

Запуск:

```bash
npm run dev
```

По README сервер доступен на `http://localhost:3000`.

## Запуск клиента

В другом терминале:

```bash
cd app
npm install
npx expo start
```

В Expo CLI:
- `w` — Web;
- `i` — iOS simulator (при наличии окружения);
- `a` — Android emulator (при наличии окружения);
- QR-код — запуск на устройстве.

Если клиент должен обращаться к серверу по другому адресу, задайте `EXPO_PUBLIC_API_URL` в окружении клиента согласно конфигурации проекта.

## Проверки

Из корня:

```bash
npm test
npm run typecheck
```

Для приложения:

```bash
cd app
npm run lint
```

## AI-конфигурация

Достаточно одного ключа:
- `ANTHROPIC_API_KEY`
- `DEEPSEEK_API_KEY`

Если оба ключа заданы, README указывает, что Claude выбирается по умолчанию; `AI_PROVIDER` может переключить провайдера. Некорректная конфигурация выбранного провайдера останавливает запуск.

## TTS

Варианты:
- Yandex SpeechKit через `YANDEX_API_KEY`;
- OpenAI-compatible endpoint через `TTS_BASE_URL`, `TTS_API_KEY`, `TTS_MODEL`, `TTS_VOICE`;
- локальный Piper через Compose.

```bash
docker compose up -d tts
```

Для Piper в `server/.env` укажите `TTS_BASE_URL=http://localhost:8880/v1` и `TTS_VOICE=denis` (либо другой поддерживаемый голос).

## Важные замечания

- Без AI ключа сервер поддерживает резервный сценарий, описанный в README.
- Без серверного TTS рассказ может читаться голосом устройства.
- Публичные OSM endpoints не следует считать production-инфраструктурой.
- Production требует HTTPS/reverse proxy.
- Не использовать production `.env`, базу или пользовательские загрузки для локальных экспериментов.
- В README есть расхождение со средствами сброса пароля и удаления аккаунта; см. `research.md` и `spec.md`.

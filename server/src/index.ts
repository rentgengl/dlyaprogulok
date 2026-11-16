import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { buildApp } from './app.ts';
import { backfillCities } from './cities.ts';
import { openDb } from './db.ts';
import { realGeoServices } from './services.ts';
import { ADMIN_EMAILS, effectiveEnv, loadOverrides, servicesFromEnv } from './settings.ts';

const dataDir = process.env.DATA_DIR ?? './data';
mkdirSync(dataDir, { recursive: true });

const db = openDb(path.join(dataDir, 'rasskazhi.sqlite'));
// Настройки из админки перекрывают .env. Если с ними сервис не собирается (например, ключ отозван),
// сервер стартует на настройках из .env, чтобы админка оставалась доступной.
const overrides = loadOverrides(db);
let services;
let overrideError: unknown = null;
try {
  services = servicesFromEnv(effectiveEnv(process.env, overrides));
} catch (err) {
  if (!Object.keys(overrides).length) throw err;
  overrideError = err;
  services = servicesFromEnv(process.env);
}

const app = await buildApp({
  db,
  geo: realGeoServices,
  ai: services.ai,
  aiInfo: { provider: services.aiProvider, model: services.aiModel },
  tts: services.tts,
  uploadsDir: path.join(dataDir, 'uploads'),
  trustProxy: process.env.TRUST_PROXY === '1',
  mailer: services.mailer,
  appUrl: services.appUrl,
  routeMonthlyLimit: services.routeMonthlyLimit,
  webIndexPath: process.env.WEB_INDEX || undefined,
  tiles: services.tiles,
  adminEmails: ADMIN_EMAILS(process.env),
  baseEnv: process.env,
});

if (overrideError) app.log.error(overrideError, 'Настройки из админки не применились, сервер работает на .env');
if (Object.keys(overrides).length) app.log.info(`Из админки заданы: ${Object.keys(overrides).join(', ')}`);
if (services.aiProvider) {
  app.log.info(`ИИ: ${services.aiProvider}, модель ${services.aiModel}`);
} else {
  app.log.warn('Ключ ИИ не задан (ANTHROPIC_API_KEY или DEEPSEEK_API_KEY): подбор эвристический, рассказы из Википедии');
}
app.log.info(services.tts ? `Озвучка: ${services.tts.name}` : 'Озвучка выключена: рассказ читает голос устройства');
app.log.info(
  services.mailer
    ? `Почта: ${services.mailer.name}, подтверждение адреса обязательно`
    : 'Почта не настроена (SMTP_URL): подтверждение адреса не требуется',
);
app.log.info(
  services.routeMonthlyLimit ? `Лимит: ${services.routeMonthlyLimit} маршрутов в месяц на пользователя` : 'Лимит маршрутов выключен',
);

await app.listen({ port: Number(process.env.PORT ?? 3000), host: process.env.HOST ?? '0.0.0.0' });

backfillCities(db, realGeoServices, app.log).catch((err) => app.log.error(err));

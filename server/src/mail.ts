/** Отправка писем: SMTP любого почтового сервиса или вывод в лог для локальной разработки. */
import nodemailer from 'nodemailer';

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  /** Для лога при запуске. */
  name: string;
  send(mail: Mail): Promise<void>;
}

type Env = Record<string, string | undefined>;

/**
 * SMTP_URL — адрес сервера с логином и паролем, например smtps://user:password@smtp.yandex.ru:465;
 * MAIL_FROM — отправитель. MAIL_TRANSPORT=log вместо отправки пишет письма в лог (для разработки).
 * Без них почта выключена, и подтверждение адреса не требуется.
 */
export function createMailerFromEnv(env: Env, log: (msg: string) => void = console.log): Mailer | null {
  if (env.SMTP_URL) {
    if (!env.MAIL_FROM) throw new Error('SMTP_URL задан, а MAIL_FROM нет: укажите адрес отправителя');
    const transport = nodemailer.createTransport(env.SMTP_URL);
    const host = new URL(env.SMTP_URL).hostname;
    return {
      name: `SMTP ${host}`,
      async send(mail) {
        await transport.sendMail({ from: env.MAIL_FROM, ...mail });
      },
    };
  }
  if (env.MAIL_TRANSPORT === 'log') {
    return {
      name: 'лог (письма не отправляются)',
      async send(mail) {
        log(`Письмо для ${mail.to}: «${mail.subject}»\n${mail.text}`);
      },
    };
  }
  if (env.MAIL_TRANSPORT) throw new Error(`MAIL_TRANSPORT=${env.MAIL_TRANSPORT}: допустимо только log`);
  return null;
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function verificationMail(to: string, name: string, link: string): Mail {
  const text = [
    `${name}, здравствуйте!`,
    '',
    'Чтобы подтвердить почту в «Для прогулок», откройте ссылку:',
    link,
    '',
    'Ссылка действует 24 часа. Если вы не регистрировались, просто удалите это письмо.',
  ].join('\n');
  const html = `<p>${escapeHtml(name)}, здравствуйте!</p>
<p>Чтобы подтвердить почту в «Для прогулок», нажмите на кнопку:</p>
<p><a href="${escapeHtml(link)}" style="display:inline-block;padding:10px 18px;background:#24483e;color:#fff;border-radius:8px;text-decoration:none">Подтвердить почту</a></p>
<p style="color:#666">Или откройте ссылку: ${escapeHtml(link)}<br>Ссылка действует 24 часа. Если вы не регистрировались, просто удалите это письмо.</p>`;
  return { to, subject: 'Подтвердите почту в «Для прогулок»', text, html };
}

export function passwordResetMail(to: string, name: string, link: string): Mail {
  const text = [
    `${name}, здравствуйте!`,
    '',
    'Кто-то, возможно вы, попросил сбросить пароль в «Для прогулок». Чтобы задать новый пароль, откройте ссылку:',
    link,
    '',
    'Ссылка действует 1 час. Если вы не просили сбросить пароль, просто удалите это письмо: пароль останется прежним.',
  ].join('\n');
  const html = `<p>${escapeHtml(name)}, здравствуйте!</p>
<p>Кто-то, возможно вы, попросил сбросить пароль в «Для прогулок». Чтобы задать новый пароль, нажмите на кнопку:</p>
<p><a href="${escapeHtml(link)}" style="display:inline-block;padding:10px 18px;background:#24483e;color:#fff;border-radius:8px;text-decoration:none">Задать новый пароль</a></p>
<p style="color:#666">Или откройте ссылку: ${escapeHtml(link)}<br>Ссылка действует 1 час. Если вы не просили сбросить пароль, просто удалите это письмо: пароль останется прежним.</p>`;
  return { to, subject: 'Сброс пароля в «Для прогулок»', text, html };
}

export type SaleDecision = 'approve' | 'reject' | 'delist';

/** Решение администратора по платному маршруту (FR-012a, FR-012b). */
export function saleDecisionMail(
  to: string,
  name: string,
  routeTitle: string,
  decision: SaleDecision,
  note: string | null,
  link: string,
): Mail {
  const subject = {
    approve: `Маршрут «${routeTitle}» одобрен для продажи`,
    reject: `Маршрут «${routeTitle}» не прошёл проверку`,
    delist: `Маршрут «${routeTitle}» снят с продажи`,
  }[decision];
  const body = {
    approve: 'Маршрут проверен и опубликован в каталоге как платный. Покупатели смогут открыть его за баллы.',
    reject: 'Маршрут не прошёл проверку и остался приватным и бесплатным. Можно исправить его и отправить на проверку снова.',
    delist: 'Маршрут снят с продажи и скрыт из каталога. Те, кто уже открыл его, сохраняют доступ.',
  }[decision];
  const text = [`${name}, здравствуйте!`, '', body, ...(note ? ['', `Комментарий администратора: ${note}`] : []), '', link].join('\n');
  const html = `<p>${escapeHtml(name)}, здравствуйте!</p>
<p>${escapeHtml(body)}</p>
${note ? `<p>Комментарий администратора: ${escapeHtml(note)}</p>` : ''}
<p><a href="${escapeHtml(link)}">${escapeHtml(routeTitle)}</a></p>`;
  return { to, subject, text, html };
}

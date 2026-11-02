import https from 'https';
import { log } from '../core/logger.js';

let config: { botToken: string; chatId: string } | null = null;

export function configureTelegram(botToken: string, chatId: string): void {
  if (!botToken || !chatId) {
    log('WARN', 'Telegram: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set. Notifications are off.');
    return;
  }
  config = { botToken, chatId };
  log('INFO', 'Telegram: notifications on.');
}

function post(pathName: string, body: Buffer | string, contentType: string): Promise<{ status: number; data: string }> {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${config!.botToken}/${pathName}`,
      method: 'POST',
      headers: { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, data }));
    });
    req.on('error', (err) => resolve({ status: 0, data: err.message }));
    req.write(body);
    req.end();
  });
}

export async function sendTelegram(message: string): Promise<boolean> {
  if (!config) return false;
  // Plain text on purpose: job titles, company names and URLs often contain _ * [ ],
  // which break Telegram Markdown and make the message fail with HTTP 400.
  const { status, data } = await post('sendMessage', JSON.stringify({ chat_id: config.chatId, text: message }), 'application/json');
  if (status === 200) return true;
  log('ERROR', `Telegram: send failed (${status}) ${data}`);
  return false;
}

export async function notifyApplication(company: string, jobTitle: string, score: number, dryRun: boolean): Promise<void> {
  await sendTelegram(`${dryRun ? 'DRY-RUN' : 'APPLIED'}\n${jobTitle} - ${company}\nScore: ${score}/10`);
}

export async function notifySummary(total: number, errors: number, dryRun: boolean): Promise<void> {
  await sendTelegram(`Run summary ${dryRun ? '(dry-run)' : ''}\nApplications: ${total}\nErrors: ${errors}`);
}

export async function notifyError(message: string): Promise<void> {
  await sendTelegram(`ERROR\n${message}`);
}

// ========== CAPTCHA HANDOFF ==========

export async function sendTelegramPhoto(photo: Buffer, caption: string): Promise<boolean> {
  if (!config) return false;
  const boundary = `----FormBoundary${Date.now()}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${config.chatId}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="captcha.png"\r\nContent-Type: image/png\r\n\r\n`),
    photo,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const { status, data } = await post('sendPhoto', body, `multipart/form-data; boundary=${boundary}`);
  if (status === 200) return true;
  log('ERROR', `Telegram: photo upload failed (${status}) ${data}`);
  return false;
}

type Update = { update_id: number; message?: { chat: { id: number }; text?: string } };

function getUpdates(offset: number): Promise<Update[]> {
  if (!config) return Promise.resolve([]);
  const params = new URLSearchParams({ offset: String(offset), timeout: '5', allowed_updates: JSON.stringify(['message']) });
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${config!.botToken}/getUpdates?${params}`,
      method: 'GET',
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data) as { ok: boolean; result: Update[] };
          resolve(parsed.ok ? parsed.result : []);
        } catch {
          resolve([]);
        }
      });
    });
    req.on('error', () => resolve([]));
    req.end();
  });
}

export type CaptchaStatus = 'solved' | 'skip' | 'timeout';

const SOLVED_REPLIES = ['OK', 'DONE', 'SOLVED'];
const SKIP_REPLIES = ['SKIP'];

/**
 * Sends a CAPTCHA screenshot and waits up to 5 minutes for the user's reply.
 *
 * reCAPTCHA/Turnstile/hCaptcha have no text answer someone could type remotely, the token
 * is created inside the browser. So we ask the user to solve it by hand in the open
 * Chrome window and reply OK, or SKIP to drop the job.
 */
export async function askHumanToSolveCaptcha(screenshotBase64: string, pageUrl: string): Promise<CaptchaStatus> {
  if (!config) {
    log('ERROR', 'CAPTCHA: Telegram is not configured, so nobody can be asked to solve it.');
    return 'timeout';
  }
  const chatId = parseInt(config.chatId, 10);

  // Skip old updates so only new replies count.
  let offset = 0;
  const pending = await getUpdates(-1);
  if (pending.length) {
    offset = pending[pending.length - 1].update_id + 1;
    await getUpdates(offset);
  }

  const caption = `CAPTCHA / anti-bot check\n\nURL: ${pageUrl}\n\nSolve it by hand in the open Chrome window, then reply OK. Reply SKIP to drop this job.`;
  if (!(await sendTelegramPhoto(Buffer.from(screenshotBase64, 'base64'), caption))) return 'timeout';

  const TIMEOUT_MS = 5 * 60 * 1000;
  const start = Date.now();
  log('INFO', 'CAPTCHA: waiting for a reply on Telegram (5 minutes)...');

  while (Date.now() - start < TIMEOUT_MS) {
    for (const update of await getUpdates(offset)) {
      offset = update.update_id + 1;
      const text = update.message?.chat.id === chatId ? update.message.text?.trim().toUpperCase() : undefined;
      if (!text) continue;
      if (SOLVED_REPLIES.includes(text)) {
        await sendTelegram('Got it, checking the page again...');
        return 'solved';
      }
      if (SKIP_REPLIES.includes(text)) {
        await sendTelegram('OK, skipping this job.');
        return 'skip';
      }
    }
    await new Promise(r => setTimeout(r, 2000));
  }

  log('WARN', 'CAPTCHA: no reply within 5 minutes.');
  await sendTelegram('No reply within 5 minutes, skipping this job.');
  return 'timeout';
}

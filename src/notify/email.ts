import { log } from '../core/logger.js';
import { escapeHtml } from '../dashboard/server.js';

// Optional email report after each run. Needs the SMTP_* and EMAIL_RECIPIENT values in .env
// (for Gmail, use an App Password: https://myaccount.google.com/apppasswords).

interface EmailConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  recipient: string;
}

let config: EmailConfig | null = null;

export function configureEmail(host: string, port: number, user: string, pass: string, recipient: string): void {
  if (!host || !user || !pass || !recipient) {
    log('WARN', 'Email: SMTP settings incomplete. Email reports are off.');
    return;
  }
  config = { host, port, user, pass, recipient };
  log('INFO', 'Email: reports on.');
}

export async function sendEmailReport(subject: string, html: string): Promise<boolean> {
  if (!config) return false;
  try {
    const nodemailer = await import('nodemailer');
    const transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.port === 465,
      auth: { user: config.user, pass: config.pass },
    });
    await transporter.sendMail({ from: `"HireHound" <${config.user}>`, to: config.recipient, subject, html });
    log('INFO', `Email: report sent to ${config.recipient}`);
    return true;
  } catch (error) {
    log('ERROR', `Email: send failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

export function buildReportHtml(data: {
  total: number;
  companies: string[];
  errors: string[];
  dryRun: boolean;
  avgScore: number;
}): string {
  const mode = data.dryRun ? 'DRY-RUN (nothing submitted)' : 'LIVE';
  const companies = data.companies.length
    ? data.companies.map(c => `<li>${escapeHtml(c)}</li>`).join('')
    : '<li>No applications this run</li>';
  const errors = data.errors.length
    ? data.errors.map(e => `<li style="color:#e74c3c">${escapeHtml(e)}</li>`).join('')
    : '<li style="color:#2ecc71">No errors</li>';

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family: -apple-system, sans-serif; background: #f5f5f5; padding: 24px;">
  <div style="max-width: 600px; margin: 0 auto; background: #fff; border-radius: 12px; padding: 32px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
    <h1 style="color: #2c3e50; margin-bottom: 8px;">HireHound report</h1>
    <p style="color: #7f8c8d; margin-top: 0;">Mode: <strong>${mode}</strong></p>
    <div style="background: #ecf0f1; border-radius: 8px; padding: 16px; margin: 16px 0;">
      <h2 style="margin: 0; font-size: 48px; color: #3498db;">${data.total}</h2>
      <p style="margin: 4px 0 0; color: #7f8c8d;">applications</p>
      <p style="margin: 4px 0 0; color: #7f8c8d;">Average score: ${data.avgScore.toFixed(1)}/10</p>
    </div>
    <h3 style="color: #2c3e50;">Companies</h3>
    <ul>${companies}</ul>
    <h3 style="color: #2c3e50;">Errors</h3>
    <ul>${errors}</ul>
  </div>
</body>
</html>`;
}

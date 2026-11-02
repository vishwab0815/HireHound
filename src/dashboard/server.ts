import http from 'http';
import { listApplications, getStats } from '../core/database.js';
import { log } from '../core/logger.js';

// Single server instance: in scheduled mode the main flow runs many times, and reopening
// the same port each time would crash with EADDRINUSE.
let server: http.Server | null = null;

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Allows only http/https links; anything else (e.g. javascript:) becomes '#'. */
export function safeUrl(url: unknown): string {
  const s = String(url ?? '');
  return /^https?:\/\//i.test(s) ? escapeHtml(s) : '#';
}

function renderPage(): string {
  const stats = getStats();
  const applications = listApplications(100);

  // Company, title and URL come from untrusted job pages, so every value is escaped.
  const rows = applications.map(a => `
    <tr>
      <td>${escapeHtml(a.appliedAt)}</td>
      <td>${escapeHtml(a.platform)}</td>
      <td>${escapeHtml(a.company)}</td>
      <td>${escapeHtml(a.jobTitle)}</td>
      <td><span class="score ${a.score && a.score >= 7 ? 'high' : a.score && a.score >= 5 ? 'mid' : 'low'}">${a.score || '-'}</span></td>
      <td><span class="status ${escapeHtml(a.status)}">${escapeHtml(a.status)}</span></td>
      <td>${escapeHtml(a.outcome ?? 'waiting')}</td>
      <td><a href="${safeUrl(a.url)}" target="_blank" rel="noopener noreferrer">Open</a></td>
    </tr>`).join('');

  const platformCards = stats.byPlatform.map(p => `
    <div class="card">
      <div class="value">${p.total}</div>
      <div class="label">${escapeHtml(p.platform)}</div>
      <div class="sub">Avg score: ${p.avgScore ? p.avgScore.toFixed(1) : '-'}</div>
    </div>`).join('');

  // Outcome funnel. Only applications with a known outcome count in the denominator;
  // with no data we show a hint instead of a misleading 0%.
  const count = (o: string) => stats.byOutcome.find(x => x.outcome === o)?.total ?? 0;
  const withOutcome = stats.byOutcome.filter(x => x.outcome !== 'waiting').reduce((acc, x) => acc + x.total, 0);
  const interviews = count('interview') + count('offer');
  const replyRate = withOutcome > 0 ? Math.round(((withOutcome - count('no_response')) / withOutcome) * 100) : null;

  const funnel = withOutcome > 0 ? `
    <div class="card"><div class="value">${replyRate}%</div><div class="label">Reply rate</div><div class="sub">${withOutcome} with a known outcome</div></div>
    <div class="card"><div class="value">${interviews}</div><div class="label">Interviews + offers</div></div>` : `
    <div class="card" style="min-width: 280px;">
      <div class="label">Outcome funnel</div>
      <div class="sub">Mark outcomes with "npm run result &lt;id&gt; &lt;outcome&gt;" to see reply rates here.</div>
    </div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="refresh" content="30">
<title>HireHound</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f172a; color: #e2e8f0; padding: 24px; }
  h1 { font-size: 24px; margin-bottom: 24px; color: #f8fafc; }
  .cards { display: flex; gap: 16px; margin-bottom: 24px; flex-wrap: wrap; }
  .card { background: #1e293b; border-radius: 12px; padding: 20px; min-width: 150px; }
  .value { font-size: 32px; font-weight: 700; color: #38bdf8; }
  .label { font-size: 14px; color: #94a3b8; margin-top: 4px; }
  .sub { font-size: 12px; color: #64748b; margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; background: #1e293b; border-radius: 12px; overflow: hidden; }
  th { background: #334155; padding: 12px 16px; text-align: left; font-size: 13px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.5px; }
  td { padding: 10px 16px; border-top: 1px solid #334155; font-size: 14px; }
  tr:hover { background: #334155; }
  a { color: #38bdf8; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .score { display: inline-block; width: 28px; height: 28px; line-height: 28px; text-align: center; border-radius: 50%; font-size: 12px; font-weight: 700; }
  .score.high { background: #166534; color: #4ade80; }
  .score.mid { background: #854d0e; color: #fbbf24; }
  .score.low { background: #991b1b; color: #fca5a5; }
  .status { padding: 4px 10px; border-radius: 12px; font-size: 12px; font-weight: 600; }
  .status.applied { background: #166534; color: #4ade80; }
  .status.dry-run { background: #1e40af; color: #93c5fd; }
  .empty { text-align: center; padding: 48px; color: #64748b; }
</style>
</head>
<body>
  <h1>HireHound</h1>
  <div class="cards">
    <div class="card">
      <div class="value">${stats.today.total}</div>
      <div class="label">Today</div>
      <div class="sub">Avg score: ${stats.today.avgScore ? stats.today.avgScore.toFixed(1) : '-'}</div>
    </div>
    <div class="card"><div class="value">${stats.total}</div><div class="label">All time</div></div>
    ${platformCards}
    ${funnel}
  </div>
  ${applications.length ? `
  <table>
    <thead>
      <tr><th>Date</th><th>Platform</th><th>Company</th><th>Job</th><th>Score</th><th>Status</th><th>Outcome</th><th>Link</th></tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>` : '<div class="empty">No applications yet.</div>'}
</body>
</html>`;
}

export function startDashboard(port: number): void {
  if (server) return;

  const srv = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
    res.end(renderPage());
  });

  srv.on('error', (err) => {
    log('ERROR', `Dashboard: could not use port ${port}: ${err.message}`);
    server = null;
  });

  // Bind to localhost only so the application history isn't exposed on the network.
  srv.listen(port, '127.0.0.1', () => log('INFO', `Dashboard running at http://localhost:${port}`));
  server = srv;
}

export function stopDashboard(): void {
  if (server) {
    server.close();
    server = null;
  }
}

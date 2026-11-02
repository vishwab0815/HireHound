// Read-only helper: prints your Internshala applications page and whether each given job page
// shows "Already applied".
//   npx tsx scripts/internshala/check-applied.ts <jobUrl> [jobUrl...]
import 'dotenv/config';
import { chromium } from 'playwright-core';

const JOBS = process.argv.slice(2);
const browser = await chromium.connectOverCDP(process.env.CDP_ENDPOINT || 'http://localhost:9222');
const page = await browser.contexts()[0].newPage();
await page.addInitScript('window.__name = window.__name || ((f) => f);');

try {
  await page.goto('https://internshala.com/student/applications', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  const text = await page.evaluate(() => document.body.innerText);
  const start = text.indexOf('APPLICATION STATUS');
  console.log('=== MY APPLICATIONS\n', text.slice(start >= 0 ? start : 0, (start >= 0 ? start : 0) + 2000));

  for (const url of JOBS) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    const applied = await page.locator('.detail_view').getByText(/already applied/i).first().isVisible().catch(() => false);
    const canApply = await page.locator('#top_easy_apply_button').isVisible().catch(() => false);
    console.log(`=== ${url}\n    already applied: ${applied}, apply button: ${canApply}`);
  }
} finally {
  await page.close();
  await browser.close();
}

// Read-only helper: walks a listing page, opens application forms and prints the markup of the
// "additional questions" section, to see which field types employers use. Never submits.
//   npx tsx scripts/internshala/inspect-questions.ts [listingUrl] [howMany]
import 'dotenv/config';
import { chromium } from 'playwright-core';

const LIST_URL = process.argv[2] ?? 'https://internshala.com/jobs/machine-learning-jobs/';
const MAX = parseInt(process.argv[3] ?? '3', 10);

const browser = await chromium.connectOverCDP(process.env.CDP_ENDPOINT || 'http://localhost:9222');
const page = await browser.contexts()[0].newPage();
await page.addInitScript('window.__name = window.__name || ((f) => f);');

try {
  await page.goto(LIST_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  const links = await page.$$eval('.individual_internship a.job-title-href', els => els.map(e => (e as HTMLAnchorElement).href));

  let found = 0;
  for (const url of links.slice(0, 15)) {
    if (found >= MAX) break;
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    const apply = page.locator('#top_easy_apply_button');
    if (!(await apply.count()) || !(await apply.isVisible())) continue;

    await apply.click();
    await page.waitForTimeout(2500);
    const proceed = page.locator('button:has-text("Proceed to application")');
    if (await proceed.count() && await proceed.first().isVisible()) {
      await proceed.first().click();
      await page.waitForTimeout(2500);
    }

    const html = await page.evaluate(() => {
      const q = document.querySelector('#assessment_questions')?.cloneNode(true) as HTMLElement | undefined;
      if (!q) return null;
      q.querySelector('#confirm_availability_container')?.remove();
      q.querySelectorAll('input[type=hidden]').forEach(e => e.remove());
      return q.outerHTML.replace(/\s+/g, ' ').slice(0, 7000);
    });
    console.log(`\n=== ${url}\n${html}`);
    if (html && html.includes('additional_question')) found++;
    await page.locator('#easy_apply_modal_close').click().catch(() => {});
    await page.waitForTimeout(800);
  }
} finally {
  await page.close();
  await browser.close();
}

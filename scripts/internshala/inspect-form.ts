// Read-only helper: opens an Internshala listing, picks one job, opens its application form
// and prints the cards, buttons and form fields. It never submits anything.
//   npx tsx scripts/internshala/inspect-form.ts [listingUrl] [jobIndex]
import 'dotenv/config';
import { chromium } from 'playwright-core';

const LIST_URL = process.argv[2] ?? 'https://internshala.com/jobs/data-science-jobs/';
const PICK = parseInt(process.argv[3] ?? '2', 10);

const browser = await chromium.connectOverCDP(process.env.CDP_ENDPOINT || 'http://localhost:9222');
const page = await browser.contexts()[0].newPage();
await page.addInitScript('window.__name = window.__name || ((f) => f);');

try {
  await page.goto(LIST_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);

  const cards = await page.$$eval('.individual_internship[internshipid]', els =>
    els.slice(0, 3).map(e => e.outerHTML.replace(/\s+/g, ' ').slice(0, 2000)));
  console.log(`=== ${cards.length} CARDS (first 3)\n${cards.join('\n\n')}`);

  const links = await page.$$eval('.individual_internship a.job-title-href', els => els.map(e => (e as HTMLAnchorElement).href));
  const url = links[PICK];
  console.log('\n=== OPENING', url);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);

  const buttons = await page.$$eval('button, a.btn', els => els
    .filter(b => (b as HTMLElement).offsetParent)
    .map(b => `${b.tagName}#${b.id}.${b.className} | ${(b as HTMLElement).innerText.trim().slice(0, 40)}`)
    .slice(0, 25));
  console.log('=== BUTTONS', buttons);

  const apply = page.locator('#top_easy_apply_button');
  if (!(await apply.count()) || !(await apply.isVisible())) {
    console.log('=== No easy-apply button (already applied, or external application).');
  } else {
    await apply.click();
    await page.waitForTimeout(3000);
    const proceed = page.locator('button:has-text("Proceed to application")');
    if (await proceed.count() && await proceed.first().isVisible()) {
      await proceed.first().click();
      await page.waitForTimeout(3000);
    }
    const fields = await page.$$eval('#application-form input, #application-form textarea, #application-form select, #application-form [contenteditable=true]',
      els => els.map(el => {
        const e = el as HTMLInputElement;
        return { tag: e.tagName, type: e.type, id: e.id, name: e.name, visible: !!e.offsetParent, required: e.required || e.getAttribute('aria-required') === 'true' };
      }).filter(f => f.type !== 'hidden'));
    console.log('=== FORM FIELDS', JSON.stringify(fields, null, 1));
    await page.locator('#easy_apply_modal_close').click().catch(() => {});
  }
} finally {
  await page.close();
  await browser.close();
}

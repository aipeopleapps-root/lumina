import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
page.on('pageerror', err => console.log('PAGEERROR:', err.message));

await page.goto('http://localhost:5173');
await page.waitForTimeout(1500);
await page.click('text=RFP Reimagine');
await page.waitForTimeout(500);
await page.fill('input[placeholder*="Cleveland Clinic"]', 'Cleveland Clinic');
await page.click('button:has-text("Look up")');
await page.waitForTimeout(4000);
await page.click('button:has-text("HCM")');
await page.click('button:has-text("Payroll")');
await page.click('button:has-text("Generate RFP Package")');
console.log('generation triggered, polling until done (up to 3 min)...');

let done = false;
for (let i = 0; i < 36; i++) {
  await page.waitForTimeout(5000);
  const bodyText = await page.textContent('body');
  if (bodyText.includes('Copy') || bodyText.includes('Generation failed')) {
    console.log(`done after ~${(i+1)*5}s`);
    done = true;
    break;
  }
}
if (!done) console.log('still not done after 3 min, capturing anyway');
await page.screenshot({ path: '/tmp/e2e-final-results.png', fullPage: true });
await browser.close();

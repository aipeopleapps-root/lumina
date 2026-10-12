import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
await page.goto('http://localhost:5173');
await page.waitForTimeout(1500);
await page.click('text=RFP Reimagine');
await page.waitForTimeout(500);
await page.fill('input[placeholder*="Cleveland Clinic"]', 'Cleveland Clinic');
await page.click('button:has-text("Look up")');
await page.waitForTimeout(4000);
await page.click('button:has-text("HCM")');
await page.click('button:has-text("Generate RFP Package")');
for (let i = 0; i < 36; i++) {
  await page.waitForTimeout(5000);
  const t = await page.textContent('body');
  if (t.includes('Copy')) break;
}
await page.click('button:has-text("Cover Letter")');
await page.waitForTimeout(300);
await page.screenshot({ path: '/tmp/e2e-cover.png', fullPage: true });
await page.click('button:has-text("Project Plan")');
await page.waitForTimeout(300);
await page.screenshot({ path: '/tmp/e2e-project.png', fullPage: true });
await page.click('button:has-text("Resource Plan")');
await page.waitForTimeout(300);
await page.screenshot({ path: '/tmp/e2e-resource.png', fullPage: true });
console.log('all tabs captured');
await browser.close();

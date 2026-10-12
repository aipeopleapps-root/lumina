import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.on('pageerror', err => console.log('PAGEERROR:', err.message));
await page.goto('http://localhost:5173');
await page.waitForTimeout(1500);
await page.screenshot({ path: '/tmp/platform-home.png', fullPage: true });
console.log('captured platform home');
await browser.close();

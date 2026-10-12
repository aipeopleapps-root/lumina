import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.on('pageerror', err => console.log('PAGEERROR:', err.message));

await page.goto('http://localhost:5173');
await page.waitForTimeout(1500);

// Click RFP Reimagine tile
await page.click('text=RFP Reimagine');
await page.waitForTimeout(500);
await page.screenshot({ path: '/tmp/click-rfp.png', fullPage: true });

// Go back home
await page.click('text=Lumina.');
await page.waitForTimeout(500);
await page.screenshot({ path: '/tmp/back-home.png', fullPage: true });

// Click a coming-soon tile
await page.click('text=ConfigGuard');
await page.waitForTimeout(300);
await page.screenshot({ path: '/tmp/click-comingsoon.png', fullPage: true });

// Click Process Intelligence
await page.click('text=Process Intelligence');
await page.waitForTimeout(800);
await page.screenshot({ path: '/tmp/click-pi.png', fullPage: true });

console.log('all flows captured');
await browser.close();

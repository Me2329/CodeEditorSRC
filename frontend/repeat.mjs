import { chromium } from 'playwright-core';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
for (let run = 1; run <= 8; run += 1) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const problems = [];
  page.on('pageerror', (e) => problems.push(String(e.stack || e)));
  await page.goto('http://127.0.0.1:5199/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);
  await page.click('.monaco-editor .view-lines');
  await page.keyboard.press('Control+a');
  await page.keyboard.type('class Engine:\n');
  await page.keyboard.type('def start(self):\n');
  await page.keyboard.type('value = 1\n');
  await page.keyboard.type('return value\n');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.keyboard.type('\ndef main():\n');
  await page.keyboard.type('engine = Engine()\n');
  await page.keyboard.type('engine.start()\n');
  await page.waitForTimeout(2500);
  await page.locator('.view-line span:text-is("Engine")').last().click();
  await page.keyboard.press('Shift+F12');
  await page.waitForTimeout(1200);
  await page.locator('.view-line span:text-is("Engine")').last().click();
  await page.keyboard.press('F12');
  await page.waitForTimeout(1200);
  console.log(`run ${run}: ${problems.length} page errors`);
  if (problems.length) {
    const frames = problems[0].split('\n').filter((line) => line.includes('/src/'));
    console.log('  our frames:', frames.slice(0, 6).join('\n    ') || '(none in our code)');
  }
  await page.close();
}
await browser.close();

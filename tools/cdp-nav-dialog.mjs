/* 连接运行中的 Electron（CDP），打开「新建连接」弹窗并截图。 */
import { createRequire } from 'node:module';

const require = createRequire('C:/Users/liyan/.workbuddy/binaries/node/versions/22.22.2-6/node_modules/@playwright/cli/');
const { chromium } = require('playwright-core');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0];
  console.log('connected:', page.url());

  // 点击连接树头部的新建连接按钮（+ 主色按钮）
  const plus = page.locator('button[title*="新建"], button[aria-label*="新建"]').first();
  if (await plus.count()) {
    await plus.click().catch(() => {});
    await sleep(2500);
  } else {
    console.log('WARN: 未找到新建按钮');
  }

  await page.screenshot({ path: 'C:/Users/liyan/AppData/Local/Temp/dbnest-dialog.png' });
  const txt = await page.locator('body').innerText();
  console.log('--- body text (前 900 字) ---');
  console.log(txt.slice(0, 900));
  process.exit(0);
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });

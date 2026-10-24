/* 连接运行中的 Electron（CDP），打开一张表的数据页并截图。
 * 用法: node tools/cdp-nav-table.mjs
 */
import { createRequire } from 'node:module';

const require = createRequire('C:/Users/liyan/.workbuddy/binaries/node/versions/22.22.2-6/node_modules/@playwright/cli/');
const { chromium } = require('playwright-core');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0];
  console.log('connected:', page.url());

  // 1) 展开 MySQL 连接
  await page.locator('text=/192\\.168\\.31\\.100/').first().click({ timeout: 5000 }).catch(() => {});
  await sleep(1200);

  // 2) 双击第一个数据库（ai-vans）展开表列表
  const db = page.locator('text=ai-vans').first();
  await db.dblclick({ timeout: 5000 }).catch(() => {});
  await sleep(1800);

  // 3) 双击第一张表
  const tbl = page.locator('[title*="表"], [title*="数据"]').first();
  if (await tbl.count()) {
    await tbl.dblclick().catch(() => {});
    await sleep(3000);
  }

  await page.screenshot({ path: 'C:/Users/liyan/AppData/Local/Temp/dbnest-table.png' });
  const txt = await page.locator('body').innerText();
  console.log('--- body text (前 1200 字) ---');
  console.log(txt.slice(0, 1200));
  process.exit(0);
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });

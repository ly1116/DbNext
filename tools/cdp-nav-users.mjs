/* 连接运行中的 Electron（CDP），导航到「用户与权限管理」页并截图。
 * 用法: node tools/cdp-nav-users.mjs
 */
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';

const require = createRequire('C:/Users/liyan/.workbuddy/binaries/node/versions/22.22.2-6/node_modules/@playwright/cli/');
const { chromium } = require('playwright-core');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0];
  console.log('connected:', page.url());

  // 1) 展开第一个 MySQL 连接（树节点文本含 192.168）
  const conn = page.locator('text=/192\\.168\\.31\\.100/').first();
  await conn.click({ timeout: 5000 }).catch(() => {});
  await sleep(1200);

  // 2) 点「用户与权限管理」节点（title 属性匹配）
  const users = page.locator('[title*="用户与权限管理"]').first();
  if (await users.count()) {
    await users.click();
    await sleep(2500);
  } else {
    console.log('WARN: 未找到用户节点，尝试再次展开连接');
    await conn.click();
    await sleep(1500);
    const users2 = page.locator('[title*="用户"]').first();
    if (await users2.count()) { await users2.click(); await sleep(2500); }
  }

  writeFileSync('C:/Users/liyan/AppData/Local/Temp/dbnest-tree.html', await page.content());
  await page.screenshot({ path: 'C:/Users/liyan/AppData/Local/Temp/dbnest-users.png' });
  console.log('saved users page screenshot');

  // 3) 顺便输出主区域可见文本，确认页面状态
  const txt = await page.locator('body').innerText();
  console.log('--- body text (前 1500 字) ---');
  console.log(txt.slice(0, 1500));
  // 注意：不要 browser.close() / disconnect()——over-CDP 关闭会破坏 Electron 的 DevTools 会话，
  // 导致后续 CDP 截图无响应。直接退出进程即可（WebSocket 随进程退出而关闭）。
  process.exit(0);
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });

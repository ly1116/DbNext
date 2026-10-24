/* 通过 CDP 截取运行中的 Electron 窗口画面。
 * 用法: node tools/cdp-shot.mjs [输出路径] [端口]
 * 依赖 Node >= 22 的全局 WebSocket。
 */
import { writeFileSync } from 'node:fs';

const out = process.argv[2] || '/tmp/dbnest-cdp.png';
const port = Number(process.argv[3] || 9222);

async function main() {
  // 1. 列出所有 target，挑第一个 page 类型
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error(`未找到 page target（共 ${list.length} 个 target）`);

  // 2. 连上该 target 的 WebSocket
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('WebSocket 连接失败'));
  });

  // 3. 调用 Page.captureScreenshot（等渲染稳定，先空跑一帧）
  const send = (method, params) =>
    new Promise((res, rej) => {
      const id = Math.floor(Math.random() * 1e9);
      const onMsg = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id === id) {
          ws.removeEventListener('message', onMsg);
          m.error ? rej(new Error(m.error.message)) : res(m.result);
        }
      };
      ws.addEventListener('message', onMsg);
      ws.send(JSON.stringify({ id, method, params }));
    });

  await send('Page.enable');
  await send('Runtime.evaluate', { expression: '1' });
  await new Promise((r) => setTimeout(r, 800));
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  ws.close();
  if (!shot?.data) throw new Error('截图返回为空');
  writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log(`saved ${out} (${page.title} @ ${page.url})`);
}

main().catch((e) => {
  console.error('CDP 截图失败:', e.message);
  process.exit(1);
});

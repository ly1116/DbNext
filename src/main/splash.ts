import { BrowserWindow } from 'electron';

/**
 * 启动页（Splash）内容：纯 CSS 动画，无脚本，规避白屏/黑屏闪现。
 *
 * 风格与 darcula 暗色主题同源：冷调近黑底（#0f1319）+ 单一利落蓝强调（#4d8dff），
 * 朴素克制（单一呼吸光环 + 细进度条），不引入渐变/彩色光球等花哨装饰。
 *
 * 历史：黑屏根因为偏好存的是 `dracula` 而代码内部约定 `darcula`，
 * `.dark` 类因此未挂载 → shadcn 暗色令牌失效、近黑原生窗口底透出 → 黑屏。
 * 该问题已由 `normalizeTheme` 在渲染端修复；启动页则独立保证「先有内容、再显主窗」。
 */

const SPLASH_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: #0f1319; overflow: hidden;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  font-family: -apple-system, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
  -webkit-user-select: none; user-select: none; }
.mark { width: 48px; height: 48px; border-radius: 13px; background: #161b23;
  border: 1px solid #232b37; position: relative; display: flex; align-items: center; justify-content: center; }
.mark::before { content: ""; width: 19px; height: 19px; border: 2px solid #4d8dff; border-radius: 5px; transform: rotate(45deg); }
.mark::after { content: ""; position: absolute; width: 19px; height: 19px; border: 2px solid #4d8dff;
  border-radius: 5px; transform: rotate(45deg); opacity: .22; animation: pulse 1.5s ease-in-out infinite; }
@keyframes pulse { 0%,100% { transform: rotate(45deg) scale(1); opacity: .22; } 50% { transform: rotate(45deg) scale(1.55); opacity: .04; } }
.name { margin-top: 20px; color: #e6eaf1; font-size: 21px; font-weight: 600; letter-spacing: .5px; }
.sub { margin-top: 7px; color: #7c8797; font-size: 11px; letter-spacing: 3px; text-transform: uppercase; }
.bar { margin-top: 24px; width: 184px; height: 3px; border-radius: 3px; background: #1f2733; overflow: hidden; }
.bar > i { display: block; height: 100%; width: 42%; border-radius: 3px; background: #4d8dff;
  animation: load 1.1s ease-in-out infinite; }
@keyframes load { 0% { transform: translateX(-110%); } 100% { transform: translateX(330%); } }
</style></head><body>
<div class="mark"></div>
<div class="name">DataRoost</div>
<div class="sub">Database Workbench</div>
<div class="bar"><i></i></div>
</body></html>`;

/** 启动页首次可见时刻，用于保证最短展示时长（避免一闪而过） */
let splashShownAt = 0;

/**
 * 创建启动页窗口（frame:false、置顶、居中、不进任务栏）。
 * 内容经 data URL 即时渲染，远快于主窗口（dev 需等 Vite、prod 需等 React 挂载），
 * 故主窗口加载期间由它覆盖，杜绝空白/黑屏闪现。
 */
export function createSplash(): BrowserWindow {
  const splash = new BrowserWindow({
    width: 360,
    height: 224,
    frame: false,
    backgroundColor: '#0f1319',
    transparent: false,
    alwaysOnTop: true,
    center: true,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  splash.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(SPLASH_HTML));
  splash.once('ready-to-show', () => {
    splashShownAt = Date.now();
    splash.show();
  });
  return splash;
}

/**
 * 主窗口就绪后平滑淡出并销毁启动页。
 * @param splash       启动页窗口（可能为 null：非首启、重建窗口等场景不展示）
 * @param minVisibleMs 最短展示时长，保证动画至少被感知一次
 */
export function dismissSplash(splash: BrowserWindow | null, minVisibleMs = 720): void {
  if (!splash || splash.isDestroyed()) return;
  const elapsed = Date.now() - splashShownAt;
  const wait = elapsed >= minVisibleMs ? 0 : minVisibleMs - elapsed;
  setTimeout(() => {
    if (!splash || splash.isDestroyed()) return;
    // 尚未可见（极端快速加载下）：直接销毁，避免露出一帧即消失的突兀感
    if (!splash.isVisible()) {
      try { splash.destroy(); } catch { /* noop */ }
      return;
    }
    // 软件渲染下逐帧降低不透明度，做平滑淡出
    let opacity = 1;
    const fade = () => {
      opacity -= 0.12;
      if (opacity <= 0) {
        try { splash.destroy(); } catch { /* noop */ }
        return;
      }
      try {
        splash.setOpacity(opacity);
      } catch {
        try { splash.destroy(); } catch { /* noop */ }
        return;
      }
      setTimeout(fade, 24);
    };
    fade();
  }, wait);
}

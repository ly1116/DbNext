# DbNest

> 跨平台桌面级一体化运维与数据库管理客户端：SSH 终端 + SFTP + SQL 编辑器 + 数据网格 + Redis + 传输向导 + 结构对比 + 云同步 + 堡垒机 + AI 助手。

[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-0e639c)](#)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](#)
[![Stack](https://img.shields.io/badge/stack-Electron%20%2B%20React%20%2B%20TypeScript-1177bb)](#)

DbNest 把开发 / 运维 / DBA 的日常工作收敛到一个深色主题的桌面客户端里。本仓库是从高保真原型
（`b.html`）落地而来的**可运行工程**：同一套代码产出 Windows / macOS / Linux 原生安装包。

---

## ✨ 特性

| # | 能力 | 说明 |
| - | ---- | ---- |
| ① | **SSH + SFTP + AI 工作台** | 多标签终端、命令广播、录制；SFTP 文件树跟随终端 pwd、断点续传队列；AI 侧栏带上下文 |
| ② | **SQL 编辑器** | 自实现语法高亮（VS Code Dark+ 配色）、运行、限制行数、结果 / 消息 / 执行计划三标签 |
| ③ | **数据网格** | 结果集排序、空值标记、数字右对齐、表头吸顶 |
| ④ | **Redis** | key 列表过滤、类型 / TTL / 值预览 |
| ⑤ | **传输向导** | 库↔库 / 库↔文件 的导入导出向导 |
| ⑥ | **连接编辑** | 分组、环境标签、SSH 跳板、测试连通性 |
| ⑦ | **结构对比** | 源/目标库表结构差异可视化（新增 / 修改 / 删除） |
| ⑧ | **云同步** | 连接配置加密多端同步 |
| ⑨ | **堡垒机** | 通过 JumpServer 风格堡垒机代理接入 |
| ⑩ | **SFTP 全屏** | 本地 / 远端双栏文件管理器 |
| ⑪ | **AI 深度任务** | 代码审查 / SQL 生成 / 性能优化的完整 AI 工作台 |

---

## 🏗 架构

```
┌──────────────────────────────────────────────────────────┐
│                      Electron Main 进程                     │
│  main.ts       窗口 / 生命周期                              │
│  ipc.ts        IPC 路由（连接/终端/SFTP/Redis/AI/SQL）       │
│  services/      业务服务（mock 适配器，接口可替换为真实实现） │
│  preload.ts    contextBridge 安全 API 白名单                │
└───────────────────────────┬──────────────────────────────┘
                              │ IPC（类型单一来源：shared/types.ts）
┌───────────────────────────▼──────────────────────────────┐
│                    React Renderer 进程                      │
│  shell/    标题栏 / 顶部 11 屏导航 / 状态栏                  │
│  screens/  11 个工作台屏幕                                   │
│  store/    Zustand 全局状态                                  │
│  api.ts    渲染侧封装（Electron 优先，浏览器自动降级 mock）   │
└──────────────────────────────────────────────────────────┘
```

**设计要点**

- **三层分离**：主进程 / 预加载 / 渲染进程职责清晰；渲染进程不直接 `require('electron')`，仅经 `contextBridge` 白名单通信（`contextIsolation: true`、`nodeIntegration: false`）。
- **类型单一来源**：`src/shared/types.ts` 与 `src/shared/ipc-channels.ts` 被两端共享，避免 IPC 数据结构漂移。
- **可插拔服务**：主进程 `services/` 当前为 mock 适配器，真实 SSH / 数据库 / Redis / LLM 接入只需实现相同接口（见路线图）。
- **开箱即跑**：渲染侧 `api.ts` 在无 preload 的浏览器环境自动降级到本地 mock，因此 `npm run web` 即可完整预览 UI。

---

## 🚀 快速开始

### 环境要求

- Node.js ≥ 20
- npm ≥ 9

### 安装

```bash
git clone <repo> dbnest
cd dbnest
npm install
```

### 开发预览（浏览器，无需 Electron）

```bash
npm run web      # 启动 Vite，打开 http://localhost:5173
```

> 浏览器模式使用本地 mock 数据，完整演示全部 11 个屏幕的交互。

### 开发预览（桌面 Electron）

```bash
npm run electron:dev   # 打包主进程 + 启动 Electron 窗口
```

### 类型检查 / 构建

```bash
npm run typecheck      # 严格 TypeScript 类型检查
npm run lint           # ESLint（企业级规则，禁止 any）
npm run build          # 类型检查 + 渲染打包到 dist/
npm run build:main     # 主进程/预加载打包到 dist-electron/
```

### 打包安装包（Windows / macOS / Linux）

```bash
npm run dist
```

产物位于 `release/`：

- Windows → `NSIS` 安装包（`.exe`）
- macOS → `DMG`
- Linux → `AppImage` + `deb`

---

## 📁 目录结构

```
DbNest/
├── docs/PLAN.md              # 开发计划
├── src/
│   ├── shared/               # 主/渲染共享类型与 IPC 通道（单一来源）
│   ├── main/                 # Electron 主进程
│   │   ├── main.ts           # 入口
│   │   ├── preload.ts        # 安全桥接
│   │   ├── ipc.ts            # IPC 路由
│   │   ├── menu.ts           # 原生菜单
│   │   ├── logger.ts         # 主进程日志
│   │   ├── errors.ts         # 统一错误类型
│   │   └── services/         # 业务服务（mock 适配器）
│   └── renderer/             # React 渲染进程
│       ├── App.tsx           # 根组件与屏幕路由
│       ├── api.ts            # 渲染侧 API（Electron 优先 / 浏览器降级）
│       ├── store/            # Zustand 状态
│       ├── mock/             # 离线 mock 数据
│       ├── components/        # shell + workbench + common
│       └── screens/          # 11 个工作台屏幕
├── scripts/build-main.mjs    # esbuild 主进程打包
├── tailwind.config.js        # 设计 token（与原型一致）
├── vite.config.ts
└── package.json
```

---

## 🧩 技术栈

| 维度 | 选型 |
| ---- | ---- |
| 跨平台框架 | Electron |
| 渲染层 | React 18 + TypeScript + Vite |
| 样式 | Tailwind CSS（复用原型设计 token） |
| 状态 | Zustand |
| 打包 | electron-builder / esbuild |
| 工程化 | 严格 TS (`strict: true`) + ESLint + Prettier |

---

## 🗺 路线图

当前为 **MVP / 原型级** 实现，核心 UI 与架构已就绪，后续增量：

- [ ] 真实 SSH（`ssh2` + `node-pty`）与 xterm.js 终端
- [ ] 真实数据库驱动（mysql2 / pg）接入 SQL 编辑器与数据网格
- [ ] 真实 Redis（`ioredis`）与传输队列持久化
- [ ] AI 助手接入 LLM（OpenAI / 自建网关），支持流式输出与一键修复落盘
- [ ] 云同步后端（对象存储 / 自建服务）+ 端到端加密
- [ ] 堡垒机协议对接（JumpServer / 标准 SSH 代理）
- [ ] 自动更新（electron-updater）
- [ ] 单元测试（Vitest）与 E2E（Playwright）

欢迎提交 Issue / PR。

---

## 🤝 贡献

1. Fork 并创建特性分支 (`git checkout -b feat/xxx`)
2. 保持严格类型与注释规范（参考 `docs/PLAN.md` 第 5 节）
3. `npm run typecheck && npm run lint` 通过
4. 提交 PR

---

## 📄 许可证

[MIT](./LICENSE)

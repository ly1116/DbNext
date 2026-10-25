
# DbNest 前端开发规范（Electron + React + TS）

## 一、分层架构（强制）
- **三层物理隔离**：
  - `src/main/` 主进程（Node 能力：数据库驱动、SSH、SFTP、文件、密钥）—— 持有所有原生/敏感逻辑，**绝不直接碰 DOM/React**。
  - `src/renderer/` 渲染进程（UI、状态、主题、CodeMirror）—— 不直接 `require` 主进程专有模块（oracledb/ssh2 等）。
  - `src/shared/` 共享层（`types/`、`ipc-channels`）—— 放**跨进程的类型与通道常量**，主/渲染都 import，禁止放运行时代码。
- **通信只走 IPC**：渲染层一律 `window.api.*`（preload 白名单），不 `ipcRenderer.send` 裸调；主进程 `ipcMain.handle` 注册，通道名**集中在 `shared/ipc-channels.ts`**，新增通道须同步补齐 `preload.ts` / `api.ts` / `vite-env.d.ts` 的类型声明。
- **主进程改动必 `npm run build:main` 后重启实例才生效**；渲染层由 Vite HMR 即时生效。提交前确认你验证了正确的进程。

## 二、单一职责（"一个类/组件只干一件事"）
- 组件/模块因**一个原因**变化。参考既有经验：`NacosScreen` 1800 行拆成 `NacosScreen`(编排) + `NacosServices`/`NacosSyncDialog`/`NacosConfigDetailPane`/`NacosConfigEditor`/`nacosShared` 多模块；`DateTimeCellEditor`、`NacosAccessScreen` 各自独立。
- **行数红线**：单组件 ≤ 300 行、单模块 ≤ 400 行；超过必须拆（拆不出就说明职责没分清）。巨型 `switch`/`if-else` 链用策略对象或子组件消解。
- 目录职责清晰：`screens/`（整页路由级）、`components/common/`（通用）、`components/workbench/`（工作台内）、`components/ui/`（shadcn 基础件，勿在内部塞业务）、`store/`（Zustand）、`theme/`、`hooks/`、`utils/`。

## 三、类型与类型安全（强制）
- **`tsc --noEmit` 必须 0 错** 才能提交（CI/`npm run build` 已卡此关）。
- **禁止 `any`**：跨进程数据用 `shared/types/*` 集中定义；不确定类型用 `unknown` + 类型守卫，不用 `as any` 蒙混。
- 跨进程传参/返回值要有明确 interface，主进程对入参做**校验后再用**（防渲染层误传导致主进程崩溃）。

## 四、命名规范
- 文件/目录：`kebab-case`（`nacos-sync-dialog.tsx`、`connection-store.ts`）；组件文件 `PascalCase.tsx` 亦可，但目录内统一。
- 组件：`PascalCase`；自定义 Hook：`useXxx`；事件回调：`onXxx`；布尔 prop：`isXxx` / `hasXxx`。
- 类型/接口：`XxxDto` / `XxxProps` / `XxxItem`；IPC 通道常量：`SNAKE_CASE` 且带域前缀（`NACOS_*`、`SQL_*`）。
- 不留魔法数/魔法字符串（如 `'nacos'`、`403`）——抽常量或枚举；语义不清的缩写（tmp/data2/flag）一律禁止。

## 五、状态管理（Zustand）
- 全局状态放 `store/`（`appStore` / `connectionStore` / `prefsStore`），局部状态放组件 `useState`。**不要在渲染中改 props**。
- **selector 外计算**：v5 的 selector 内不能 `filter`/`sort`（触发 getSnapshot 告警），需在 selector 外先算好再选。
- 可变派生数据用 `useMemo`，不每次渲染重算。

## 六、UI / 样式规范（按你的产品标准）
- **框架统一 shadcn/ui**（radix-ui + cva + tailwind-merge + lucide-react），**不混用**其他 UI 库；新组件优先复用既有 shadcn 件。
- **只用语令类，禁止硬编码颜色值**（除 `UI_THEMES` 已定义的 token）：`bg-background` / `text-foreground` / `border-border` / `bg-muted` / `text-muted-foreground` 等；旧令牌映射：`bg-panel→bg-background`、`accent→primary`、`text-prod→text-destructive` 等已定，沿用。
- **三套主题（darcula/light/glass）共用同一组 token、语义色一致**。改 UI 前先查 `src/renderer/theme/ui-themes.ts` 的 `UI_THEMES` 作为唯一真相源；切换主题认知一致。
- **设计朴素、克制**：禁用渐变图标/徽标、大数字指标卡、彩色胶囊标签、比例条、彩色光球等花哨装饰；偏好单行工具条、纯文字、普通表格、细边框、克制留白。
- **危险操作按钮一律红色**（`text-destructive`，静止即红）：删除/解绑/移除/回滚等破坏性操作；配置/新增类保持中性或主色蓝。
- 模态/浮层在玻璃态下须有**近实色毛玻璃底**（不透出底层），已统一在 `index.css` 的 `[data-glass='1']` 段处理，新浮层请复用 `bg-popover` / `role=dialog` 而非 `bg-muted`。

## 七、错误处理与日志
- 主进程 service 全程 `try/catch`，返回**结构化错误**（`{ok:false, message}` 或抛带码的 `Error`），不把原始堆栈/SQL 直接抛给渲染层。
- 渲染层：页面级用 `ErrorBoundary` 兜底；异步失败有 toast/状态提示，**禁止空 catch**。
- 日志走主进程 `logger`，**不打印密码、Token、密钥、身份证**；用参数化而非字符串拼接。

## 八、并发与副作用
- 主进程异步/流操作用 `async` + 背压/流式返回，**不阻塞事件循环**；长任务通过 IPC 进度事件回报渲染层。
- 渲染层 `useEffect` 必须清理副作用（监听器、定时器、`addEventListener`），避免内存泄漏与重复触发（参考 `DateTimeCellEditor` 的 `document.addEventListener('mousedown', ..., true)` 清理）。

## 九、验证与提交（强制关卡）
- 提交前本地必过：`npm run typecheck`（0 错）+ `npm run lint`（ESLint **max-warnings=0**）+ 主进程改动 `npm run build:main`。
- 自测覆盖：UI 改动在三套主题（深/浅/玻璃）下各验一遍；主进程改动在真实实例（非沙箱）验功能。
- Git：提交原子化（一件事一提交），message 动宾 + 关联需求/缺陷号；**禁止 `--no-verify` 绕过钩子**。

## 十、代码审查清单（PR 必过）
- [ ] 主/渲染/共享分层正确，无跨层裸调用
- [ ] 单一职责，无超行数巨型组件/模块
- [ ] `tsc` 0 错、无 `any`、无魔法数
- [ ] 新增 IPC 通道已补齐 channels/preload/api 类型
- [ ] 样式只用语令类，未硬编码颜色，三套主题一致
- [ ] 危险操作红色、UI 朴素无花哨装饰
- [ ] 异常被正确处理，无空 catch、无敏感信息泄露
- [ ] `useEffect` 副作用已清理
- [ ] `lint` 零警告，主进程改动已 `build:main`


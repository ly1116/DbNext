import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

/**
 * 渲染进程入口。
 *
 * 职责：
 * 1. 挂载 React 根节点到 `#root`。
 * 2. 启用 StrictMode 以便在开发期暴露副作用问题。
 *
 * 注意：渲染进程不在此处直接 import 'electron'，
 * 所有主进程能力通过 `window.dbnest`（preload 注入）访问。
 *
 * @since 0.1.0
 */
const container = document.getElementById('root');
if (!container) {
  throw new Error('[DbNest] 未找到 #root 挂载点');
}

ReactDOM.createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

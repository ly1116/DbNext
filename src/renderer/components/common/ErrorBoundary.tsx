import { Component, type ReactNode } from 'react';

/**
 * 错误边界：捕获子树渲染异常，显示错误详情而不是整页黑屏。
 * 便于开发期定位（React 渲染抛错默认会卸载整棵树）。
 *
 * @since 0.2.0
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { err: Error | null }> {
  override state = { err: null as Error | null };

  static getDerivedStateFromError(err: Error) {
    return { err };
  }

  override render() {
    const e = this.state.err;
    if (!e) return this.props.children;
    return (
      <div className="flex h-full w-full items-center justify-center p-6">
        <div className="max-w-[640px] rounded border border-prod/50 bg-panel p-4 text-[12px]">
          <div className="mb-2 font-medium text-prod">渲染出错</div>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] text-dim">{e.stack || e.message}</pre>
        </div>
      </div>
    );
  }
}

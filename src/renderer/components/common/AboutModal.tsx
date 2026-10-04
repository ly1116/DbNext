import { useEffect, useState } from 'react';
import { api } from '@renderer/api';

/**
 * 关于 DataRoost 弹窗（帮助 → 关于）。
 *
 * 与「设置」弹窗分离：帮助菜单的「关于」打开本弹窗，不再误开整个设置面板。
 * 展示产品名、版本、能力简介；版本经主进程 getVersion 暴露。
 *
 * @since 0.1.0
 */
export function AboutModal({ onClose }: { onClose: () => void }) {
  const [version, setVersion] = useState('…');
  useEffect(() => {
    let alive = true;
    api.getVersion().then((v) => alive && setVersion(v)).catch(() => alive && setVersion('0.1.1'));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-black/55 p-6"
      onMouseDown={onClose}
    >
      <div
        className="w-[420px] overflow-hidden rounded-xl border border-line2 bg-panel shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* 头部：渐变标识 + 产品名 */}
        <div className="relative flex flex-col items-center px-6 pt-7 pb-5">
          <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-ai to-ai2 shadow-lg">
            <svg className="h-6 w-6 text-white" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
              <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
              <path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z" />
            </svg>
          </div>
          <div className="text-[17px] font-semibold text-fg">DataRoost</div>
          <div className="mt-1 text-[11px] text-dim2">数据库与 SSH 一体化工作台 · v{version}</div>
        </div>

        {/* 能力简介 */}
        <div className="space-y-2 px-6 pb-5 text-[12px] leading-relaxed text-dim">
          <p>
            统一管理 MySQL / PostgreSQL / Oracle 数据库连接与 SSH / 堡垒机主机，
            提供对象浏览、数据查询、表数据编辑、结构同步、数据传输等专业能力。
          </p>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 pt-1">
            {FEATURES.map((f) => (
              <div key={f} className="flex items-center gap-1.5">
                <span className="h-1 w-1 shrink-0 rounded-full bg-ai" />
                <span className="text-fg/90">{f}</span>
              </div>
            ))}
          </div>
        </div>

        {/* 底部 */}
        <div className="flex items-center justify-between border-t border-line bg-panel2 px-6 py-3">
          <span className="text-[10px] text-dim2">© DataRoost · 仅供内部研发使用</span>
          <button
            onClick={onClose}
            className="h-7 rounded bg-accent px-3.5 text-[11px] font-medium text-white hover:opacity-90"
          >
            确定
          </button>
        </div>
      </div>
    </div>
  );
}

const FEATURES = [
  '对象树与表数据',
  'SQL 编辑器',
  '结构同步 / 数据传输',
  'SSH 终端',
  'SFTP 文件管理',
  'AI 助手',
];

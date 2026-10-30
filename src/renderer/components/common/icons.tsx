// ── 图标规范（Icon Convention）─────────────────────────────────────────────
// 本应用图标分两级，新图标一律「先 lucide，后自建」：
//
//   1) 标准 / 通用 UI 图标 → 优先从 lucide-react 取（已安装，lucide 1.x 官方线，1500+ 图标）：
//        import { Database, Server, RefreshCw } from 'lucide-react';
//      常用名：Database / Server / HardDrive / Network / Folder / File / Plus /
//      Trash2 / Settings / Search / RefreshCw / RotateCw / Check / X /
//      ChevronDown / ChevronUp / ChevronRight / ChevronLeft / Lock / Shield /
//      Link / Image / Cloud / History / Save / Code / List / Table / User /
//      Star / Info / AlertTriangle / Filter / ArrowUpDown 等。
//      ⚠️ 注意：刷新在 lucide 里叫 RefreshCw（不是 Refresh）；删除叫 Trash2；关闭叫 X；编辑叫 SquarePen。
//
//   2) 品牌 / 领域专属、lucide 没有的图标 → 在下方 REG 注册表里用内联 SVG 补：
//        <Icon name="xxx" className=... />
//      尺寸 / 颜色 / 旋转等一律由 className 透传（currentColor），组件里不写死。
//
//   命名约定：一律按图形 / 语义命名（如 sparkles、filter、primaryKey）；
//   同形变体用 -2 / -3 后缀（如 search-2、close-2），禁止 ic0 / ic1 这类无意义名称。
//
//   新图标先去 lucide 找；找不到再来这里加 SVG，不要重复造 lucide 已有的轮子。
//
//   <Icon name="..." /> 的解析顺序：先查 LUCIDE 表（命中即用 lucide 组件），
//   未命中再回退到 REG 的内联 SVG；都不命中返回 null。
// ──────────────────────────────────────────────────────────────────────────
import React from 'react';
import {
  Sparkles, X, Copy, ChevronRight, ChevronLeft, ChevronDown, Trash2, SquarePen, Eye, Star,
  Search, AlertTriangle, Folder, Settings, Plus, Menu, User, ArrowDown, ArrowUp, ArrowRight,
  ArrowLeft, Terminal, Database, Info, Table, Filter, List, Code, Shield, Lock, Link, Image,
  File, Cloud, ExternalLink, History, Save, CheckCircle, Play, Plug, Key, Check, RefreshCw,
  RefreshCcw, ArrowLeftRight, Zap, ArrowUpDown, FileCode, ListChecks, FolderOpen, Mic,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

type P = { className?: string; strokeWidth?: number; style?: React.CSSProperties; strokeLinecap?: 'round'|'butt'|'square'; strokeLinejoin?: 'round'|'miter'|'bevel'; title?: string };

type Def = { viewBox: string; fill?: string|null; stroke?: string|null; inner: string };

/** lucide 优先表：REG 中与 lucide 同义/等价的存量图标统一映射到 lucide 组件（避免重复造轮子）。 */
const LUCIDE: Record<string, LucideIcon> = {
  sparkles: Sparkles, close: X, copy: Copy, chevronRight: ChevronRight, chevronLeft: ChevronLeft,
  chevronDown: ChevronDown, trash: Trash2, edit: SquarePen, eye: Eye, star: Star, search: Search,
  warning: AlertTriangle, folder: Folder, settings: Settings, plus: Plus, menu: Menu, user: User,
  arrowDown: ArrowDown, arrowUp: ArrowUp, arrowRight: ArrowRight, arrowLeft: ArrowLeft,
  terminal: Terminal, database: Database, info: Info, table: Table, filter: Filter, list: List,
  code: Code, shield: Shield, lock: Lock, link: Link, image: Image, file: File, cloud: Cloud,
  externalLink: ExternalLink, history: History, save: Save, checkCircle: CheckCircle, play: Play,
  plug: Plug, key: Key, check: Check, refresh: RefreshCw, sync: RefreshCcw, transfer: ArrowLeftRight,
  bolt: Zap, sort: ArrowUpDown, script: FileCode, checklist: ListChecks, folderOpen: FolderOpen, mic: Mic,
};

const REG: Record<string, Def> = {
  // 命名约定：一律按图形/语义命名（如 sparkles、filter、winMinimize、primaryKey），
  // 同形变体用 -2/-3 后缀（如 search-2、close-2），禁止使用 ic0/ic1 这类无意义名称。
  // —— 以下为 lucide 没有、或品牌/领域专属、或为刻意保留的变体/窗口控件，才用内联 SVG ——
  "chevronRight-2": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"m9 6 6 6-6 6\" strokeLinecap=\"round\" strokeLinejoin=\"round\" />" },
  "winMinimize": { viewBox: "0 0 12 12", fill: "none", stroke: "currentColor", inner: "<path d=\"M1.5 6h9\" />" },
  "winRestore": { viewBox: "0 0 12 12", fill: "none", stroke: "currentColor", inner: "<rect x=\"3.5\" y=\"1.5\" width=\"7\" height=\"7\" rx=\"1\" /><path d=\"M8.5 3.5v-1a1 1 0 0 0-1-1h-5a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1h1\" />" },
  "winMaximize": { viewBox: "0 0 12 12", fill: "none", stroke: "currentColor", inner: "<rect x=\"2\" y=\"2\" width=\"8\" height=\"8\" rx=\"1\" />" },
  "winClose": { viewBox: "0 0 12 12", fill: "none", stroke: "currentColor", inner: "<path d=\"m2 2 8 8M10 2l-8 8\" />" },
  "redirect": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"M4 8h13M13 4l4 4-4 4\" /><path d=\"M20 16H7M11 20l-4-4 4-4\" />" },
  "moveH": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"M12 3v18M5 8l-3 4 3 4M19 8l3 4-3 4\" />" },
  "key-2": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<circle cx=\"8\" cy=\"8\" r=\"4\" /><path d=\"M11 11l8 8M16 16l2-2M19 19l2-2\" />" },
  "arrowUp-2": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"m5 12 7-7 7 7M12 19V5\" />" },
  "caretRight": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"m9 6 6 6-6 6\" strokeLinecap=\"round\" strokeLinejoin=\"round\" />" },
  "refresh-2": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"M21 12a9 9 0 1 1-2.6-6.4\" /><path d=\"M21 3v6h-6\" />" },
  "folder-2": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z\" /><path d=\"M12 11v6M9 14h6\" />" },
  "search-2": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<circle cx=\"11\" cy=\"11\" r=\"8\" /><path d=\"m21 21-4.3-4.3\" />" },
  "close-2": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"M18 6 6 18M6 6l12 12\" />" },
  "warning-2": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z\" strokeLinejoin=\"round\" />" },
  "search-3": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<circle cx=\"11\" cy=\"11\" r=\"7\" /><path d=\"m21 21-4-4\" />" },
  "chevronLeft-2": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"m15 18-6-6 6-6\" />" },
  "chevronLeft-3": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"m9 18 6-6-6-6\" />" },
  "table-2": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<rect x=\"3\" y=\"4\" width=\"18\" height=\"16\" rx=\"2.5\" /><path d=\"M3 10h18M9.5 10v10\" />" },
  "refresh-3": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6\" />" },
  "refresh-4": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"M21 12a9 9 0 1 1-2.6-6.3M21 4v5h-5\" strokeLinecap=\"round\" strokeLinejoin=\"round\" />" },
  "plus-2": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"M12 5v14M5 12h14\" strokeLinecap=\"round\" />" },
  "primaryKey": { viewBox: "0 0 16 16", fill: null, stroke: null, inner: "<title>主键</title><circle cx=\"5.5\" cy=\"5.5\" r=\"3.2\" fill=\"none\" stroke=\"#4aa8e8\" strokeWidth=\"1.6\" /><path d=\"M8 8l5 5M11 11l1.6-1.6M12.6 12.6l1.4-1.4\" stroke=\"#4aa8e8\" strokeWidth=\"1.6\" fill=\"none\" strokeLinecap=\"round\" />" },
  "dtKey": { viewBox: "0 0 16 16", fill: null, stroke: null, inner: "<title>数值</title><text x=\"8\" y=\"12\" textAnchor=\"middle\" fontSize=\"10\" fontWeight=\"700\" fill=\"#5bb8d4\">#</text>" },
  "dtText": { viewBox: "0 0 16 16", fill: null, stroke: null, inner: "<title>文本</title><text x=\"8\" y=\"12.5\" textAnchor=\"middle\" fontSize=\"11\" fontWeight=\"700\" fill=\"#8fbf6f\">A</text>" },
  "dtDate": { viewBox: "0 0 16 16", fill: "none", stroke: "#c9a35a", inner: "<title>日期/时间</title><rect x=\"2\" y=\"3\" width=\"12\" height=\"11\" rx=\"1\" /><path d=\"M2 6.5h12M5.5 1.5v3M10.5 1.5v3\" />" },
  "dtField": { viewBox: "0 0 16 16", fill: "none", stroke: "#9aa3ad", inner: "<title>字段</title><rect x=\"2.5\" y=\"2.5\" width=\"11\" height=\"11\" rx=\"1.5\" /><path d=\"M2.5 6h11M2.5 10h11M6.5 2.5v11\" />" },
  "check-2": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"M5 13l4 4L19 7\" strokeLinecap=\"round\" strokeLinejoin=\"round\" />" },
  "close-3": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"M6 6l12 12M18 6L6 18\" strokeLinecap=\"round\" />" },
  "shield-2": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"M12 3v18M5 7l7-4 7 4M5 7v5c0 3 3 6 7 7 4-1 7-4 7-7V7\" strokeLinejoin=\"round\" />" },
  "warning-3": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z\" />" },
  "database-2": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<ellipse cx=\"12\" cy=\"5.5\" rx=\"7.5\" ry=\"3\" /><path d=\"M4.5 5.5v13c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3v-13\" /><path d=\"M4.5 12c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3\" />" },
  "star-2": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"M12 2.8 20 7.4v9.2L12 21.2 4 16.6V7.4z\" /><circle cx=\"12\" cy=\"12\" r=\"2.6\" />" },
  "table-3": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<rect x=\"3\" y=\"4\" width=\"18\" height=\"16\" rx=\"2\" /><path d=\"M3 9.5h18M3 15h18M9.5 4v16\" />" },
  "list-2": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"M4 7h9M4 12h13M4 17h9\" /><path d=\"m16.5 5 2.5 2-2.5 2M16.5 15l2.5 2-2.5 2\" />" },
  "star-3": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<circle cx=\"12\" cy=\"12\" r=\"5.2\" /><path d=\"M12 2.8v2.6M12 18.6v2.6M2.8 12h2.6M18.6 12h2.6M5.5 5.5l1.9 1.9M16.6 16.6l1.9 1.9M18.5 5.5l-1.9 1.9M7.4 16.6l-1.9 1.9\" /><path d=\"m12.6 9.2-2.4 3.2h2l-.8 2.4 2.4-3.2h-2z\" fill=\"currentColor\" stroke=\"none\" />" },
  "lines": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"M8 6h8M8 12h8M8 18h8\" />" },
  "erd": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<rect x=\"8.6\" y=\"3\" width=\"6.8\" height=\"5.2\" rx=\"1.2\" /><rect x=\"2.8\" y=\"15.8\" width=\"6.8\" height=\"5.2\" rx=\"1.2\" /><rect x=\"14.4\" y=\"15.8\" width=\"6.8\" height=\"5.2\" rx=\"1.2\" /><path d=\"M12 8.2v3.2M6.2 15.8v-1.8h11.6v1.8M12 11.4v2.6\" strokeLinecap=\"round\" />" },
  "routine": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"M10 4a2 2 0 1 1 4 0v1.5h3.5a1 1 0 0 1 1 1V10h1.5a2 2 0 1 1 0 4H18v3.5a1 1 0 0 1-1 1H13.5V17a2 2 0 1 0-4 0v1.5H5.5a1 1 0 0 1-1-1V13H6a2 2 0 1 1 0-4h1.5V5.5a1 1 0 0 1 1-1H10z\" />" },
  "database-3": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<ellipse cx=\"12\" cy=\"6\" rx=\"8\" ry=\"3\" /><path d=\"M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6\" /><path d=\"M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6\" />" },
  "user-2": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<circle cx=\"9\" cy=\"8\" r=\"3.2\" /><path d=\"M3.5 19c0-3 2.5-5 5.5-5s5.5 2 5.5 5\" /><path d=\"M16 6.2a3 3 0 0 1 0 5.6\" />" },
  "folderFilled": { viewBox: "0 0 24 24", fill: "currentColor", stroke: null, inner: "<path d=\"M3 7a2 2 0 0 1 2-2h3.9c.5 0 1 .2 1.3.6L11.5 7H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z\" />" },
  "info-2": { viewBox: "0 0 24 24", fill: "none", stroke: null, inner: "<circle cx=\"12\" cy=\"12\" r=\"9\" stroke=\"currentColor\" strokeOpacity=\"0.25\" strokeWidth=\"3\" /><path d=\"M21 12a9 9 0 00-9-9\" stroke=\"currentColor\" strokeWidth=\"3\" strokeLinecap=\"round\" />" },
  "cluster": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"M20.5 7.3 12 3 3.5 7.3v9.4L12 21l8.5-4.3V7.3Z\" strokeLinejoin=\"round\" /><path d=\"M3.5 7.3 12 11.6l8.5-4.3M12 11.6V21\" />" },
  "database-4": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<ellipse cx=\"12\" cy=\"5\" rx=\"8\" ry=\"3\" /><path d=\"M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5\" /><path d=\"M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3\" />" },
  "database-5": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<ellipse cx=\"12\" cy=\"6\" rx=\"8\" ry=\"3\" /><path d=\"M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6\" />" },
};

export function Icon({ name, className, strokeWidth, style, strokeLinecap, strokeLinejoin, title }: P & { name: string }) {
  // 优先走 lucide（与官方图标完全统一，且随 lucide 版本持续维护）
  const Lc = LUCIDE[name];
  if (Lc) {
    const Cmp = Lc as LucideIcon;
    return (
      <Cmp
        className={className}
        strokeWidth={strokeWidth ?? 2}
        strokeLinecap={strokeLinecap}
        strokeLinejoin={strokeLinejoin}
        style={style}
        aria-hidden={title ? undefined : true}
        {...(title ? { title } : {})}
      />
    );
  }
  // lucide 没有 / 自定义变体 / 品牌·领域图标：回退到内联 SVG
  const d = REG[name];
  if (!d) return null;
  return (
    <svg
      viewBox={d.viewBox}
      className={className}
      fill={d.fill ?? 'none'}
      stroke={d.stroke ?? 'currentColor'}
      strokeWidth={strokeWidth ?? 2}
      strokeLinecap={strokeLinecap}
      strokeLinejoin={strokeLinejoin}
      style={style}
      aria-hidden
      {...(title?{role:'img',title}:{})}
      dangerouslySetInnerHTML={{ __html: d.inner }}
    />
  );
}

/** 透传容器：给已有把子图标塞进来的写法（<IconBox>{icon}</IconBox>）。 */
export function IconBox({ className, viewBox, strokeWidth, strokeLinecap, strokeLinejoin, children, style }: P & { viewBox?: string; children: React.ReactNode }) {
  return (
    <svg viewBox={viewBox ?? '0 0 24 24'} className={className} fill="none" stroke="currentColor" strokeWidth={strokeWidth ?? 2} strokeLinecap={strokeLinecap} strokeLinejoin={strokeLinejoin} style={style} aria-hidden>
      {children}
    </svg>
  );
}

/** 条件状态图标（tone 决定锁/盾外观）。 */
export function StatusIcon({ className, tone }: { className?: string; tone?: string }) {
  return tone === 'warn' ? (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} aria-hidden>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ) : (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
      <path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" strokeLinejoin="round" />
    </svg>
  );
}

/** 应用 Logo：现代风圆形渐变徽标 + 节点连接图（白），表达「连接」这一产品核心。 */
export function AppLogo({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 1024 1024" aria-label="DataRoost">
      <defs>
        <linearGradient id="applogo-tile" x1="0.15" y1="0" x2="0.85" y2="1">
          <stop offset="0" stopColor="#2f6feb" />
          <stop offset="1" stopColor="#7c5cff" />
        </linearGradient>
      </defs>
      <circle cx="512" cy="512" r="490" fill="url(#applogo-tile)" />
      <circle cx="512" cy="512" r="490" fill="none" stroke="#ffffff" strokeOpacity="0.18" strokeWidth="16" />
      <g stroke="#ffffff" strokeOpacity="0.78" strokeWidth="64" strokeLinecap="round">
        <path d="M290 307 L401 401" />
        <path d="M623 623 L734 734" />
      </g>
      <rect x="401" y="401" width="222" height="222" rx="73" fill="#ffffff" />
      <circle cx="213" cy="256" r="90" fill="#ffffff" fillOpacity="0.92" />
      <circle cx="811" cy="768" r="90" fill="#ffffff" fillOpacity="0.92" />
    </svg>
  );
}

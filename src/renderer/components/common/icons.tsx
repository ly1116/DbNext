// 统一图标模块：所有内联 SVG 在此集中定义，文件里用 <Icon name="xxx" className=... /> 调用。
// 尺寸/颜色/旋转等全部由 className 透传（currentColor），不在组件里写死。
import React from 'react';

type P = { className?: string; strokeWidth?: number; style?: React.CSSProperties; strokeLinecap?: 'round'|'butt'|'square'; strokeLinejoin?: 'round'|'miter'|'bevel'; title?: string };

type Def = { viewBox: string; fill?: string|null; stroke?: string|null; inner: string };

const REG: Record<string, Def> = {
  // 命名约定：一律按图形/语义命名（如 sparkles、filter、winMinimize、primaryKey），
  // 同形变体用 -2/-3 后缀（如 search-2、close-2），禁止使用 ic0/ic1 这类无意义名称。
  "sparkles": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z\" /><path d=\"M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z\" />" },
  "close": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"M6 6l12 12M18 6L6 18\" />" },
  "copy": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<rect x=\"9\" y=\"9\" width=\"11\" height=\"11\" rx=\"2\" /><path d=\"M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1\" />" },
  "chevronRight": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"m9 6 6 6-6 6\" />" },
  "trash": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2\" />" },
  "chevronRight-2": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"m9 6 6 6-6 6\" strokeLinecap=\"round\" strokeLinejoin=\"round\" />" },
  "eye": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z\" /><circle cx=\"12\" cy=\"12\" r=\"2.5\" />" },
  "star": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4L16.5 3.5z\" />" },
  "search": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<circle cx=\"11\" cy=\"11\" r=\"7\" /><path d=\"m20 20-3.5-3.5\" />" },
  "warning": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"M12 9v4M12 17h.01\" /><path d=\"M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z\" />" },
  "folder": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z\" />" },
  "winMinimize": { viewBox: "0 0 12 12", fill: "none", stroke: "currentColor", inner: "<path d=\"M1.5 6h9\" />" },
  "winRestore": { viewBox: "0 0 12 12", fill: "none", stroke: "currentColor", inner: "<rect x=\"3.5\" y=\"1.5\" width=\"7\" height=\"7\" rx=\"1\" /><path d=\"M8.5 3.5v-1a1 1 0 0 0-1-1h-5a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1h1\" />" },
  "winMaximize": { viewBox: "0 0 12 12", fill: "none", stroke: "currentColor", inner: "<rect x=\"2\" y=\"2\" width=\"8\" height=\"8\" rx=\"1\" />" },
  "winClose": { viewBox: "0 0 12 12", fill: "none", stroke: "currentColor", inner: "<path d=\"m2 2 8 8M10 2l-8 8\" />" },
  "settings": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<circle cx=\"12\" cy=\"12\" r=\"3\" /><path d=\"M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z\" />" },
  "plus": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"M12 5v14M5 12h14\" />" },
  "menu": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"M4 7h16M4 12h16M4 17h10\" />" },
  "user": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<circle cx=\"9\" cy=\"8\" r=\"3.2\" /><path d=\"M3.5 19c0-3 2.5-5 5.5-5s5.5 2 5.5 5\" /><path d=\"M16 6.2a3 3 0 010 5.6M16.5 19c0-2.4 1.4-4.1 3.5-4.6\" />" },
  "redirect": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"M4 8h13M13 4l4 4-4 4\" /><path d=\"M20 16H7M11 20l-4-4 4-4\" />" },
  "moveH": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"M12 3v18M5 8l-3 4 3 4M19 8l3 4-3 4\" />" },
  "arrowDown": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"M12 3v12M8 11l4 4 4-4M4 19h16\" />" },
  "arrowUp": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"M12 15V3M8 7l4-4 4 4M4 19h16\" />" },
  "refresh": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"M21 12a9 9 0 1 1-2.64-6.36\" /><path d=\"M21 3v6h-6\" />" },
  "arrowRight": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"M5 12h14M13 6l6 6-6 6\" />" },
  "arrowLeft": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"M19 12H5M11 6l-6 6 6 6\" />" },
  "terminal": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<rect x=\"3\" y=\"4\" width=\"18\" height=\"16\" rx=\"2\" /><path d=\"m7 10 2 2-2 2M13 14h4\" />" },
  "database": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<ellipse cx=\"12\" cy=\"5.5\" rx=\"7.5\" ry=\"3\" /><path d=\"M4.5 5.5v13c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-13\" />" },
  "info": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<circle cx=\"12\" cy=\"12\" r=\"9\" /><path d=\"M12 11v5M12 8h.01\" />" },
  "key-2": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<circle cx=\"8\" cy=\"8\" r=\"4\" /><path d=\"M11 11l8 8M16 16l2-2M19 19l2-2\" />" },
  "arrowUp-2": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"m5 12 7-7 7 7M12 19V5\" />" },
  "mic": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z\" /><path d=\"M19 10v2a7 7 0 0 1-14 0v-2\" />" },
  "caretRight": { viewBox: "0 0 12 12", fill: "currentColor", stroke: null, inner: "<path d=\"M4 3l4 3-4 3z\" />" },
  "refresh-2": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"M21 12a9 9 0 1 1-2.6-6.4\" /><path d=\"M21 3v6h-6\" />" },
  "folder-2": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z\" /><path d=\"M12 11v6M9 14h6\" />" },
  "search-2": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<circle cx=\"11\" cy=\"11\" r=\"8\" /><path d=\"m21 21-4.3-4.3\" />" },
  "close-2": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"M18 6 6 18M6 6l12 12\" />" },
  "table": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<rect x=\"3\" y=\"4\" width=\"18\" height=\"16\" rx=\"1.5\" /><path d=\"M3 9.5h18M9 9.5V20\" />" },
  "warning-2": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z\" strokeLinejoin=\"round\" />" },
  "filter": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"M3 5h18l-7 8v5.5L10 21v-8L3 5Z\" strokeLinecap=\"round\" strokeLinejoin=\"round\" />" },
  "sort": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"M7 4v13M4 14l3 3 3-3M17 20V7M14 10l3-3 3 3\" strokeLinecap=\"round\" strokeLinejoin=\"round\" />" },
  "search-3": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<circle cx=\"11\" cy=\"11\" r=\"7\" /><path d=\"m21 21-4-4\" />" },
  "chevronLeft": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"m11 19-7-7 7-7M20 5v14\" />" },
  "chevronLeft-2": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"m15 18-6-6 6-6\" />" },
  "chevronLeft-3": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"m9 18 6-6-6-6\" />" },
  "table-2": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<rect x=\"3\" y=\"4\" width=\"18\" height=\"16\" rx=\"2.5\" /><path d=\"M3 10h18M9.5 10v10\" />" },
  "refresh-3": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6\" />" },
  "plus-2": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"M12 5v14M5 12h14\" strokeLinecap=\"round\" />" },
  "primaryKey": { viewBox: "0 0 16 16", fill: null, stroke: null, inner: "<title>主键</title><circle cx=\"5.5\" cy=\"5.5\" r=\"3.2\" fill=\"none\" stroke=\"#4aa8e8\" strokeWidth=\"1.6\" /><path d=\"M8 8l5 5M11 11l1.6-1.6M12.6 12.6l1.4-1.4\" stroke=\"#4aa8e8\" strokeWidth=\"1.6\" fill=\"none\" strokeLinecap=\"round\" />" },
  "dtKey": { viewBox: "0 0 16 16", fill: null, stroke: null, inner: "<title>数值</title><text x=\"8\" y=\"12\" textAnchor=\"middle\" fontSize=\"10\" fontWeight=\"700\" fill=\"#5bb8d4\">#</text>" },
  "dtText": { viewBox: "0 0 16 16", fill: null, stroke: null, inner: "<title>文本</title><text x=\"8\" y=\"12.5\" textAnchor=\"middle\" fontSize=\"11\" fontWeight=\"700\" fill=\"#8fbf6f\">A</text>" },
  "dtDate": { viewBox: "0 0 16 16", fill: "none", stroke: "#c9a35a", inner: "<title>日期/时间</title><rect x=\"2\" y=\"3\" width=\"12\" height=\"11\" rx=\"1\" /><path d=\"M2 6.5h12M5.5 1.5v3M10.5 1.5v3\" />" },
  "dtField": { viewBox: "0 0 16 16", fill: "none", stroke: "#9aa3ad", inner: "<title>字段</title><rect x=\"2.5\" y=\"2.5\" width=\"11\" height=\"11\" rx=\"1.5\" /><path d=\"M2.5 6h11M2.5 10h11M6.5 2.5v11\" />" },
  "key": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4\" />" },
  "chevronDown": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"m6 9 6 6 6-6\" />" },
  "check": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"m5 13 4 4L19 7\" />" },
  "play": { viewBox: "0 0 24 24", fill: "currentColor", stroke: null, inner: "<path d=\"M7 4.5v15l13-7.5z\" />" },
  "code": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"M8 6 3 12l5 6M16 6l5 6-5 6\" strokeLinecap=\"round\" strokeLinejoin=\"round\" />" },
  "bolt": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"M13 2 4 14h6l-1 8 9-12h-6l1-8\" strokeLinecap=\"round\" strokeLinejoin=\"round\" />" },
  "refresh-4": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"M21 12a9 9 0 1 1-2.6-6.3M21 4v5h-5\" strokeLinecap=\"round\" strokeLinejoin=\"round\" />" },
  "list": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"M4 7h9M4 12h13M4 17h9\" strokeLinecap=\"round\" /><path d=\"m16.5 5 2.5 2-2.5 2M16.5 15l2.5 2-2.5 2\" strokeLinecap=\"round\" strokeLinejoin=\"round\" />" },
  "check-2": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"M5 13l4 4L19 7\" strokeLinecap=\"round\" strokeLinejoin=\"round\" />" },
  "plug": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"M17 8V6a3 3 0 0 0-3-3H6a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3h8a3 3 0 0 0 3-3v-2\" /><path d=\"M21 12H9m0 0 3-3m-3 3 3 3\" strokeLinecap=\"round\" strokeLinejoin=\"round\" />" },
  "shield": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7l8-4Z\" strokeLinejoin=\"round\" />" },
  "lock": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13h10l1-13\" strokeLinecap=\"round\" strokeLinejoin=\"round\" />" },
  "close-3": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"M6 6l12 12M18 6L6 18\" strokeLinecap=\"round\" />" },
  "shield-2": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"M12 3v18M5 7l7-4 7 4M5 7v5c0 3 3 6 7 7 4-1 7-4 7-7V7\" strokeLinejoin=\"round\" />" },
  "warning-3": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z\" />" },
  "script": { viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", inner: "<path d=\"M4 1.5h5.5L13 5v9.5H4z\" strokeLinejoin=\"round\" /><path d=\"M9.5 1.5V5H13\" strokeLinejoin=\"round\" />" },
  "database-2": { viewBox: "0 0 24 24", fill: "currentColor", stroke: null, inner: "<ellipse cx=\"12\" cy=\"5.5\" rx=\"7.5\" ry=\"3\" /><path d=\"M4.5 5.5v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-6c0 1.7-3.4 3-7.5 3s-7.5-1.3-7.5-3z\" opacity=\"0.85\" /><path d=\"M4.5 11.5v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-6c0 1.7-3.4 3-7.5 3s-7.5-1.3-7.5-3z\" opacity=\"0.6\" />" },
  "star-2": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"M12 2.8 20 7.4v9.2L12 21.2 4 16.6V7.4z\" /><circle cx=\"12\" cy=\"12\" r=\"2.6\" />" },
  "table-3": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<rect x=\"3\" y=\"4\" width=\"18\" height=\"16\" rx=\"2\" /><path d=\"M3 9.5h18M3 15h18M9.5 4v16\" />" },
  "list-2": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"M4 7h9M4 12h13M4 17h9\" /><path d=\"m16.5 5 2.5 2-2.5 2M16.5 15l2.5 2-2.5 2\" />" },
  "star-3": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<circle cx=\"12\" cy=\"12\" r=\"5.2\" /><path d=\"M12 2.8v2.6M12 18.6v2.6M2.8 12h2.6M18.6 12h2.6M5.5 5.5l1.9 1.9M16.6 16.6l1.9 1.9M18.5 5.5l-1.9 1.9M7.4 16.6l-1.9 1.9\" /><path d=\"m12.6 9.2-2.4 3.2h2l-.8 2.4 2.4-3.2h-2z\" fill=\"currentColor\" stroke=\"none\" />" },
  "lines": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"M8 6h8M8 12h8M8 18h8\" />" },
  "erd": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<rect x=\"8.6\" y=\"3\" width=\"6.8\" height=\"5.2\" rx=\"1.2\" /><rect x=\"2.8\" y=\"15.8\" width=\"6.8\" height=\"5.2\" rx=\"1.2\" /><rect x=\"14.4\" y=\"15.8\" width=\"6.8\" height=\"5.2\" rx=\"1.2\" /><path d=\"M12 8.2v3.2M6.2 15.8v-1.8h11.6v1.8M12 11.4v2.6\" strokeLinecap=\"round\" />" },
  "routine": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"M10 4a2 2 0 1 1 4 0v1.5h3.5a1 1 0 0 1 1 1V10h1.5a2 2 0 1 1 0 4H18v3.5a1 1 0 0 1-1 1H13.5V17a2 2 0 1 0-4 0v1.5H5.5a1 1 0 0 1-1-1V13H6a2 2 0 1 1 0-4h1.5V5.5a1 1 0 0 1 1-1H10z\" />" },
  "database-3": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<ellipse cx=\"12\" cy=\"6\" rx=\"8\" ry=\"3\" /><path d=\"M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6\" /><path d=\"M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6\" />" },
  "user-2": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<circle cx=\"9\" cy=\"8\" r=\"3.2\" /><path d=\"M3.5 19c0-3 2.5-5 5.5-5s5.5 2 5.5 5\" /><path d=\"M16 6.2a3 3 0 0 1 0 5.6\" />" },
  "link": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71\" strokeLinecap=\"round\" strokeLinejoin=\"round\" /><path d=\"M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71\" strokeLinecap=\"round\" strokeLinejoin=\"round\" />" },
  "image": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3\" />" },
  "folderFilled": { viewBox: "0 0 24 24", fill: "currentColor", stroke: null, inner: "<path d=\"M3 7a2 2 0 0 1 2-2h3.9c.5 0 1 .2 1.3.6L11.5 7H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z\" />" },
  "folderOpen": { viewBox: "0 0 24 24", fill: "currentColor", stroke: null, inner: "<path d=\"M3 8a2 2 0 0 1 2-2h3.6c.5 0 1 .2 1.3.6L11.2 8H20a1 1 0 0 1 1 1.2l-1.4 7A2 2 0 0 1 17.6 18H5a2 2 0 0 1-2-2V8z\" opacity=\"0.85\" />" },
  "info-2": { viewBox: "0 0 24 24", fill: "none", stroke: null, inner: "<circle cx=\"12\" cy=\"12\" r=\"9\" stroke=\"currentColor\" strokeOpacity=\"0.25\" strokeWidth=\"3\" /><path d=\"M21 12a9 9 0 00-9-9\" stroke=\"currentColor\" strokeWidth=\"3\" strokeLinecap=\"round\" />" },
  "cluster": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"M20.5 7.3 12 3 3.5 7.3v9.4L12 21l8.5-4.3V7.3Z\" strokeLinejoin=\"round\" /><path d=\"M3.5 7.3 12 11.6l8.5-4.3M12 11.6V21\" />" },
  "transfer": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"M7 4v13M7 4 4 7M7 4l3 3M17 20V7M17 20l3-3M17 20l-3-3\" />" },
  "database-4": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<ellipse cx=\"12\" cy=\"5\" rx=\"8\" ry=\"3\" /><path d=\"M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5\" /><path d=\"M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3\" />" },
  "checklist": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"M4 6h16M4 12h16M4 18h10\" /><circle cx=\"18\" cy=\"18\" r=\"2.2\" />" },
  "database-5": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<ellipse cx=\"12\" cy=\"6\" rx=\"8\" ry=\"3\" /><path d=\"M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6\" />" },
  "file": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z\" /><path d=\"M14 3v5h5\" />" },
  "cloud": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"M17.5 19a4.5 4.5 0 0 0 .88-8.91 6 6 0 0 0-11.7-1.09A4.5 4.5 0 0 0 7.5 19z\" strokeLinejoin=\"round\" />" },
  "externalLink": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"M15 4h5v5M20 4l-8 8M19 13v6a1.5 1.5 0 0 1-1.5 1.5h-12A1.5 1.5 0 0 1 4 19V7a1.5 1.5 0 0 1 1.5-1.5H10\" strokeLinecap=\"round\" strokeLinejoin=\"round\" />" },
  "history": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8\" strokeLinecap=\"round\" strokeLinejoin=\"round\" /><path d=\"M3 3v5h5\" /><path d=\"M12 7v5l4 2\" strokeLinecap=\"round\" strokeLinejoin=\"round\" />" },
  "sync": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"M3 12a9 9 0 0 1 15-6.7L21 8\" strokeLinecap=\"round\" strokeLinejoin=\"round\" /><path d=\"M21 3v5h-5\" strokeLinecap=\"round\" strokeLinejoin=\"round\" /><path d=\"M21 12a9 9 0 0 1-15 6.7L3 16\" strokeLinecap=\"round\" strokeLinejoin=\"round\" /><path d=\"M3 21v-5h5\" strokeLinecap=\"round\" strokeLinejoin=\"round\" />" },
  "save": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<path d=\"M15.5 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8.5z\" strokeLinejoin=\"round\" /><path d=\"M15 3v6H9V3M9 21v-6h6v6\" />" },
  "checkCircle": { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", inner: "<circle cx=\"12\" cy=\"12\" r=\"9\" /><path d=\"m8.5 12 2.5 2.5 4.5-5\" strokeLinecap=\"round\" strokeLinejoin=\"round\" />" },
};

export function Icon({ name, className, strokeWidth, style, strokeLinecap, strokeLinejoin, title }: P & { name: string }) {
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

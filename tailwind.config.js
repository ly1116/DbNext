/**
 * Tailwind 配置 —— 设计 token 与高保真原型 b.html 完全一致。
 * 集中定义颜色，避免在组件里硬编码十六进制，保证主题统一可维护。
 */
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // 背景层级（由深到浅）
        bg: '#181818',
        panel: '#1f1f1f',
        panel2: '#252526',
        panel3: '#2d2d30',
        // 描边
        line: '#2d2d30',
        line2: '#3e3e42',
        // 文字
        fg: '#cccccc',
        dim: '#858585',
        dim2: '#6a6a6a',
        // 主题色（链接/选中/主操作）
        accent: '#0e639c',
        accent2: '#1177bb',
        // 语义色
        prod: '#e5484d', // 生产/危险
        ok: '#4ec9b0', // 正常/成功
        warn: '#e5a00d', // 警告/跳板
        // 语法高亮（VS Code Dark+ 配色）
        purple: '#c586c0',
        blue: '#569cd6',
        str: '#ce9178',
        num: '#b5cea8',
        fn: '#dcdcaa',
        // 终端
        term: '#0c0c0c',
        termfg: '#d4d4d4',
        // AI 紫
        ai: '#7c5cff',
        ai2: '#9d7cff',
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'SF Mono', 'Menlo', 'Consolas', 'monospace'],
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'PingFang SC',
          'Microsoft YaHei',
          'sans-serif',
        ],
      },
    },
  },
  plugins: [],
};

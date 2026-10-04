/**
 * 远端文件类型识别（对标 VSCode 的语言自动检测思路）。
 *
 * 判定优先级：精确文件名（Dockerfile 等）→ 扩展名 → 常见无扩展名脚本。
 * 用于：SFTP 右键「在编辑器打开」时决定是否可编辑、编辑器用哪种语法高亮。
 */

/** 支持编辑（纯文本）的文件大小上限，与主进程保持一致 */
export const MAX_EDIT_BYTES = 4 * 1024 * 1024;

/** 按文件名精确匹配（无扩展名或特殊命名，优先级最高） */
const BY_NAME: Record<string, string> = {
  dockerfile: 'dockerfile',
  containerfile: 'dockerfile',
  makefile: 'makefile',
  jenkinsfile: 'groovy',
  vagrantfile: 'ruby',
  procfile: 'yaml',
  gemfile: 'ruby',
  rakefile: 'ruby',
  brewfile: 'ruby',
  cmakelists: 'cmake',
  'cmakelists.txt': 'cmake',
  '.bashrc': 'shell',
  '.bash_profile': 'shell',
  '.bash_logout': 'shell',
  '.zshrc': 'shell',
  '.zsh_profile': 'shell',
  '.profile': 'shell',
  '.bash_aliases': 'shell',
  '.env': 'dotenv',
  '.gitignore': 'gitignore',
  '.gitattributes': 'gitattributes',
  '.gitconfig': 'ini',
  '.editorconfig': 'ini',
  '.npmrc': 'ini',
  '.nvmrc': 'plaintext',
  '.dockerignore': 'plaintext',
  'hosts': 'plaintext',
  passwd: 'plaintext',
  shadow: 'plaintext',
  fstab: 'ini',
  crontab: 'crontab',
};

/** 按扩展名匹配（全部小写，不含点） */
const BY_EXT: Record<string, string> = {
  // Web / 前端
  html: 'html', htm: 'html', xhtml: 'html',
  vue: 'vue', svelte: 'svelte',
  css: 'css', scss: 'scss', sass: 'sass', less: 'less',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx',
  json: 'json', json5: 'json5', jsonc: 'json5', webmanifest: 'json',
  // 脚本 / 编程
  py: 'python', pyw: 'python', pyi: 'python',
  rb: 'ruby', rake: 'ruby', gemspec: 'ruby',
  pl: 'perl', pm: 'perl',
  php: 'php', sh: 'shell', bash: 'shell', zsh: 'shell', ksh: 'shell', csh: 'shell',
  fish: 'shell', ksh93: 'shell', bat: 'batch', cmd: 'batch', ps1: 'powershell', psm1: 'powershell',
  lua: 'lua', tcl: 'tcl', awk: 'awk', sed: 'plaintext',
  go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', kts: 'kotlin', scala: 'scala',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp',
  cs: 'csharp', fs: 'fsharp', vb: 'vb',
  swift: 'swift', m: 'objectivec', mm: 'objectivec',
  js2: 'plaintext', vue2: 'plaintext',
  // 标记 / 数据 / 文档
  md: 'markdown', markdown: 'markdown', mdx: 'markdown', rst: 'restructuredtext',
  tex: 'latex', bib: 'latex',
  htmlx: 'html', xml: 'xml', xsd: 'xml', xsl: 'xml', plist: 'xml', svg: 'xml',
  toml: 'toml', ini: 'ini', cfg: 'ini', conf: 'ini', properties: 'ini', env: 'dotenv',
  yaml: 'yaml', yml: 'yaml',
  csv: 'csv', tsv: 'csv',
  sql: 'sql',
  graphql: 'graphql', gql: 'graphql', proto: 'protobuf',
  // 基础设施
  tf: 'hcl', tfvars: 'hcl', hcl: 'hcl',
  dockerfile: 'dockerfile',
  // 其它
  diff: 'diff', patch: 'diff', log: 'plaintext', out: 'plaintext', txt: 'plaintext',
  pem: 'plaintext', crt: 'plaintext', key: 'plaintext', pub: 'plaintext',
  gpg: 'plaintext', ttf: 'plaintext', otf: 'plaintext', woff: 'plaintext', woff2: 'plaintext',
  png: 'binary', jpg: 'binary', jpeg: 'binary', gif: 'binary', webp: 'binary', ico: 'binary',
  pdf: 'binary', zip: 'binary', gz: 'binary', tgz: 'binary', bz2: 'binary', xz: 'binary',
  tar: 'binary', rar: 'binary', '7z': 'binary',
  jar: 'binary', war: 'binary', class: 'binary', so: 'binary', o: 'binary', a: 'binary',
  exe: 'binary', dll: 'binary', bin: 'binary', dat: 'binary', db: 'binary', sqlite: 'binary',
  iso: 'binary', img: 'binary', rpm: 'binary', deb: 'binary', whl: 'binary',
  mp3: 'binary', mp4: 'binary', avi: 'binary', mov: 'binary', mkv: 'binary',
  ttf2: 'binary', swp: 'binary', lock: 'plaintext',
};

/** 明显不可编辑的二进制扩展名（命中即拒绝打开） */
const BINARY_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'tif', 'tiff', 'svgz',
  'pdf', 'zip', 'gz', 'tgz', 'bz2', 'xz', 'zst', 'rar', '7z', 'tar', 'lz4',
  'jar', 'war', 'ear', 'class', 'so', 'o', 'a', 'lib', 'exe', 'dll', 'bin', 'dat', 'msi',
  'db', 'sqlite', 'sqlite3', 'mdb', 'iso', 'img', 'dmg', 'rpm', 'deb', 'apk', 'whl', 'egg',
  'mp3', 'mp4', 'avi', 'mov', 'mkv', 'flv', 'wmv', 'webm', 'ogg', 'wav', 'flac',
  'ttf', 'otf', 'woff', 'woff2', 'eot', 'psd', 'ai', 'sketch',
  'pyc', 'pyo', 'swp', 'swo', 'bak', 'dump', 'core',
]);

/** 取文件名（去目录） */
function baseName(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

/** 取小写扩展名（不含点）；无扩展名返回空串 */
export function extOf(path: string): string {
  const name = baseName(path);
  const i = name.lastIndexOf('.');
  // 无点 / 点在开头（.bashrc）/ 结尾（foo.）都视为无扩展名
  if (i <= 0 || i === name.length - 1) return '';
  return name.slice(i + 1).toLowerCase();
}

/** 识别语言 id（供 CodeMirror 语法高亮使用）；未知返回 'plaintext' */
export function detectLanguage(path: string): string {
  const name = baseName(path);
  const lower = name.toLowerCase();

  // 1) 精确文件名
  if (BY_NAME[lower]) return BY_NAME[lower];
  // 2) 形如 nginx.conf / app.properties 的「主名 + 扩展」都在 BY_EXT 里，走扩展名
  const ext = extOf(path);
  if (ext && BY_EXT[ext]) return BY_EXT[ext];
  // 3) 常见无扩展名脚本
  if (lower === 'nginx' || lower === 'docker' || lower === 'bashrc') return 'shell';
  // 4) 常见「点开头无扩展」配置（.bashrc 等已在 BY_NAME，这里兜底 .xxx.conf 形式）
  if (lower.startsWith('.') && !ext) return 'ini';
  return 'plaintext';
}

/** 该文件是否可能为二进制（按扩展名 + 名称特征判断，不可编辑） */
export function looksBinary(path: string): boolean {
  const ext = extOf(path);
  if (ext && BINARY_EXT.has(ext)) return true;
  // .so.1 / .tar.gz 这类复合扩展：取最后两段再判一次
  const name = baseName(path).toLowerCase();
  const parts = name.split('.');
  if (parts.length >= 3) {
    const last2 = parts[parts.length - 1];
    if (BINARY_EXT.has(last2)) return true;
  }
  return false;
}

/**
 * 是否允许在编辑器中打开。
 * 规则：非目录、看起来不是二进制、体积在上限内。
 */
export function canEdit(path: string, type: 'file' | 'dir', size: number): boolean {
  if (type !== 'file') return false;
  if (size > MAX_EDIT_BYTES) return false;
  if (looksBinary(path)) return false;
  return true;
}

/** 人类可读的语言名（标签页/状态栏展示用） */
export function languageLabel(lang: string): string {
  const map: Record<string, string> = {
    plaintext: '纯文本', markdown: 'Markdown', html: 'HTML', css: 'CSS', scss: 'SCSS', sass: 'Sass', less: 'Less',
    javascript: 'JavaScript', typescript: 'TypeScript', jsx: 'JSX', tsx: 'TSX', json: 'JSON', json5: 'JSON5',
    vue: 'Vue', svelte: 'Svelte', python: 'Python', ruby: 'Ruby', perl: 'Perl', php: 'PHP',
    shell: 'Shell', batch: '批处理', powershell: 'PowerShell', lua: 'Lua', tcl: 'Tcl', awk: 'AWK',
    go: 'Go', rust: 'Rust', java: 'Java', kotlin: 'Kotlin', scala: 'Scala', c: 'C', cpp: 'C++',
    csharp: 'C#', fsharp: 'F#', vb: 'VB', swift: 'Swift', objectivec: 'Objective-C',
    xml: 'XML', yaml: 'YAML', toml: 'TOML', ini: 'INI', dotenv: 'DotEnv', csv: 'CSV', sql: 'SQL',
    graphql: 'GraphQL', protobuf: 'Protobuf', hcl: 'HCL/Terraform', dockerfile: 'Dockerfile',
    makefile: 'Makefile', cmake: 'CMake', groovy: 'Groovy', latex: 'LaTeX', restructuredtext: 'reST',
    gitignore: 'gitignore', gitattributes: 'gitattributes', crontab: 'crontab', diff: 'Diff',
  };
  return map[lang] ?? lang;
}

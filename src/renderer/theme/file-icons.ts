/**
 * SFTP 文件图标：按文件类型给出差异化图标与配色（对标 VSCode 资源管理器 / WinSCP）。
 *
 * 之前所有文件都是同一个绿色文档图标，一眼扫过去完全分不清类型；
 * 现在按「目录 / 代码 / 配置 / 脚本 / 数据 / 压缩包 / 二进制 / 普通文件」分类，
 * 同类再用颜色区分（配置橙、脚本紫、数据青、压缩黄…）。
 */

/** 图标语义类别（决定用哪个图形 + 主题色槽） */
export type FileIconKind =
  | 'dir'
  | 'dir-open'
  | 'code'
  | 'config'
  | 'script'
  | 'data'
  | 'query'
  | 'markup'
  | 'archive'
  | 'binary'
  | 'log'
  | 'image'
  | 'cert'
  | 'lock'
  | 'file';

/** 扩展名 → 类别 */
const BY_EXT: Record<string, FileIconKind> = {
  // 代码
  js: 'code', mjs: 'code', cjs: 'code', jsx: 'code', ts: 'code', tsx: 'code',
  java: 'code', kt: 'code', scala: 'code', c: 'code', h: 'code', cpp: 'code', hpp: 'code', cc: 'code',
  go: 'code', rs: 'code', cs: 'code', swift: 'code', py: 'code', rb: 'code', php: 'code', pl: 'code',
  // 脚本
  sh: 'script', bash: 'script', zsh: 'script', ksh: 'script', ps1: 'script', bat: 'script', cmd: 'script',
  lua: 'script', tcl: 'script', awk: 'script', fish: 'script',
  // 配置
  yml: 'config', yaml: 'config', json: 'config', json5: 'config', toml: 'config', ini: 'config',
  cfg: 'config', conf: 'config', properties: 'config', env: 'config', xml: 'config', gradle: 'config',
  // 标记
  html: 'markup', htm: 'markup', vue: 'markup', svelte: 'markup', css: 'markup', scss: 'markup',
  less: 'markup', md: 'markup', markdown: 'markup', rst: 'markup', tex: 'markup',
  // 数据 / 查询
  sql: 'query', ddl: 'query', csv: 'data', tsv: 'data', xlsx: 'data', xls: 'data', db: 'data',
  sqlite: 'data', parquet: 'data',
  // 压缩
  zip: 'archive', gz: 'archive', tgz: 'archive', tar: 'archive', bz2: 'archive', xz: 'archive',
  rar: 'archive', '7z': 'archive', zst: 'archive', whl: 'archive', jar: 'archive', war: 'archive',
  // 日志
  log: 'log', out: 'log',
  // 密钥 / 锁
  pem: 'cert', crt: 'cert', key: 'lock', pub: 'cert', gpg: 'lock', asc: 'lock', p12: 'lock', jks: 'lock',
  keystore: 'lock',
  // 图片 / 字体
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image', ico: 'image', bmp: 'image',
  ttf: 'binary', otf: 'binary', woff: 'binary', woff2: 'binary', eot: 'binary',
  // 二进制
  exe: 'binary', dll: 'binary', so: 'binary', dylib: 'binary', bin: 'binary', class: 'binary',
  o: 'binary', a: 'binary', pyc: 'binary', img: 'binary', iso: 'binary', rpm: 'binary', deb: 'binary',
};

/** 文件名精确匹配（无扩展名但语义明确） */
const BY_NAME: Record<string, FileIconKind> = {
  dockerfile: 'config', containerfile: 'config', makefile: 'config', cmakelists: 'config',
  jenkinsfile: 'config', vagrantfile: 'config', procfile: 'config', gemfile: 'config', rakefile: 'script',
  'nginx.conf': 'config', '.bashrc': 'script', '.bash_profile': 'script', '.zshrc': 'script',
  '.profile': 'script', '.bash_logout': 'script', '.env': 'config', '.gitignore': 'config',
  '.gitattributes': 'config', '.gitconfig': 'config', '.editorconfig': 'config', '.npmrc': 'config',
  '.bash_history': 'log', '.mysql_history': 'log', '.psql_history': 'log',
  passwd: 'config', shadow: 'lock', fstab: 'config', crontab: 'config', hosts: 'config',
  'hosts.allow': 'config', 'hosts.deny': 'config', 'resolv.conf': 'config', 'os-release': 'config',
  id_rsa: 'lock', id_dsa: 'lock', id_ecdsa: 'lock', id_ed25519: 'lock', authorized_keys: 'lock',
  known_hosts: 'lock',
};

/** 取扩展名（小写，不含点） */
function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  if (i <= 0 || i === name.length - 1) return '';
  return name.slice(i + 1).toLowerCase();
}

/** 判定文件图标类别 */
export function fileIconKind(name: string, isDir: boolean, isOpen = false): FileIconKind {
  if (isDir) return isOpen ? 'dir-open' : 'dir';
  const lower = name.toLowerCase();
  if (BY_NAME[lower]) return BY_NAME[lower];
  // .env.local / nginx.conf 这类「主名.后缀」双段名也走名称表
  const ext = extOf(name);
  if (ext && BY_NAME[`${lower.slice(0, lower.length - ext.length - 1)}.${ext}`]) {
    return BY_NAME[`${lower.slice(0, lower.length - ext.length - 1)}.${ext}`];
  }
  if (ext && BY_EXT[ext]) return BY_EXT[ext];
  // 按扩展名首字符兜底
  if (ext) {
    if (/^\d+$/.test(ext)) return 'binary';
    if (ext.length <= 2) return 'config';
  }
  return 'file';
}

/**
 * 类别 → 主题色 class。
 * 只用 tailwind.config 里真实定义的语义色（fg/dim/dim2/accent/accent2/prod/ok/warn/
 * purple/blue/str/num/fn/ai/ai2），保证跟随配色方案切换。
 */
export function iconColorClass(kind: FileIconKind): string {
  switch (kind) {
    case 'dir':
    case 'dir-open':
      return 'text-warn';
    case 'code':
      return 'text-accent';
    case 'config':
      return 'text-prod';
    case 'script':
      return 'text-ai';
    case 'data':
      return 'text-ok';
    case 'query':
      return 'text-blue';
    case 'markup':
      return 'text-ai2';
    case 'archive':
      return 'text-purple';
    case 'log':
      return 'text-dim';
    case 'image':
      return 'text-str';
    case 'cert':
      return 'text-num';
    case 'lock':
      return 'text-dim2';
    case 'binary':
      return 'text-dim2';
    default:
      return 'text-dim2';
  }
}

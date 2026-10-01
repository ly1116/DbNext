/**
 * Java 序列化流（java.io.ObjectOutputStream 协议）解析器。
 *
 * 仅做「读取还原」：把 JDK 序列化二进制还原成可读 JSON 结构，
 * 用于 Redis 值面板的反序列化展示，不支持写回。
 *
 * 覆盖：TC_OBJECT / TC_ARRAY / TC_CLASS / TC_ENUM / TC_STRING(含 LONG) /
 * TC_REFERENCE / TC_CLASSDESC / TC_PROXYCLASSDESC / TC_BLOCKDATA(含 LONG)、
 * 类链字段值、SC_WRITE_METHOD 自定义数据；并对 String、包装类型、
 * BigInteger/BigDecimal、Date、java.time.*、UUID、常用集合
 * （HashMap/ArrayList/HashSet 等）与 Collections$* 包装类做特化还原。
 */

interface FieldDesc { name: string; tc: string }
interface ClassDesc { name: string; flags: number; fields: FieldDesc[]; super: ClassDesc | null }

const TC = {
  NULL: 0x70, REF: 0x71, CLASSDESC: 0x72, OBJECT: 0x73, STRING: 0x74, ARRAY: 0x75,
  CLASS: 0x76, BLOCKDATA: 0x77, ENDBLOCK: 0x78, RESET: 0x79, BLOCKLONG: 0x7a,
  LONGSTR: 0x7c, PROXY: 0x7d, ENUM: 0x7e,
} as const;

const SC_WRITE = 0x01, SC_SER = 0x02, SC_BLOCK = 0x04, SC_EXT = 0x08, SC_ENUMF = 0x10;
const HANDLE_BASE = 0x7e0000;
const LONG_MIN_STR = '-9223372036854775808';

/** 是否为 JDK 序列化流（魔数 AC ED 00 05） */
export function isJavaSerialized(b: Buffer): boolean {
  return b.length > 4 && b[0] === 0xac && b[1] === 0xed && b[2] === 0x00 && b[3] === 0x05;
}

const pad2 = (n: number) => String(n).padStart(2, '0');
const trimNano = (n: number) => (n ? '.' + String(n).padStart(9, '0').replace(/0+$/, '') : '');

/** byte[] → 可读值：可打印文本直接给字符串，否则 base64 标注 */
function bytesValue(b: Buffer): unknown {
  if (b.length === 0) return '';
  const s = b.toString('utf8');
  // round-trip 相等说明是合法 UTF-8；再排除常见控制字符
  if (Buffer.byteLength(s) === b.length && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(s)) return s;
  return { '@bytes': b.length, '@base64': b.toString('base64') };
}

/** 有符号 byte[] → BigInt（BigInteger.mag 用） */
function bytesToBigInt(b: Buffer): bigint {
  return b.length ? BigInt((b[0] & 0x80 ? '-' : '') + '0x' + b.toString('hex') || '0') : 0n;
}

/** (无符号值, 缩放) → 十进制字符串 */
function unscaledToString(v: bigint, scale: number): string {
  if (scale === 0) return v.toString();
  const neg = v < 0n;
  let s = (neg ? -v : v).toString();
  if (scale < 0) return (neg ? '-' : '') + s + '0'.repeat(-scale);
  s = s.padStart(scale + 1, '0');
  const out = `${s.slice(0, -scale)}.${s.slice(-scale)}`.replace(/\.?0+$/, '');
  return (neg ? '-' : '') + (out || '0');
}

const MONTHS: Record<string, number> = {
  JANUARY: 1, FEBRUARY: 2, MARCH: 3, APRIL: 4, MAY: 5, JUNE: 6,
  JULY: 7, AUGUST: 8, SEPTEMBER: 9, OCTOBER: 10, NOVEMBER: 11, DECEMBER: 12,
};

class Parser {
  pos = 0;
  depth = 0;
  private handles: unknown[] = [];
  constructor(private buf: Buffer) {}

  private need(n: number): void { if (this.pos + n > this.buf.length) throw new Error(`流提前结束 @${this.pos} 需 ${n} 字节`); }
  private b(): number { this.need(1); return this.buf[this.pos++]; }
  private peek(): number { if (this.pos >= this.buf.length) throw new Error('流提前结束'); return this.buf[this.pos]; }
  private i16(): number { this.need(2); const v = this.buf.readInt16BE(this.pos); this.pos += 2; return v; }
  private u16(): number { this.need(2); const v = this.buf.readUInt16BE(this.pos); this.pos += 2; return v; }
  private i32(): number { this.need(4); const v = this.buf.readInt32BE(this.pos); this.pos += 4; return v; }
  private i64(): bigint { this.need(8); const v = this.buf.readBigInt64BE(this.pos); this.pos += 8; return v; }
  private f32(): number { this.need(4); const v = this.buf.readFloatBE(this.pos); this.pos += 4; return v; }
  private f64(): number { this.need(8); const v = this.buf.readDoubleBE(this.pos); this.pos += 8; return v; }

  /** Modified UTF-8（含 0xC0 0x80 与 CESU-8 代理对） */
  private utf(len: number): string {
    this.need(len);
    const units: number[] = [];
    const end = this.pos + len;
    while (this.pos < end) {
      const a = this.buf[this.pos++];
      if (a < 0x80) units.push(a);
      else if ((a & 0xe0) === 0xc0) { this.need(1); units.push(((a & 0x1f) << 6) | (this.buf[this.pos++] & 0x3f)); }
      else if ((a & 0xf0) === 0xe0) {
        this.need(2);
        units.push(((a & 0x0f) << 12) | ((this.buf[this.pos++] & 0x3f) << 6) | (this.buf[this.pos++] & 0x3f));
      } else throw new Error(`非法 UTF 字节 0x${a.toString(16)}`);
    }
    let s = '';
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      if (u >= 0xd800 && u <= 0xdbff && i + 1 < units.length && units[i + 1] >= 0xdc00 && units[i + 1] <= 0xdfff) {
        s += String.fromCharCode(u, units[i + 1]); i++;
      } else s += String.fromCharCode(u);
    }
    return s;
  }

  private assign(v: unknown): number { this.handles.push(v); return this.handles.length - 1; }
  private ref(): unknown {
    const i = this.i32() - HANDLE_BASE;
    if (i < 0 || i >= this.handles.length || this.handles[i] === undefined) throw new Error(`无效句柄引用 #${i}`);
    return this.handles[i];
  }

  parse(): unknown {
    if (this.b() !== 0xac || this.b() !== 0xed) throw new Error('缺少 Java 序列化魔数');
    this.i16(); // 版本 0x0005
    return this.object();
  }

  private object(): unknown {
    const tag = this.b();
    switch (tag) {
      case TC.NULL: return null;
      case TC.REF: return this.ref();
      case TC.STRING: { const s = this.utf(this.i16()); this.assign(s); return s; }
      case TC.LONGSTR: { const s = this.utf(this.i32()); this.assign(s); return s; }
      case TC.OBJECT: return this.newObject();
      case TC.ARRAY: return this.newArray();
      case TC.CLASS: { const cd = this.classDesc(); const h = this.assign(null); const v = `class ${cd?.name ?? '?'}`; this.handles[h] = v; return v; }
      case TC.ENUM: return this.newEnum();
      case TC.BLOCKDATA: { const len = this.b(); this.need(len); this.pos += len; return null; }
      case TC.BLOCKLONG: { const len = this.i32(); this.need(len); this.pos += len; return null; }
      case TC.RESET: this.handles.length = 0; return this.object();
      default: throw new Error(`意外标签 0x${tag.toString(16)} @${this.pos - 1}`);
    }
  }

  private newObject(): unknown {
    if (++this.depth > 512) { this.depth--; throw new Error('嵌套过深'); }
    const cd = this.classDesc();
    if (!cd) throw new Error('对象缺少类描述');
    const h = this.assign(null);
    let v: unknown;
    try { v = this.classData(cd); } finally { this.depth--; }
    this.handles[h] = v;
    return v;
  }

  private newEnum(): unknown {
    const cd = this.classDesc();
    const h = this.assign(null);
    const name = this.object();
    const v = `${cd?.name ?? 'Enum'}.${String(name)}`;
    this.handles[h] = v;
    return v;
  }

  private classDesc(): ClassDesc | null {
    const tag = this.b();
    if (tag === TC.NULL) return null;
    if (tag === TC.REF) return this.ref() as ClassDesc;
    if (tag === TC.CLASSDESC) {
      const h = this.assign(null);
      const name = this.utf(this.i16());
      this.i64(); // serialVersionUID
      const flags = this.b();
      const fc = this.i16();
      const fields: FieldDesc[] = [];
      for (let i = 0; i < fc; i++) {
        const tc = String.fromCharCode(this.b());
        const fn = this.utf(this.i16());
        if (tc === 'L' || tc === '[') this.object(); // 对象字段的类型签名以字符串对象形式写入（TC_STRING/引用）
        fields.push({ name: fn, tc });
      }
      this.annots(); // 类注解（自定义 resolveClass 数据，通常仅 ENDBLOCK）
      const sup = this.superDesc();
      const cd: ClassDesc = { name, flags, fields, super: sup };
      this.handles[h] = cd;
      return cd;
    }
    if (tag === TC.PROXY) {
      const h = this.assign(null);
      const n = this.i32();
      for (let i = 0; i < n; i++) this.utf(this.i16());
      this.annots();
      const sup = this.superDesc();
      const cd: ClassDesc = { name: '(动态代理)', flags: SC_SER, fields: [], super: sup };
      this.handles[h] = cd;
      return cd;
    }
    throw new Error(`意外的 classDesc 标签 0x${tag.toString(16)} @${this.pos - 1}`);
  }

  private superDesc(): ClassDesc | null {
    const t = this.peek();
    if (t === TC.NULL) { this.b(); return null; }
    if (t === TC.CLASSDESC || t === TC.PROXY || t === TC.REF) return this.classDesc();
    return null; // 非法/未知情形不消费，交给上层容错
  }

  /** 读注解区：对象 + 块数据，直到 TC_ENDBLOCKDATA */
  private annots(): { bd: Buffer[]; objs: unknown[] } {
    const bd: Buffer[] = [];
    const objs: unknown[] = [];
    for (;;) {
      const t = this.peek();
      if (t === TC.ENDBLOCK) { this.b(); break; }
      if (t === TC.BLOCKDATA) { this.b(); const len = this.b(); this.need(len); bd.push(this.buf.subarray(this.pos, this.pos + len)); this.pos += len; continue; }
      if (t === TC.BLOCKLONG) { this.b(); const len = this.i32(); this.need(len); bd.push(this.buf.subarray(this.pos, this.pos + len)); this.pos += len; continue; }
      if (t === TC.RESET) { this.b(); this.handles.length = 0; continue; }
      objs.push(this.object());
    }
    return { bd, objs };
  }

  private classData(cd: ClassDesc): unknown {
    // 枚举：类数据即常量名
    if (cd.flags & SC_ENUMF) return `${cd.name}.${String(this.object())}`;
    const values: Record<string, unknown> = {};
    const bd: Buffer[] = [];
    const objs: unknown[] = [];
    // 字段值按「派生递增」顺序写入：基类字段（及其自定义数据）在前，派生类在后
    const chain: ClassDesc[] = [];
    for (let d: ClassDesc | null = cd; d; d = d.super) chain.unshift(d);
    for (const d of chain) {
      if (d.flags & SC_EXT && !(d.flags & SC_BLOCK)) throw new Error(`不支持的外部化对象 ${d.name}`);
      for (const f of d.fields) values[f.name] = this.fieldValue(f);
      const hasCustom = (d.flags & SC_SER && d.flags & SC_WRITE) || (d.flags & SC_EXT && d.flags & SC_BLOCK);
      if (hasCustom) {
        const a = this.annots();
        bd.push(...a.bd);
        objs.push(...a.objs);
      }
    }
    return this.wrap(cd.name, values, bd, objs);
  }

  private fieldValue(f: FieldDesc): unknown {
    switch (f.tc) {
      case 'B': return this.buf.readInt8(this.pos++);
      case 'C': return String.fromCharCode(this.u16());
      case 'D': return this.f64();
      case 'F': return this.f32();
      case 'I': return this.i32();
      case 'J': { const v = this.i64(); return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString(); }
      case 'S': return this.i16();
      case 'Z': return this.b() !== 0;
      default: return this.object(); // 'L' / '['
    }
  }

  private newArray(): unknown {
    const cd = this.classDesc();
    const h = this.assign(null);
    const n = this.i32();
    const put = (v: unknown) => { this.handles[h] = v; return v; };
    switch (cd?.name) {
      case '[C': { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(this.u16()); return put(s); }
      case '[B': { this.need(n); const b = this.buf.subarray(this.pos, this.pos + n); this.pos += n; return put(bytesValue(b)); }
      case '[Z': { const a: boolean[] = []; for (let i = 0; i < n; i++) a.push(this.b() !== 0); return put(a); }
      case '[S': { const a: number[] = []; for (let i = 0; i < n; i++) a.push(this.i16()); return put(a); }
      case '[I': { const a: number[] = []; for (let i = 0; i < n; i++) a.push(this.i32()); return put(a); }
      case '[J': { const a: (number | string)[] = []; for (let i = 0; i < n; i++) { const v = this.i64(); a.push(v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString()); } return put(a); }
      case '[F': { const a: number[] = []; for (let i = 0; i < n; i++) a.push(this.f32()); return put(a); }
      case '[D': { const a: number[] = []; for (let i = 0; i < n; i++) a.push(this.f64()); return put(a); }
      default: {
        const a: unknown[] = [];
        for (let i = 0; i < n; i++) a.push(this.object());
        return put(a);
      }
    }
  }

  /** 特化还原：常见 JDK 类型 → 直观 JSON */
  private wrap(name: string, v: Record<string, unknown>, bd: Buffer[], objs: unknown[]): unknown {
    try {
      switch (name) {
        case 'java.lang.String':
          return v.value;
        case 'java.lang.Byte': case 'java.lang.Short': case 'java.lang.Integer': case 'java.lang.Long':
          return Number(v.value);
        case 'java.lang.Float': case 'java.lang.Double':
          return v.value;
        case 'java.lang.Boolean':
          return Boolean(v.value);
        case 'java.lang.Character':
          return String(v.value ?? '');
        case 'java.util.Date': {
          if (bd.length && bd[0].length >= 8) return new Date(Number(bd[0].readBigInt64BE(0))).toISOString();
          break;
        }
        case 'java.util.UUID': {
          const m = BigInt(String(v.mostSigBits ?? 0));
          const l = BigInt(String(v.leastSigBits ?? 0));
          const hex = m.toString(16).padStart(16, '0') + l.toString(16).padStart(16, '0');
          return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
        }
        case 'java.math.BigInteger': {
          const mag = v.magnitude;
          if (mag && typeof mag === 'object' && '@base64' in (mag as Record<string, unknown>)) {
            const bytes = Buffer.from((mag as Record<string, string>)['@base64'], 'base64');
            const sign = Number(v.signum ?? 1);
            return sign === 0 ? '0' : (bytesToBigInt(bytes) * BigInt(sign)).toString();
          }
          break;
        }
        case 'java.math.BigDecimal': {
          const scale = Number(v.scale ?? 0);
          let unscaled: bigint | null = null;
          if (v.intCompact !== undefined && String(v.intCompact) !== LONG_MIN_STR) unscaled = BigInt(String(v.intCompact));
          else if (v.intVal != null) unscaled = BigInt(String(v.intVal));
          if (unscaled !== null) return unscaledToString(unscaled, scale);
          break;
        }
        case 'java.time.Instant':
          return `${new Date(Number(v.seconds ?? 0) * 1000).toISOString().slice(0, 19)}${trimNano(Number(v.nanos ?? 0))}Z`;
        case 'java.time.Duration':
          return `PT${Number(v.seconds ?? 0)}S`;
        case 'java.time.Period':
          return `P${Number(v.years ?? 0)}Y${Number(v.months ?? 0)}M${Number(v.days ?? 0)}D`;
        case 'java.time.LocalDate': {
          const mm = typeof v.month === 'string' ? MONTHS[v.month.split('.').pop() ?? ''] : Number(v.month);
          if (mm) return `${Number(v.year)}-${pad2(mm)}-${pad2(Number(v.day))}`;
          break;
        }
        case 'java.time.LocalTime':
          return `${pad2(Number(v.hour ?? 0))}:${pad2(Number(v.minute ?? 0))}:${pad2(Number(v.second ?? 0))}${trimNano(Number(v.nano ?? 0))}`;
        case 'java.time.LocalDateTime':
          if (typeof v.date === 'string' && typeof v.time === 'string') return `${v.date}T${v.time}`;
          break;
        case 'java.time.Ser': {
          // writeReplace 包装：type=1 Duration / 2 Instant / 3 LocalDate / 4 LocalTime / 5 LocalDateTime
          if (objs.length) return objs[0];
          if (bd.length) {
            const b = bd[0];
            const type = b[0];
            if (type === 2 && b.length >= 13) return `${new Date(Number(b.readBigInt64BE(1)) * 1000).toISOString().slice(0, 19)}${trimNano(b.readInt32BE(9))}Z`;
            if (type === 1 && b.length >= 9) return `PT${Number(b.readBigInt64BE(1))}S`;
            if (type === 3 && b.length >= 7) return `${b.readInt32BE(1)}-${pad2(b[5])}-${pad2(b[6])}`;
            if (type === 4 && b.length >= 8) return `${pad2(b[1])}:${pad2(b[2])}:${pad2(b[3])}${trimNano(b.readInt32BE(4))}`;
            if (type === 5 && b.length >= 14) return `${b.readInt32BE(1)}-${pad2(b[5])}-${pad2(b[6])}T${pad2(b[7])}:${pad2(b[8])}:${pad2(b[9])}${trimNano(b.readInt32BE(10))}`;
          }
          break;
        }
        case 'java.util.Optional':
          return v.value ?? null;
        case 'java.util.ArrayList': case 'java.util.LinkedList': case 'java.util.Stack':
          return objs.slice(0, Number(v.size ?? objs.length));
        case 'java.util.Vector':
          return (Array.isArray(v.elementData) ? v.elementData : objs).slice(0, Number(v.elementCount ?? 0));
        case 'java.util.ArrayDeque': {
          const size = bd.length ? Number(bd[bd.length - 1].readInt32BE(Math.max(0, bd[bd.length - 1].length - 4))) : objs.length;
          return objs.slice(0, size || objs.length);
        }
        case 'java.util.HashSet': case 'java.util.LinkedHashSet': case 'java.util.TreeSet': {
          const m = v.map ?? v.m ?? objs[0];
          return this.keysOf(m);
        }
        case 'java.util.HashMap': case 'java.util.LinkedHashMap': case 'java.util.Hashtable': case 'java.util.TreeMap': case 'java.util.concurrent.ConcurrentHashMap':
          return this.pairsOf(objs);
        default: {
          if (name.startsWith('java.util.Collections$')) {
            const short = name.slice('java.util.Collections$'.length);
            if (short === 'EmptyList' || short === 'EmptySet' || short === 'EmptySortedSet') return [];
            if (short === 'EmptyMap' || short === 'EmptySortedMap') return {};
            if (short === 'SingletonList' || short === 'SingletonSet') return [v.element ?? objs[0]];
            if (short === 'SingletonMap') return { [String(v.k ?? objs[0])]: v.v ?? objs[1] };
            // UnmodifiableMap / UnmodifiableCollection / SubList 等：解包内部集合
            for (const key of ['m', 'list', 'c']) if (key in v) return v[key];
          }
          break;
        }
      }
    } catch { /* 特化失败回退通用结构 */ }
    const out: Record<string, unknown> = { '@class': name, ...v };
    if (objs.length) out['@extra'] = objs;
    if (bd.length) out['@blockdata'] = `«自定义序列化数据 ${bd.length} 段»`;
    return out;
  }

  /** 对象/数组 kv 对 → 全字符串键时给对象，否则 [k,v] 数组 */
  private pairsOf(objs: unknown[]): unknown {
    const entries: [unknown, unknown][] = [];
    for (let i = 0; i + 1 < objs.length; i += 2) entries.push([objs[i], objs[i + 1]]);
    if (entries.every(([k]) => typeof k === 'string')) {
      const o: Record<string, unknown> = {};
      for (const [k, val] of entries) o[k as string] = val;
      return o;
    }
    return entries;
  }

  /** Map 值 → 键集合（HashSet 家族） */
  private keysOf(m: unknown): unknown {
    if (m && typeof m === 'object' && !Array.isArray(m)) return Object.keys(m);
    if (Array.isArray(m)) return m.map((e) => (Array.isArray(e) ? e[0] : e));
    return m;
  }
}

/** 解析 JDK 序列化二进制为可读 JSON 结构 */
export function parseJavaSerialized(buf: Buffer): unknown {
  return new Parser(buf).parse();
}

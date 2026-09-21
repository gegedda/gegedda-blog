/**
 * frontmatter 的解析与**规范形式**序列化。
 *
 * 为什么解析和序列化要分开对待：
 *   - 解析必须健壮。标题里有冒号、描述跨多行、值里带引号——手写解析器遇到这些
 *     会静默丢数据。所以解析交给 js-yaml。
 *   - 序列化必须**可预测**。js-yaml 的 dump 会按自己的规则决定加不加引号
 *     （'欢迎' 会输出成不加引号的 欢迎），那样来回一趟就和原文对不上了。
 *     所以序列化由自己写，规则固定死。
 *
 * 两者合起来保证「Markdown → 数据库 → Markdown」逐字节一致，
 * 这是 P0 的验收判据，也是内容不丢的唯一证据。
 */

// js-yaml 5 的 ESM 构建只有具名导出，没有 default —— 写 `import yaml from 'js-yaml'`
// 会在解析期就抛 "does not provide an export named 'default'"。
import { load as loadYaml, JSON_SCHEMA } from 'js-yaml';

/** frontmatter 分隔符 */
const DELIM = '---';

/**
 * 导出时的键顺序。固定顺序才能保证同一份数据每次产出同样的字节，
 * 否则 diff 里全是无意义的键序变动。
 *
 * 顺序与 content.config.ts 的 schema 声明顺序一致。
 */
export const KEY_ORDER = [
  'title',
  'description',
  'pubDate',
  'updatedDate',
  'heroImage',
  'draft',
  'tags',
  'categories',
];

/** 这几个键一律写成单引号字符串（现有文章的写法就是如此） */
const QUOTED_KEYS = new Set(['title', 'description', 'pubDate', 'updatedDate', 'heroImage']);

/** 这几个键是字符串数组，写成 YAML 流式数组 */
const ARRAY_KEYS = new Set(['tags', 'categories']);

/**
 * 剥掉 UTF-8 BOM。
 *
 * BOM 会让 YAML frontmatter 解析失败（`---` 前面多出三个不可见字节），
 * 也会让 sqlite3 读 .sql 时首条语句报语法错——两处报的错看起来都和编码无关。
 * 所以读入口一律先剥 BOM，而不是等它出错。
 */
export function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * 拆出一篇文章的 frontmatter 与正文。
 *
 * 返回：
 *   frontmatter —— 解析后的普通对象
 *   body        —— 正文，**不含** frontmatter 与正文之间那个空行
 *                  （序列化时会原样补回去，所以来回一趟字节不变）
 */
export function parsePostFile(text) {
  const src = stripBom(text);

  if (!src.startsWith(DELIM + '\n')) {
    throw new Error(`缺少 frontmatter：文件必须以 "${DELIM}" 独占一行开头`);
  }

  // 只在第 4 个字符之后找闭合行，避免把开头的 --- 当成闭合
  const end = src.indexOf('\n' + DELIM, DELIM.length);
  if (end === -1) {
    throw new Error(`frontmatter 没有闭合的 "${DELIM}"`);
  }

  const rawFm = src.slice(DELIM.length + 1, end);
  let body = src.slice(end + 1 + DELIM.length);

  // 这里要吃掉**两层**换行，少一层就回不去：
  //   第一层是闭合分隔行 `---` 自己的行尾
  //   第二层是 frontmatter 与正文之间的那个空行
  // 序列化时会原样补回两层（`---\n\n`），所以正文存的是干净的第一行。
  // 只吃一层的后果很隐蔽：body 会以 '\n' 开头，导出时多出一个空行，
  // 逐字节比对失败，但页面上肉眼看不出任何区别。
  if (body.startsWith('\n')) body = body.slice(1);
  if (body.startsWith('\n')) body = body.slice(1);

  // JSON_SCHEMA 而不是默认 schema：让 `2026-09-20` 这种值保持字符串。
  // 需要的是「frontmatter 里写了什么」，不是「它代表什么时刻」——
  // 后者由 pub_date_utc 承担。
  //
  // 空 frontmatter 单独处理：js-yaml 5 对空输入**抛异常**（4.x 是返回 undefined），
  // 而 `---\n---\n` 这种空 frontmatter 是合法的，不该让整个导入挂掉。
  const frontmatter = rawFm.trim() === '' ? {} : loadYaml(rawFm, { schema: JSON_SCHEMA });

  if (typeof frontmatter !== 'object' || Array.isArray(frontmatter)) {
    throw new Error('frontmatter 必须是键值对');
  }

  return { frontmatter, body };
}

/** YAML 单引号字符串：内部的 ' 要写成 '' */
function quote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** 流式数组：tags: ['a', 'b'] */
function flowArray(values) {
  return `[${values.map(quote).join(', ')}]`;
}

/**
 * 按规范形式序列化 frontmatter。
 *
 * 省略规则（与现有文章一致）：
 *   - draft 为 false 时不写（schema 默认值就是 false，写出来是噪音）
 *   - tags / categories 为空数组时不写
 *   - 其余 undefined / null 不写
 */
export function serializeFrontmatter(frontmatter) {
  const lines = [];

  for (const key of KEY_ORDER) {
    const value = frontmatter[key];

    if (value === undefined || value === null) continue;
    if (key === 'draft') {
      if (value !== true) continue;
      lines.push(`${key}: true`);
      continue;
    }
    if (ARRAY_KEYS.has(key)) {
      if (!Array.isArray(value) || value.length === 0) continue;
      lines.push(`${key}: ${flowArray(value)}`);
      continue;
    }
    if (QUOTED_KEYS.has(key)) {
      lines.push(`${key}: ${quote(value)}`);
      continue;
    }

    lines.push(`${key}: ${value}`);
  }

  return lines.join('\n');
}

/**
 * 反过来拼回一个完整的 Markdown 文件。
 *
 * 中间那个空行是**固定**写死的：parsePostFile 会吃掉它，这里补回来，
 * 于是 `---\n<fm>\n---\n\n<body>` 这个形状来回一趟稳定不变。
 */
export function serializePostFile(frontmatter, body) {
  return `${DELIM}\n${serializeFrontmatter(frontmatter)}\n${DELIM}\n\n${body}`;
}

/**
 * 日期原文 → epoch 毫秒。**实现已搬到 `src/utils/date-raw.ts`**，这里只做转发。
 *
 * 搬家的理由：P5 的写接口（Worker 代码）也要用它，而 Worker 不能引
 * 这个文件——它顶层 import 了 js-yaml，那是个 devDependency。
 * `src/utils/` 是"两端都能引"的地方，`tag-segment.ts` / `reading.ts` 已经在那儿。
 *
 * 保留这行 re-export 是为了让 `content-to-sql.mjs` 等处的 import 一个字都不用改，
 * 同时保证**全项目只有一份实现**——写第二遍的表现是某些文章的排序悄悄不对。
 */
export { dateRawToUtc } from '../../src/utils/date-raw.ts';

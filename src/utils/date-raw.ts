/**
 * frontmatter 里的日期原文 → 用于 ORDER BY 的 epoch 毫秒。
 *
 * 只服务排序，不参与任何显示或分组：分组一律走 `src/utils/posts.ts` 里
 * 那三段 Asia/Shanghai 的 Intl.DateTimeFormat。
 *
 * ── 为什么这个函数住在 src/ 而不是 scripts/ ──────────────────────
 *
 * 它原来在 `scripts/lib/frontmatter.mjs` 里，那个文件 import 了 `js-yaml`
 * （一个 devDependency）。**Worker 代码不能引 devDependency**，而 P5 的写接口
 * 需要在校验之后用它算出 `pub_date_utc` 才能入库。
 *
 * 搬到 `src/utils/` 与 `tag-segment.ts` / `reading.ts` 是同一个位置理由：
 * 它们是少数几个**同时被 src/ 与 scripts/ 导入**的纯函数模块
 * （`scripts/content-to-sql.mjs` 已经在 import 那两个）。
 * `frontmatter.mjs` 现在只是把它 re-export 出去，保持脚本侧的 import 路径不变。
 *
 * 这个文件**不能**引入任何 `node:` 或构建期模块——它要能在 workerd 里跑。
 */

/**
 * 显式校验的原因：`Date.parse` 对无法识别的输入返回 NaN 而**不抛错**，
 * NaN 插进 INTEGER 列会变成 NULL，表现为「这篇文章莫名其妙排到最后」。
 */
export function dateRawToUtc(raw: string | Date): number {
	if (typeof raw !== 'string' && !(raw instanceof Date)) {
		throw new Error(`日期必须是字符串，收到 ${typeof raw}`);
	}
	const value = raw instanceof Date ? raw.toISOString() : raw;
	const ms = Date.parse(value);
	if (Number.isNaN(ms)) {
		throw new Error(`无法解析的日期：${JSON.stringify(raw)}`);
	}
	return ms;
}

/**
 * 日期原文是否是一个**真实存在**的日子。
 *
 * `dateRawToUtc` 挡不住 `2026-02-31`：`Date.parse` 对它是**宽容**的，
 * 返回的是 3 月 3 日，而不是 NaN。所以后台的日期输入需要这道更严的检查。
 *
 * 判据是「解析回来还是同一天」。只比对 「格式化后的字符串等于原串」不够可靠
 * （各引擎对越界日期的进位策略一致，但那是实现细节）；这里直接比较年月日三元组。
 *
 * 注意用 `Date.UTC` 解析而不是 `Date.parse`：`Date.parse('2026-02-31')`
 * 走的是本地时区规则，同一台机器换了 TZ 结果可能不同，而这里要的是
 * 与 `pub_date_utc`（UTC 零点）一致的语义。
 */
export function isValidDateRaw(raw: string): boolean {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
	if (!m) return false;

	const [, y, mo, d] = m;
	const year = Number(y);
	const month = Number(mo);
	const day = Number(d);
	if (month < 1 || month > 12 || day < 1 || day > 31) return false;

	const ms = Date.UTC(year, month - 1, day);
	if (Number.isNaN(ms)) return false;

	const date = new Date(ms);
	return (
		date.getUTCFullYear() === year &&
		date.getUTCMonth() === month - 1 &&
		date.getUTCDate() === day
	);
}

/**
 * 今天的日期原文（`YYYY-MM-DD`），**按上海时区**。
 *
 * 后台新建文章时用它填默认的发布日期。
 *
 * 为什么不能用 `new Date().toISOString().slice(0, 10)`：那是 **UTC** 日期。
 * 上海的凌晨 0 点到 8 点之间，UTC 还停在前一天，于是"今天写的文章"会被
 * 标成昨天——而且只在那个时段复现。这和 `src/utils/posts.ts` 里
 * `postYear/postMonth/postDay` 必须显式写 `timeZone: 'Asia/Shanghai'`
 * 是同一条约定，站点只认一个时区。
 *
 * `en-CA` 的默认格式恰好是 ISO 的 `YYYY-MM-DD`，不需要再拼。
 */
export function todayDateRaw(now: Date = new Date()): string {
	return new Intl.DateTimeFormat('en-CA', {
		timeZone: 'Asia/Shanghai',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	}).format(now);
}

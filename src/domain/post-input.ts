/**
 * 后台写接口的输入校验。**纯函数**，不碰 D1、不碰 Request、不碰 Astro。
 *
 * 写成纯函数是为了能直接单测：构造一个 `Request` 去测校验器，
 * 得到的失败信息里分不清是"校验拒绝"还是"读 body 时就炸了"。
 *
 * ── 每一条规则都对应一个**不报错**的失效模式 ──────────────────
 *
 * 这个文件的注释密度偏高，是因为这里的每一条看起来都可以"以后再补"，
 * 而它们的共同点是：不校验不会立刻出错，只会让数据或页面在某个时刻
 * 悄悄不对。具体后果逐条写在下面。
 */

import { isValidDateRaw } from '../utils/date-raw';
import { tagSegment } from '../utils/tag-segment';

/** slug 的规范形式：小写字母数字，单词间单连字符。 */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const MAX_SLUG_LENGTH = 120;
export const MAX_TITLE_LENGTH = 200;
export const MAX_DESCRIPTION_LENGTH = 1000;
export const MAX_HERO_IMAGE_LENGTH = 500;
export const MAX_HEADINGS = 500;
export const MAX_TAGS = 20;
export const MAX_TAG_LENGTH = 32;
export const MAX_MINUTES = 100_000;

/**
 * `body` + `bodyHtml` 的长度上限。
 *
 * ⚠️ **这是一个防御性的界，不是查出来的 D1 限制。** D1 的单行/语句上限
 * 在本项目里没有实测过（计划 §12 未决项 6）。取一个明显安全的数，
 * 超了返回 413 并带一句人话，而不是让 D1 抛一句看不懂的 SQL 报错。
 *
 * 第一次真实保存一个接近上限的草稿时，用 `wrangler dev` 实测真值，
 * 回来把这个数字换成实测结果。
 */
export const MAX_CONTENT_LENGTH = 900_000;

export interface PostInput {
	slug: string;
	title: string;
	description: string;
	pubDateRaw: string;
	updatedDateRaw: string | null;
	heroImage: string | null;
	draft: boolean;
	body: string;
	bodyHtml: string;
	headingsJson: string;
	words: number;
	minutes: number;
	tags: string[];
	categories: string[];
}

/**
 * 把"成功/失败"表达成**一个形状**，成功时值放在 `.value` 里。
 *
 * ⚠️ 这个类型的存在是因为它挡掉了一整类 bug。原来几个解析辅助函数
 * 的签名是 `T | ValidationResult`（成功直接返回 `T`，失败返回对象），
 * 调用点靠自己判断"拿到的是 T 还是失败对象"——而 `parseHeadings` 成功时
 * 返回的是 **string**，调用点却用 `Array.isArray()` 判，于是
 * **每一个合法输入都被判成失败**，函数提前返回一个裸字符串。
 * 后果是 `parsed.ok` 为 undefined，所有保存全部失败，而且不抛异常。
 *
 * 统一成 `.ok` 之后，"判错了"这件事在类型上就不可能发生：
 * 无论 `T` 是什么（string、数组、对象），判据都是同一个字段。
 */
export type Parsed<T> =
	| { ok: true; value: T }
	| { ok: false; status: number; message: string };

export type ValidationResult = Parsed<PostInput>;

function bad<T>(status: number, message: string): Parsed<T> {
	return { ok: false, status, message };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 字符串数组：去重、去空、限量、限长。 */
function parseStringList(raw: unknown, label: string): Parsed<string[]> {
	if (raw === undefined || raw === null) return { ok: true, value: [] };
	if (!Array.isArray(raw)) return bad(400, `${label}必须是数组`);
	if (raw.length > MAX_TAGS) return bad(400, `${label}最多 ${MAX_TAGS} 个`);

	const out: string[] = [];
	const seen = new Set<string>();
	for (const item of raw) {
		if (typeof item !== 'string') return bad(400, `${label}的每一项都必须是字符串`);
		const value = item.trim();
		if (value === '') return bad(400, `${label}里有空项`);
		if (value.length > MAX_TAG_LENGTH) {
			return bad(400, `${label}里的「${value.slice(0, 12)}…」超过 ${MAX_TAG_LENGTH} 个字符`);
		}
		if (seen.has(value)) continue;
		seen.add(value);
		out.push(value);
	}
	return { ok: true, value: out };
}

/** 目录项的 JSON 原文：缺省补 `'[]'`，给了就要能解析成合法形状。 */
function parseHeadings(raw: unknown): Parsed<string> {
	if (raw === undefined || raw === null) return { ok: true, value: '[]' };
	if (typeof raw !== 'string') return bad(400, 'headingsJson 必须是字符串');

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return bad(400, 'headingsJson 不是合法的 JSON');
	}
	if (!Array.isArray(parsed)) return bad(400, 'headingsJson 必须是一个数组');
	if (parsed.length > MAX_HEADINGS) {
		return bad(400, `目录项太多了（${parsed.length} 项，上限 ${MAX_HEADINGS}）`);
	}

	for (const item of parsed) {
		if (!isPlainObject(item)) return bad(400, '目录项必须是对象');
		const { depth, slug, text } = item;
		if (typeof depth !== 'number' || !Number.isInteger(depth) || depth < 1 || depth > 6) {
			// 越界的 depth 会让 TableOfContents 渲染出 h7 之类的标签，
			// 或者把层级算错——页面看着没问题，只是目录结构是错的。
			return bad(400, '目录项的 depth 必须是 1–6 的整数');
		}
		if (typeof slug !== 'string' || slug === '') return bad(400, '目录项缺少 slug');
		if (typeof text !== 'string') return bad(400, '目录项缺少 text');
	}

	// 存**原文**而不是 `JSON.stringify(parsed)`：重新序列化会改变键的顺序
	// 与空白，于是"保存两次"在字节层面不相等——那正好是 §13.11 第 11 条
	// 那条不动点断言要盯的东西。
	return { ok: true, value: raw };
}

/**
 * 校验一份写请求。
 *
 * 返回归一化之后的值（tag 已 trim、目录已校验），路由直接把它交给写层，
 * 不再自己加工——两处加工就会出现"接口存的和校验的不是同一份"。
 */
export function validatePostInput(raw: unknown): ValidationResult {
	if (!isPlainObject(raw)) return bad(400, '请求体必须是一个对象');

	// ── slug ────────────────────────────────────────────────────
	const { slug } = raw;
	if (typeof slug !== 'string' || slug === '') return bad(400, '缺少 slug');
	if (slug.length > MAX_SLUG_LENGTH) {
		return bad(400, `slug 超过 ${MAX_SLUG_LENGTH} 个字符`);
	}
	if (!SLUG_PATTERN.test(slug)) {
		// 不校验的后果：URL 里出现需要百分号编码的字符，而
		// `src/pages/posts/[...slug].astro` 的前提是「params 已经是解码后的」。
		// 那个前提失效时页面不是 404，是错的文章。
		return bad(400, 'slug 只能是小写字母、数字和单个连字符（如 hello-world）');
	}

	// ── 文本字段 ────────────────────────────────────────────────
	const { title, description } = raw;
	if (typeof title !== 'string' || title.trim() === '') return bad(400, '标题不能为空');
	if (title.length > MAX_TITLE_LENGTH) return bad(400, `标题超过 ${MAX_TITLE_LENGTH} 个字符`);
	if (typeof description !== 'string') return bad(400, 'description 必须是字符串');
	if (description.length > MAX_DESCRIPTION_LENGTH) {
		return bad(400, `摘要超过 ${MAX_DESCRIPTION_LENGTH} 个字符`);
	}

	// ── 日期 ────────────────────────────────────────────────────
	const { pubDateRaw } = raw;
	if (typeof pubDateRaw !== 'string') return bad(400, '缺少发布日期');
	if (!isValidDateRaw(pubDateRaw)) {
		// 只检查格式是不够的：`2026-02-31` 能过正则，而 Date.parse 是宽容的，
		// 它会把它当成 3 月 3 日。不拦的话存进去的是一个"文章日期自己变了"的 bug。
		return bad(400, `发布日期不是一个真实存在的日子：${pubDateRaw}`);
	}

	let updatedDateRaw: string | null = null;
	if (raw.updatedDateRaw !== undefined && raw.updatedDateRaw !== null) {
		if (typeof raw.updatedDateRaw !== 'string' || !isValidDateRaw(raw.updatedDateRaw)) {
			return bad(400, `更新日期不是一个真实存在的日子：${String(raw.updatedDateRaw)}`);
		}
		updatedDateRaw = raw.updatedDateRaw;
	}

	// ── 封面图 ──────────────────────────────────────────────────
	let heroImage: string | null = null;
	if (raw.heroImage !== undefined && raw.heroImage !== null && raw.heroImage !== '') {
		if (typeof raw.heroImage !== 'string') return bad(400, '封面图必须是字符串');
		if (raw.heroImage.length > MAX_HERO_IMAGE_LENGTH) {
			return bad(400, `封面图路径超过 ${MAX_HERO_IMAGE_LENGTH} 个字符`);
		}
		heroImage = raw.heroImage;
	}

	// ── draft ───────────────────────────────────────────────────
	const { draft } = raw;
	if (typeof draft !== 'boolean') return bad(400, 'draft 必须是 true 或 false');

	// ── 正文 ────────────────────────────────────────────────────
	const { body, bodyHtml } = raw;
	if (typeof body !== 'string' || body === '') return bad(400, '正文不能为空');
	if (body.includes('\r')) {
		// ⚠️ 这一条**不可能在浏览器里被发现**。
		//
		// 正文是经由 HTML 属性（data-post）传下来的，而 HTML 输入流预处理器
		// 会把 \r\n 和 \r 规范化成 \n。所以带 CR 的正文到了前端就是 LF，
		// 保存回去也看不出来——直到有一天拿库里的 body 和原始文件逐字节比对，
		// 发现少了几个字节，而两边的肉眼渲染完全一样。
		//
		// 仓库有 .gitattributes 的 eol=lf 与 .editorconfig 的 end_of_line = lf，
		// Vditor 的产出也是 LF，正常路径不会出现。出现了说明有别的工具介入，
		// 报错能把它变成一个可查的故障。
		return bad(400, '正文里含有回车符（\\r）。这通常意味着有别的工具改写了换行，请检查后再保存。');
	}
	if (typeof bodyHtml !== 'string') return bad(400, '缺少渲染后的 HTML');

	if (/<\s*script/i.test(bodyHtml) || /<\s*iframe/i.test(bodyHtml)) {
		// ⚠️ 这是**护栏，不是安全边界**，而且**有正常的误报可能**。
		//
		// `shared/markdown.ts` 是开着 allowDangerousHtml 的（601 与 605 两处），
		// 所以正文里合法的原始 HTML 会原样穿过渲染管线。也就是说，
		// 一个人真的在 Markdown 里写 <script> 会被这里拒绝——那是有意的，
		// 博客正文不该有它，但注释里不能写成"零误报"。
		//
		// 它挡的是这条路径：会话被盗后往正文里塞脚本，从而对所有读者生效。
		return bad(400, '渲染结果里含有 <script> 或 <iframe>。请把它从正文里去掉。');
	}

	if (body.length + bodyHtml.length > MAX_CONTENT_LENGTH) {
		return bad(
			413,
			`正文太长了（Markdown ${body.length} + HTML ${bodyHtml.length} 字符，上限 ${MAX_CONTENT_LENGTH}）。`,
		);
	}

	// ── 缓存列 ──────────────────────────────────────────────────
	const { words, minutes } = raw;
	if (typeof words !== 'number' || !Number.isFinite(words) || words < 0) {
		return bad(400, 'words 必须是非负数');
	}
	if (
		typeof minutes !== 'number' ||
		!Number.isInteger(minutes) ||
		minutes < 1 ||
		minutes > MAX_MINUTES
	) {
		return bad(400, 'minutes 必须是 1 以上的整数');
	}

	// 三个辅助函数的判据都是 `.ok`，**不再按返回值的形状去猜**。
	// 这里曾经写的是 `if (!Array.isArray(headingsJson)) return headingsJson;`，
	// 而 `parseHeadings` 成功时返回的是一个 **string**——`Array.isArray('…')`
	// 恒为 false，于是每一个合法输入都在这里被当成失败返回，
	// 症状是"保存永远失败且不抛异常"。统一成 `.ok` 之后这类错误写不出来。
	const headings = parseHeadings(raw.headingsJson);
	if (!headings.ok) return headings;

	// ── 标签 ────────────────────────────────────────────────────
	const tags = parseStringList(raw.tags, '标签');
	if (!tags.ok) return tags;
	const categories = parseStringList(raw.categories, '分类');
	if (!categories.ok) return categories;

	// 两个不同的显示名规范化后撞到同一个 URL 片段（'Hello World' 与 'hello-world'）。
	// 在**输入内部**就能发现，所以在这里报 409。
	//
	// 与库里已有标签的冲突这里看不到 —— 那一半在写层（`posts.write.ts` 的
	// `assertNoTagCollision`），因为它需要一次查询。
	//
	// 不预检的后果：撞的是 tags.segment 的 UNIQUE 约束，报出来是一句
	// 「UNIQUE constraint failed: tags.segment」，看不出和标签有关。
	const bySegment = new Map<string, string>();
	for (const tag of tags.value) {
		const segment = tagSegment(tag);
		const previous = bySegment.get(segment);
		if (previous !== undefined && previous !== tag) {
			return bad(409, `标签「${previous}」和「${tag}」会变成同一个地址 /tags/${segment}/，请改掉其中一个。`);
		}
		bySegment.set(segment, tag);
	}

	return {
		ok: true,
		value: {
			slug,
			title: title.trim(),
			description,
			pubDateRaw,
			updatedDateRaw,
			heroImage,
			draft,
			body,
			bodyHtml,
			headingsJson: headings.value,
			words,
			minutes,
			tags: tags.value,
			categories: categories.value,
		},
	};
}

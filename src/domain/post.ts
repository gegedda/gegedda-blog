/**
 * Post 实体。
 *
 * 改造前它是 `CollectionEntry<'blog'>`（Astro 内容集合的条目）。现在内容存在
 * D1 里，这个类型就是"一篇文章"的领域定义，由 `src/data/posts.repo.ts` 从
 * 数据库行映射出来。
 *
 * 为什么形状刻意贴近 CollectionEntry：全站有 7 处调用 `src/utils/posts.ts`
 * 的导出、18 个组件读 `post.data.*`。保持 `{ id, data, body }` 这个外形，
 * 各处就不用改，改造的爆炸半径只有仓储层一个文件。
 *
 * CollectionEntry 额外带的 `collection` / `filePath` / `digest` / `rendered` /
 * `deferredRender` 没有搬过来：它们在 `src/` 里零引用（已全树核实）。
 * 唯一用到的是 `post.body` 和 `render(post)`，后者是 `feed.xml.js` 里那个
 * 每次请求重渲染全部文章的地方——它改用 `bodyHtml` 缓存列。
 */

/** 与 Markdown 的 frontmatter 一一对应。字段名与 `content.config.ts` 的 schema 一致。 */
export interface PostData {
	title: string;
	description: string;
	/**
	 * **上海时区**语义下的发布日期。
	 *
	 * 数据库里存的是 `pub_date_raw` 原文与 `pub_date_utc`（仅服务 ORDER BY）。
	 * 这里把它还原成 Date，之后一律交给 `postYear` / `postMonth` / `postDay`
	 * 那三段 `Asia/Shanghai` 的 Intl 格式化器——**不要在别处再算一次日期**，
	 * 那会出现第二份时区实现，表现是侧栏、归档、正文三处日期对不上。
	 */
	pubDate: Date;
	updatedDate?: Date;
	/**
	 * 封面图在 frontmatter 里的**相对路径原文**（如 `'../../assets/x.jpg'`）。
	 *
	 * 类型与改造前不同：以前 `image()` 把它解析成 ImageMetadata 对象，直接喂给
	 * Astro 的 `<Image>`。Workers 上没有 sharp，`<Image>` 会退化成直通服务
	 * （不缩放、不转格式），所以那个方案连同 `image()` 一起作废了。
	 * 保持原文不解析，是留给 P6 上 R2 的接缝：到时候只需要改**解析处**一个函数。
	 */
	heroImage?: string;
	draft: boolean;
	tags: string[];
	categories: string[];
}

/**
 * frontmatter 里的封面图路径原文 → 可用的 URL。取不到则返回 undefined，
 * 模板里 `heroImage && …` 的写法就自然不渲染（而不是渲染一个碎图）。
 *
 * 数据库里存的是**原文**（`'../../assets/blog-placeholder-4.jpg'`），
 * 解析只在这一处发生。这是留给 P6 上 R2 的接缝：那时候只需要把
 * 下面这个 `/hero/` 前缀换成 R2 的地址，数据一行都不用动。
 *
 * 为什么要解析而不能原样喂给 `<img src>`：那个路径是**相对于内容文件**的
 * （`src/content/blog/` 往上两级到 `src/assets/`），浏览器按站点根解析会 404。
 * 改造前 `image()` 在构建期把它变成一个带哈希的产物地址，现在没有那一步了。
 *
 * 已经写成绝对地址（`/` 开头或带协议）的原样返回，方便逐篇迁移，
 * 也避免以后往库里直接写 R2 地址时被这个函数改坏。
 *
 * ── 已知退化，留给 P6 ────────────────────────────────────────────
 *
 * 改造前封面图走 `<Image>`，产物是 sharp 转出来的 **webp**；现在是原图 jpg。
 * 实测（`fetch` 对比线上旧站与新站的同一张图）：
 *
 *     blog-placeholder-1   旧 webp 23.0 KB  →  新 jpg 31.3 KB   （+36%）
 *
 * 封面图是文章页的 LCP 元素，所以这条直接打在 G3 上。之所以现在不补：
 * 省下的是 8 KB 量级，在 4G 上约 20–40ms，不是 LCP 的主导项——
 * 补它要么得预生成 webp 再写 `<picture>`，要么等 P6 上 R2 时一起做
 * （那时的方案本来就是"客户端预缩放后上传"，格式转换顺带就解决了）。
 * 现在做一半，P6 会推翻重做一遍。
 *
 * 真要现在补的话：`sharp` 已经是依赖，离线转一遍写进 `public/hero/`，
 * 这里返回 `/hero/<stem>.webp`，模板里用 `<picture>` 带 jpg 兜底
 * （这样漏转的图会静默回落到 jpg，而不是碎图）。
 */
export function heroImageSrc(raw: string | undefined): string | undefined {
	if (!raw) return undefined;
	if (raw.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(raw)) return raw;

	// 只取文件名：不试图还原 `../../` 的相对语义，那会把「图片放在哪」
	// 这个仓储布局的决定泄露到每一篇文章的 frontmatter 里。
	const base = raw.split('/').pop();
	if (!base) return undefined;
	return `/hero/${base}`;
}

/** `headings_json` 解析后的形状，与 `src/utils/toc.ts` 的 Heading 对齐。 */
export interface PostHeading {
	depth: number;
	slug: string;
	text: string;
}

export interface Post {
	/** 等于 `posts.slug` 主键，也等于改造前的 `post.id`。URL 由它决定，不能改。 */
	id: string;
	data: PostData;
	/** Markdown 源码。库里存的唯一真源。 */
	body: string;
	/**
	 * ↓ 以下四列是**可重建的缓存**，导入时由 `shared/markdown.ts` 渲染好写进库。
	 *
	 * 为什么不当场算：Workers 免费版每次请求只有 10ms CPU，读路径必须直接取
	 * 现成的 HTML。渲染一篇带代码块的文章远超这个预算，而且 shiki 在 Worker 里
	 * 根本跑不起来。
	 *
	 * 它们和 `posts` 表的缓存列一一对应，导入脚本在**同一个 batch** 里更新，
	 * 所以不会出现"HTML 是新的、字数还是旧的"这种半更新状态。
	 */
	bodyHtml: string;
	headings: PostHeading[];
	words: number;
	minutes: number;
}

/**
 * 把数据库行映射成领域对象。
 *
 * 单独抽成一个函数，是为了让"行 → 对象"这件事只有一处实现：列表查询、
 * 单篇查询、将来的后台查询都走它。写第二遍的表现是某个页面的日期或标签
 * 悄悄不一样，而且只在那个页面复现。
 */
export interface PostRow {
	slug: string;
	title: string;
	description: string;
	pub_date_raw: string;
	pub_date_utc: number;
	updated_date_raw: string | null;
	updated_date_utc: number | null;
	hero_image: string | null;
	draft: number;
	body: string;
	body_html: string | null;
	headings_json: string | null;
	words: number | null;
	minutes: number | null;
	categories_json: string;
}

/**
 * 列表查询用的列清单：排除 body / body_html 这种大字段，列表页用不到它们。
 *
 * 空串和 NULL 是**别名占位**，让列表行和全文行有同一个 PostRow 形状，
 * 于是 mapPostRow 只有一份。取一篇 800 字的文章的 HTML 只为了渲染一张卡片，
 * 是纯粹的浪费——而这是每页都要付的。
 *
 * tags 不在这里取，见 `src/data/posts.repo.ts` 的 attachTags()。
 */
export const POST_LIST_COLUMNS = `
	p.slug, p.title, p.description,
	p.pub_date_raw, p.pub_date_utc, p.updated_date_raw, p.updated_date_utc,
	p.hero_image, p.draft, p.categories_json,
	'' AS body, NULL AS body_html, NULL AS headings_json, NULL AS words, NULL AS minutes
`;

/** 全文查询用的列清单。单篇文章页要 body 和缓存列。 */
export const POST_FULL_COLUMNS = `
	p.slug, p.title, p.description,
	p.pub_date_raw, p.pub_date_utc, p.updated_date_raw, p.updated_date_utc,
	p.hero_image, p.draft, p.body, p.body_html, p.headings_json, p.words, p.minutes,
	p.categories_json
`;

/**
 * 行 → 领域对象。
 *
 * 两个刻意的选择：
 *
 * 1. `pubDate` 用 `new Date(row.pub_date_raw)` 而不是 `new Date(row.pub_date_utc)`。
 *    后者是给 ORDER BY 用的整数。用 raw 原文解析，和改造前 Astro 解析 frontmatter
 *    的方式一致，年月日在上海时区下也就和以前逐字相同。
 *
 * 2. 缓存列为 NULL 时**不抛错**，退化成空串和 0。库里允许它们为 NULL（表示尚未
 *    渲染），如果这里抛，一篇还没渲染的文章会让整个列表页 500，而不是只让那一篇
 *    看起来是空的。真正需要报警的地方是导入脚本，它在写入前就知道渲染失败了。
 */
export function mapPostRow(row: PostRow): Post {
	let headings: PostHeading[] = [];
	if (row.headings_json) {
		try {
			headings = JSON.parse(row.headings_json) as PostHeading[];
		} catch {
			// 解析不了就当作没有目录。目录是增强，不是正文，不值得让整页挂掉。
			headings = [];
		}
	}

	let categories: string[] = [];
	if (row.categories_json) {
		try {
			categories = JSON.parse(row.categories_json) as string[];
		} catch {
			categories = [];
		}
	}

	return {
		id: row.slug,
		body: row.body,
		bodyHtml: row.body_html ?? '',
		headings,
		words: row.words ?? 0,
		minutes: row.minutes ?? 1,
		data: {
			title: row.title,
			description: row.description,
			pubDate: new Date(row.pub_date_raw),
			updatedDate: row.updated_date_raw ? new Date(row.updated_date_raw) : undefined,
			heroImage: row.hero_image ?? undefined,
			draft: row.draft === 1,
			// 由仓储层的 attachTags() 填。默认空数组而不是 undefined，
			// 这样 `post.data.tags ?? []` 这种防御写在组件里就没必要了。
			tags: [],
			categories,
		},
	};
}

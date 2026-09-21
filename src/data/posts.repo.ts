/**
 * 文章的数据访问层：SQL → 领域对象的**唯一出口**。
 *
 * 页面与组件不直接写 SQL。这条规矩在这里不是洁癖，而是因为下面
 * `publishedWhere()` 那个过滤条件——它是这次改造里唯一一处"漏了不会报错、
 * 只会静默泄露草稿"的地方。把它收进一个函数、让所有查询都从它出发，
 * 是让"忘了过滤"这件事在结构上难以发生的唯一办法。
 *
 * 所有函数都**接收** db 而不是自己去取（`src/lib/db.ts` 的 getDb()），
 * 于是这一层可以在 workerd 之外被测试。
 */

import {
	POST_FULL_COLUMNS,
	POST_LIST_COLUMNS,
	mapPostRow,
	type Post,
	type PostRow,
} from '../domain/post';

/**
 * 公开文章的过滤条件。
 *
 * **列表查询和单篇查询必须共用它，绝不写两遍。**
 *
 * 为什么把这件事单独拧出来当一个错误来讲：改造前是纯静态 SSG，详情页的
 * `getStaticPaths` 继承了列表的过滤，草稿根本不会被生成出来。改成 SSR 之后
 * 这个保护**没有了**——只过滤列表的话，草稿依然可以被任何人按 URL 直达，
 * 而它在任何一个列表里都不出现，所以你不会发现。这正是
 * `src/pages/posts/[...slug].astro` 的注释警告过的那个 bug。
 *
 * 返回的是可拼接的 SQL 片段，所有以它过滤的查询都要用 `p` 作 posts 的别名。
 */
export function publishedWhere(): string {
	return 'p.draft = 0';
}

/**
 * 全序：`pub_date_utc DESC, slug DESC`。
 *
 * 兜底键 `slug` 不是可有可无的。现有两篇文章的 pubDate 完全相同
 * （都是 2026-09-20），没有全序时 `LIMIT/OFFSET` 的行为是未定义的——
 * 表现为同一篇文章在第 1 页和第 2 页都出现、或者从两页里都消失。
 * SSG 时这只是侧栏顺序偶尔变，分页之后就是实打实的内容丢失。
 */
const ORDER_BY = 'ORDER BY p.pub_date_utc DESC, p.slug DESC';

/** 一次查询最多取多少行。防止将来某个调用点忘了传 limit 而把全表拉进内存。 */
export const MAX_LIMIT = 500;

function clampLimit(limit: number | undefined): number {
	if (limit === undefined) return MAX_LIMIT;
	return Math.max(1, Math.min(MAX_LIMIT, Math.trunc(limit)));
}

function clampOffset(offset: number | undefined): number {
	if (offset === undefined || !Number.isFinite(offset)) return 0;
	return Math.max(0, Math.trunc(offset));
}

/**
 * 批量补上标签。
 *
 * 为什么不写成 `json_group_array` 的关联子查询（那是更"聪明"的一行 SQL）：
 * SQLite 会把子查询扁平化，内层 `ORDER BY pt.position` 不保证被保留，
 * 于是标签顺序变成不确定的。而 `TagChips.astro` 是按数组顺序渲染的——
 * 顺序错了不报错，只是标签次序会莫名其妙地变。
 *
 * 这里显式 `ORDER BY pt.post_slug, pt.position`，再在 JS 里分组，
 * 顺序由 SQL 保证，不依赖任何优化器的行为。一次查询覆盖整页，
 * 不是每篇文章一次（那才是 N+1）。
 */
async function attachTags(db: D1Database, posts: Post[]): Promise<Post[]> {
	if (posts.length === 0) return posts;

	const placeholders = posts.map(() => '?').join(', ');
	const { results } = await db
		.prepare(
			`SELECT pt.post_slug AS slug, t.name AS name
			 FROM post_tags pt
			 JOIN tags t ON t.id = pt.tag_id
			 WHERE pt.post_slug IN (${placeholders})
			 ORDER BY pt.post_slug, pt.position`,
		)
		.bind(...posts.map((p) => p.id))
		.all<{ slug: string; name: string }>();

	const bySlug = new Map<string, string[]>();
	for (const row of results ?? []) {
		const bucket = bySlug.get(row.slug);
		if (bucket) bucket.push(row.name);
		else bySlug.set(row.slug, [row.name]);
	}

	for (const post of posts) {
		post.data.tags = bySlug.get(post.id) ?? [];
	}
	return posts;
}

/** 文章的列表行（不含 body / body_html），按全序倒序。 */
export async function listPublishedPosts(
	db: D1Database,
	opts: { limit?: number; offset?: number } = {},
): Promise<Post[]> {
	const { results } = await db
		.prepare(
			`SELECT ${POST_LIST_COLUMNS}
			 FROM posts p
			 WHERE ${publishedWhere()}
			 ${ORDER_BY}
			 LIMIT ? OFFSET ?`,
		)
		.bind(clampLimit(opts.limit), clampOffset(opts.offset))
		.all<PostRow>();

	return attachTags(db, (results ?? []).map(mapPostRow));
}

/**
 * 带正文的公开文章列表。
 *
 * 和 `listPublishedPosts` 的唯一区别是走 `POST_FULL_COLUMNS`（含
 * `body_html`）。**只有 RSS 需要它**：`<content:encoded>` 要的是整篇正文，
 * 而列表查询里 `body_html` 是 `NULL AS body_html` 的占位。
 *
 * 为什么把这条写成一段警告：用错了**不会报错**。列表列清单里的 `body_html`
 * 是 NULL，`mapPostRow` 又刻意把 NULL 退化成空串（见 domain/post.ts 的说明），
 * 于是 RSS 会老老实实产出一篇篇 `<content:encoded/>` 空的条目——
 * 文件本身合法、订阅器里却是空的。这个 bug 已经真实发生过一次。
 */
export async function listPublishedPostsWithContent(
	db: D1Database,
	opts: { limit?: number } = {},
): Promise<Post[]> {
	const { results } = await db
		.prepare(
			`SELECT ${POST_FULL_COLUMNS}
			 FROM posts p
			 WHERE ${publishedWhere()}
			 ${ORDER_BY}
			 LIMIT ?`,
		)
		.bind(clampLimit(opts.limit))
		.all<PostRow>();

	return attachTags(db, (results ?? []).map(mapPostRow));
}

/** 公开文章总数。分页要用，和 listPublishedPosts 共用同一个过滤条件。 */
export async function countPublishedPosts(db: D1Database): Promise<number> {
	const row = await db
		.prepare(`SELECT COUNT(*) AS n FROM posts p WHERE ${publishedWhere()}`)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

/**
 * 单篇文章，带 body 与缓存列。
 *
 * **带 `publishedWhere()`**：草稿在这里查不到。这是上面那段注释说的那件事的
 * 另一半——列表过滤了、单篇没过滤，是这次改造最容易漏掉的一处。
 * 后台要用草稿请走 `getPostBySlugForAdmin`。
 */
export async function getPublishedPostBySlug(
	db: D1Database,
	slug: string,
): Promise<Post | null> {
	const row = await db
		.prepare(
			`SELECT ${POST_FULL_COLUMNS}
			 FROM posts p
			 WHERE ${publishedWhere()} AND p.slug = ?
			 LIMIT 1`,
		)
		.bind(slug)
		.first<PostRow>();

	if (!row) return null;
	return (await attachTags(db, [mapPostRow(row)]))[0] ?? null;
}

/** 后台用：不滤草稿。P5 的编辑器要靠它把文章读回来。 */
export async function getPostBySlugForAdmin(
	db: D1Database,
	slug: string,
): Promise<Post | null> {
	const row = await db
		.prepare(`SELECT ${POST_FULL_COLUMNS} FROM posts p WHERE p.slug = ? LIMIT 1`)
		.bind(slug)
		.first<PostRow>();

	if (!row) return null;
	return (await attachTags(db, [mapPostRow(row)]))[0] ?? null;
}

/**
 * 后台列表：**故意不过滤草稿**。
 *
 * 函数名里的 `ForAdmin` 就是"豁免 `publishedWhere()`"的标记，与既有的
 * `getPostBySlugForAdmin` 同一套命名。后台读不到草稿的话，草稿就等于
 * 写进了黑洞——存下来了、但再也找不回来。
 *
 * 排序与读者侧的 `ORDER_BY` **不同**：这里按 `updated_at` 倒序，
 * 也就是"最近动过的在最上面"。理由是这个列表只给一个人看——
 * 找的是"我刚才改的那篇"，不是"最新发布的"。它不参与任何对外分页，
 * 所以不存在 ORDER_BY 那条注释里说的全序问题。
 */
export async function listPostsForAdmin(
	db: D1Database,
	opts: { limit?: number; offset?: number } = {},
): Promise<Post[]> {
	const { results } = await db
		.prepare(
			`SELECT ${POST_LIST_COLUMNS}
			 FROM posts p
			 ORDER BY p.updated_at DESC, p.slug DESC
			 LIMIT ? OFFSET ?`,
		)
		.bind(clampLimit(opts.limit), clampOffset(opts.offset))
		.all<PostRow>();

	return attachTags(db, (results ?? []).map(mapPostRow));
}

/** 后台列表的总数（含草稿）。分页用。 */
export async function countPostsForAdmin(db: D1Database): Promise<number> {
	const row = await db.prepare('SELECT COUNT(*) AS n FROM posts').first<{ n: number }>();
	return row?.n ?? 0;
}

/**
 * 全站标签名（含只被草稿用到的）。后台的标签输入框用它做候选提示。
 *
 * 与 `listTagCounts` 的区别有两点：不过滤草稿、不带计数。
 * 后台要的是"我写过哪些标签"，而不是"读者能看到哪些"。
 */
export async function listTagNames(db: D1Database): Promise<string[]> {
	const { results } = await db
		.prepare('SELECT name FROM tags ORDER BY name')
		.all<{ name: string }>();
	return (results ?? []).map((row) => row.name);
}

/**
 * 某个标签下的公开文章。`segment` 是 URL 里的形式（见 `tagParam`），
 * 不是显示名——`tags` 表两个都存了。
 */
export async function listPublishedPostsByTag(
	db: D1Database,
	segment: string,
	opts: { limit?: number; offset?: number } = {},
): Promise<Post[]> {
	const { results } = await db
		.prepare(
			`SELECT ${POST_LIST_COLUMNS}
			 FROM posts p
			 JOIN post_tags pt ON pt.post_slug = p.slug
			 JOIN tags t ON t.id = pt.tag_id
			 WHERE ${publishedWhere()} AND t.segment = ?
			 ${ORDER_BY}
			 LIMIT ? OFFSET ?`,
		)
		.bind(segment, clampLimit(opts.limit), clampOffset(opts.offset))
		.all<PostRow>();

	return attachTags(db, (results ?? []).map(mapPostRow));
}

/** 某个标签下公开文章的篇数。 */
export async function countPublishedPostsByTag(
	db: D1Database,
	segment: string,
): Promise<number> {
	const row = await db
		.prepare(
			`SELECT COUNT(*) AS n
			 FROM posts p
			 JOIN post_tags pt ON pt.post_slug = p.slug
			 JOIN tags t ON t.id = pt.tag_id
			 WHERE ${publishedWhere()} AND t.segment = ?`,
		)
		.bind(segment)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

/**
 * URL 片段 → 标签的显示名。找不到返回 null（调用方应 404）。
 *
 * 为什么不能拿 URL 里的片段直接当标签名用：片段是规范形式
 * （`hello-world`），而显示名是 frontmatter 里的原文（`Hello World`）。
 * 拿片段去比对文章标签会一篇都筛不出来，页面看着正常、只是空的。
 * 改造前这个映射由 `getStaticPaths` 在构建期传 props 完成，SSR 下得查库。
 */
export async function getTagBySegment(
	db: D1Database,
	segment: string,
): Promise<{ tag: string; segment: string } | null> {
	const row = await db
		.prepare('SELECT name AS tag, segment FROM tags WHERE segment = ? LIMIT 1')
		.bind(segment)
		.first<{ tag: string; segment: string }>();
	return row ?? null;
}

/**
 * 全站标签 + 计数，**只算公开文章**。
 *
 * 顺序与改造前的 `collectTags` 一致：先按数量倒序，同数量按显示名排。
 * `zh-CN` 的 localeCompare 在 workerd 里如果不可用会退化成二进制序——
 * 只影响同数量标签的相对次序，URL 和计数都不变。
 */
export async function listTagCounts(db: D1Database): Promise<
	{ tag: string; segment: string; count: number }[]
> {
	const { results } = await db
		.prepare(
			`SELECT t.name AS tag, t.segment AS segment, COUNT(*) AS count
			 FROM tags t
			 JOIN post_tags pt ON pt.tag_id = t.id
			 JOIN posts p ON p.slug = pt.post_slug
			 WHERE ${publishedWhere()}
			 GROUP BY t.id
			 ORDER BY count DESC, t.name`,
		)
		.all<{ tag: string; segment: string; count: number }>();

	return results ?? [];
}

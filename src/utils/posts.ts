import { listPublishedPosts } from '../data/posts.repo';
import { getDb } from '../lib/db';
import { tagSegment } from './tag-segment';
import type { Post } from '../domain/post';

export type { Post, PostData, PostHeading } from '../domain/post';

/**
 * 按发布时间倒序返回可公开的文章。
 *
 * 全站**只有这一个函数**碰数据源。它以前调 `getCollection`（Astro 内容集合），
 * 现在调仓储层读 D1。签名一个字没变，所以 7 个调用点、18 个组件都不用改——
 * 这次改造的爆炸半径就是这么被限制在一个文件里的。
 *
 * 两处行为变化，都是刻意的：
 *
 * 1. **草稿在本地 dev 也不再出现了。** 以前是 `import.meta.env.PROD ? !draft : true`，
 *    本地能看到未完成的文章。`import.meta.env.PROD` 是构建期常量，在 SSR 下
 *    它反映的是构建时而非请求时，继续用会得到"本地 dev 看得见草稿、线上也看得见"
 *    或者反过来的错乱。草稿预览改由 `/admin` 提供（P5）。
 *
 * 2. **同一天的两篇文章顺序反了。** 以前只按 pubDate 排序、没有兜底键，
 *    顺序取决于加载器的迭代顺序；现在和数据库索引一致，是
 *    `pub_date_utc DESC, slug DESC`。现有两篇都是 2026-09-20，所以
 *    `hello-world` 排到了 `building-this-blog` 前面。
 *    这个兜底键不是风格问题：分页用 LIMIT/OFFSET 时，没有全序会让同一篇
 *    在第 1 页和第 2 页都出现、或者从两页里都消失。
 *
 * 排序现在由 SQL 保证，所以这里不再 return 一个 sort 后的副本。
 *
 * ⚠️ **`body` 和 `bodyHtml` 是空的。** 这个函数走的是列表列清单
 * （`POST_LIST_COLUMNS`），只有标题、日期、标签这些卡片要用的字段——
 * 全站每页都要跑侧栏，把它换成全列等于每页都拖一遍所有正文。
 *
 * 所以：**要正文的地方不能用它**。RSS 走
 * `listPublishedPostsWithContent`，后台编辑器走 `getPostBySlugForAdmin`，
 * 详情页走 `getPublishedPostBySlug`。
 *
 * 这个警告不是多余的——已经踩过一次：RSS 曾经用它取数，于是每篇都输出
 * `<content:encoded/>`，文件合法、订阅器里却是空的，而且不报错。
 */
export async function getPublishedPosts(): Promise<Post[]> {
	return listPublishedPosts(getDb());
}

/** 文章详情页路径。改路由时只需要改这一处。 */
export function postUrl(post: Post): string {
	return `/posts/${post.id}/`;
}

/**
 * 年份必须按 Asia/Shanghai 取，**不能**用 getFullYear()。
 *
 * pubDate 是构建机上解析出来的 Date，getFullYear() 读的是构建机的时区；
 * 构建机在负时区时，1 月 1 日的文章会在侧栏落到上一年，而正文里
 * FormattedDate 显示的是下一年——两处对不上，且只在特定时区的构建机上复现。
 */
const YEAR_FORMAT = new Intl.DateTimeFormat('en-CA', {
	timeZone: 'Asia/Shanghai',
	year: 'numeric',
});

export function postYear(post: Post): number {
	return Number(YEAR_FORMAT.format(post.data.pubDate));
}

/** 月份同理，必须和年份用同一个时区，否则跨月边界会互相打架 */
const MONTH_FORMAT = new Intl.DateTimeFormat('en-CA', {
	timeZone: 'Asia/Shanghai',
	month: 'numeric',
});

export function postMonth(post: Post): number {
	return Number(MONTH_FORMAT.format(post.data.pubDate));
}

/**
 * 日同理。归档页要显示「几号」，而 getUTCDate() 和 getDate() 都不是这个时区：
 * 一篇 2026-01-01 00:30（上海）的文章，UTC 下是 2025-12-31 16:30，
 * 用 getUTCDate() 会在「2026 年 1 月」下面显示 31 号——分组用上海时区、
 * 日期用 UTC，两处对不上，且只在特定时刻的文章上复现。
 */
const DAY_FORMAT = new Intl.DateTimeFormat('en-CA', {
	timeZone: 'Asia/Shanghai',
	day: 'numeric',
});

export function postDay(post: Post): number {
	return Number(DAY_FORMAT.format(post.data.pubDate));
}

export interface YearGroup {
	year: number;
	posts: Post[];
}

export interface Neighbours {
	/** 更早的一篇 */
	older?: Post;
	/** 更新的一篇 */
	newer?: Post;
}

/**
 * 相邻文章。入参必须是 getPublishedPosts() 的返回值（时间倒序），
 * 因为「更早/更新」完全由这个顺序决定，再排一次序反而容易搞反方向。
 *
 * 草稿已在 getPublishedPosts 里滤掉，所以这里不会出现「下一篇是草稿」。
 */
export function postNeighbours(posts: Post[], id: string): Neighbours {
	const index = posts.findIndex((post) => post.id === id);
	if (index === -1) return {};
	return { newer: posts[index - 1], older: posts[index + 1] };
}

/**
 * 按年分组。入参需已按时间倒序（getPublishedPosts 的返回值即是），
 * 这样组内顺序和组间顺序都天然正确，不必再排一次。
 */
export function groupByYear(posts: Post[]): YearGroup[] {
	const buckets = new Map<number, Post[]>();
	for (const post of posts) {
		const year = postYear(post);
		const bucket = buckets.get(year);
		if (bucket) bucket.push(post);
		else buckets.set(year, [post]);
	}
	return [...buckets]
		.sort((a, b) => b[0] - a[0])
		.map(([year, grouped]) => ({ year, posts: grouped }));
}

export interface MonthGroup {
	month: number;
	posts: Post[];
}

export interface YearMonthGroup {
	year: number;
	/** 计数用，省得在模板里 monthGroups.reduce() */
	count: number;
	months: MonthGroup[];
}

/**
 * 归档页用的「年 → 月」两级分组。
 *
 * 复用 postYear/postMonth（都按 Asia/Shanghai），所以和侧栏文章树、
 * 正文里的 FormattedDate 三处显示的日期必然一致。
 *
 * 不用 `groupByYear` 再嵌一层：年份分桶要重新遍历，多一次 Map 构建，
 * 而且两级分组有「月份归属哪一年」的边界问题，一次遍历同时判年+月最稳。
 */
export function groupByYearMonth(posts: Post[]): YearMonthGroup[] {
	const years = new Map<number, Map<number, Post[]>>();

	for (const post of posts) {
		const year = postYear(post);
		const month = postMonth(post);

		let months = years.get(year);
		if (!months) {
			months = new Map<number, Post[]>();
			years.set(year, months);
		}

		const bucket = months.get(month);
		if (bucket) bucket.push(post);
		else months.set(month, [post]);
	}

	return [...years]
		.sort((a, b) => b[0] - a[0])
		.map(([year, months]) => {
			// 入参已按时间倒序，所以年月都天然从大到小，不必再排
			const monthGroups = [...months].map(([month, grouped]) => ({
				month,
				posts: grouped,
			}));
			return {
				year,
				count: monthGroups.reduce((sum, group) => sum + group.posts.length, 0),
				months: monthGroups,
			};
		});
}

export interface TagCount {
	tag: string;
	/** href 用（已编码） */
	slug: string;
	/** getStaticPaths 的 params 用（已解码），见 tagParam */
	param: string;
	count: number;
}

/**
 * 全站标签 + 计数，按数量倒序，同数量按标签名排序保证构建可复现
 * （Map 的迭代顺序取决于文章顺序，不稳定会表现为每次构建标签顺序都在跳）。
 */
export function collectTags(posts: Post[]): TagCount[] {
	const counts = new Map<string, number>();

	for (const post of posts) {
		for (const tag of post.data.tags ?? []) {
			const trimmed = tag.trim();
			if (!trimmed) continue;
			counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1);
		}
	}

	return [...counts]
		.map(([tag, count]) => ({
			tag,
			slug: tagSlug(tag),
			param: tagParam(tag),
			count,
		}))
		.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'zh-CN'));
}

/**
 * href 用：编码后的 URL 片段。中文标签变成 %E5%89%8D%E7%AB%AF 这样的转义序列。
 *
 * **不要**自己写拼音或哈希——那会让 TagChips 生成的链接和 [tag].astro 的
 * getStaticPaths 算出两个不同结果，表现为标签页 404 而列表页看着正常。
 */
export function tagSlug(tag: string): string {
	return encodeURIComponent(tagSegment(tag));
}

/**
 * getStaticPaths 的 params 用：**解码后**的片段。
 *
 * Astro 拿到 params 后会先解码再做路由匹配，所以这里必须传 `随笔`
 * 而不是 `%E9%9A%8F%E7%AC%94`。传编码过的值不会静默错配，而是直接构建失败：
 *   NoMatchingStaticPathFound: ... no matching static path for `/tags/随笔/`
 * 注意它和 tagSlug 不是「编码/不编码」的简单关系：`Hello World` 的
 * href 是 /tags/hello-world/，而 param 也必须是 hello-world（不是
 * `Hello World`）——两边都基于同一个 tagSegment，链接才不会指向别处。
 */
export function tagParam(tag: string): string {
	return tagSegment(tag);
}

export function tagUrl(tag: string): string {
	return `/tags/${tagSlug(tag)}/`;
}

/**
 * `readingStats` 已挪到 ./reading，因为那个模块要同时被非 Astro 环境使用
 * （scripts/content-to-sql.mjs 在导入文章时要把字数写进 D1 的 words/minutes 缓存列），
 * 而本文件要 import astro:content，在浏览器和 Node 脚本里都加载不了。
 *
 * 在这里 re-export 是为了保住现有调用点的 import 路径：
 * src/components/ReadingTime.astro 与 test/posts.test.ts 都不用改。
 */
export { readingStats, type ReadingStats } from './reading';

import { getCollection, type CollectionEntry } from 'astro:content';

export type Post = CollectionEntry<'blog'>;

/**
 * 按发布时间倒序返回可公开的文章。
 *
 * 所有需要文章列表的地方都应该走这里，不要在页面里直接调 getCollection——
 * 否则很容易漏掉 draft 过滤（草稿会同时出现在首页、列表页、详情页和 RSS 里）。
 *
 * 生产构建剔除 draft: true；本地 dev 保留，方便预览未完成的文章。
 */
export async function getPublishedPosts(): Promise<Post[]> {
	const posts = await getCollection('blog', ({ data }) =>
		import.meta.env.PROD ? !data.draft : true,
	);
	return posts.sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf());
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

export interface ReadingStats {
	/** 汉字 + 西文单词总数 */
	words: number;
	/** 预计阅读分钟数，最少 1 */
	minutes: number;
}

/**
 * 标签 → URL 片段的**规范形式**（未编码）：小写 + 空格转连字符。
 * 不要在这里编码，编码与否是两个不同的消费方各自的事，见下面两个函数。
 */
function tagSegment(tag: string): string {
	return tag.trim().toLowerCase().replace(/\s+/g, '-');
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

const CJK = /[㐀-䶿一-鿿豈-﫿]/g;

/**
 * 字数与阅读时长。
 *
 * 中文按「字」计、西文按「词」计，两者数量级接近，直接相加即可。
 * 代码块整段剔除：读代码的时间不该算进「读这篇文章要多久」。
 */
export function readingStats(body: string | undefined): ReadingStats {
	if (!body) return { words: 0, minutes: 1 };

	const text = body
		.replace(/```[\s\S]*?```/g, '') // 围栏代码块
		.replace(/~~~[\s\S]*?~~~/g, '')
		.replace(/`[^`\n]*`/g, '') // 行内码
		.replace(/!?\[[^\]]*\]\([^)]*\)/g, '') // 链接与图片
		.replace(/^\s{0,3}#{1,6}\s+/gm, '') // 标题标记
		.replace(/[#>*_~|]/g, ' ');

	const cjk = (text.match(CJK) ?? []).length;
	const latin = (text.replace(CJK, ' ').match(/[A-Za-z0-9]+/g) ?? []).length;
	const words = cjk + latin;

	// 中文阅读速度约 400 字/分钟
	return { words, minutes: Math.max(1, Math.round(words / 400)) };
}

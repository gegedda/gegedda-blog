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
	return `/blog/${post.id}/`;
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

export interface ReadingStats {
	/** 汉字 + 西文单词总数 */
	words: number;
	/** 预计阅读分钟数，最少 1 */
	minutes: number;
}

/**
 * 标签 → URL 片段。
 *
 * 只做「小写 + 空格转连字符」，其余交给 encodeURIComponent：
 * 中文标签会变成 %E5%89%8D%E7%AB%AF 这样的转义序列，Astro 取 params 时
 * 会自动解码回来。**不要**自己写拼音或哈希——那会让同一个标签在两个
 * 地方（TagChips 生成的链接、[tag].astro 的 getStaticPaths）算出不同结果，
 * 表现为标签页 404 而列表页看着正常。
 */
export function tagSlug(tag: string): string {
	return encodeURIComponent(tag.trim().toLowerCase().replace(/\s+/g, '-'));
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

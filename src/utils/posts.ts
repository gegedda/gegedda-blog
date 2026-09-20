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

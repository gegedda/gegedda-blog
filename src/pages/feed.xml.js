import rss from '@astrojs/rss';
import { FEED_LIMIT, SITE_DESCRIPTION, SITE_LANG, SITE_TITLE } from '../consts';
import { listPublishedPostsWithContent } from '../data/posts.repo';
import { getDb } from '../lib/db';
import { postUrl } from '../utils/posts';

/**
 * RSS。
 *
 * 改造前这里对每篇文章跑一次 `render(post)`，再用 `experimental_AstroContainer`
 * 把组件渲染成 HTML 字符串，塞进 `<content:encoded>`。SSR 之后那两步都去掉了：
 * `bodyHtml` 就是现成的 HTML，import 时的渲染管线（shared/markdown.ts）已经
 * 产出过它。
 *
 * 去掉的不只是两行代码：`render()` 每次请求重渲染全部文章，而免费版 Worker
 * 每个请求只有 10ms CPU；AstroContainer 还要把整棵组件树再跑一遍。
 * 订阅器通常每分钟来取一次，这个开销是持续付的。
 *
 * ⚠️ **取数必须走 `listPublishedPostsWithContent`，不能用 `getPublishedPosts()`。**
 * 后者走的是列表列清单，`body_html` 是 `NULL` 占位，`mapPostRow` 又把它退化成
 * 空串——结果是每一篇都输出 `<content:encoded/>`，文件看着完全合法、
 * 订阅器里却是空的，且不报错。这个 bug 已经真实发生过一次。
 */
export async function GET(context) {
	// 只取最近 FEED_LIMIT 篇：每篇都带整篇正文，不设上限的话
	// 响应体积和组装它的 CPU 开销都会随文章数线性增长。理由见 consts.ts。
	const posts = await listPublishedPostsWithContent(getDb(), { limit: FEED_LIMIT });

	// 逐项显式映射，不用 `...post.data` 展开：
	// 展开会把字段名硬编码进 RSS（schema 里 pubDate 一改名，RSS 就静默丢日期）。
	const items = posts.map((post) => ({
		title: post.data.title,
		description: post.data.description,
		pubDate: post.data.pubDate,
		link: postUrl(post),
		// 已经是 HTML 字符串，@astrojs/rss 会输出为 <content:encoded>
		content: post.bodyHtml,
	}));

	return rss({
		title: SITE_TITLE,
		description: SITE_DESCRIPTION,
		site: context.site,
		items,
		customData: `<language>${SITE_LANG}</language>`,
	});
}

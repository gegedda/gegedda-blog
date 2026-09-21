/**
 * sitemap 的 urlset。
 *
 * 为什么不用 `@astrojs/sitemap` 集成：它在 SSR 下会**静默产出一份不含任何
 * 文章的 sitemap**。那个集成是靠注入路由的 `pathname` 来枚举页面的，而
 * `pathname` 只在「全部路由段都是静态」时才被填充
 * （node_modules/astro/dist/core/routing/create-manifest.js 里那段判断），
 * 于是 `/posts/*`、`/tags/*`、`/2/` 全部贡献 0 条，而且**不报错**——
 * 构建日志里一切正常，线上 sitemap 里只有首页。
 * astro.config.mjs 里原来那个 filter 也一并变成了死代码。
 *
 * 所以这里自己查库枚举。文件名是 `sitemap-0.xml` 而不是 `sitemap.xml`：
 * 保持和原集成一样的产物形状，public/robots.txt 里指向
 * `/sitemap-index.xml` 的那一行就不用改。
 *
 * 分页页 `/2/`、`/3/`… **不进 sitemap**（与原集成的 filter 一致）：
 * 它们的内容是首页内容的一部分，和 `/` 一起被索引是重复内容，
 * 只会分散首页的权重。它们仍可被抓取（有正常链接、没有 noindex），
 * 只是不主动提交。
 */

import { PAGE_SIZE } from '../consts';
import {
	MAX_LIMIT,
	countPublishedPosts,
	listPublishedPosts,
	listTagCounts,
} from '../data/posts.repo';
import { getDb } from '../lib/db';

/** XML 文本节点转义。标签名是中文，`tagSlug` 之后已百分号编码，但 `&` 仍可能出现。 */
function esc(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

export async function GET(context: { site: URL | undefined }) {
	const site = context.site;
	if (!site) {
		// site 没配时 canonical / RSS / sitemap 全都会产出相对地址，
		// 那种 sitemap 是无效的（协议要求绝对 URL）。这里直接报错而不是
		// 产出一份看起来正常但被搜索引擎拒收的文件。
		throw new Error('astro.config.mjs 里必须配置 site，sitemap 需要绝对 URL');
	}

	const db = getDb();
	const absolute = (path: string) => new URL(path, site).href;

	const entries: { loc: string; lastmod?: string }[] = [
		{ loc: absolute('/') },
		{ loc: absolute('/archives/') },
		{ loc: absolute('/tags/') },
		{ loc: absolute('/about/') },
	];

	// 文章。MAX_LIMIT 是本项目仓储层的取数上限；文章数超过它时
	// 这份 sitemap 会截断，而不是无声地少几篇——见下面那行 console.warn。
	const total = await countPublishedPosts(db);
	if (total > MAX_LIMIT) {
		console.warn(
			`[sitemap] 公开文章 ${total} 篇，超过单次取数上限 ${MAX_LIMIT}，` +
				`sitemap 将只包含最近 ${MAX_LIMIT} 篇。需要分页取数。`,
		);
	}

	const posts = await listPublishedPosts(db, { limit: MAX_LIMIT });
	for (const post of posts) {
		// lastmod 用「最后更新，否则发布」。格式必须是 W3C 的完整时间戳。
		const stamp = post.data.updatedDate ?? post.data.pubDate;
		entries.push({
			loc: absolute(`/posts/${post.id}/`),
			lastmod: stamp.toISOString(),
		});
	}

	// 标签页。只包含有公开文章的标签（listTagCounts 已经带了草稿过滤）。
	for (const { segment } of await listTagCounts(db)) {
		entries.push({ loc: absolute(`/tags/${encodeURIComponent(segment)}/`) });
	}

	const body = entries
		.map(
			(e) =>
				`  <url>\n    <loc>${esc(e.loc)}</loc>` +
				(e.lastmod ? `\n    <lastmod>${e.lastmod}</lastmod>` : '') +
				`\n  </url>`,
		)
		.join('\n');

	return new Response(
		`<?xml version="1.0" encoding="UTF-8"?>\n` +
			`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
			`${body}\n</urlset>\n`,
		{
			headers: {
				'Content-Type': 'application/xml; charset=utf-8',
				// 内容只随发布变化；一小时对个人博客足够，也让爬虫别每来必打库。
				'Cache-Control': 'public, max-age=3600',
			},
		},
	);
}

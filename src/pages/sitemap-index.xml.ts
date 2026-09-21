/**
 * sitemap 索引。
 *
 * 单独一个文件、而且分成索引 + urlset 两份，是为了**保持和原
 * `@astrojs/sitemap` 集成完全一样的产物形状**：那个集成产出的就是
 * `sitemap-index.xml` + `sitemap-0.xml`。public/robots.txt 里指向
 * `/sitemap-index.xml` 的那一行因此一个字都不用改。
 *
 * 只有一份 urlset 的时候，其实也可以把 urlset 直接放在这个地址上
 * （协议允许任何文件名承载 urlset）。仍然分两份，是因为文章多起来之后
 * 单份 urlset 会超过 50MB / 50000 条的协议上限，那时候加的是
 * `sitemap-1.xml`、`sitemap-2.xml`——索引这一层现在就在，到时不改结构。
 */

export async function GET(context: { site: URL | undefined }) {
	const site = context.site;
	if (!site) {
		throw new Error('astro.config.mjs 里必须配置 site，sitemap 需要绝对 URL');
	}

	const lastmod = new Date().toISOString();

	return new Response(
		`<?xml version="1.0" encoding="UTF-8"?>\n` +
			`<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
			`  <sitemap>\n` +
			`    <loc>${new URL('/sitemap-0.xml', site).href}</loc>\n` +
			`    <lastmod>${lastmod}</lastmod>\n` +
			`  </sitemap>\n` +
			`</sitemapindex>\n`,
		{
			headers: {
				'Content-Type': 'application/xml; charset=utf-8',
				'Cache-Control': 'public, max-age=3600',
			},
		},
	);
}

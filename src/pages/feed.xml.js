import { render } from 'astro:content';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import rss from '@astrojs/rss';
import { SITE_DESCRIPTION, SITE_LANG, SITE_TITLE } from '../consts';
import { getPublishedPosts, postUrl } from '../utils/posts';

export async function GET(context) {
	const posts = await getPublishedPosts();
	const container = await AstroContainer.create();

	// 逐项显式映射，不用 `...post.data` 展开：
	// 展开会把字段名硬编码进 RSS（schema 里 pubDate 一改名，RSS 就静默丢日期）。
	const items = await Promise.all(
		posts.map(async (post) => {
			const { Content } = await render(post);
			return {
				title: post.data.title,
				description: post.data.description,
				pubDate: post.data.pubDate,
				link: postUrl(post),
				// 渲染成 HTML 字符串 -> @astrojs/rss 会输出为 <content:encoded>
				content: await container.renderToString(Content),
			};
		}),
	);

	return rss({
		title: SITE_TITLE,
		description: SITE_DESCRIPTION,
		site: context.site,
		items,
		customData: `<language>${SITE_LANG}</language>`,
	});
}

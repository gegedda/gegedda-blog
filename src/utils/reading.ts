/**
 * 字数与阅读时长。
 *
 * 单独一个文件、**不 import 任何 Astro 的东西**，是因为它有两个调用方：
 *
 *   1. `src/utils/posts.ts` / `ReadingTime.astro` —— 服务端渲染时用
 *   2. `scripts/content-to-sql.mjs` —— 导入文章时要把结果写进 D1 的
 *      `words` / `minutes` 缓存列，运行时就不再重算
 *
 * 原先它住在 `src/utils/posts.ts` 里，而那个文件 `import 'astro:content'`，
 * 于是任何非 Astro 环境（Node 脚本、浏览器）都用不了它。
 *
 * `posts.ts` 仍然把它 re-export 出去，所以 `ReadingTime.astro` 和
 * `test/posts.test.ts` 的 import 路径一个字都不用改。
 */

export interface ReadingStats {
	/** 汉字 + 西文单词总数 */
	words: number;
	/** 预计阅读分钟数，最少 1 */
	minutes: number;
}

const CJK = /[㐀-䶿一-鿿豈-﫿]/g;

/**
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

/**
 * 分页。
 *
 * 改造前这些由 Astro 的 `paginate()` 在 `getStaticPaths` 里算好：它枚举出
 * `/`、`/2/`、`/3/`… 每一页，把 Page 对象当 props 塞进页面。SSR 之后
 * `getStaticPaths` 被**完全忽略**（构建时只打一行 WARN），页码来自 URL，
 * 分页得自己算。这个文件就是那件事。
 *
 * 形状刻意与 Astro 的 `Page<T>` 对齐（见 node_modules/astro/dist/core/render/paginate.js），
 * 因为 `Pagination.astro` 是照那个形状写的，而且它 import 了 Astro 的 `Page` 类型。
 * 对齐之后那个组件的代码一个字都不用改。
 */

export interface PageUrl {
	current: string;
	prev?: string;
	next?: string;
	first: string;
	last?: string;
}

export interface PageLike<T> {
	data: T[];
	/** 本页第一条在全集里的下标（含） */
	start: number;
	/** 本页最后一条在全集里的下标（**含**，与 Array.slice 的 end 不同） */
	end: number;
	size: number;
	/** 全集条数，不是本页条数 */
	total: number;
	currentPage: number;
	lastPage: number;
	url: PageUrl;
}

/**
 * URL 里的页码 → 数字。返回 `null` 表示这个地址不是一个合法页码，调用方应当 404。
 *
 * 为什么必须严格校验：路由是 `[...page].astro`（rest 参数），它会**吞掉所有**
 * 没有被更具体的路由匹配到的路径。`/posts/` 之外的任何地址都落到这里——
 * `/foo/`、`/a/b/`、`/wp-admin/`，`params.page` 会是 `'foo'`、`'a/b'`。
 * 改造前这些路径在构建期就不存在，请求会 404；现在它们都会进到这个页面，
 * 不校验的话每种拼错的历史地址都会渲染成首页并返回 **200**，
 * 于是爬虫会把无数个 URL 都当成有效页面收进去。
 *
 * 同样的理由不能只写 `Number(raw)`：`Number('')`、`Number(' ')`、`Number('1e3')`
 * 都是合法数字。
 */
export function parsePageParam(raw: string | undefined): number | null {
	// `/` 没有 page 段
	if (raw === undefined) return 1;
	if (!/^[1-9][0-9]*$/.test(raw)) return null;

	const n = Number(raw);
	// 页码大到超出安全整数时说明是构造出来的地址，不接受
	if (!Number.isSafeInteger(n)) return null;
	return n;
}

/** 第 n 页的路径。第 1 页是 `/`（不是 `/1/`），与改造前一致。 */
export function pageUrl(n: number): string {
	return n === 1 ? '/' : `/${n}/`;
}

/**
 * 组装 Page 对象。
 *
 * 一处与 Astro 的 `paginate()` **不同**，是刻意修的：
 * Astro 在第 1 页把 `url.first` 设成 `undefined`（paginate.js 里 `first` 的分支是
 * `pageNum === 1 ? void 0 : …`），而 `Pagination.astro` 用 `url.first` 渲染页码「1」
 * 的链接——于是第 1 页底部的「1」是一个**没有 href 的链接**。
 * 当前 2 篇文章只有 1 页，整块分页不渲染，所以这个 bug 一直没露面。
 * 这里让 `first` 恒为 `/`（第 1 页的地址就是它），链接就正常了。
 */
export function buildPage<T>(
	items: T[],
	currentPage: number,
	size: number,
	total: number,
): PageLike<T> {
	const lastPage = Math.max(1, Math.ceil(total / size));
	const start = (currentPage - 1) * size;

	return {
		data: items,
		start,
		// 含尾下标：Astro 存的是 end - 1，别改成 slice 语义
		end: Math.min(start + size, total) - 1,
		size,
		total,
		currentPage,
		lastPage,
		url: {
			current: pageUrl(currentPage),
			prev: currentPage === 1 ? undefined : pageUrl(currentPage - 1),
			next: currentPage === lastPage ? undefined : pageUrl(currentPage + 1),
			first: pageUrl(1),
			last: currentPage === lastPage ? undefined : pageUrl(lastPage),
		},
	};
}

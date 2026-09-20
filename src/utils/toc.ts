/**
 * 目录（TOC）构建。
 *
 * 只有 h2/h3 进目录：h1 就是文章标题本身，出现在目录里是重复；
 * h4 及以下在 240px 宽的右栏里会碎成一堆换行，反而没法扫读。
 */

/** 结构类型而非 import astro 的类型：这样本文件不依赖 Astro 的运行时 */
export interface Heading {
	depth: number;
	slug: string;
	text: string;
}

export interface TocItem {
	slug: string;
	text: string;
	children: TocItem[];
}

/** 只保留 h2/h3。渲染成目录前的第一道过滤。 */
export function filterHeadings(headings: Heading[]): Heading[] {
	return headings.filter((h) => h.depth === 2 || h.depth === 3);
}

/**
 * 把扁平标题列表折成两层树：h2 为父，紧随其后的 h3 挂到该 h2 下。
 *
 * 开头的 h3（还没有任何 h2 时）不丢弃，作为顶级项——正文里先出现 h3
 * 是作者的写法问题，但目录不该因此少一条，那样读者会以为标题不存在。
 */
export function buildTocTree(headings: Heading[]): TocItem[] {
	const tree: TocItem[] = [];
	let current: TocItem | undefined;

	for (const heading of filterHeadings(headings)) {
		const item: TocItem = { slug: heading.slug, text: heading.text, children: [] };
		if (heading.depth === 2) {
			tree.push(item);
			current = item;
		} else if (current) {
			current.children.push(item);
		} else {
			tree.push(item);
		}
	}
	return tree;
}

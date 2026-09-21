/**
 * `astro:content` 的测试替身，只在 vitest 里生效（见 vitest.config.ts 的 alias）。
 *
 * 存在的理由：`src/utils/posts.ts` 顶部 import 了 `astro:content`，那是 Astro 的
 * 构建期虚拟模块，Node 直接解析会抛 "Received protocol 'astro:'"。
 * 而那个文件里除了 `getPublishedPosts` 之外全是纯函数，值得单独测。
 *
 * `getCollection` 故意抛错而不是返回空数组：真被调用说明测试写错了——
 * 空数组会让断言在"没有数据"的情况下安静地通过，比报错更糟。
 */

export async function getCollection(): Promise<never> {
	throw new Error(
		'测试不应调用 getCollection。这个替身只用来让 posts.ts 能被 import，' +
			'被测对象是同一文件里的纯函数（日期分组、标签片段、阅读时长）。',
	);
}

/**
 * 与 astro:content 的 CollectionEntry 结构对齐，只保留 src/ 里真正用到的字段。
 * vitest 默认不做类型检查，所以这里主要是给读代码的人看的。
 */
export interface CollectionEntry<C extends string> {
	id: string;
	collection: C;
	data: Record<string, unknown>;
	body?: string;
}

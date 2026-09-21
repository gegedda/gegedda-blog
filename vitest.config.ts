import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	resolve: {
		alias: {
			// 这里曾经还有一个 'astro:content' 替身，给当时还 import 内容集合的
			// src/utils/posts.ts 用。换成 D1 之后 src/ 里已经没有任何文件引
			// astro:content，content.config.ts 也删了，那个替身就成了死配置——
			// 删掉。如果将来有人再往 src/ 里加 Astro 构建期的虚拟模块 import，
			// vitest 会直接报"找不到模块"，那比留一个空替身更容易定位。

			// 只有 workerd 认识这个协议。src/lib/db.ts 引它，而 posts.ts 又引 db.ts，
			// 于是纯函数的测试会被连带拖死。替身里的 env 是空的——getDb() 会抛错，
			// 这正是想要的：仓储层测试直接传 stub db，不经过 getDb()。
			'cloudflare:workers': fileURLToPath(
				new URL('./test/stubs/cloudflare-workers.ts', import.meta.url),
			),
		},
	},
});

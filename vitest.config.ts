import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	resolve: {
		alias: {
			// src/utils/posts.ts 的第一行是 `import ... from 'astro:content'`，
			// 那是 Astro 的构建期虚拟模块，Node 解析不了（报 "Received protocol 'astro:'"）。
			// 这里把它指向一个替身，好让文件里那些**纯函数**能被单独测。
			//
			// 只测纯函数：日期分组、标签片段、阅读时长都不碰内容集合，
			// 拿 Post 类型只是为了取 post.data.pubDate 而已。
			'astro:content': fileURLToPath(new URL('./test/stubs/astro-content.ts', import.meta.url)),
		},
	},
});

// @ts-check

import cloudflare from '@astrojs/cloudflare';
import mdx from '@astrojs/mdx';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
	// 正式站点地址：影响 canonical URL 与 RSS 中的链接。
	// 换域名时这里、public/robots.txt、docs/部署指南.md 三处要一起改。
	site: 'https://gegedda-blog.pages.dev',

	// 全站 SSR。内容存在 D1，页面在请求时拼装。
	output: 'server',
	adapter: cloudflare({
		// ⚠️ 这一行不能删。
		//
		// 适配器的默认值是 `cloudflare-binding`，也就是 Cloudflare Images——
		// 一个**付费**产品，而且它会在部署时自动往账号里塞一个 IMAGES 绑定
		// （适配器源码 index.js:88 `needsImagesBinding = runtimeService === "cloudflare-binding"`，
		// 还会打一行 "Enabling image processing with Cloudflare Images"）。
		// 类型定义里的注释有句 "including the default"，那说的是 transformAtBuild，
		// 很容易读成默认值是 compile —— 不是，看 normalizeImageServiceConfig 的实现。
		//
		// 'passthrough' 的含义是：构建期和运行时都不做图片处理，原样输出，
		// 不碰 Cloudflare Images，也不需要在 Worker 里跑 sharp（那里跑不了）。
		// 代价是 `<Image>` 不再缩放，LCP 指标（G3）会退，这正是 P6 上 R2
		// 做预缩放要补回来的东西。
		imageService: 'passthrough',
	}),

	// 不用 Astro 的 session：会话是自签名的 cookie（见 src/lib/auth.ts 的计划），
	// 不需要服务端存储。
	//
	// 显式关掉是因为**不关就会自动开通一个 KV 命名空间**：
	// 适配器源码 index.js:109 `if (session !== false && !session?.driver)` 会
	// 默认启用 cloudflareKVBinding 驱动并加上 SESSION 绑定。一个用不到的
	// KV 命名空间会一直在账号里，而且是因为一个没写出来的配置项而存在的。
	session: false,

	integrations: [
		mdx(),
		// sitemap() 集成已移除。它在 SSR 下会**静默产出不含任何文章的 sitemap**：
		// 注入的 pathname 只在全部路由段都是静态时才填充，于是 /posts/*、/tags/*、
		// /2/ 全部贡献 0 条，且不报错。这里那个 filter 也就变成了死代码。
		// 替代品是自建的 src/pages/sitemap-index.xml.ts（P4）。
	],
	// Tailwind v4 走 Vite 插件，不要用 @astrojs/tailwind
	//（那个包 peer 锁死在 Astro 3–5 + Tailwind 3，与本项目不兼容）
	vite: {
		plugins: [tailwindcss()],
	},
	// 不再用 astro:fonts 加载 webfont：中文用系统字体栈，零下载。
	// Atkinson 是 preload 阻塞资源，对中文零覆盖，还让中西文交界处字重不匀。
	markdown: {
		shikiConfig: {
			// 双主题：Shiki 会把两个主题的值都写成内联自定义属性，
			// 由 global.css 里的 light-dark() 按 color-scheme 择一显示。
			themes: { light: 'vitesse-light', dark: 'vitesse-dark' },
			// 必须是 false。默认（'light'）时 Shiki 把亮色写成真正的
			// color/background-color 内联样式，只把暗色写成 --shiki-dark，
			// 于是根本没有 --shiki-light 这个变量可用，
			// light-dark() 会整条失效 → 代码块掉光配色（不报错，只是没颜色）。
			// false 让两套主题都写成自定义属性，内联样式里不再有 color。
			defaultColor: false,
		},
	},
});

// @ts-check

import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
	// 正式站点地址：影响 sitemap、canonical URL 与 RSS 中的链接
	site: 'https://gegedda-blog.pages.dev',
	integrations: [mdx(), sitemap()],
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

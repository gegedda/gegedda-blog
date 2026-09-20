import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const blog = defineCollection({
	// Load Markdown and MDX files in the `src/content/blog/` directory.
	loader: glob({ base: './src/content/blog', pattern: '**/*.{md,mdx}' }),
	// Type-check frontmatter using a schema
	// 注意：未在此声明的 frontmatter 字段会被 Zod 静默丢弃（不报错、不生效）。
	schema: ({ image }) =>
		z.object({
			title: z.string(),
			description: z.string(),
			// Transform string to Date object
			pubDate: z.coerce.date(),
			updatedDate: z.coerce.date().optional(),
			heroImage: z.optional(image()),
			// 草稿：生产构建不输出（含首页/列表/RSS/详情页），本地 dev 仍可预览
			draft: z.boolean().default(false),
			// 预留：标签/分类系统尚未实现，先让 frontmatter 有地方可写
			tags: z.array(z.string()).default([]),
			categories: z.array(z.string()).default([]),
		}),
});

export const collections = { blog };

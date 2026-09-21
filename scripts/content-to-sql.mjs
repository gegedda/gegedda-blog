#!/usr/bin/env node
/**
 * Markdown → SQL。
 *
 *   node scripts/content-to-sql.mjs [--src src/content/blog] [--out scripts/out/seed_content.sql]
 *
 * 产出的是一个普通的 .sql 文件，用
 *   npx wrangler d1 execute <库名> --remote --file=scripts/out/seed_content.sql
 * 导入，或者本地用 sqlite3 建库验证。
 *
 * 为什么产出文件而不是打到 stdout：**PowerShell 5.1 的 `>` 默认写 UTF-16LE**，
 * 用它重定向会得到一个 sqlite3 读不了的文件，而报错和编码毫无关系、极难查。
 * 所以这里由脚本自己用 UTF-8 写盘，不依赖调用方的 shell 行为。
 *
 * 幂等：用的是 UPSERT 而不是 INSERT OR REPLACE。后者在 SQLite 里等于
 * DELETE + INSERT，会顺带触发 post_tags 的 ON DELETE CASCADE —— 标签会被清掉，
 * 而且没有任何报错。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parsePostFile, dateRawToUtc } from './lib/frontmatter.mjs';
import { lit, cols, vals } from './lib/sql.mjs';
import { tagSegment } from '../src/utils/tag-segment.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
	const opts = { src: 'src/content/blog', out: 'scripts/out/seed_content.sql' };
	for (let i = 0; i < argv.length; i += 1) {
		const a = argv[i];
		if (a === '--src') opts.src = argv[++i];
		else if (a === '--out') opts.out = argv[++i];
		else throw new Error(`无法识别的参数：${a}`);
	}
	return opts;
}

/** 读一篇 .md，拆成 posts 行需要的数据 */
function readPost(file) {
	const text = fs.readFileSync(file, 'utf8');
	const { frontmatter: fm, body } = parsePostFile(text);

	// slug 必须和 Astro 的 glob loader 保持一致：相对 base 的路径去掉扩展名。
	// 这个值同时决定 URL（postUrl() → /posts/<slug>/），算错就是全站 404。
	const slug = path.basename(file, path.extname(file));

	for (const required of ['title', 'description', 'pubDate']) {
		if (fm[required] === undefined || fm[required] === null || fm[required] === '') {
			throw new Error(`${file} 缺少必填字段 ${required}`);
		}
	}

	return {
		slug,
		title: String(fm.title),
		description: String(fm.description),
		pubDateRaw: String(fm.pubDate),
		pubDateUtc: dateRawToUtc(fm.pubDate),
		updatedDateRaw: fm.updatedDate == null ? null : String(fm.updatedDate),
		updatedDateUtc: fm.updatedDate == null ? null : dateRawToUtc(fm.updatedDate),
		heroImage: fm.heroImage == null ? null : String(fm.heroImage),
		draft: fm.draft === true,
		body,
		tags: Array.isArray(fm.tags) ? fm.tags.map((t) => String(t).trim()).filter(Boolean) : [],
		categories: Array.isArray(fm.categories) ? fm.categories.map((t) => String(t)) : [],
	};
}

const POST_COLUMNS = [
	'slug', 'title', 'description',
	'pub_date_raw', 'pub_date_utc',
	'updated_date_raw', 'updated_date_utc',
	'hero_image', 'draft', 'body', 'categories_json',
	'created_at', 'updated_at',
];

function main() {
	const { src, out } = parseArgs(process.argv.slice(2));

	const srcDir = path.resolve(ROOT, src);
	const files = fs
		.readdirSync(srcDir)
		.filter((f) => f.endsWith('.md') || f.endsWith('.mdx'))
		.sort(); // 排序保证同样的输入产出同样的字节

	// .mdx 在改造后不再支持（satteri 的 evaluate() 用 new Function，Workers 禁止），
	// 现在还没有，但出现时要在导入阶段就拦住，而不是等到线上渲染失败。
	const mdx = files.filter((f) => f.endsWith('.mdx'));
	if (mdx.length) {
		throw new Error(`不再支持 .mdx（satteri 在 Workers 上无法求值）：${mdx.join(', ')}`);
	}

	if (files.length === 0) {
		throw new Error(`${srcDir} 里没有找到任何 .md 文件`);
	}

	const posts = files.map((f) => readPost(path.join(srcDir, f)));
	const now = Date.now();

	const lines = [
		'-- 由 scripts/content-to-sql.mjs 生成，请勿手工编辑。',
		`-- 来源：${src}（${posts.length} 篇）`,
		'-- 幂等：可重复执行。posts 用 UPSERT，post_tags 先删后插。',
		'',
	];

	for (const p of posts) {
		const values = [
			p.slug, p.title, p.description,
			p.pubDateRaw, p.pubDateUtc,
			p.updatedDateRaw, p.updatedDateUtc,
			p.heroImage, p.draft, p.body, JSON.stringify(p.categories),
			now, now,
		];
		const updatable = POST_COLUMNS.filter((c) => c !== 'slug' && c !== 'created_at');

		lines.push(
			`INSERT INTO posts ${cols(POST_COLUMNS)} VALUES ${vals(values)}`,
			`ON CONFLICT(slug) DO UPDATE SET`,
			// created_at 不在更新列表里：首次导入的时间才是这篇文章的创建时间
			updatable.map((c) => `  ${c} = excluded.${c}`).join(',\n') + ';',
			'',
		);
	}

	// 标签去重：name 保留显示形式，segment 是 URL 用的规范形式。
	// 两个不同的 name 算出同一个 segment 时，下面的 INSERT 会因为
	// segment 的唯一约束**报错**——这正是想要的：现在 'Hello World' 和
	// 'hello-world' 会静默共用同一个 URL，两个标签页互相覆盖。
	const tagNames = new Map();
	for (const p of posts) {
		for (const t of p.tags) tagNames.set(t, tagSegment(t));
	}

	if (tagNames.size) {
		lines.push('-- 标签');
		for (const [name, segment] of [...tagNames].sort((a, b) => a[0].localeCompare(b[0], 'zh-CN'))) {
			lines.push(
				`INSERT INTO tags (name, segment) VALUES ${vals([name, segment])}`,
				`ON CONFLICT(name) DO UPDATE SET segment = excluded.segment;`,
			);
		}
		lines.push('');
	}

	// 先清掉这些文章原有的标签关联，再按 frontmatter 的顺序重建。
	// position 必须存：TagChips 是按数组顺序渲染的，丢了顺序每次查询还不一样。
	const slugsInOrder = posts.map((p) => p.slug);
	lines.push('-- 文章标签关联');
	lines.push(`DELETE FROM post_tags WHERE post_slug IN (${slugsInOrder.map(lit).join(', ')});`);
	for (const p of posts) {
		p.tags.forEach((tag, i) => {
			// tag_id 用子查询取，因为它是自增主键，导入前并不知道值。
			// 用变量拼而不是走 vals()：vals() 只处理字面量，处理不了子查询。
			lines.push(
				`INSERT INTO post_tags (post_slug, tag_id, position) VALUES ` +
					`(${lit(p.slug)}, (SELECT id FROM tags WHERE name = ${lit(tag)}), ${i});`,
			);
		});
	}
	lines.push('');

	const outPath = path.resolve(ROOT, out);
	fs.mkdirSync(path.dirname(outPath), { recursive: true });
	// 显式 utf8 且不加 BOM
	fs.writeFileSync(outPath, lines.join('\n'), 'utf8');

	console.log(`✓ ${posts.length} 篇 → ${path.relative(ROOT, outPath)}`);
	for (const p of posts) {
		const flag = p.draft ? ' [草稿]' : '';
		const tags = p.tags.length ? `  标签: ${p.tags.join(', ')}` : '';
		console.log(`    ${p.slug}  ${p.pubDateRaw}${flag}${tags}`);
	}
}

main();

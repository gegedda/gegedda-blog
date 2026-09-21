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
 *
 * 这里**顺带把缓存列算出来**（body_html / headings_json / words / minutes）。
 *
 * 为什么放在导入路径上而不是单独一个回填脚本：运行时的 Worker 每次请求只有
 * 10ms CPU，读路径必须直接取现成的 body_html，没有余量现场渲染；而"记得要跑
 * 回填"是一个迟早会被忘掉的步骤，忘了的表现是文章页空白而不是报错。
 *
 * 用的渲染管线就是 shared/markdown.ts —— **和浏览器端同一份文件**，
 * 所以导入时的产出与后台预览、与读者看到的必然一致，不存在第二套实现漂移。
 * Node 24 的类型剥离让 .mjs 可以直接 import 这个 .ts。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parsePostFile, dateRawToUtc } from './lib/frontmatter.mjs';
import { lit, cols, vals } from './lib/sql.mjs';
import { tagSegment } from '../src/utils/tag-segment.ts';
import { readingStats } from '../src/utils/reading.ts';
import { renderMarkdown } from '../shared/markdown.ts';

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

/** 读一篇 .md，拆成 posts 行需要的数据（含渲染好的缓存列） */
async function readPost(file) {
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

	// 渲染缓存列。headings 直接用 shared 的产出，形状与 src/utils/toc.ts 的
	// Heading 一致，所以读路径可以原样 JSON.parse 后喂给目录组件。
	const { html, headings } = await renderMarkdown(body);
	const { words, minutes } = readingStats(body);

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
		bodyHtml: html,
		headingsJson: JSON.stringify(headings),
		words,
		minutes,
		tags: Array.isArray(fm.tags) ? fm.tags.map((t) => String(t).trim()).filter(Boolean) : [],
		categories: Array.isArray(fm.categories) ? fm.categories.map((t) => String(t)) : [],
	};
}

// 顺序与 migrations/0001_init.sql 里的列顺序一致，便于对照。
// 加列时**必须同时**改 valuesFor()，两处错位的表现是数据被静默写进错误的列。
const POST_COLUMNS = [
	'slug', 'title', 'description',
	'pub_date_raw', 'pub_date_utc',
	'updated_date_raw', 'updated_date_utc',
	'hero_image', 'draft', 'body',
	'body_html', 'headings_json', 'words', 'minutes',
	'categories_json',
	'created_at', 'updated_at',
];

/** 与 POST_COLUMNS 一一对应。写成函数是为了让它紧跟列定义，改一处就看得见另一处。 */
function valuesFor(p, now) {
	return [
		p.slug, p.title, p.description,
		p.pubDateRaw, p.pubDateUtc,
		p.updatedDateRaw, p.updatedDateUtc,
		p.heroImage, p.draft, p.body,
		p.bodyHtml, p.headingsJson, p.words, p.minutes,
		JSON.stringify(p.categories),
		now, now,
	];
}

async function main() {
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

	// 串行而不是 Promise.all：shiki 的 highlighter 是惰性单例，第一次调用要把
	// 主题和语法定义读进来，并发反而让首篇之后的几篇一起等同一个 promise。
	// 顺序 await 让输出顺序与 files 的排序一致，报错时也知道卡在哪一篇。
	const posts = [];
	for (const f of files) {
		posts.push(await readPost(path.join(srcDir, f)));
	}
	const now = Date.now();

	const lines = [
		'-- 由 scripts/content-to-sql.mjs 生成，请勿手工编辑。',
		`-- 来源：${src}（${posts.length} 篇）`,
		'-- 幂等：可重复执行。posts 用 UPSERT，post_tags 先删后插。',
		'',
	];

	for (const p of posts) {
		const values = valuesFor(p, now);
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
		// 缓存列一并报出来：0 字或 0 标题都是"渲染管线没跑起来"的早期信号，
		// 在这里看得见，就不用等到读者打开文章发现是空白页。
		console.log(
			`      html ${p.bodyHtml.length}B  标题 ${JSON.parse(p.headingsJson).length} 个` +
				`  ${p.words} 字 / ${p.minutes} 分钟`,
		);
	}
}

main().catch((err) => {
	console.error(err.message ?? err);
	process.exit(1);
});

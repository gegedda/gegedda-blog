#!/usr/bin/env node
/**
 * 数据库 → Markdown。content-to-sql.mjs 的逆操作。
 *
 *   node scripts/db-to-content.mjs --db <sqlite 文件> [--out <目录>]
 *
 * 承担两件事：
 *
 * 1. **保住 G1「内容归自己」**。内容进了 D1 就等于被锁在别人的服务里，
 *    这个脚本把它反解回纯 Markdown 文件树，随时可以喂给任何静态站点生成器。
 *
 * 2. **验证往返无损**。`--db` 指向由 content-to-sql.mjs 的产物建出来的库时，
 *    输出应当与 src/content/blog/*.md **逐字节一致**。这是 P0 的验收判据，
 *    也是"没有丢内容"的唯一证据。
 *
 * 用的是 Node 自带的 node:sqlite，不需要额外依赖，也不需要 wrangler 或联网。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { serializePostFile } from './lib/frontmatter.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
	const opts = { db: null, out: 'scripts/out/content' };
	for (let i = 0; i < argv.length; i += 1) {
		const a = argv[i];
		if (a === '--db') opts.db = argv[++i];
		else if (a === '--out') opts.out = argv[++i];
		else throw new Error(`无法识别的参数：${a}`);
	}
	if (!opts.db) throw new Error('必须指定 --db <sqlite 文件>');
	return opts;
}

function main() {
	const { db: dbPath, out } = parseArgs(process.argv.slice(2));
	const outDir = path.resolve(ROOT, out);

	const db = new DatabaseSync(path.resolve(ROOT, dbPath), { readOnly: true });

	// ORDER BY slug：产出顺序固定，同样的库每次导出同样的文件顺序
	const rows = db
		.prepare(
			`SELECT slug, title, description, pub_date_raw, updated_date_raw,
			        hero_image, draft, body, categories_json
			   FROM posts
			  ORDER BY slug`,
		)
		.all();

	const tagStmt = db.prepare(
		`SELECT t.name
		   FROM post_tags pt
		   JOIN tags t ON t.id = pt.tag_id
		  WHERE pt.post_slug = ?
		  ORDER BY pt.position`,
	);

	fs.mkdirSync(outDir, { recursive: true });

	const written = [];
	for (const row of rows) {
		const tags = tagStmt.all(row.slug).map((t) => t.name);

		let categories = [];
		try {
			categories = JSON.parse(row.categories_json ?? '[]');
		} catch {
			// 坏数据不应该让整次导出失败，但必须让人看见
			console.warn(`  ⚠ ${row.slug} 的 categories_json 不是合法 JSON，按空数组处理`);
		}

		// 键顺序由 serializeFrontmatter 的 KEY_ORDER 固定，与这里的书写顺序无关
		const frontmatter = {
			title: row.title,
			description: row.description,
			pubDate: row.pub_date_raw,
			updatedDate: row.updated_date_raw,
			heroImage: row.hero_image,
			draft: row.draft === 1 || row.draft === true,
			tags,
			categories,
		};

		const file = path.join(outDir, `${row.slug}.md`);
		// 显式 utf8、不加 BOM，与导入端对称
		fs.writeFileSync(file, serializePostFile(frontmatter, row.body), 'utf8');
		written.push(row.slug);
	}

	db.close();

	console.log(`✓ ${written.length} 篇 → ${path.relative(ROOT, outDir)}`);
	for (const slug of written) console.log(`    ${slug}.md`);
}

main();

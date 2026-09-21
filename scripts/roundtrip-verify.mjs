#!/usr/bin/env node
/**
 * 往返一致性验证 —— P0 的验收判据。
 *
 *   node scripts/roundtrip-verify.mjs
 *
 * 完整走一遍真实链路，逐步比字节：
 *
 *   .md  →  content-to-sql.mjs  →  .sql  →  sqlite3  →  db-to-content.mjs  →  .md
 *
 * 为什么要比到字节而不是「看起来一样」：
 * 这个改造把内容真源从 Git 里的文件搬进了数据库。搬过去之后再发现丢东西，
 * 原始文件可能已经被覆盖了。所以搬之前必须先证明**来回一趟一个字节都不差**。
 * 文字层面的「渲染出来一样」不够——它盖不住标签顺序、行尾空格、
 * frontmatter 引号形式这些不会被肉眼发现、但会持续产生 diff 噪音的差异。
 *
 * 跑两个目标：真实正文（src/content/blog）和夹具（scripts/fixtures/content）。
 * 夹具是必需的：真实那两篇没有 tags / draft / updatedDate，
 * 只跑它们的话这三条路径等于没验证过。
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { stripBom } from './lib/frontmatter.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'scripts', 'out', 'roundtrip');

const TARGETS = [
	{ name: 'posts', label: '现有正文', src: 'src/content/blog' },
	{ name: 'fixtures', label: '测试夹具', src: 'scripts/fixtures/content' },
];

function run(script, args) {
	execFileSync(process.execPath, [path.join(ROOT, 'scripts', script), ...args], {
		cwd: ROOT,
		stdio: ['ignore', 'pipe', 'pipe'],
		encoding: 'utf8',
	});
}

/** 找出两段 buffer 第一个不同的字节位置，用于报错定位 */
function firstDiff(a, b) {
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i += 1) {
		if (a[i] !== b[i]) return i;
	}
	return a.length === b.length ? -1 : n;
}

/** 把差异位置翻译成「第几行、上下文是什么」，比报偏移量有用得多 */
function describe(text, offset) {
	const before = text.slice(0, offset);
	const line = before.split('\n').length;
	const col = offset - (before.lastIndexOf('\n') + 1) + 1;
	const snippet = text.slice(Math.max(0, offset - 30), offset + 30);
	return { line, col, snippet: JSON.stringify(snippet) };
}

function verifyTarget(target) {
	const srcDir = path.join(ROOT, target.src);
	const workDir = path.join(OUT, target.name);
	fs.rmSync(workDir, { recursive: true, force: true });
	fs.mkdirSync(workDir, { recursive: true });

	const fs1 = fs.readdirSync(srcDir).filter((f) => f.endsWith('.md')).sort();
	if (fs1.length === 0) throw new Error(`${target.src} 里没有 .md`);

	// 1) Markdown → SQL
	const seedSql = path.join(workDir, 'seed.sql');
	run('content-to-sql.mjs', ['--src', target.src, '--out', path.relative(ROOT, seedSql)]);

	// 2) SQL → 数据库（真的执行一遍 SQL，不是只测 JS）
	const dbPath = path.join(workDir, 'roundtrip.sqlite');
	const db = new DatabaseSync(dbPath);
	db.exec(stripBom(fs.readFileSync(path.join(ROOT, 'migrations', '0001_init.sql'), 'utf8')));
	db.exec(stripBom(fs.readFileSync(seedSql, 'utf8')));
	db.close();

	// 3) 数据库 → Markdown
	const outDir = path.join(workDir, 'content');
	run('db-to-content.mjs', ['--db', path.relative(ROOT, dbPath), '--out', path.relative(ROOT, outDir)]);

	// 4) 逐字节比对
	const fs2 = fs.readdirSync(outDir).filter((f) => f.endsWith('.md')).sort();
	const results = [];

	const missing = fs1.filter((f) => !fs2.includes(f));
	const extra = fs2.filter((f) => !fs1.includes(f));
	for (const f of missing) results.push({ file: f, ok: false, why: '导出后丢失了这个文件' });
	for (const f of extra) results.push({ file: f, ok: false, why: '导出了源目录里没有的文件' });

	for (const f of fs1) {
		if (!fs2.includes(f)) continue;

		const a = fs.readFileSync(path.join(srcDir, f));
		const b = fs.readFileSync(path.join(outDir, f));

		if (a[0] === 0xef && a[1] === 0xbb && a[2] === 0xbf) {
			results.push({ file: f, ok: false, why: '源文件带 UTF-8 BOM' });
		}
		if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) {
			results.push({ file: f, ok: false, why: '导出文件带 UTF-8 BOM' });
			continue;
		}

		const d = firstDiff(a, b);
		if (d === -1) {
			results.push({ file: f, ok: true, bytes: a.length });
		} else {
			results.push({
				file: f,
				ok: false,
				why: `第 ${describe(b.toString('utf8'), d).line} 行附近不一致（字节偏移 ${d}）`,
				detail: `  源文件: ${describe(a.toString('utf8'), d).snippet}\n  导出后: ${describe(b.toString('utf8'), d).snippet}`,
			});
		}
	}

	return results;
}

let allOk = true;

for (const target of TARGETS) {
	console.log(`\n──── ${target.label}  (${target.src}) ────`);
	let results;
	try {
		results = verifyTarget(target);
	} catch (e) {
		console.log(`  ✗ 执行失败：${e.message}`);
		allOk = false;
		continue;
	}

	for (const r of results) {
		if (r.ok) {
			console.log(`  ✓ ${r.file.padEnd(28)} ${String(r.bytes).padStart(5)} 字节，逐字节一致`);
		} else {
			allOk = false;
			console.log(`  ✗ ${r.file.padEnd(28)} ${r.why}`);
			if (r.detail) console.log(r.detail);
		}
	}
}

console.log();
if (allOk) {
	console.log('✓ 往返一致：Markdown → 数据库 → Markdown 一个字节都没变');
} else {
	console.log('✗ 往返不一致 —— 内容会在迁移中损坏，先修好再往下走');
	process.exitCode = 1;
}

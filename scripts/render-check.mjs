/**
 * 渲染管线回归门槛：`shared/markdown.ts` 的产出必须与**改造前线上产物**逐字节一致。
 *
 * 为什么门槛是这个而不是「看起来差不多」：
 *
 * 改造后 `body_html` 由浏览器产出，读者请求只是把它读出来套模板。也就是说
 * `shared/markdown.ts` 的产出就是线上形态，没有第二道工序会纠正它。
 * 「差不多」在中文排版和代码高亮这两件事上没有意义 —— 差一个字符就是差一个字符，
 * 而且这类差异不会报错，只会以「某篇文章看着不太对」的形式出现。
 *
 * 所以判据只能是最硬的那条：字节相同。不同的是哪一段、差在哪，脚本会直接指出来。
 *
 * ── 基准从哪来 ──────────────────────────────────────────────
 *
 * 基准是 `scripts/fixtures/<slug>.html`，内容是改造前 `dist/posts/<slug>/index.html`
 * 里 `<div class="prose">` 那一段的**原文**。
 *
 * 它必须固化进仓库，不能每次现从 `dist/` 取：P4 之后路由改成 SSR，
 * `npm run build` 就不再产出一篇篇的 `index.html` 了，现取就永远取不到。
 * 固化之后这个脚本才是一份长期有效的回归测试，而不是一次性的迁移检查。
 *
 * 用法：
 *   node scripts/render-check.mjs              # 比对（npm run verify 会跑这个）
 *   node scripts/render-check.mjs --snapshot   # 从 dist/ 重新生成基准（仅迁移期用过一次）
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parsePostFile } from './lib/frontmatter.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTENT_DIR = path.join(ROOT, 'src', 'content', 'blog');
const FIXTURE_DIR = path.join(ROOT, 'scripts', 'fixtures');
const DIST_DIR = path.join(ROOT, 'dist', 'posts');

const SNAPSHOT = process.argv.includes('--snapshot');

const SLUGS = ['hello-world', 'building-this-blog'];

/**
 * 从渲染好的整页 HTML 里切出 Markdown 正文那一段。
 *
 * 切法是数 div 开闭配对，而不是正则取最后一个 div 结束标签 —— 正文里必然有
 * 嵌套 div（代码块、提示框之类），最外层正文还没结束时内层就已经闭合过了。
 * （注意：这段注释里不能出现 div 的结束标签字面量，它会把块注释提前闭合。）
 */
function extractProse(html) {
	const open = /<div class="prose"[^>]*>/.exec(html);
	if (!open) return null;

	const start = open.index + open[0].length;
	let depth = 1;
	const re = /<div\b|<\/div>/g;
	re.lastIndex = start;

	for (let m; (m = re.exec(html)) !== null; ) {
		depth += m[0] === '</div>' ? -1 : 1;
		if (depth === 0) return html.slice(start, m.index);
	}
	return null;
}

/** 找出第一处不同，附上前后文，让差异可读。 */
function firstDiff(a, b) {
	const max = Math.max(a.length, b.length);
	for (let i = 0; i < max; i++) {
		if (a[i] !== b[i]) return i;
	}
	return -1;
}

function context(str, at, span = 90) {
	const from = Math.max(0, at - span);
	const to = Math.min(str.length, at + span);
	return JSON.stringify(str.slice(from, to));
}

function snapshot() {
	if (!existsSync(DIST_DIR)) {
		console.error(`✗ 找不到 ${path.relative(ROOT, DIST_DIR)}/，无法重建基准。`);
		console.error('  这一步只在迁移期做一次；若已做过，基准就在 scripts/fixtures/ 里。');
		process.exit(2);
	}
	mkdirSync(FIXTURE_DIR, { recursive: true });

	for (const slug of SLUGS) {
		const distPath = path.join(DIST_DIR, slug, 'index.html');
		if (!existsSync(distPath)) {
			console.error(`✗ 基准源不存在：${path.relative(ROOT, distPath)}`);
			process.exit(2);
		}
		const prose = extractProse(readFileSync(distPath, 'utf8'));
		if (prose === null) {
			console.error(`✗ ${slug}：产物里找不到 <div class="prose">`);
			process.exit(2);
		}
		writeFileSync(path.join(FIXTURE_DIR, `${slug}.html`), prose, 'utf8');
		console.log(`✓ 已固化基准 scripts/fixtures/${slug}.html（${prose.length} 字节）`);
	}
}

async function main() {
	if (SNAPSHOT) return snapshot();

	// Node 24 的类型剥离支持直接从 .mjs import .ts，
	// 所以门槛脚本和浏览器用的是**同一个文件**，不存在两份实现漂移的可能。
	const { renderMarkdown } = await import('../shared/markdown.ts');

	let failed = 0;

	for (const slug of SLUGS) {
		const mdPath = path.join(CONTENT_DIR, `${slug}.md`);
		const fixturePath = path.join(FIXTURE_DIR, `${slug}.html`);

		if (!existsSync(fixturePath)) {
			console.log(`\n─ ${slug}\n  ✗ 基准不存在：${path.relative(ROOT, fixturePath)}`);
			failed++;
			continue;
		}

		const { body } = parsePostFile(readFileSync(mdPath, 'utf8'));
		const { html, headings } = await renderMarkdown(body);
		const expected = readFileSync(fixturePath, 'utf8');

		const at = firstDiff(expected, html);
		const ok = at === -1;

		console.log(`\n─ ${slug}`);
		console.log(`  正文长度  基准 ${expected.length} / 新管线 ${html.length}`);
		console.log(`  标题       ${headings.map((h) => h.slug).join(' | ')}`);

		if (ok) {
			console.log('  ✓ 逐字节一致');
		} else {
			failed++;
			console.log(`  ✗ 第 ${at} 字节起不同`);
			console.log(`    基准: ${context(expected, at)}`);
			console.log(`    新值: ${context(html, at)}`);
		}
	}

	console.log(`\n${'─'.repeat(60)}`);
	if (failed) {
		console.log(`✗ ${failed}/${SLUGS.length} 篇不一致`);
		process.exit(1);
	}
	console.log(`✓ ${SLUGS.length} 篇全部逐字节一致`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});

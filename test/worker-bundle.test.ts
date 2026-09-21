/**
 * Worker 产物里**不许**出现 Shiki / Oniguruma。
 *
 * ── 为什么这条门槛看产物而不是看源码 ──────────────────────────
 *
 * 在源码里 grep `shared/markdown` 只能查到"直接 import"。真正的风险路径是
 * 间接的：某个服务端路由 import 了一个组件，那个组件又 import 了渲染管线，
 * 于是 Shiki 和它那 1.4 MB 的内联 wasm 顺着依赖图悄悄进了 Worker。
 *
 * 后果有两层，第二层比第一层难查得多：
 *
 *   1. **每次请求的 CPU 预算**：免费版只有 10ms，渲染一篇带代码块的文章远超它。
 *      表现是 500，而报错是 Error 1102，**一个字都不会提到 markdown**。
 *   2. **bundle 体积**：Worker 的免费额度是 gzip 后 3 MiB，超了**部署被拒收**，
 *      报错同样不提 markdown。
 *
 * 结果导向的断言（"产物里有没有这个引擎"）比源码 grep 可靠：它不关心是怎么
 * 进去的，也不怕以后有人换了一种导入姿势。
 *
 * ── 判据是「实现」而不是「字符串 shiki」 ────────────────────────
 *
 * ⚠️ 直接 grep `shiki` 会**误报**。产物里有一份 Vite 的模块图清单
 * （`dist/server/chunks/entrypoints_*.mjs`，约 300 KB），里面逐条列出了
 * `node_modules/@shikijs/langs/dist/abap.mjs → _astro/abap.XXXX.js` 这样的
 * **路径映射**——那是"客户端动过哪些语言包"的账本，不是引擎本身。
 * 拿它当判据的话这条门槛会永远红着，然后被人删掉。
 *
 * 所以用的是几个只可能出现在**实现**里的记号：
 *
 *   - `AGFzbQ` —— base64 里 wasm 魔数 `\0asm` 的开头。内联 wasm 一定带它。
 *   - `oniguruma` —— 引擎名。
 *   - `WebAssembly` —— 任何真跑 wasm 的代码都要碰这个全局。
 *   - `getSingletonHighlighter` / `createHighlighterCore` / `codeToTokens` ——
 *     Shiki 的运行时 API 名。
 *
 * ── 反向对照 ──────────────────────────────────────────────────
 *
 * 只断言"服务端没有"是不够的：哪天有人把预览面板整个删掉，这条会**因为
 * 引擎压根不存在**而变绿，看起来像通过了。所以同时断言**客户端产物里必须有**
 * 内联 wasm —— 一对匹配的断言才能说明"它在该在的地方，不在不该在的地方"。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// ⚠️ `fileURLToPath` 而不是 `new URL(import.meta.url).pathname`：那个 pathname 是
// **百分号编码**的，本项目路径里有中文，于是会去找一个叫
// `%E4%B8%AA%E4%BA%BA...` 的目录，报 ENOENT 且看不出和编码有关。
// （与 `test/stubs/d1.ts` 同一条约定。）
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_DIR = path.join(ROOT, 'dist', 'server');
const CLIENT_DIR = path.join(ROOT, 'dist', 'client');

/** Worker 的入口。它不在就说明没构建过。 */
const WORKER_ENTRY = path.join(SERVER_DIR, 'entry.mjs');
const BUILT = existsSync(WORKER_ENTRY);

/** 只在实现里出现的记号。见文件头的说明。 */
const ENGINE_MARKERS = [
	'AGFzbQ', // 内联 wasm 的 base64 魔数
	'oniguruma',
	'WebAssembly',
	'getSingletonHighlighter',
	'createHighlighterCore',
	'codeToTokens',
];

/**
 * 浏览器里那份内联 wasm 的魔数。用来做反向对照。
 *
 * 单独拎出来是因为它是**二进制格式**的一部分，比任何 API 名字都稳：
 * Shiki 换版本会改函数名，不会改 wasm 魔数。
 */
const WASM_MAGIC_BASE64 = 'AGFzbQ';

/**
 * `dist/` 下所有文本产物，`相对路径 → 内容`。
 *
 * 跳过非文本文件（图片等）：`readFileSync(…, 'utf8')` 读二进制不会抛，
 * 只会把字节按 UTF-8 解出一堆替换字符，白花时间还可能制造假阳性。
 */
function readBundles(dir: string): Map<string, string> {
	const out = new Map<string, string>();
	if (!existsSync(dir)) return out;

	for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
		if (!entry.isFile()) continue;
		if (!/\.(mjs|js|cjs|json|txt)$/.test(entry.name)) continue;
		const full = path.join(entry.parentPath, entry.name);
		out.set(path.relative(dir, full), readFileSync(full, 'utf8'));
	}
	return out;
}

/** 哪些文件含有这个记号。返回 `文件名: 出现次数` 的清单，空数组表示干净。 */
function hits(bundles: Map<string, string>, marker: string, limit = 5): string[] {
	const found: string[] = [];
	for (const [file, content] of bundles) {
		if (!content.includes(marker)) continue;
		found.push(`${file} (${content.split(marker).length - 1} 次)`);
		if (found.length >= limit) break;
	}
	return found;
}

/**
 * 没构建时要说的话。
 *
 * ⚠️ 用 `ctx.skip(原因)` 而不是 `console.warn`：模块作用域的 `console.warn`
 * 发生在收集阶段，vitest 的默认 reporter **不会**把它打出来（实测）。
 * 一条没有理由的 `skipped` 很容易被读成"通过了"，那正是这条门槛最不该有的样子。
 */
const SKIP_REASON =
	'找不到 dist/server/entry.mjs —— 这条门槛断言的是**构建产物**，必须先 npm run build。' +
	'`npm run verify` 的顺序是 build → test，天然满足；单独跑 `npm run test` 时它会跳过，跳过不等于通过。';

describe('Worker 产物里没有 Shiki / Oniguruma', () => {
	it('前提：构建产物存在', (ctx) => {
		// 单独跑 `npm run test`（没有先构建）时会走到这里。
		//
		// 刻意**不**把"没构建"当成失败：那会让没有 dist 时的 `npm run test` 红掉，
		// 而这条门槛想拦的东西和"你还没构建"是两件事。
		if (!BUILT) ctx.skip(SKIP_REASON);
		expect(BUILT).toBe(true);
	});
});

describe.skipIf(!BUILT)('Worker 产物里没有 Shiki / Oniguruma', () => {
	const server = readBundles(SERVER_DIR);
	const client = readBundles(CLIENT_DIR);

	it('确实读到了产物（否则下面全是空转）', () => {
		// 这条是给下面所有断言兜底的：`readBundles` 返回空 Map 时，
		// "没有任何文件含有这个记号"会自动成立 —— 整个文件变成一场空转。
		expect(server.size).toBeGreaterThan(0);
		expect(client.size).toBeGreaterThan(0);
		expect(server.has(path.relative(SERVER_DIR, WORKER_ENTRY))).toBe(true);
	});

	describe('服务端（Worker）', () => {
		for (const marker of ENGINE_MARKERS) {
			it(`不含 ${marker}`, () => {
				// 失败时要把"哪个文件、出现几次"打出来。只说一句
				// "expected false to be true" 的话，下一个人得自己再 grep 一遍。
				expect(hits(server, marker), `在 ${marker} 上命中`).toEqual([]);
			});
		}

		it('整包的体积还在一个粗放的界内', () => {
			// ⚠️ 这是一个**粗放的兜底**，不是精确预算。
			//
			// 真正的硬限制是 gzip 后 3 MiB，而这里量的是**未压缩**的字符数，
			// 两者不能直接比。它的作用只有一个：万一有人把某个大依赖整体拖进来，
			// 而那个依赖恰好不含上面那六个记号，这一条还能说话。
			//
			// 当前实测约 1.1 MB。界放到 4 MiB 是为了留出正常的增长空间，
			// 不至于因为多几个页面就红。
			const bytes = [...server.values()].reduce((n, s) => n + s.length, 0);
			expect(
				bytes,
				`dist/server 现在 ${(bytes / 1024).toFixed(0)} KB。` +
					'超了先看是不是有东西顺着依赖图进了服务端。',
			).toBeLessThan(4 * 1024 * 1024);
		});
	});

	describe('客户端（对照）', () => {
		it('内联 wasm 在客户端产物里**确实存在**', () => {
			// 反向对照。没有这一条，上面那六条会因为"引擎压根没装"而变绿。
			// 这一个记号同时证明了两件事：预览面板的懒加载 chunk 还在，
			// 并且它带着真的 Oniguruma —— 也就是服务端不该有的那个东西。
			expect(hits(client, WASM_MAGIC_BASE64)).not.toEqual([]);
		});
	});
});

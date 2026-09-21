/**
 * Markdown → HTML 渲染管线。**浏览器与 Node 脚本共用同一份代码。**
 *
 * 为什么这件事值得单独一个目录、单独一份实现：
 *
 * 站点的 HTML 不是构建时生成的，而是**在浏览器里生成好、存进 D1 的 `body_html` 列**。
 * 读者请求只做「读库 + 套模板」。所以这里产出的字符串就是线上最终形态，
 * 它必须稳定 —— 一旦前后两次发布同一篇文章产出不同 HTML，问题会以
 * 「某篇文章的排版和别人不一样」这种极难定位的方式出现。
 *
 * 因此有两条硬约束：
 *
 * 1. **只有这一份实现。** 浏览器（`/admin` 发布时）和 `scripts/render-check.mjs`
 *    （比对历史产物）import 的是同一个文件。两份实现必然漂移。
 * 2. **输出必须与改造前的 `dist/posts/<slug>/index.html` 逐字节一致。** 那 2 篇文章是
 *    唯一的参照物，也是「中文排版和代码高亮有没有回归」的唯一判据。
 *
 * ── 关于为什么不用 astro 自己的渲染器 ──────────────────────────────
 *
 * 改造前 Astro 7 用的是 `satteri`（Rust 引擎，NAPI 原生绑定）。它的浏览器版本
 * 要求 `WebAssembly.Memory({ shared: true })`，而浏览器只在 cross-origin isolated
 * （`COOP: same-origin` + `COEP: require-corp`）下才给 SharedArrayBuffer。
 * 为了渲染 Markdown 给整个 `/admin` 套上跨域隔离，代价远高于收益。
 *
 * 所以这里重新实现了 Astro 那条管线的**产出等价物**。关键点是：
 * Astro 的管线里，除了 satteri 内部的 parse / GFM / smartypants，
 * 其余每一环本来就是 JavaScript，可以原样对应：
 *
 * | 产出 | 改造前的来源 | 这里 |
 * |---|---|---|
 * | 标题 id | `github-slugger` | 同一个包，行为必然一致 |
 * | `astro-code` 类名 | `class.replace(/shiki/g, 'astro-code')` | 同一条正则 |
 * | `--shiki-light/dark` 变量 | Shiki + `defaultColor: false` | 同一个 shiki，同一份配置 |
 * | `tabindex="0"` | `@shikijs/core` 的默认值 | 同一个 shiki，自动一致 |
 * | GFM | satteri 内部 | `remark-gfm` |
 * | 智能标点 | satteri 内部 | **本文件自己实现**（见下方「智能标点」一节） |
 *
 * 最后两行是**唯一**有真实漂移风险的地方，也正是 P2 门槛要逐字节验证的东西。
 * 智能标点没有可复用的 JS 实现 —— `remark-smartypants` 在中文上是错的，
 * 所以它是本文件里唯一需要逆向 satteri 行为的部分。
 */

import Slugger from 'github-slugger';
import rehypeStringify from 'rehype-stringify';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { createHighlighter, isSpecialLang, type Highlighter } from 'shiki';
import { createOnigurumaEngine } from 'shiki/engine/oniguruma';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';

/** 与 `astro.config.mjs` 的 `markdown.shikiConfig` 保持一致。 */
const SHIKI_THEMES = { light: 'vitesse-light', dark: 'vitesse-dark' };

/**
 * 不交给 Shiki 处理的语言。
 * 对应 `@astrojs/internal-helpers/markdown` 的 `defaultExcludeLanguages`。
 * 只有 `math`：数学块由 KaTeX 之类接管，Shiki 不认识它。
 */
const DEFAULT_EXCLUDE_LANGS = ['math'];

/** `headings` 的每一项，与 `src/utils/toc.ts` 的 `Heading` 对齐。 */
export interface Heading {
	depth: number;
	slug: string;
	text: string;
}

export interface RenderResult {
	html: string;
	headings: Heading[];
}

// ─────────────────────────────────────────────────────────────
// Shiki：高亮器是重对象（要加载主题与 WASM），全进程只建一次。
// ─────────────────────────────────────────────────────────────

let highlighterPromise: Promise<Highlighter> | undefined;

function getHighlighter(): Promise<Highlighter> {
	highlighterPromise ??= createHighlighter({
		themes: Object.values(SHIKI_THEMES),
		// 必须显式带上 plaintext：没有语言标注的围栏代码块会走它。
		langs: ['plaintext'],
		// 与 astro 一致，用 oniguruma 而非 JS 正则引擎。
		// 两者的分词结果对边缘语法可能不同，换引擎等于换高亮结果。
		engine: createOnigurumaEngine(import('shiki/wasm')),
	});
	return highlighterPromise;
}

/**
 * 复刻 `@astrojs/internal-helpers/shiki` 里 `pre()` 那个 transformer 的产出。
 *
 * 改动只有一处：原实现支持传入 `attributes` 做类名/样式的追加，本项目没有用到，
 * 去掉后 `classValue` / `styleValue` 就是 shiki 的原值，结果完全相同。
 *
 * `tabindex` 不在这里设置 —— 它是 shiki 的默认行为，别再加一遍。
 */
function astroCodeTransformers(lang: string) {
	return [
		{
			pre(node: { properties: Record<string, unknown> }) {
				const classValue = normalizeProp(node.properties.class) ?? '';
				const styleValue = normalizeProp(node.properties.style) ?? '';

				// shiki 给的是 `shiki shiki-themes vitesse-light vitesse-dark`。
				// 全局替换成 astro-code，得到
				// `astro-code astro-code-themes vitesse-light vitesse-dark`。
				node.properties.class = classValue.replace(/shiki/g, 'astro-code');
				node.properties.dataLanguage = lang;
				node.properties.style = `${styleValue}; overflow-x: auto;`;
			},
		},
		{
			/**
			 * diff 语言的特殊处理，与 astro 的高亮器一致：
			 * 把行首的 +/- 挪进一个独立的 `user-select: none` 的 span，
			 * 这样复制代码时不会把增删标记一起带走。
			 */
			line(node: { children: unknown[] }) {
				if (lang !== 'diff') return;
				const inner = node.children[0] as
					| { type?: string; children?: unknown[] }
					| undefined;
				if (inner?.type !== 'element') return;
				const text = inner.children?.[0] as
					| { type?: string; value?: string }
					| undefined;
				if (text?.type !== 'text' || typeof text.value !== 'string') return;

				const marker = text.value[0];
				if (marker !== '+' && marker !== '-') return;

				text.value = text.value.slice(1);
				(inner.children as unknown[]).unshift({
					type: 'element',
					tagName: 'span',
					properties: { style: 'user-select: none;' },
					children: [{ type: 'text', value: marker }],
				});
			},
		},
	];
}

function normalizeProp(value: unknown): string | undefined {
	return Array.isArray(value) ? value.join(' ') : (value as string | undefined);
}

/**
 * 把 `<pre><code>` 换成 Shiki 产出的 `<pre>`。
 *
 * 对应 satteri-processor 里的 `createHighlightPlugin`。取语言和 meta 的路径不同
 * 但取值等价：satteri 放在 `codeChild.data.lang/meta`，`mdast-util-to-hast` 放在
 * `className: ['language-xx']` 与 `data.meta`。
 */
function rehypeShikiHighlight() {
	return async (tree: unknown) => {
		type Job = {
			parent: { children: unknown[] };
			index: number;
			code: string;
			lang: string;
			meta: string | undefined;
		};
		const jobs: Job[] = [];

		visit(tree as never, 'element', (node, index, parent) => {
			if ((node as { tagName?: string }).tagName !== 'pre') return;
			if (!parent || index === undefined) return;

			const children = (node as { children: unknown[] }).children;
			const codeChild = children.find(
				(c) => (c as { type?: string; tagName?: string }).type === 'element' && (c as { tagName?: string }).tagName === 'code',
			) as { children: unknown[]; properties?: Record<string, unknown>; data?: { meta?: string } } | undefined;
			if (!codeChild) return;

			const className = codeChild.properties?.className;
			const classList = Array.isArray(className) ? className.map(String) : [];
			const langClass = classList.find((c) => c.startsWith('language-'));
			const lang = langClass ? langClass.slice('language-'.length) : 'plaintext';
			if (DEFAULT_EXCLUDE_LANGS.includes(lang)) return;

			jobs.push({
				parent: parent as { children: unknown[] },
				index,
				// 末尾换行要去掉：Shiki 自己会按行切分，留着会多出一个空行。
				code: textContent(codeChild).replace(/\n$/, ''),
				lang,
				meta: codeChild.data?.meta,
			});
		});

		// visit 不支持异步回调，所以先收集、再并发渲染、最后回填。
		await Promise.all(
			jobs.map(async (job) => {
				const highlighter = await getHighlighter();
				let lang = job.lang;

				// 按需加载语法。漏掉这一步的表现是：博主写一个 ```js 代码块，
				// 后台直接抛 "Language `js` not found" 而整个发布失败。
				// 语法是从 `@shikijs/langs` 动态引入的，所以这里只能 await。
				if (!isSpecialLang(lang) && !highlighter.getLoadedLanguages().includes(lang)) {
					try {
						await highlighter.loadLanguage(lang as never);
					} catch {
						// 收录不到的语法不该让发布失败，退回纯文本并出声。
						// shiki 的语法是按需从 `@shikijs/langs` 动态引入的，
						// 走到这里说明那个包也没有这门语法（或构建时被裁掉了）。
						console.warn(
							`[markdown] 未收录的代码语言 "${lang}"，已按纯文本渲染。`,
						);
						lang = 'plaintext';
					}
				}

				const root = highlighter.codeToHast(job.code, {
					themes: SHIKI_THEMES,
					defaultColor: false,
					lang,
					meta: job.meta ? { __raw: job.meta } : undefined,
					transformers: astroCodeTransformers(lang),
				});
				// shiki 返回的 Root 里，第一个子节点就是我们最终要的 <pre>。
				job.parent.children[job.index] = root.children[0];
			}),
		);
	};
}

/**
 * 给 h1–h6 打 id 并收集目录。
 * 对应 satteri-processor 里的 `createHeadingIdsPlugin`。
 *
 * Slugger 必须每个文档新建一个 —— 它的去重状态（`foo`、`foo-1`）是跨标题累积的，
 * 复用实例会让第二篇文章的标题被第一篇文章影响。
 */
function rehypeHeadingIds(headings: Heading[]) {
	const slugger = new Slugger();
	return () => (tree: unknown) => {
		visit(tree as never, 'element', (node) => {
			const el = node as { tagName?: string; properties?: Record<string, unknown> };
			if (!el.tagName || !/^h[1-6]$/.test(el.tagName)) return;

			const text = textContent(node);
			const existingId = el.properties?.id;
			const slug = typeof existingId === 'string' ? existingId : slugger.slug(text);

			headings.push({ depth: Number.parseInt(el.tagName[1], 10), slug, text });

			if (typeof existingId !== 'string') {
				el.properties ??= {};
				el.properties.id = slug;
			}
		});
	};
}

// ─────────────────────────────────────────────────────────────
// 智能标点（smart punctuation）
//
// 对应 satteri 的 `features.smartPunctuation: true`。
//
// **为什么不用 `remark-smartypants`。** 试过，它在中文上是错的：
//
//   中文"引号"结尾
//     satteri（改造前线上行为）→ 中文“引号”结尾
//     remark-smartypants        → 中文”引号”结尾
//
// 它按「前一个字符不是空白 ⇒ 收尾引号」判断，而中文句子里引号两侧都是汉字，
// 于是**开引号也变成闭引号** —— 这在中文博客里是常态而非边缘情况。
// 另外 satteri 不做 `(c)` / `(tm)` / `(r)` / `1st` / `1/2`，而 smartypants
// 默认会做，多出来的那部分本身就是差异。
//
// 下面的规则**不是猜的**：拿 satteri 的原生绑定当裁判，用矩阵探针
// （前一个字符的类型 × 后一个字符的类型，各 13 类）逐格测出来的。
// ─────────────────────────────────────────────────────────────

const OPEN_DOUBLE_QUOTE = '“'; // “
const CLOSE_DOUBLE_QUOTE = '”'; // ”
const OPEN_SINGLE_QUOTE = '‘'; // ‘
const CLOSE_SINGLE_QUOTE = '’'; // ’
const EM_DASH = '—'; // —
const EN_DASH = '–'; // –
const ELLIPSIS = '…'; // …

/** 「字」：Unicode 字母或数字。汉字、拉丁字母、阿拉伯数字都算。 */
const WORD_CHAR = /[\p{L}\p{N}]/u;

/** 英寸写法只看 ASCII 数字。 */
const DIGIT_CHAR = /^[0-9]$/;

/**
 * 空白。注意占位符 `\u0000` **不是**空白 —— 它代表源码里的标记字符
 * （`*`、反引号、`)` 等），在 satteri 眼里是标点，判引号时按标点处理。
 */
const SPACE_CHAR = /^\s$/;
const isSpace = (ch: string) => SPACE_CHAR.test(ch);

/** 这些内联节点不是正文，不参与标点判断，也不能被改写。 */
const OPAQUE_INLINE = new Set([
	'inlineCode',
	'code',
	'html',
	'image',
	'imageReference',
	'break',
	'footnoteReference',
]);

/** 承载内联内容的块级节点。状态在每个这样的节点开头重置。 */
const INLINE_BLOCK = new Set(['paragraph', 'heading', 'tableCell']);

/**
 * 一段连续连字符要变成什么。
 *
 * 实测 satteri 在 1..26 个连字符上的**全部**输出，规律是：
 *   - 个数能被 3 整除     → 全 em（`---` 一个 `—`）
 *   - 否则个数是偶数      → 全 en（`--` 一个 `–`）
 *   - 否则（奇数且非 3 倍）→ em 取「不超过 n/3 的最大奇数」，剩下按 en 补
 * 三支的顺序不能换：`------` 能被 3 整除，必须是 `——` 而不是三个 `–`。
 */
function convertDashRun(n: number): string {
	if (n === 1) return '-';
	if (n % 3 === 0) return EM_DASH.repeat(n / 3);
	if (n % 2 === 0) return EN_DASH.repeat(n / 2);

	let em = Math.floor(n / 3);
	if (em % 2 === 0) em -= 1;
	return EM_DASH.repeat(em) + EN_DASH.repeat((n - 3 * em) / 2);
}

function remarkSmartPunctuation() {
	return (tree: unknown) => {
		visit(tree as never, (node) => {
			if (INLINE_BLOCK.has((node as { type: string }).type)) {
				educatePunctuation(node as never);
			}
		});
	};
}

/**
 * 把一块内联内容摊平成字符数组再改写，而不是逐个 text 节点处理。
 * 因为判断引号方向要看**紧邻的字符**，而那个字符可能落在兄弟节点里
 * （`**粗**"引号"` 这种）。摊平之后前后字符自然相邻。
 */
function educatePunctuation(block: unknown) {
	const chars: string[] = [];
	/** 每个位置归属的 text 节点与偏移；不可改写的位置是 null。 */
	const owners: Array<{ node: { value: string }; offset: number } | null> = [];

	/**
	 * 占位符：既不是「字」也不是引号，也不是空白。
	 * 它有两处用途，共用同一个字符：
	 *   - 行内代码、图片这类**不可改写**的内容，整块压成一个占位符
	 *   - `**粗体**`、`[链接](x)` 这类**透明容器**的两侧边界
	 *
	 * 第二处是关键。`a"**b**` 在源码里 `"` 后面紧跟的是 `*`（标点），
	 * 但摊平之后会变成 `b`（字），引号方向就判反了。
	 * satteri 是在带标记的文本上做标点教育的，这里必须把标记补回来。
	 */
	const pushPlaceholder = () => {
		chars.push('\u0000');
		owners.push(null);
	};

	const collect = (node: unknown, isRoot = false) => {
		const n = node as { type: string; value?: string; children?: unknown[] };

		if (n.type === 'text') {
			const value = n.value ?? '';
			for (let i = 0; i < value.length; i++) {
				chars.push(value[i]);
				owners.push({ node: n as { value: string }, offset: i });
			}
			return;
		}
		if (OPAQUE_INLINE.has(n.type)) {
			pushPlaceholder();
			return;
		}
		if (!Array.isArray(n.children)) return;

		// 块级节点自己不是标记，不该在两端加占位符；只有内联容器才是。
		if (!isRoot) pushPlaceholder();
		for (const child of n.children) collect(child);
		if (!isRoot) pushPlaceholder();
	};

	collect(block, true);

	const len = chars.length;
	const at = (i: number) => (i >= 0 && i < len ? chars[i] : '');

	// 先定下每个引号的最终形态，再统一发射 —— 单引号要靠后面的上下文才能定
	// （见下面 slot 的说明），边扫边写是不行的。
	const repl = chars.slice();

	educateDoubleQuotes(chars, repl, at);
	educateSingleQuotes(chars, repl, at);

	// 发射：引号取 repl，连字符与省略号要成串处理，其余原样。
	const out: string[] = [];
	const outOrigin: number[] = [];
	const emit = (text: string, origin: number) => {
		for (const ch of text) {
			out.push(ch);
			outOrigin.push(origin);
		}
	};

	/**
	 * 从 i 起、与 chars[i] 同属一个 text 节点的连续重复字符有多长。
	 * 比较的是 `.node` 而不是 owner 本身 —— 每个字符的 owner 都是新建的对象，
	 * 比对象身份会永远不相等，整串就永远不会被当成一串。
	 */
	const runLength = (i: number, ch: string) => {
		const node = owners[i]?.node;
		let n = 1;
		while (i + n < len && chars[i + n] === ch && owners[i + n]?.node === node) n++;
		return n;
	};

	for (let i = 0; i < len; ) {
		const ch = chars[i];

		if (ch === '-' && repl[i] === ch) {
			const n = runLength(i, '-');
			emit(convertDashRun(n), i);
			i += n;
			continue;
		}
		// 省略号贪心左到右：每满三个点换一个 `…`，不足三个的原样留下。
		// `a....b` → `a….b`、`a......b` → `a……b`，与 satteri 一致。
		if (ch === '.' && repl[i] === ch) {
			const n = runLength(i, '.');
			if (n >= 3) {
				emit(ELLIPSIS.repeat(Math.floor(n / 3)) + '.'.repeat(n % 3), i);
				i += n;
				continue;
			}
		}

		emit(repl[i], i);
		i++;
	}

	// 按 text 节点归并写回。一个连字符串的产物全部记在它的**起始位置**名下，
	// 所以按「产物来源落在哪个节点的区间内」分组即可。
	const rebuilt = new Map<{ value: string }, string[]>();
	const append = (node: { value: string }, text: string) => {
		let buffer = rebuilt.get(node);
		if (!buffer) {
			buffer = [];
			rebuilt.set(node, buffer);
		}
		buffer.push(text);
	};

	for (let k = 0; k < out.length; k++) {
		const owner = owners[outOrigin[k]];
		if (owner) append(owner.node, out[k]);
	}
	for (const [node, parts] of rebuilt) {
		node.value = parts.join('');
	}
}

/**
 * 双引号消歧。规则（按顺序判定）：
 *
 *   1. 前一个字符是数字    → 闭引号（`5"10` 这种英寸写法）
 *   2. 段首或前面是空白    → 开引号
 *   3. 后一个字符是字      → 交替，初始为开引号
 *   4. 后接空白或已到段尾  → 闭引号
 *   5. 后接标点            → 前一个是字则闭，否则交替
 *
 * 第 3、5 条的交替**共用一个状态**，且**每个双引号都翻转**（不只是走交替分支的
 * 那些）。这必须靠状态、不能靠局部上下文：`往往比"感觉自己会了"难得多` 里两个
 * 引号的局部形状完全相同（两侧都是汉字），satteri 给的是「开 + 闭」。
 * 状态**逐块重置**（`比"甲` 与另一段里的 `比"乙` 都是开引号）。
 *
 * 第 2 条看着多余，其实是最反直觉的一条：` " ` 和 `a" ` 都是「后接空白」，
 * 但前者开、后者闭 —— 差别只在**前一个字符是不是空白**。实测矩阵证实，
 * 「后接空白/段尾」那一列下，前一个字符是字、数字、逗号、点、连字符、括号、
 * 句号、冒号时**一律收尾**，只有段首和空白例外。
 */
function educateDoubleQuotes(
	chars: string[],
	repl: string[],
	at: (i: number) => string,
) {
	let nextIsOpening = true;

	for (let i = 0; i < chars.length; i++) {
		if (chars[i] !== '"') continue;

		const prev = at(i - 1);
		const next = at(i + 1);

		if (DIGIT_CHAR.test(prev)) {
			repl[i] = CLOSE_DOUBLE_QUOTE;
		} else if (prev === '' || isSpace(prev)) {
			repl[i] = OPEN_DOUBLE_QUOTE;
		} else if (WORD_CHAR.test(next)) {
			repl[i] = nextIsOpening ? OPEN_DOUBLE_QUOTE : CLOSE_DOUBLE_QUOTE;
		} else if (next === '' || isSpace(next)) {
			repl[i] = CLOSE_DOUBLE_QUOTE;
		} else if (WORD_CHAR.test(prev)) {
			repl[i] = CLOSE_DOUBLE_QUOTE;
		} else {
			repl[i] = nextIsOpening ? OPEN_DOUBLE_QUOTE : CLOSE_DOUBLE_QUOTE;
		}

		// 每个双引号都翻转，不只是走了交替分支的那些。
		nextIsOpening = !nextIsOpening;
	}
}

/**
 * 单引号消歧。这个规则比双引号绕得多，靠一个**唯一槽位**实现：
 *
 *   - 待闭合的开引号同时只允许有一个，记为 `slot`
 *   - 遇到「后面不是字」的 `'`，它能当闭合：槽位里有货就把它升格成 `‘`
 *     并清空槽位；槽位是空的、且后面紧跟着另一个 `'`，说明这是 `''` 这种
 *     空引用，它自己转成开引号占住槽位
 *   - 遇到「后面是字」的 `'`，若前一个字符不是字，它可以当开引号：
 *     **顶替**掉槽位里那个（被顶替的降级回 `’`）
 *   - 扫完时槽位里若还剩一个，它就是没被闭合的，降级回 `’`
 *
 * 「降级」是这一条的关键 —— 它解释了为什么 `'a` → `’a` 而 `'a'` → `‘a’`：
 * 同样是「前面非字、后面是字」，只有真的等到了闭合才配当开引号。
 * 也解释了 `中'甲'文` → `中’甲’文`（两个 `'` 后面都是汉字，都不是闭合），
 * 以及 `'a'b` → `’a’b`（第二个 `'` 后面是字，不是闭合，第一个等不到配对）。
 *
 * 已知的两处与 satteri 不一致（都是没人会写的形状，实测记录下来而不是假装没有）：
 *   `(a)'b'`  → satteri `(a)’b’`，这里给 `(a)‘b’`（`(` 与 `)` 未作区分）
 *   `'中'文'中'` → satteri `‘中’文’中’`，这里给 `中’文’中’`
 */
function educateSingleQuotes(
	chars: string[],
	repl: string[],
	at: (i: number) => string,
) {
	/** 待闭合的开引号位置；-1 表示没有。 */
	let slot = -1;

	for (let i = 0; i < chars.length; i++) {
		if (chars[i] !== "'") continue;

		const prev = at(i - 1);
		const next = at(i + 1);

		// 默认按撇号（`’`）写，只有真的配成对才升格 —— 见上面的「降级」。
		repl[i] = CLOSE_SINGLE_QUOTE;

		if (!WORD_CHAR.test(next)) {
			if (slot >= 0) {
				repl[slot] = OPEN_SINGLE_QUOTE;
				slot = -1;
			} else if (next === "'") {
				// `''` / `''''` 这类连续引号串：槽位空的也能自己开一个
				slot = i;
			}
		} else if (prev === '' || !WORD_CHAR.test(prev)) {
			slot = i;
		}
	}
}

/** hast 节点的纯文本。等价于 satteri 的 `ctx.textContent`。 */
function textContent(node: unknown): string {
	const n = node as { value?: unknown; children?: unknown[] };
	let text = typeof n.value === 'string' ? n.value : '';
	if (Array.isArray(n.children)) {
		for (const child of n.children) text += textContent(child);
	}
	return text;
}

/**
 * 渲染一篇 Markdown。这是 `shared/` 对外的唯一入口。
 *
 * 注意它**不返回字数**：阅读时长用的是 `readingStats`（`src/utils/reading.ts`），
 * 那是独立的一块逻辑，由调用方自己组合。塞进来只会让这个文件承担两件事。
 */
export async function renderMarkdown(markdown: string): Promise<RenderResult> {
	const headings: Heading[] = [];

	const file = await unified()
		.use(remarkParse)
		// 与 satteri 的 `features.gfm: true` 对应：表格、删除线、任务列表、自动链接。
		.use(remarkGfm)
		// 与 satteri 的 `features.smartPunctuation: true` 对应。
		// 引号、破折号、省略号都在这一环里自己实现 —— 见文件下方那一大段说明。
		.use(remarkSmartPunctuation)
		// allowDangerousHtml：Astro 默认放行正文里的原始 HTML，这里保持一致。
		.use(remarkRehype, { allowDangerousHtml: true })
		// 顺序与 satteri 的 hastPlugins 一致：先高亮，再打标题 id。
		.use(rehypeShikiHighlight)
		.use(rehypeHeadingIds(headings))
		.use(rehypeStringify, { allowDangerousHtml: true })
		.process(markdown);

	const html = String(file);

	// satteri 产出的 HTML 每个块都以 \n 结尾，所以非空输出末尾也有一个 \n；
	// 而 rehype-stringify 只在块**之间**放 \n，末尾没有。差的就是这一个字节。
	// 空输入 satteri 给的是空串（不是 "\n"），所以要分支。
	return { html: html === '' ? '' : `${html}\n`, headings };
}

/**
 * `src/domain/post-input.ts` 的校验器。
 *
 * 每条规则都对应一个**不报错**的失效模式，所以每条都在这里钉一遍：
 * 校验漏了的后果不是异常，而是某个字段在某个时刻悄悄不对，
 * 或者一句看不懂的 SQLite 报错顶替掉一句人话。
 */

import { describe, expect, it } from 'vitest';

import {
	MAX_CONTENT_LENGTH,
	MAX_DESCRIPTION_LENGTH,
	MAX_HEADINGS,
	MAX_TAG_LENGTH,
	MAX_TITLE_LENGTH,
	validatePostInput,
} from '../src/domain/post-input';

/** 一份能通过的最小输入，各测试按需覆盖字段。 */
function valid(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		slug: 'hello-world',
		title: '标题',
		description: '摘要',
		pubDateRaw: '2026-09-20',
		updatedDateRaw: null,
		heroImage: null,
		draft: false,
		body: '# 标题\n\n正文。\n',
		bodyHtml: '<h1>标题</h1>\n<p>正文。</p>',
		headingsJson: '[{"depth":1,"slug":"标题","text":"标题"}]',
		words: 10,
		minutes: 1,
		tags: ['随笔'],
		categories: [],
		...overrides,
	};
}

/** 断言失败，并返回 status 与 message，便于逐条断言原因。 */
function expectFail(input: unknown, status: number): string {
	const result = validatePostInput(input);
	expect(result.ok).toBe(false);
	if (result.ok) throw new Error('应当失败');
	expect(result.status).toBe(status);
	return result.message;
}

describe('整体', () => {
	it('非对象一律 400', () => {
		for (const raw of [null, undefined, 'x', 42, [], true]) {
			expectFail(raw, 400);
		}
	});

	it('合法输入原样通过，并归一化', () => {
		const result = validatePostInput(valid());
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.slug).toBe('hello-world');
		expect(result.value.tags).toEqual(['随笔']);
	});
});

describe('slug', () => {
	it('拒绝空、缺、非字符串', () => {
		expectFail(valid({ slug: '' }), 400);
		expectFail(valid({ slug: undefined }), 400);
		expectFail(valid({ slug: 1 }), 400);
	});

	it('拒绝大写、下划线、空格、连续连字符、首尾连字符', () => {
		// 不校验的后果：URL 里出现需要百分号编码的字符，而
		// `src/pages/posts/[...slug].astro` 的前提是「params 已经是解码后的」。
		// 那个前提失效时页面不是 404，是**错的文章**。
		for (const slug of ['Hello', 'a_b', 'a b', 'a--b', '-a', 'a-', '中文', 'a/b', 'a.b']) {
			expectFail(valid({ slug }), 400);
		}
	});

	it('接受单个连字符分隔的小写字母数字', () => {
		for (const slug of ['a', 'abc', 'a1', '1a', 'hello-world', 'a-b-c-1']) {
			const result = validatePostInput(valid({ slug }));
			expect(result.ok, slug).toBe(true);
		}
	});

	it('拒绝超过 120 字符', () => {
		expectFail(valid({ slug: 'a'.repeat(121) }), 400);
		expect(validatePostInput(valid({ slug: 'a'.repeat(120) })).ok).toBe(true);
	});
});

describe('标题与摘要', () => {
	it('标题不能空，但要 trim 后再判', () => {
		expectFail(valid({ title: '   ' }), 400);
		expectFail(valid({ title: '' }), 400);
		const result = validatePostInput(valid({ title: '  两边有空格  ' }));
		expect(result.ok && result.value.title).toBe('两边有空格');
	});

	it('标题超长', () => {
		expectFail(valid({ title: 'x'.repeat(MAX_TITLE_LENGTH + 1) }), 400);
	});

	it('摘要可以空（只有类型和长度限制）', () => {
		expect(validatePostInput(valid({ description: '' })).ok).toBe(true);
		expectFail(valid({ description: 'x'.repeat(MAX_DESCRIPTION_LENGTH + 1) }), 400);
		expectFail(valid({ description: 1 }), 400);
	});
});

describe('日期', () => {
	it('拒绝 2026-02-31', () => {
		// 只检查 `\d{4}-\d{2}-\d{2}` 是不够的。`Date.parse` 对 02-31 是
		// **宽容**的（返回 3 月 3 日），所以它会一路存进去，表现为
		// "这篇文章的日期自己变了"。
		const message = expectFail(valid({ pubDateRaw: '2026-02-31' }), 400);
		expect(message).toContain('2026-02-31');
	});

	it('拒绝形状不对的发布日期', () => {
		for (const raw of ['', '2026-9-20', '2026/09/20', 'x']) {
			expectFail(valid({ pubDateRaw: raw }), 400);
		}
	});

	it('updatedDateRaw 可空，给了就要合法', () => {
		expect(validatePostInput(valid({ updatedDateRaw: null })).ok).toBe(true);
		expect(validatePostInput(valid({ updatedDateRaw: undefined })).ok).toBe(true);
		expect(validatePostInput(valid({ updatedDateRaw: '2026-10-01' })).ok).toBe(true);
		expectFail(valid({ updatedDateRaw: '2026-02-31' }), 400);
	});
});

describe('封面图', () => {
	it('空串当成 null', () => {
		const result = validatePostInput(valid({ heroImage: '' }));
		expect(result.ok && result.value.heroImage).toBeNull();
	});

	it('超长被拒', () => {
		expectFail(valid({ heroImage: 'x'.repeat(501) }), 400);
	});

	it('可以带中文路径（不是 URL 校验）', () => {
		// 它是**仓库里的相对路径原文**（如 '../../assets/x.jpg'），
		// 不是 URL。将来 R2 的绝对地址也走这里。
		expect(validatePostInput(valid({ heroImage: '../../assets/封面.jpg' })).ok).toBe(true);
	});
});

describe('draft', () => {
	it('必须是布尔值，不接受 0/1/"true"', () => {
		// 接受 `1` 的话，`draft ? 1 : 0` 在写层和校验层会各有一套真值规则，
		// 而它们对 `"false"` 的判断相反——那是一个"草稿突然发布了"的 bug。
		expectFail(valid({ draft: 0 }), 400);
		expectFail(valid({ draft: 1 }), 400);
		expectFail(valid({ draft: 'false' }), 400);
		expectFail(valid({ draft: undefined }), 400);
	});
});

describe('正文', () => {
	it('不能为空', () => {
		expectFail(valid({ body: '' }), 400);
	});

	it('拒绝含 \\r 的正文', () => {
		// ⚠️ 这一条**不可能在浏览器里被发现**：正文是经由 HTML 属性
		// （data-post）传下来的，而 HTML 输入流预处理器会把 \r\n 与 \r
		// 规范化成 \n。所以带 CR 的正文到了前端就是 LF，保存回去也看不出来
		// ——直到拿库里的 body 和原始文件逐字节比对，发现少了几个字节，
		// 而两边的肉眼渲染完全一样。
		const message = expectFail(valid({ body: 'a\r\nb' }), 400);
		expect(message).toContain('\\r');
		expectFail(valid({ body: 'a\rb' }), 400);
	});

	it('单独的 \\n 不受影响', () => {
		expect(validatePostInput(valid({ body: 'a\nb\n' })).ok).toBe(true);
	});

	it('缺 bodyHtml 被拒', () => {
		expectFail(valid({ bodyHtml: undefined }), 400);
	});

	it('bodyHtml 里有 <script> / <iframe> 被拒', () => {
		// ⚠️ 这是**护栏，不是安全边界**：`shared/markdown.ts` 开着
		// allowDangerousHtml（601 与 605 两处），所以正文里合法的原始 HTML
		// 会原样穿过管线——这条检查**有正常的误报可能**。
		// 它挡的是"会话被盗后往正文里塞脚本、从而对所有读者生效"。
		expectFail(valid({ bodyHtml: '<p>x</p><script>alert(1)</script>' }), 400);
		expectFail(valid({ bodyHtml: '<p>x</p><SCRIPT >alert(1)</SCRIPT>' }), 400);
		expectFail(valid({ bodyHtml: '<iframe src="//evil"></iframe>' }), 400);
		expectFail(valid({ bodyHtml: '<p>x</p><  iframe src=x>' }), 400);
	});

	it('正文合计超长 → 413，不是 400', () => {
		// 状态码不同是有意的：413 说的是"内容太大"，客户端据此提示用户
		// 拆成两篇；400 会被读成"格式错了"。
		const message = expectFail(
			valid({ body: 'x'.repeat(MAX_CONTENT_LENGTH), bodyHtml: 'y'.repeat(1) }),
			413,
		);
		expect(message).toContain(String(MAX_CONTENT_LENGTH));
	});
});

describe('缓存列', () => {
	it('words 必须是非负有限数', () => {
		expectFail(valid({ words: -1 }), 400);
		expectFail(valid({ words: Number.NaN }), 400);
		expectFail(valid({ words: Number.POSITIVE_INFINITY }), 400);
		expectFail(valid({ words: '10' }), 400);
		expect(validatePostInput(valid({ words: 0 })).ok).toBe(true);
	});

	it('minutes 必须是 ≥1 的整数', () => {
		expectFail(valid({ minutes: 0 }), 400);
		expectFail(valid({ minutes: 1.5 }), 400);
		expectFail(valid({ minutes: 100_001 }), 400);
		expect(validatePostInput(valid({ minutes: 1 })).ok).toBe(true);
	});
});

describe('headingsJson', () => {
	it('缺省时补成空数组', () => {
		const result = validatePostInput(valid({ headingsJson: undefined }));
		expect(result.ok && result.value.headingsJson).toBe('[]');
	});

	it('拒绝坏 JSON / 非数组', () => {
		expectFail(valid({ headingsJson: '{' }), 400);
		expectFail(valid({ headingsJson: '{"a":1}' }), 400);
		expectFail(valid({ headingsJson: 1 }), 400);
	});

	it('depth 必须在 1–6', () => {
		// 越界的 depth 会让 TableOfContents 渲染出 h7 之类的标签，
		// 或者把层级算错——页面看着没问题，只是目录结构是错的。
		const heading = (depth: number) =>
			`[{"depth":${depth},"slug":"s","text":"t"}]`;
		expectFail(valid({ headingsJson: heading(0) }), 400);
		expectFail(valid({ headingsJson: heading(7) }), 400);
		expectFail(valid({ headingsJson: heading(1.5) }), 400);
		expect(validatePostInput(valid({ headingsJson: heading(1) })).ok).toBe(true);
		expect(validatePostInput(valid({ headingsJson: heading(6) })).ok).toBe(true);
	});

	it('缺 slug / text 被拒', () => {
		expectFail(valid({ headingsJson: '[{"depth":1,"text":"t"}]' }), 400);
		expectFail(valid({ headingsJson: '[{"depth":1,"slug":"","text":"t"}]' }), 400);
		expectFail(valid({ headingsJson: '[{"depth":1,"slug":"s"}]' }), 400);
		expectFail(valid({ headingsJson: '["不是对象"]' }), 400);
	});

	it('项目数超过上限被拒', () => {
		const many = JSON.stringify(
			Array.from({ length: MAX_HEADINGS + 1 }, () => ({ depth: 2, slug: 's', text: 't' })),
		);
		expectFail(valid({ headingsJson: many }), 400);
	});
});

describe('标签', () => {
	it('缺省当空数组', () => {
		const result = validatePostInput(valid({ tags: undefined }));
		expect(result.ok && result.value.tags).toEqual([]);
	});

	it('trim、丢重复、保留顺序', () => {
		const result = validatePostInput(valid({ tags: ['  甲 ', '乙', '甲'] }));
		expect(result.ok && result.value.tags).toEqual(['甲', '乙']);
	});

	it('拒绝空项、非字符串项、超长项', () => {
		expectFail(valid({ tags: [''] }), 400);
		expectFail(valid({ tags: ['   '] }), 400);
		expectFail(valid({ tags: [1] }), 400);
		expectFail(valid({ tags: ['x'.repeat(MAX_TAG_LENGTH + 1)] }), 400);
	});

	it('超过 20 个被拒', () => {
		expectFail(valid({ tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }), 400);
	});

	it('不是数组被拒', () => {
		expectFail(valid({ tags: '话题' }), 400);
	});

	it('输入内部的两个标签撞到同一个 URL 片段 → 409，不是 400', () => {
		// 'Hello World' 与 'hello-world' 规范化后是同一个 segment。
		// 不预检的后果：撞的是 tags.segment 的 UNIQUE 约束，报出来是
		// 一句「UNIQUE constraint failed: tags.segment」，看不出和标签有关、
		// 也看不出是哪两个标签。
		const message = expectFail(valid({ tags: ['Hello World', 'hello-world'] }), 409);
		expect(message).toContain('Hello World');
		expect(message).toContain('hello-world');
	});

	it('同一个标签写两遍不算冲突（去重在前）', () => {
		expect(validatePostInput(valid({ tags: ['随笔', '随笔'] })).ok).toBe(true);
	});
});

describe('categories', () => {
	it('与标签同一套规则', () => {
		expectFail(valid({ categories: [''] }), 400);
		expectFail(valid({ categories: [1] }), 400);
		expect(validatePostInput(valid({ categories: ['技术'] })).ok).toBe(true);
	});
});

describe('校验器是纯函数', () => {
	it('不改动传入的对象', () => {
		// 就地 trim 的话，调用方手里那份和校验后那份会不一致，
		// 而"接口存的和校验的不是同一份"是最难查的一类偏差。
		const input = valid({ title: '  有空格  ', tags: [' 甲 '] });
		const snapshot = structuredClone(input);
		validatePostInput(input);
		expect(input).toEqual(snapshot);
	});

	it('同一份输入调用两次结果相同', () => {
		const input = valid();
		const a = validatePostInput(input);
		const b = validatePostInput(input);
		expect(a).toEqual(b);
	});
});

import { describe, it, expect } from 'vitest';

import {
	postYear,
	postMonth,
	postDay,
	postNeighbours,
	groupByYear,
	groupByYearMonth,
	collectTags,
	readingStats,
	tagSlug,
	tagParam,
	tagUrl,
	type Post,
} from '../src/utils/posts';
import { tagSegment } from '../src/utils/tag-segment';

/**
 * 造一个只带被测字段的假 Post。
 * 这些函数只读 post.id 和 post.data，不需要真的内容集合。
 */
function mk(id: string, iso: string, tags: string[] = []): Post {
	return { id, data: { pubDate: new Date(iso), tags } } as unknown as Post;
}

// ─────────────────────────────────────────────────────────────
// 日期：Asia/Shanghai 是承重的不变量
//
// 这三段 Intl.DateTimeFormat 的注释里各写了一个具体的出错场景，
// 下面把它们变成可执行的断言。共同点是：**UTC 日历时区不同**，
// 所以任何用 getFullYear()/getMonth()/getDate() 的实现都会挂。
// ─────────────────────────────────────────────────────────────
describe('日期分组固定用 Asia/Shanghai', () => {
	it('跨年边界按上海算：UTC 还在去年，上海已经跨年', () => {
		// UTC 是 2025-12-31 16:30，上海是 2026-01-01 00:30
		const post = mk('boundary', '2025-12-31T16:30:00Z');

		expect(postYear(post)).toBe(2026);
		expect(postMonth(post)).toBe(1);
		expect(postDay(post)).toBe(1);

		// 对照：这正是不能用的那几个方法会给出的答案。
		// 用 getUTCFullYear() 的话，侧栏会把这篇文章放到 2025 年，
		// 而正文里的 FormattedDate 显示 2026 年——两处对不上。
		const raw = new Date('2025-12-31T16:30:00Z');
		expect(raw.getUTCFullYear()).toBe(2025);
		expect(raw.getUTCMonth() + 1).toBe(12);
		expect(raw.getUTCDate()).toBe(31);
	});

	it('同一天里、上海时区相邻的两小时会落到不同的年/月', () => {
		// 两个时刻在 UTC 下只差一小时，在 +08:00 下却跨了年
		const late = mk('late', '2025-12-31T15:30:00Z'); // 上海 2025-12-31 23:30
		expect(postYear(late)).toBe(2025);
		expect(postMonth(late)).toBe(12);
		expect(postDay(late)).toBe(31);
	});

	it('普通日期不受影响', () => {
		const d = mk('normal', '2026-09-20T00:00:00Z');
		expect(postYear(d)).toBe(2026);
		expect(postMonth(d)).toBe(9);
		expect(postDay(d)).toBe(20);
	});
});

describe('groupByYearMonth', () => {
	it('按上海时区判年+月，UTC 的同一天会被拆到两个组里', () => {
		// 入参必须已按时间倒序（getPublishedPosts 的返回值即是）
		const posts = [
			mk('a', '2025-12-31T16:30:00Z'), // 上海 2026-01-01
			mk('b', '2025-12-31T15:30:00Z'), // 上海 2025-12-31
		];

		const groups = groupByYearMonth(posts);

		expect(groups.map((g) => g.year)).toEqual([2026, 2025]);
		expect(groups[0].months.map((m) => m.month)).toEqual([1]);
		expect(groups[1].months.map((m) => m.month)).toEqual([12]);

		// count 是模板里直接用的，别让它在两边算得不一样
		expect(groups.map((g) => g.count)).toEqual([1, 1]);
	});

	it('同年多个月份按月倒序，组内保持传入顺序', () => {
		const posts = [
			mk('c', '2026-03-10T00:00:00Z'),
			mk('b', '2026-03-09T00:00:00Z'),
			mk('a', '2026-01-05T00:00:00Z'),
		];

		const groups = groupByYearMonth(posts);

		expect(groups).toHaveLength(1);
		expect(groups[0].year).toBe(2026);
		expect(groups[0].count).toBe(3);
		expect(groups[0].months.map((m) => m.month)).toEqual([3, 1]);
		expect(groups[0].months[0].posts.map((p) => p.id)).toEqual(['c', 'b']);
		expect(groups[0].months[1].posts.map((p) => p.id)).toEqual(['a']);
	});

	it('空入参不炸', () => {
		expect(groupByYearMonth([])).toEqual([]);
	});
});

describe('groupByYear / postNeighbours', () => {
	it('groupByYear 按年倒序分桶', () => {
		const posts = [mk('a', '2026-05-01T00:00:00Z'), mk('b', '2024-01-01T00:00:00Z')];
		expect(groupByYear(posts).map((g) => g.year)).toEqual([2026, 2024]);
	});

	it('相邻文章完全由传入顺序决定（更早/更新不能排反）', () => {
		const posts = [
			mk('newest', '2026-03-01T00:00:00Z'),
			mk('middle', '2026-02-01T00:00:00Z'),
			mk('oldest', '2026-01-01T00:00:00Z'),
		];

		const { newer, older } = postNeighbours(posts, 'middle');
		expect(newer?.id).toBe('newest');
		expect(older?.id).toBe('oldest');
	});

	it('首尾两端各缺一个邻居', () => {
		const posts = [mk('a', '2026-02-01T00:00:00Z'), mk('b', '2026-01-01T00:00:00Z')];
		expect(postNeighbours(posts, 'a').newer).toBeUndefined();
		expect(postNeighbours(posts, 'a').older?.id).toBe('b');
		expect(postNeighbours(posts, 'b').older).toBeUndefined();
		expect(postNeighbours(posts, 'b').newer?.id).toBe('a');
	});

	it('找不到 id 时返回空对象，而不是错位的邻居', () => {
		expect(postNeighbours([mk('a', '2026-01-01T00:00:00Z')], 'nope')).toEqual({});
	});
});

// ─────────────────────────────────────────────────────────────
// 标签：URL 片段规则
//
// encodeURIComponent 之后仍然 404 是最难查的一类问题，
// 因为它只在「链接生成处」和「路由匹配处」用了不同规则时才出现。
// ─────────────────────────────────────────────────────────────
describe('标签 URL 片段', () => {
	it('小写 + 空格转连字符（href 与 param 共用同一套规则）', () => {
		expect(tagParam('Hello World')).toBe('hello-world');
		expect(tagSlug('Hello World')).toBe('hello-world');
		expect(tagUrl('Hello World')).toBe('/tags/hello-world/');
	});

	it('连续空白折叠成**一个**连字符（用的是 \\s+ 不是 \\s）', () => {
		expect(tagSegment('a  b')).toBe('a-b');
		expect(tagSegment('  a \t b  ')).toBe('a-b');
	});

	it('中文标签：param 不编码，href 编码 —— 两者必须不同', () => {
		// Astro 拿到 params 后会先解码再匹配路由，所以 param 必须是原文。
		// 传编码过的值不会静默错配，而是直接构建失败：
		//   NoMatchingStaticPathFound: no matching static path for `/tags/前端/`
		expect(tagParam('前端')).toBe('前端');
		expect(tagSlug('前端')).toBe(encodeURIComponent('前端'));
		expect(tagUrl('前端')).toBe('/tags/%E5%89%8D%E7%AB%AF/');
	});

	it('href 用的 slug 里不会出现斜杠（否则会把路由切多一段）', () => {
		for (const tag of ['a/b', 'C++ / Rust', '../etc/passwd', 'a b/c d']) {
			expect(tagSlug(tag)).not.toContain('/');
		}
	});

	// 记录现状，不是断言它"对"。tagParam 不编码是刻意的（Astro 拿到 params 后
	// 会先解码再匹配路由），代价是含斜杠的标签会生成多一层路径。
	// 真实数据里不会有这种标签：数据库的 tags.segment 有唯一约束，
	// 而且这种标签本身也没有意义。将来若要收紧，改的是 tagSegment。
	it('已知边界：含斜杠的标签，param 不编码而会多切一层路径', () => {
		expect(tagParam('a/b')).toBe('a/b');
		expect(tagSlug('a/b')).toBe('a%2Fb');
	});

	// 这条是防漂移用的。tagSegment 原本是 posts.ts 的私有函数，
	// 现在抽成了独立模块，导入脚本要靠它填数据库的 tags.segment 列。
	// 一旦两边对不上，表现是「标签页 404，但列表页看起来完全正常」。
	it('tagParam 与脚本共用的 tagSegment 必须完全一致', () => {
		for (const tag of ['Hello World', '前端', 'a  b', 'CSS 布局', 'C++']) {
			expect(tagParam(tag)).toBe(tagSegment(tag));
		}
	});
});

describe('collectTags', () => {
	it('按数量倒序；同数量时顺序必须稳定（保证构建可复现）', () => {
		const posts = [
			mk('a', '2026-03-01T00:00:00Z', ['前端', 'Astro']),
			mk('b', '2026-02-01T00:00:00Z', ['前端']),
			mk('c', '2026-01-01T00:00:00Z', ['Astro']),
		];

		const tags = collectTags(posts);

		// 数量倒序是硬契约
		expect(tags.map((t) => t.count)).toEqual([2, 2]);
		expect(new Set(tags.map((t) => t.tag))).toEqual(new Set(['Astro', '前端']));

		// 同数量时的**具体顺序**由 localeCompare(…, 'zh-CN') 决定，而它的结果
		// 依赖运行时的 ICU 数据版本（Node 与 workerd 不一定一致）。
		// 所以这里断言的是「稳定」，而不是某个写死的顺序——
		// 真正要防的是「每次构建标签顺序都在跳」，那会让 diff 一直抖。
		expect(collectTags(posts).map((t) => t.tag)).toEqual(tags.map((t) => t.tag));

		// href 用 slug，getStaticPaths 用 param，两个字段都要在且不能相等
		const frontend = tags.find((t) => t.tag === '前端');
		expect(frontend?.slug).toBe(encodeURIComponent('前端'));
		expect(frontend?.param).toBe('前端');
	});

	it('忽略空白标签，并 trim 后再去重', () => {
		const posts = [mk('a', '2026-01-01T00:00:00Z', ['  前端  ', '', '   ', '前端'])];
		const tags = collectTags(posts);

		expect(tags).toHaveLength(1);
		expect(tags[0].tag).toBe('前端');
		expect(tags[0].count).toBe(2);
	});

	it('没有标签时返回空数组', () => {
		expect(collectTags([mk('a', '2026-01-01T00:00:00Z')])).toEqual([]);
	});
});

describe('readingStats', () => {
	it('中文按字计，西文按词计', () => {
		expect(readingStats('你好世界').words).toBe(4);
		expect(readingStats('hello world foo').words).toBe(3);
		expect(readingStats('你好 hello 世界').words).toBe(5);
	});

	it('代码块整段剔除（读代码的时间不算进读文章的时间）', () => {
		const withCode = '```js\nconst a = 1;\nconst b = 2;\n```\n\n你好世界';
		expect(readingStats(withCode).words).toBe(4);

		// 整篇只有代码时字数为 0，但分钟数仍有下限 1
		expect(readingStats('```\nfoo bar baz\n```')).toEqual({ words: 0, minutes: 1 });
	});

	it('行内码、链接与图片不计入', () => {
		expect(readingStats('`inline code here`').words).toBe(0);
		expect(readingStats('[链接文字](https://example.com)').words).toBe(0);
		expect(readingStats('![图](https://example.com/a.png)').words).toBe(0);
	});

	it('标题标记与 Markdown 符号不被当成正文', () => {
		expect(readingStats('## 标题').words).toBe(2);
		expect(readingStats('# ## ###').words).toBe(0);
	});

	it('分钟数最少为 1，并与字数成比例', () => {
		expect(readingStats('').minutes).toBe(1);
		// 400 字/分钟
		expect(readingStats('字'.repeat(800)).minutes).toBe(2);
		expect(readingStats('字'.repeat(2000)).minutes).toBe(5);
	});

	it('body 为 undefined（草稿没有正文）时返回零值而不是 NaN', () => {
		expect(readingStats(undefined)).toEqual({ words: 0, minutes: 1 });
	});
});

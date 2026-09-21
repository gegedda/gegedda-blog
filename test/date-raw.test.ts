/**
 * `src/utils/date-raw.ts`。
 *
 * 这个模块是 P5 从 `scripts/lib/frontmatter.mjs` 里搬出来的（Worker 代码
 * 不能引 devDependency，而 `js-yaml` 是 devDependency）。搬完之后
 * `frontmatter.mjs` 只是把它 re-export 出去——**脚本侧不另写一份实现**。
 * 最后那一组测试就是钉这条的栅栏。
 */

import { describe, expect, it } from 'vitest';

import { dateRawToUtc, isValidDateRaw, todayDateRaw } from '../src/utils/date-raw';
import { dateRawToUtc as fromScripts } from '../scripts/lib/frontmatter.mjs';

describe('dateRawToUtc', () => {
	it('日期串按 UTC 零点解析', () => {
		expect(dateRawToUtc('2026-09-20')).toBe(Date.UTC(2026, 8, 20));
	});

	it('Date 对象直接取 ISO', () => {
		expect(dateRawToUtc(new Date('2026-09-20T00:00:00Z'))).toBe(Date.UTC(2026, 8, 20));
	});

	it('无法解析的字符串抛错，而不是返回 NaN', () => {
		// 返回 NaN 的话，它插进 INTEGER 列会变成 NULL——
		// 表现是"这篇文章莫名其妙排到最后"，没有任何报错。
		expect(() => dateRawToUtc('昨天')).toThrow();
		expect(() => dateRawToUtc('')).toThrow();
	});

	it('非字符串非 Date 抛错', () => {
		expect(() => dateRawToUtc(20260920 as never)).toThrow();
		expect(() => dateRawToUtc(null as never)).toThrow();
	});
});

describe('isValidDateRaw', () => {
	it('接受正常日期', () => {
		expect(isValidDateRaw('2026-09-20')).toBe(true);
		expect(isValidDateRaw('2024-02-29')).toBe(true); // 闰年
	});

	it('拒绝 2026-02-31（Date.parse 对它是宽容的）', () => {
		// 这是这个函数存在的全部理由。`Date.parse('2026-02-31')` 返回
		// 3 月 3 日而不是 NaN，所以 `dateRawToUtc` 那层的 NaN 检查拦不住它。
		expect(isValidDateRaw('2026-02-31')).toBe(false);
		expect(Number.isNaN(Date.parse('2026-02-31'))).toBe(false); // 前提本身
	});

	it('拒绝非闰年的 2 月 29 日', () => {
		expect(isValidDateRaw('2025-02-29')).toBe(false);
	});

	it('拒绝月份/日期越界', () => {
		expect(isValidDateRaw('2026-13-01')).toBe(false);
		expect(isValidDateRaw('2026-00-10')).toBe(false);
		expect(isValidDateRaw('2026-04-31')).toBe(false);
		expect(isValidDateRaw('2026-01-00')).toBe(false);
	});

	it('拒绝形状不对的输入', () => {
		for (const raw of ['2026-9-20', '26-09-20', '2026/09/20', '', '2026-09-20T00:00:00Z']) {
			expect(isValidDateRaw(raw), raw).toBe(false);
		}
	});
});

describe('todayDateRaw', () => {
	it('用上海时区，不是 UTC', () => {
		// UTC 0 点，上海已经是当天早上 8 点 → 同一个日子
		expect(todayDateRaw(new Date('2026-09-20T00:00:00Z'))).toBe('2026-09-20');

		// UTC 16:00 = 上海次日 00:00。这一条是关键：
		// `new Date().toISOString().slice(0,10)` 在这时会给出 09-20，
		// 也就是把"今天写的文章"标成昨天——而且只在上海的凌晨复现。
		expect(todayDateRaw(new Date('2026-09-20T16:00:00Z'))).toBe('2026-09-21');
	});

	it('格式是 en-CA 的 YYYY-MM-DD', () => {
		expect(todayDateRaw(new Date('2026-01-05T12:00:00Z'))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});
});

describe('不许在脚本里重新实现一遍', () => {
	it('scripts/lib/frontmatter.mjs 的 dateRawToUtc 是同一个函数', () => {
		// 搬走实现之后这条断言退化成恒等，这是**预期**的：它的价值不在于
		// 此刻能发现什么，而在于有人将来在 frontmatter.mjs 里另写一份
		// 时立刻变红。脚本侧和 Worker 侧对同一个日期串必须给出同一个数，
		// 否则排序会和显示对不上，而且只在某一条路径上复现。
		expect(fromScripts).toBe(dateRawToUtc);
	});
});

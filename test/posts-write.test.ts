/**
 * 写层（`src/data/posts.write.ts`）跑在真的 SQLite 上。
 *
 * 这里盯的全是**半写状态**——一次发布涉及十几条写语句，分成几次调用
 * 就会出现"文章写进去了、标签没写"或"版本号没加（缓存永不失效）"这类状态，
 * 而且**全都不报错**。所以每一条断言都是"库里最终长什么样"，
 * 不看返回值。
 *
 * ⚠️ 本 stub 的 `batch()` 是 BEGIN/COMMIT，D1 的 batch 语义是否完全等价
 * 没有验证过（见 test/stubs/d1.ts 的注释）。所以这里证明的是**写路径的
 * SQL 与顺序正确**，不是"D1 上一定原子"。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TagCollisionError, deletePost, upsertPost } from '../src/data/posts.write';
import { getContentRevision } from '../src/lib/settings';
import type { PostInput } from '../src/domain/post-input';
import { createStubDb, attachTag, type StubDb } from './stubs/d1';

let db: StubDb;

/** 固定时刻，不依赖真实时间。 */
const NOW = 1_800_000_000;

beforeEach(() => {
	db = createStubDb();
});
afterEach(() => {
	db.close();
});

function input(overrides: Partial<PostInput> = {}): PostInput {
	return {
		slug: 'hello-world',
		title: '你好，世界',
		description: '第一篇',
		pubDateRaw: '2026-09-20',
		updatedDateRaw: null,
		heroImage: null,
		draft: false,
		body: '# 你好\n\n正文。\n',
		bodyHtml: '<h1 id="你好">你好</h1>\n<p>正文。</p>',
		headingsJson: '[{"depth":1,"slug":"你好","text":"你好"}]',
		words: 12,
		minutes: 1,
		tags: ['随笔', '技术'],
		categories: [],
		...overrides,
	}
}

/** posts 表的这一行，用来断言"库里到底存了什么"。 */
async function postRow(slug = 'hello-world') {
	return db
		.prepare('SELECT * FROM posts WHERE slug = ?')
		// ⚠️ `.bind(slug)` 不能省。省了的后果不是报错：SQLite 把没有绑定的
		// 参数当作 NULL，于是 `WHERE slug = NULL` 匹配不到任何行，
		// 这个辅助函数静默返回 null —— 每一条断言都会以
		// 「expected undefined to be …」的形式失败，看起来像写层没写进去。
		.bind(slug)
		.first<Record<string, unknown> & { created_at: number; updated_at: number }>();
}

/** 一篇文章的标签，按 position 排序。 */
async function tagNames(slug = 'hello-world'): Promise<string[]> {
	const { results } = await db
		.prepare(
			`SELECT t.name FROM post_tags pt
			 JOIN tags t ON t.id = pt.tag_id
			 WHERE pt.post_slug = ? ORDER BY pt.position`,
		)
		.bind(slug)
		.all<{ name: string }>();
	return (results ?? []).map((r) => r.name);
}

async function revisions(slug = 'hello-world') {
	const { results } = await db
		.prepare('SELECT title, body FROM post_revisions WHERE post_slug = ? ORDER BY id')
		.bind(slug)
		.all<{ title: string; body: string }>();
	return results ?? [];
}

async function countRows(table: string, slug = 'hello-world'): Promise<number> {
	const row = await db
		.prepare(
			table === 'post_tags'
				? 'SELECT COUNT(*) AS n FROM post_tags WHERE post_slug = ?'
				: `SELECT COUNT(*) AS n FROM ${table} WHERE slug = ?`,
		)
		.bind(slug)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

describe('新建', () => {
	it('写进 posts 并返回 created: true', async () => {
		const result = await upsertPost(db, input(), { nowSeconds: NOW });
		expect(result).toEqual({ created: true });

		const row = await postRow();
		expect(row?.title).toBe('你好，世界');
		expect(row?.body).toBe('# 你好\n\n正文。\n');
		expect(row?.pub_date_raw).toBe('2026-09-20');
		expect(row?.draft).toBe(0);
	});

	it('双重日期列：原文逐字存，utc 只用于排序', async () => {
		await upsertPost(db, input(), { nowSeconds: NOW });
		const row = await postRow();
		// 原文逐字存是"F 盘反解出的 Markdown 逐字节一致"的前提
		expect(row?.pub_date_raw).toBe('2026-09-20');
		expect(row?.pub_date_utc).toBe(Date.UTC(2026, 8, 20));
	});

	it('标签按数组顺序写进 post_tags', async () => {
		// TagChips.astro 按 .map() 的顺序渲染，顺序错了是"标签自己换了位置"。
		await upsertPost(db, input({ tags: ['丙', '甲', '乙'] }), { nowSeconds: NOW });
		expect(await tagNames()).toEqual(['丙', '甲', '乙']);
	});

	it('bump 了 content_revision', async () => {
		// 不 bump 的后果是缓存永不失效——「发布后刷新还是旧页面」，不报错。
		const before = await getContentRevision(db);
		await upsertPost(db, input(), { nowSeconds: NOW });
		expect(await getContentRevision(db)).toBe(before + 1);
	});

	it('写了第一条修订', async () => {
		await upsertPost(db, input(), { nowSeconds: NOW });
		expect(await revisions()).toEqual([{ title: '你好，世界', body: '# 你好\n\n正文。\n' }]);
	});
});

describe('更新', () => {
	it('同 slug 二次保存**不产生第二行**', async () => {
		// `INSERT OR REPLACE` 在这里是个陷阱：SQLite 里它等价于 DELETE+INSERT，
		// 会连带触发 post_tags 的 ON DELETE CASCADE，标签被清掉且不报错。
		// 用的是 ON CONFLICT DO UPDATE。
		await upsertPost(db, input(), { nowSeconds: NOW });
		const result = await upsertPost(db, input({ title: '改过的标题' }), { nowSeconds: NOW + 60 });

		expect(result).toEqual({ created: false });
		expect(await countRows('posts')).toBe(1);
		expect((await postRow())?.title).toBe('改过的标题');
	});

	it('**不覆盖 created_at**，但更新 updated_at', async () => {
		await upsertPost(db, input(), { nowSeconds: NOW });
		await upsertPost(db, input({ title: '改了' }), { nowSeconds: NOW + 60 });

		const row = await postRow();
		expect(row?.created_at).toBe(NOW);
		expect(row?.updated_at).toBe(NOW + 60);
	});

	it('删掉一个标签后它**不再**在 post_tags 里', async () => {
		// 只做 `ON CONFLICT DO UPDATE` 的典型后果：那一行不会消失，
		// 表现是「标签删不掉」且不报错。
		await upsertPost(db, input({ tags: ['甲', '乙'] }), { nowSeconds: NOW });
		expect(await tagNames()).toEqual(['甲', '乙']);

		await upsertPost(db, input({ tags: ['甲'] }), { nowSeconds: NOW + 1 });
		expect(await tagNames()).toEqual(['甲']);
	});

	it('标签顺序变了要跟着变', async () => {
		await upsertPost(db, input({ tags: ['甲', '乙'] }), { nowSeconds: NOW });
		await upsertPost(db, input({ tags: ['乙', '甲'] }), { nowSeconds: NOW + 1 });
		expect(await tagNames()).toEqual(['乙', '甲']);
	});

	it('标签清空后 post_tags 一行不剩', async () => {
		await upsertPost(db, input({ tags: ['甲', '乙'] }), { nowSeconds: NOW });
		await upsertPost(db, input({ tags: [] }), { nowSeconds: NOW + 1 });
		expect(await tagNames()).toEqual([]);
	});

	it('正文没变就不写第二条修订', async () => {
		// 反复点保存不该把历史冲掉。
		await upsertPost(db, input(), { nowSeconds: NOW });
		await upsertPost(db, input(), { nowSeconds: NOW + 1 });
		await upsertPost(db, input(), { nowSeconds: NOW + 2 });
		expect(await revisions()).toHaveLength(1);
	});

	it('改了标题**或**正文就写一条', async () => {
		await upsertPost(db, input(), { nowSeconds: NOW });
		await upsertPost(db, input({ title: '改名了' }), { nowSeconds: NOW + 1 });
		expect(await revisions()).toHaveLength(2);

		await upsertPost(db, input({ title: '改名了', body: '新的正文' }), { nowSeconds: NOW + 2 });
		expect(await revisions()).toHaveLength(3);
	});

	it('正文没变但只有其他字段变了，仍然不写修订', async () => {
		// draft / tags / pubDate 的改动不进修订——修订是"内容"的历史，
		// 每次切换草稿都留一条会让真正的历史淹没在噪音里。
		await upsertPost(db, input(), { nowSeconds: NOW });
		await upsertPost(db, input({ draft: true, tags: ['别的'] }), { nowSeconds: NOW + 1 });
		expect(await revisions()).toHaveLength(1);
	});

	it('每次保存都 bump content_revision（哪怕内容没变）', async () => {
		// 内容没变就不 bump 的话，"改了 draft 但没改正文"不会让缓存失效，
		// 于是草稿状态在页面上不生效——而且只在别人已经缓存过那一页时复现。
		const before = await getContentRevision(db);
		await upsertPost(db, input(), { nowSeconds: NOW });
		await upsertPost(db, input(), { nowSeconds: NOW + 1 });
		expect(await getContentRevision(db)).toBe(before + 2);
	});
});

describe('修订的不变量', () => {
	it('最新一条修订的 (title, body) == posts 当前行', async () => {
		// 这条等价于"删除可恢复"：删除时最后一条修订就是被删文章的内容。
		await upsertPost(db, input(), { nowSeconds: NOW });
		await upsertPost(db, input({ title: '第二版', body: '正文二' }), { nowSeconds: NOW + 1 });

		const latest = (await revisions()).at(-1);
		const row = await postRow();
		expect(latest?.title).toBe(row?.title);
		expect(latest?.body).toBe(row?.body);
	});

	it('反复保存后这条不变量仍然成立', async () => {
		for (let i = 0; i < 5; i++) {
			await upsertPost(db, input({ title: `第 ${i} 版` }), { nowSeconds: NOW + i });
		}
		const latest = (await revisions()).at(-1);
		expect(latest?.title).toBe('第 4 版');
		expect(latest?.title).toBe((await postRow())?.title);
	});
});

describe('标签段冲突', () => {
	it('库里已有「Hello World」，这次来「hello-world」→ TagCollisionError', async () => {
		await upsertPost(db, input({ tags: ['Hello World'] }), { nowSeconds: NOW });

		// 不预检的话撞的是 tags.segment 的 UNIQUE 约束，报出来是一句
		// 「UNIQUE constraint failed: tags.segment」，看不出和标签有关，
		// 也看不出是哪两个标签。
		await expect(
			upsertPost(db, input({ slug: 'other', tags: ['hello-world'] }), { nowSeconds: NOW + 1 }),
		).rejects.toBeInstanceOf(TagCollisionError);
	});

	it('**同一个**标签名不算冲突（重复出现是允许的）', async () => {
		await upsertPost(db, input({ tags: ['Hello World'] }), { nowSeconds: NOW });
		await expect(
			upsertPost(db, input({ slug: 'other', tags: ['Hello World'] }), { nowSeconds: NOW + 1 }),
		).resolves.toEqual({ created: true });
	});

	it('冲突时**库里不留半写状态**', async () => {
		// 这是"batch 真的是原子的"这条假设的正面证据：冲突发生在写之前，
		// 所以新文章一行都不该出现。
		await upsertPost(db, input({ tags: ['Hello World'] }), { nowSeconds: NOW });
		const revisionBefore = await getContentRevision(db);

		await expect(
			upsertPost(db, input({ slug: 'other', tags: ['hello-world'] }), { nowSeconds: NOW + 1 }),
		).rejects.toThrow();

		expect(await postRow('other')).toBeNull();
		expect(await countRows('posts', 'other')).toBe(0);
		expect(await getContentRevision(db)).toBe(revisionBefore);
	});

	it('没有标签的文章不查库也不报错', async () => {
		await expect(
			upsertPost(db, input({ tags: [] }), { nowSeconds: NOW }),
		).resolves.toEqual({ created: true });
	});
});

describe('删除', () => {
	it('删得掉时返回 true，并清掉 posts 与 post_tags', async () => {
		await upsertPost(db, input(), { nowSeconds: NOW });
		expect(await deletePost(db, 'hello-world', { nowSeconds: NOW + 1 })).toBe(true);

		expect(await postRow()).toBeNull();
		expect(await tagNames()).toEqual([]);
	});

	it('不存在时返回 false（调用方 404）', async () => {
		expect(await deletePost(db, 'nope', { nowSeconds: NOW })).toBe(false);
	});

	it('**不依赖 ON DELETE CASCADE**：post_tags 是显式删的', async () => {
		// D1 默认是否开启 PRAGMA foreign_keys 在本项目没有验证过。
		// 若没开，级联不触发 → post_tags 留下孤儿行 → 平时看不见
		// （所有读路径都 JOIN posts），但**用同一个 slug 新建文章时
		// 旧标签会自己回来**。
		await upsertPost(db, input({ tags: ['甲', '乙'] }), { nowSeconds: NOW });
		await deletePost(db, 'hello-world', { nowSeconds: NOW + 1 });

		const row = await db
			.prepare('SELECT COUNT(*) AS n FROM post_tags')
			.first<{ n: number }>();
		expect(row?.n).toBe(0);
	});

	it('**修订留下来**（这是"删了还能捞回来"的唯一退路）', async () => {
		// post_revisions 故意没有外键。加上的话，删除会连历史一起带走——
		// 那正是这张表存在的意义的反面。
		//
		// ⚠️ 断言的是**最后一条修订的内容**，不是条数。删除时无条件写一条
		// （见 `deletePost` 的注释），所以这里必然是两条：upsert 那条 + 删除那条。
		// 钉「条数 === 1」就会把"删除也记了一条"这个有意的行为判成失败，
		// 而那不是这条测试要盯的东西。
		await upsertPost(db, input(), { nowSeconds: NOW });
		await deletePost(db, 'hello-world', { nowSeconds: NOW + 1 });

		const latest = (await revisions()).at(-1);
		expect(latest).toEqual({ title: '你好，世界', body: '# 你好\n\n正文。\n' });
	});

	it('删除时**无条件**写一条修订，哪怕内容没变过', async () => {
		// ⚠️ 导入脚本写的文章**没有任何修订**（content-to-sql.mjs 不写这张表）。
		// 若这里也做"内容没变就跳过"的优化，删掉一篇导入的文章就是永久丢失。
		db.exec(
			`INSERT INTO posts (slug, title, description, pub_date_raw, pub_date_utc,
			   updated_date_raw, updated_date_utc, hero_image, draft, body, body_html,
			   headings_json, words, minutes, categories_json, created_at, updated_at)
			 VALUES ('imported', '导入的', '描述', '2026-01-01', 0, NULL, NULL, NULL, 0,
			   '导入的正文', '<p>导入的正文</p>', '[]', 5, 1, '[]', 0, 0)`,
		);
		expect(await revisions('imported')).toHaveLength(0);

		await deletePost(db, 'imported', { nowSeconds: NOW + 1 });
		expect(await revisions('imported')).toEqual([
			{ title: '导入的', body: '导入的正文' },
		]);
	});

	it('bump 了 content_revision', async () => {
		await upsertPost(db, input(), { nowSeconds: NOW });
		const before = await getContentRevision(db);
		await deletePost(db, 'hello-world', { nowSeconds: NOW + 1 });
		expect(await getContentRevision(db)).toBe(before + 1);
	});

	it('不存在的 slug 不 bump', async () => {
		const before = await getContentRevision(db);
		await deletePost(db, 'nope', { nowSeconds: NOW });
		expect(await getContentRevision(db)).toBe(before);
	});

	it('删了再用同一个 slug 新建，旧标签不会自己回来', async () => {
		// 这一条是"显式删 post_tags"的最终收益。留着孤儿行的话，
		// 同名新文章会突然带上几个月前那篇的标签。
		await upsertPost(db, input({ tags: ['旧标签'] }), { nowSeconds: NOW });
		await deletePost(db, 'hello-world', { nowSeconds: NOW + 1 });
		await upsertPost(db, input({ tags: ['新标签'] }), { nowSeconds: NOW + 2 });

		expect(await tagNames()).toEqual(['新标签']);
	});
});

describe('已有标签复用', () => {
	it('另一篇文章用过的标签不会产生第二行 tags', async () => {
		await upsertPost(db, input({ tags: ['共用'] }), { nowSeconds: NOW });
		await upsertPost(db, input({ slug: 'second', tags: ['共用'] }), { nowSeconds: NOW + 1 });

		const row = await db
			.prepare(`SELECT COUNT(*) AS n FROM tags WHERE name = '共用'`)
			.first<{ n: number }>();
		expect(row?.n).toBe(1);
	});

	it('一篇文章里的重复标签只写一条关联（去重在前）', async () => {
		// validatePostInput 会先去重；这里再挡一次是因为写层是公开的
		// 导出函数，不能假设调用方一定走过校验器。
		await upsertPost(db, input({ tags: ['甲', '甲'] }), { nowSeconds: NOW });
		expect(await tagNames()).toEqual(['甲']);
	});
});

describe('批量写入的原子性', () => {
	it('所有写操作在**同一个** batch 里（测一个真实的违反外键场景）', async () => {
		// 直接构造一个必然失败的批次：往 post_tags 里插一个不存在的 post_slug。
		// 它证明的是 stub 的 batch 真的会回滚——也就是"半写状态"这类断言
		// 有它该有的意义（否则 BEGIN/COMMIT 没生效，测试会安静地放过一切）。
		await expect(
			db.batch([
				db.prepare('INSERT INTO tags (name, segment) VALUES (?, ?)').bind('孤立', 'gu-li'),
				db
					.prepare('INSERT INTO post_tags (post_slug, tag_id, position) VALUES (?, ?, ?)')
					.bind('不存在的文章', 1, 0),
			]),
		).rejects.toThrow();

		// 第一条语句也必须被回滚
		const row = await db
			.prepare(`SELECT COUNT(*) AS n FROM tags WHERE name = '孤立'`)
			.first<{ n: number }>();
		expect(row?.n).toBe(0);
	});

	it('嵌套 batch 会炸（守卫换了个位置，没有消失）', async () => {
		// D1 上嵌套 batch 是什么行为本项目没验证过。与其猜，不如在测试里直接炸。
		//
		// 守卫抛在 async 函数里，所以它是**一个被拒的 promise 而不是同步抛出**
		// ——和真的 D1 API 形状一致。测试必须 await 到那一次拒绝，
		// 否则会留下一个未处理的 rejection（vitest 会把它报成整个文件的错误）。
		let nested: Promise<unknown> | undefined;
		await db.batch([
			db.prepare('SELECT 1'),
			{
				execSync: () => {
					nested = db.batch([]);
					return { success: true as const, meta: { changes: 0, last_row_id: 0 } };
				},
			} as never,
		]);
		await expect(nested).rejects.toThrow('嵌套');
	});
});

describe('prepared statement 的可复用性', () => {
	it('同一个 stub db 上反复 upsert 不报错', async () => {
		// 语句对象如果被跨调用复用（比如模块级缓存了一个 prepare 结果），
		// 在 D1 上会因为绑定参数被覆盖而写入错的数据——那是最难查的一类。
		for (let i = 0; i < 10; i++) {
			await upsertPost(db, input({ slug: `p${i}`, title: `第 ${i} 篇` }), {
				nowSeconds: NOW + i,
			});
		}
		expect(await countRows('posts', 'p0')).toBe(1);
		expect((await postRow('p9'))?.title).toBe('第 9 篇');
	});
});

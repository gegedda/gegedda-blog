/**
 * 文章的数据**写入**层。
 *
 * ⚠️ **本文件不导出任何读函数。** 读 SQL 一律在 `src/data/posts.repo.ts`，
 * 那边开头写着"SQL → 领域对象的唯一出口"。往这里加一个读函数，
 * 下一个人就会去错地方查「草稿为什么出现在列表里」。
 *
 * ── 这里唯一真正的风险是"半写" ─────────────────────────────────
 *
 * D1 拒绝显式 `BEGIN`/`COMMIT`，所以一次发布涉及的全部写操作必须放进
 * **同一个 `db.batch([...])`**——一批语句是唯一的原子序列。
 * 分成几次调用的话，会出现"文章写进去了、标签没写"或"文章写了、
 * content_revision 没加（缓存永不失效）"这类状态，而且**全都不报错**。
 */

import type { PostInput } from '../domain/post-input';
import { dateRawToUtc } from '../utils/date-raw';
import { tagSegment } from '../utils/tag-segment';
import { bumpContentRevisionStatement } from '../lib/settings';

/**
 * 两个不同的标签名规范化后撞到了同一个 URL 片段
 * （比如库里已经有 `Hello World`，这次来了 `Hello-World`）。
 *
 * 单列成一个错误类型，是为了让接口层能**只捕获它**返回 409。
 * 宽泛的 `catch` 会把真正的故障（D1 挂了）也吞成 409，
 * 于是"保存失败"看起来像是"标签重名"，查错方向从一开始就是错的。
 */
export class TagCollisionError extends Error {
	constructor(
		readonly segment: string,
		readonly existing: string,
		readonly incoming: string,
	) {
		super(`标签「${existing}」和「${incoming}」会变成同一个地址 /tags/${segment}/`);
		this.name = 'TagCollisionError';
	}
}

/**
 * 发布结果。`created` 用来决定接口回 201 还是 200——
 * 不是必须的，但让"新建"和"更新"在日志里可区分。
 */
export interface WriteResult {
	created: boolean;
}

/**
 * 与库里已有标签做一次**显式**的重名预检。
 *
 * 不做预检的话，撞的是 `tags.segment` 的 UNIQUE 约束，报出来是一句
 * 「UNIQUE constraint failed: tags.segment」——看不出和标签有关，
 * 也看不出是哪两个标签。
 *
 * 输入**内部**的重名（同一篇里写了 `Hello World` 和 `hello-world`）
 * 由 `validatePostInput` 在更早一步拦掉，不需要查库。
 */
async function assertNoTagCollision(db: D1Database, tags: string[]): Promise<void> {
	if (tags.length === 0) return;

	const bySegment = new Map<string, string>();
	for (const tag of tags) bySegment.set(tagSegment(tag), tag);

	const placeholders = [...bySegment.keys()].map(() => '?').join(', ');
	const { results } = await db
		.prepare(`SELECT name, segment FROM tags WHERE segment IN (${placeholders})`)
		.bind(...bySegment.keys())
		.all<{ name: string; segment: string }>();

	for (const row of results ?? []) {
		const incoming = bySegment.get(row.segment);
		if (incoming !== undefined && incoming !== row.name) {
			throw new TagCollisionError(row.segment, row.name, incoming);
		}
	}
}

/**
 * posts 表的 UPSERT。
 *
 * 两处是承重的：
 *
 * 1. **必须排在 batch 的第一条。** `post_tags.post_slug` 有
 *    `REFERENCES posts(slug)`，新建文章时先插关联会违反外键。
 *    （测试用的 node:sqlite 默认开启外键约束，所以顺序写错在测试里就会炸，
 *    不会留到线上才发现。）
 *
 * 2. **不用 `INSERT OR REPLACE`。** SQLite 里它等价于 DELETE + INSERT，
 *    会连带触发 `post_tags` 的 `ON DELETE CASCADE` —— 标签被清掉，
 *    而且不报错。`scripts/content-to-sql.mjs` 已经为同一个理由避开了它。
 *
 * `created_at` 不进更新列表：首次写入的时刻才是创建时间。
 */
function upsertPostStatement(
	db: D1Database,
	input: PostInput,
	nowSeconds: number,
): D1PreparedStatement {
	return db
		.prepare(
			`INSERT INTO posts (
			   slug, title, description, pub_date_raw, pub_date_utc,
			   updated_date_raw, updated_date_utc, hero_image, draft, body,
			   body_html, headings_json, words, minutes, categories_json,
			   created_at, updated_at
			 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(slug) DO UPDATE SET
			   title = excluded.title,
			   description = excluded.description,
			   pub_date_raw = excluded.pub_date_raw,
			   pub_date_utc = excluded.pub_date_utc,
			   updated_date_raw = excluded.updated_date_raw,
			   updated_date_utc = excluded.updated_date_utc,
			   hero_image = excluded.hero_image,
			   draft = excluded.draft,
			   body = excluded.body,
			   body_html = excluded.body_html,
			   headings_json = excluded.headings_json,
			   words = excluded.words,
			   minutes = excluded.minutes,
			   categories_json = excluded.categories_json,
			   updated_at = excluded.updated_at`,
		)
		.bind(
			input.slug,
			input.title,
			input.description,
			input.pubDateRaw,
			dateRawToUtc(input.pubDateRaw),
			input.updatedDateRaw,
			input.updatedDateRaw ? dateRawToUtc(input.updatedDateRaw) : null,
			input.heroImage,
			input.draft ? 1 : 0,
			input.body,
			input.bodyHtml,
			input.headingsJson,
			input.words,
			input.minutes,
			JSON.stringify(input.categories),
			nowSeconds,
			nowSeconds,
		);
}

/** 标签的 UPSERT。必须在挂关联之前执行，后面那个子查询要能解析出 id。 */
function upsertTagStatement(db: D1Database, tag: string): D1PreparedStatement {
	return db
		.prepare(
			`INSERT INTO tags (name, segment) VALUES (?, ?)
			 ON CONFLICT(name) DO UPDATE SET segment = excluded.segment`,
		)
		.bind(tag, tagSegment(tag));
}

/**
 * 新建或更新一篇文章。整件事是一个 `db.batch()`。
 *
 * ── 关于修订（post_revisions）─────────────────────────────────
 *
 * 记录的是**保存之后的新状态**，不是旧状态。决定性理由在删除路径上：
 * 删除时最后一条修订就是被删文章的内容，于是"删除"天然可恢复。
 * 若改成记录旧状态，删除会丢掉最终稿。
 *
 * `title` 与 `body` 都没变时**不写**新的修订——反复点保存不该把历史冲掉。
 * 这次 SELECT 本来就需要（要区分新建与更新，也要给"更新一个不存在的 slug"
 * 返回 404），所以判断是免费的。
 *
 * 已知残留竞态：这个 SELECT 与后面的 batch 之间有窗口，另一个并发保存
 * 可能插进来，于是历史里多一行或少一行。单作者的博客里这不是数据损坏，
 * 写进注释而不修——为一个不会发生的场景加锁，代价大于收益。
 */
export async function upsertPost(
	db: D1Database,
	input: PostInput,
	opts: { nowSeconds: number },
): Promise<WriteResult> {
	await assertNoTagCollision(db, input.tags);

	const current = await db
		.prepare('SELECT title, body FROM posts WHERE slug = ? LIMIT 1')
		.bind(input.slug)
		.first<{ title: string; body: string }>();

	const created = current === null;
	const changed = created || current.title !== input.title || current.body !== input.body;

	const statements: D1PreparedStatement[] = [upsertPostStatement(db, input, opts.nowSeconds)];

	// ⚠️ 去重只做**一次**，两个循环共用这一份。
	//
	// 原来 `tags` 的 UPSERT 用了 `new Set(input.tags)`，而下面 `post_tags` 的
	// 插入直接遍历 `input.tags`。于是 `tags: ['甲', '甲']` 会写两条
	// `(post_slug, tag_id)` 相同的关联行 —— 撞 `post_tags` 的主键，
	// 整个 batch 回滚，报出来是一句「UNIQUE constraint failed:
	// post_tags.post_slug, post_tags.tag_id」，看不出和"标签写重了"有关。
	//
	// 校验器（`validatePostInput`）确实会先去重，**但写层不该假设它跑过**：
	// 它是一个公开导出，`content-to-sql.mjs` 之类的调用方不会经过 HTTP 校验。
	// 这也正是"两处各去各的重"会漂移的地方，所以只在顶部做一次。
	const tags = [...new Set(input.tags)];

	for (const tag of tags) statements.push(upsertTagStatement(db, tag));

	// 先清后插。**先清是必需的**：`ON CONFLICT DO UPDATE` 只能改 position，
	// 从文章上删掉一个标签时那一行不会消失——表现是「标签删不掉」且不报错。
	//
	// 而且**不能依赖 `ON DELETE CASCADE`**：D1 默认是否开启 `PRAGMA foreign_keys`
	// 在本项目没有验证过。若没开，级联不触发，`post_tags` 会留下孤儿行——
	// 平时看不见（所有读路径都 JOIN posts），但用同一个 slug 新建文章时
	// 旧标签会自己回来。显式删一条的成本是 0，schema 里的外键留作第二道防线。
	statements.push(db.prepare('DELETE FROM post_tags WHERE post_slug = ?').bind(input.slug));

	for (const [position, tag] of tags.entries()) {
		statements.push(
			db
				.prepare(
					`INSERT INTO post_tags (post_slug, tag_id, position)
					 VALUES (?, (SELECT id FROM tags WHERE name = ?), ?)`,
				)
				.bind(input.slug, tag, position),
		);
	}

	if (changed) {
		statements.push(
			db
				.prepare(
					`INSERT INTO post_revisions (post_slug, title, body, created_at)
					 VALUES (?, ?, ?, ?)`,
				)
				.bind(input.slug, input.title, input.body, opts.nowSeconds),
		);
	}

	// 和文章写入**同一个 batch**。分成两次调用的话，文章写成功而版本号没加
	// = 缓存永不失效 =「发布后刷新还是旧页面」，全程不报错。
	statements.push(bumpContentRevisionStatement(db));

	await db.batch(statements);
	return { created };
}

/**
 * 删除一篇文章。删不掉时返回 false（调用方 404）。
 *
 * 两条与保存路径**不同**的规则：
 *
 * 1. **无条件写一条修订**，不做"内容没变就跳过"的优化。`post_revisions`
 *    是"删了还能捞回来"的唯一退路，而**导入脚本写的文章没有任何修订**
 *    （`content-to-sql.mjs` 不写这张表）。若这里也跳过，删掉一篇导入的
 *    文章就是永久丢失。宁可偶尔多一行。
 *
 * 2. **显式删 `post_tags`**，理由同上（不依赖 CASCADE 是否开启）。
 *
 * `post_revisions` 表本身**故意没有外键**（见迁移文件的注释），
 * 所以删 posts 不会带走修订——这正是"删除可恢复"成立的前提。
 * 测试里有一条专门盯它。
 */
export async function deletePost(
	db: D1Database,
	slug: string,
	opts: { nowSeconds: number },
): Promise<boolean> {
	const current = await db
		.prepare('SELECT title, body FROM posts WHERE slug = ? LIMIT 1')
		.bind(slug)
		.first<{ title: string; body: string }>();

	if (!current) return false;

	await db.batch([
		db
			.prepare(
				`INSERT INTO post_revisions (post_slug, title, body, created_at)
				 VALUES (?, ?, ?, ?)`,
			)
			.bind(slug, current.title, current.body, opts.nowSeconds),
		db.prepare('DELETE FROM post_tags WHERE post_slug = ?').bind(slug),
		db.prepare('DELETE FROM posts WHERE slug = ?').bind(slug),
		bumpContentRevisionStatement(db),
	]);

	return true;
}

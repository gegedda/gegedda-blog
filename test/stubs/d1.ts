/**
 * `D1Database` 的测试替身，底下是 Node 24 自带的 `node:sqlite`。
 *
 * 为什么值得写这个：仓储层最容易错的两件事都不在类型层面——
 * 一是过滤条件漏写（草稿被按 URL 直达），二是 `ORDER BY` 缺兜底键
 * （分页时同一篇重复出现或消失）。这两件事**都不报错**，只表现为
 * 内容悄悄不对。用假的返回值去测等于什么都没测；这里跑的是真的 SQLite，
 * 真的索引、真的 `LIMIT/OFFSET`、真的排序。
 *
 * 只实现仓储层真正用到的那几个方法（prepare / bind / all / first / run / batch），
 * 不追求 D1 API 的完整性。遇到没实现的调用抛错而不是返回空——
 * 空结果会让断言在"没有数据"的情况下安静地通过。
 *
 * ── `batch()` 的语义是**近似**的，写清楚差在哪 ──────────────────
 *
 * 这里用真的 `BEGIN` / `COMMIT` / `ROLLBACK` 做原子性（D1 拒绝显式事务，
 * 一批语句本身就是它的原子单位）。但两者是否**完全等价**没有验证过：
 *
 *   - D1 的 batch 是否也回滚整个批次（而不是停在出错的那条）——未验证
 *   - batch 里能不能用 `DELETE` / `ON CONFLICT` / 子查询——未验证
 *     （本地 D1 上跑一次完整保存即可确认，见计划 §13.12 第 3 条）
 *   - D1 的语句大小与行大小上限——未验证
 *
 * 所以 `test/posts-write.test.ts` 里那些"半写状态"的断言证明的是
 * **写路径的 SQL 顺序正确**，不是"D1 上一定原子"。后者只能靠 wrangler dev。
 *
 * 另一半：本 stub 的 `run()` 返回的 `meta.changes` 是真的（来自
 * `node:sqlite` 的 `StatementSync.run()`），对齐 D1 API 的形状。
 * 但**没有任何断言依赖它**——原子抢占用的是 `RETURNING` + `first()`，
 * 那条路径 `bumpIntSetting` 已经在生产里用过了。对齐只是不想让将来的
 * 断言因为错误的原因通过。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

// 必须用 fileURLToPath 而不是 `new URL(import.meta.url).pathname`：
// 那个 pathname 是**百分号编码**的，本项目路径里有中文，于是会去找一个叫
// %E4%B8%AA%E4%BA%BA... 的目录，报 ENOENT 且看不出和编码有关。
const MIGRATION = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'../../migrations/0001_init.sql',
);

class StubStatement {
	constructor(
		private readonly db: DatabaseSync,
		private readonly sql: string,
		private readonly params: unknown[] = [],
	) {}

	bind(...params: unknown[]): StubStatement {
		return new StubStatement(this.db, this.sql, params);
	}

	async all<T>(): Promise<{ results: T[] }> {
		const rows = this.db.prepare(this.sql).all(...(this.params as never[]));
		return { results: rows as T[] };
	}

	async first<T>(): Promise<T | null> {
		const rows = this.db.prepare(this.sql).all(...(this.params as never[]));
		return (rows[0] as T) ?? null;
	}

	/**
	 * `meta.changes` 取自 `node:sqlite` 的真实返回值，形状对齐 D1
	 * （`last_row_id` 是 D1 的字段名，不是 `lastInsertRowid`）。
	 *
	 * `node:sqlite` 在整数可能超出 `Number.MAX_SAFE_INTEGER` 时返回 BigInt，
	 * 所以这里显式转一次——D1 的对应字段是 number，不转的话下游拿到的是
	 * 一个看起来像数字的 BigInt，`===` 比较会莫名其妙地假。
	 */
	async run(): Promise<{ success: true; meta: { changes: number; last_row_id: number } }> {
		const info = this.db.prepare(this.sql).run(...(this.params as never[]));
		return {
			success: true,
			meta: {
				changes: Number(info.changes),
				last_row_id: Number(info.lastInsertRowid),
			},
		};
	}

	/** 给 `batch()` 用：同步执行，好让整批包在一个真实的 BEGIN/COMMIT 里。 */
	execSync(): { success: true; meta: { changes: number; last_row_id: number } } {
		const info = this.db.prepare(this.sql).run(...(this.params as never[]));
		return {
			success: true,
			meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) },
		};
	}
}

export interface StubDb extends D1Database {
	/** 绕过 D1 API 直接执行 SQL，给测试装数据用。 */
	seed(sql: string): void;
	/** 直接执行一条写语句（带参数），不想写一长串字面量时用。 */
	exec(sql: string, ...params: unknown[]): void;
	close(): void;
}

/**
 * 建一个内存库并打好 schema。
 *
 * 刻意读**真正的** `migrations/0001_init.sql` 而不是在测试里另写一份建表语句：
 * 后者会和迁移漂移，测试全绿而线上表结构不对。
 */
export function createStubDb(): StubDb {
	const db = new DatabaseSync(':memory:');
	db.exec(readFileSync(MIGRATION, 'utf8'));

	/** 嵌套 batch 的哨兵。见下面 `batch()` 的注释。 */
	let inBatch = false;

	const stub = {
		prepare(sql: string) {
			return new StubStatement(db, sql);
		},
		seed(sql: string) {
			db.exec(sql);
		},
		exec(sql: string, ...params: unknown[]) {
			db.prepare(sql).run(...(params as never[]));
		},
		close() {
			db.close();
		},
		/**
		 * 一批语句 = 一个原子序列。
		 *
		 * ── 为什么这次实现了它，而原来的守卫是抛错 ──────────────────
		 *
		 * 原来 `batch()` 抛错是**刻意的**：那时仓储层只用单条语句，
		 * 留一个"batch 的原子性在 workerd 之外验不了"的显式缺口，
		 * 好过让测试给人一个"原子性被测过了"的错觉。
		 *
		 * P5 的写路径**必须**用 batch（一个 post 的 17 列 + 标签 + 关联 +
		 * 版本号加一，分几次调用会出现"文章写成功、标签没写"这种半写状态，
		 * 且不报错）。所以守卫**换个位置，而不是删掉**：原来挡的是
		 * "别用 batch"，现在挡的是"别嵌套 batch"——后者在 D1 上是什么
		 * 行为本项目没有验证过，与其猜，不如在测试里直接炸。
		 */
		async batch(stmts: StubStatement[]) {
			if (inBatch) {
				throw new Error('未实现：嵌套 db.batch()。D1 上嵌套 batch 的行为未验证。');
			}
			inBatch = true;
			db.exec('BEGIN');
			try {
				const out = stmts.map((stmt) => stmt.execSync());
				db.exec('COMMIT');
				return out;
			} catch (err) {
				// 回滚之后**照原样抛出**：吞掉的话，一个违反外键的批次
				// 会表现为"batch 返回了但库里什么都没有"，而那个症状
				// 会把人引向"是不是 D1 没写进去"，方向完全错了。
				db.exec('ROLLBACK');
				throw err;
			} finally {
				inBatch = false;
			}
		},
		async dump() {
			throw new Error('未实现：db.dump()');
		},
	} as unknown as StubDb;

	return stub;
}

/** 往库里塞一篇文章。字段名与 posts 表一致，缺的走默认值。 */
export function insertPost(
	db: StubDb,
	post: {
		slug: string;
		title?: string;
		description?: string;
		pubDate?: string;
		updatedDate?: string | null;
		draft?: boolean;
		body?: string;
		bodyHtml?: string;
		headingsJson?: string;
		words?: number;
		minutes?: number;
	},
): void {
	// pub_date_utc 用和 scripts/lib/frontmatter.mjs 一致的算法（日期串按 UTC 零点）。
	// 测试里只用它排序，具体数值不影响断言。
	const pubUtc = Date.parse(`${post.pubDate ?? '2026-01-01'}T00:00:00Z`);
	const updRaw = post.updatedDate ?? null;
	const updUtc = updRaw ? Date.parse(`${updRaw}T00:00:00Z`) : null;

	db.exec(
		`INSERT INTO posts (
			slug, title, description, pub_date_raw, pub_date_utc,
			updated_date_raw, updated_date_utc, hero_image, draft, body,
			body_html, headings_json, words, minutes, categories_json,
			created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, '[]', 0, 0)`,
		post.slug,
		post.title ?? `标题 ${post.slug}`,
		post.description ?? `描述 ${post.slug}`,
		post.pubDate ?? '2026-01-01',
		pubUtc,
		updRaw,
		updUtc,
		post.draft ? 1 : 0,
		post.body ?? `# ${post.slug}`,
		post.bodyHtml ?? `<h1>${post.slug}</h1>`,
		post.headingsJson ?? '[]',
		post.words ?? 10,
		post.minutes ?? 1,
	);
}

/** 加一个标签并挂到文章上。`position` 决定 TagChips 的渲染顺序。 */
export function attachTag(
	db: StubDb,
	slug: string,
	tag: string,
	segment: string,
	position: number,
): void {
	db.exec(
		`INSERT INTO tags (name, segment) VALUES (?, ?)
		 ON CONFLICT(name) DO UPDATE SET segment = excluded.segment`,
		tag,
		segment,
	);
	db.exec(
		`INSERT INTO post_tags (post_slug, tag_id, position)
		 VALUES (?, (SELECT id FROM tags WHERE name = ?), ?)`,
		slug,
		tag,
		position,
	);
}

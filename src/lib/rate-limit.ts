/**
 * 登录限流。表是 `login_attempts`，键是 `SHA-256(ip + salt)`（见 `auth.ts` 的 ipHash）。
 *
 * ── 这个文件存在的理由是一句话的顺序 ───────────────────────────
 *
 * **锁定检查必须在口令比对之前。**
 *
 * 反过来的话，锁定态就成了 CPU DoS 放大器：攻击者用任意错口令把账号锁住，
 * 然后继续打，每次请求仍然要付一次 SHA-256。10ms 的 CPU 预算下，
 * 几十个并发就足以让后台不可用——而"已经锁了"这件事看起来像是保护。
 *
 * 为了让它**在结构上**做不到反，登录接口不自己拼流程，而是调
 * `attemptLogin`，把口令比对作为回调传进来。回调只在通过锁定检查之后
 * 才会被调用，这一点是可以单测的（传一个一被调用就失败的函数进去）。
 */

import { GLOBAL_RATE_LIMIT_KEY } from './auth';

export interface RateLimitConfig {
	/** 单个 IP 的统计窗口（秒） */
	windowSeconds: number;
	/**
	 * 窗口内允许的失败次数。计数**达到**这个数就落锁。
	 *
	 * 注意"落锁"与"开始拒绝"差一次：造成落锁的那一次仍然回复它自己的
	 * 结果（`bad`），拒绝从下一次尝试开始。见 `attemptLogin` 第 ③ 步。
	 */
	maxFailures: number;
	/** 锁定时长（秒） */
	lockSeconds: number;
	/** 全局窗口（秒） */
	globalWindowSeconds: number;
	/** 全局窗口内允许的失败次数，防分布式绕过 */
	globalMaxFailures: number;
}

export const RATE_LIMIT: RateLimitConfig = {
	windowSeconds: 900, // 15 分钟
	maxFailures: 5,
	lockSeconds: 900, // 15 分钟
	globalWindowSeconds: 3600, // 1 小时
	globalMaxFailures: 100,
};

interface AttemptRow {
	ip_hash: string;
	failed_count: number;
	window_start: number;
	locked_until: number | null;
}

export interface LockState {
	locked: boolean;
	/** 还有多少秒解锁。未锁定时为 0。 */
	retryAfter: number;
}

/** 未锁定。 */
const UNLOCKED: LockState = { locked: false, retryAfter: 0 };

function lockState(row: AttemptRow | undefined, nowSeconds: number): LockState {
	if (!row) return UNLOCKED;
	const until = row.locked_until;
	if (until === null || until === undefined) return UNLOCKED;
	if (until <= nowSeconds) return UNLOCKED;
	return { locked: true, retryAfter: Math.max(1, until - nowSeconds) };
}

/**
 * 窗口内已经失败了几次。
 *
 * 窗口过期后计数**视为 0**，而不是「等有人来写库时才清零」——
 * 一个只读的检查不该产生写操作，而且"过期的锁"必须在读的时候就不算数，
 * 否则锁定会一直续下去。
 */
function failedCount(row: AttemptRow | undefined, nowSeconds: number, windowSeconds: number): number {
	if (!row) return 0;
	if (nowSeconds - row.window_start >= windowSeconds) return 0;
	return row.failed_count;
}

async function readRows(db: D1Database, keys: string[]): Promise<Map<string, AttemptRow>> {
	const placeholders = keys.map(() => '?').join(', ');
	const { results } = await db
		.prepare(
			`SELECT ip_hash, failed_count, window_start, locked_until
			 FROM login_attempts
			 WHERE ip_hash IN (${placeholders})`,
		)
		.bind(...keys)
		.all<AttemptRow>();

	const map = new Map<string, AttemptRow>();
	for (const row of results ?? []) map.set(row.ip_hash, row);
	return map;
}

/**
 * 只读地判断当前是否处于锁定态。**不产生任何写操作。**
 *
 * 全局那一行也在这里一起看：它是防分布式绕过的（100 次失败/小时）。
 * ⚠️ 它会拒绝所有人，包括博主本人——恢复命令写在 `docs/部署指南.md`。
 */
export async function checkLock(
	db: D1Database,
	ipKey: string,
	nowSeconds: number,
	config: RateLimitConfig = RATE_LIMIT,
): Promise<LockState> {
	const rows = await readRows(db, [ipKey, GLOBAL_RATE_LIMIT_KEY]);

	const perIp = lockState(rows.get(ipKey), nowSeconds);
	if (perIp.locked) return perIp;

	const global = lockState(rows.get(GLOBAL_RATE_LIMIT_KEY), nowSeconds);
	if (global.locked) return global;

	return UNLOCKED;
}

/**
 * 记一次失败，必要时落锁。
 *
 * 一条语句覆盖三种情形（首次 / 窗口已过期 / 窗口内累加），用
 * `ON CONFLICT DO UPDATE` + `CASE` 表达——分成"先读再写"两步的话，
 * 两个并发请求可能读到同一个旧值，于是只加了一次。
 */
function failureStatement(
	db: D1Database,
	key: string,
	nowSeconds: number,
	windowSeconds: number,
	maxFailures: number,
	lockSeconds: number,
): D1PreparedStatement {
	// ⚠️ `VALUES` 那一支里也要求一次锁定判定，不能简单写 `NULL`。
	//
	// 只在 `ON CONFLICT` 的 `DO UPDATE` 里判的话，某个键的**第一次**失败
	// （走 INSERT 分支）永远不会被检查——于是阈值为 1 的配置实际是"2 次才锁"，
	// 而阈值 2 以上恰好看不出差别（第一次记 1，第二次起才走 CASE）。
	// 这种"只在某个配置下才错"的偏差最难查，所以让两条分支用同一个判定。
	//
	// 插入分支里"新计数"恒等于 1，所以判定化简成 `1 >= maxFailures`。
	const lockedAt = nowSeconds + lockSeconds;
	return db
		.prepare(
			`INSERT INTO login_attempts (ip_hash, failed_count, window_start, locked_until)
			 VALUES (?, 1, ?, CASE WHEN 1 >= ? THEN ? ELSE NULL END)
			 ON CONFLICT(ip_hash) DO UPDATE SET
			   failed_count = CASE
			     WHEN ? - login_attempts.window_start >= ? THEN 1
			     ELSE login_attempts.failed_count + 1
			   END,
			   window_start = CASE
			     WHEN ? - login_attempts.window_start >= ? THEN ?
			     ELSE login_attempts.window_start
			   END,
			   locked_until = CASE
			     WHEN (CASE
			             WHEN ? - login_attempts.window_start >= ? THEN 1
			             ELSE login_attempts.failed_count + 1
			           END) >= ? THEN ?
			     ELSE NULL
			   END`,
		)
		.bind(
			key,
			nowSeconds,
			maxFailures,
			lockedAt,
			nowSeconds,
			windowSeconds,
			nowSeconds,
			windowSeconds,
			nowSeconds,
			nowSeconds,
			windowSeconds,
			maxFailures,
			lockedAt,
		);
}

/** 记一次失败（同时记到该 IP 与全局那一行）。返回记录之后的锁定态与计数。 */
export async function recordFailure(
	db: D1Database,
	ipKey: string,
	nowSeconds: number,
	config: RateLimitConfig = RATE_LIMIT,
): Promise<{ lock: LockState; failedCount: number }> {
	// 两条语句放一个 batch：D1 拒绝显式 BEGIN/COMMIT，一批是唯一的原子序列，
	// 而"该 IP 记了一次、全局没记"会让计数悄悄偏少。
	await db.batch([
		failureStatement(
			db,
			ipKey,
			nowSeconds,
			config.windowSeconds,
			config.maxFailures,
			config.lockSeconds,
		),
		failureStatement(
			db,
			GLOBAL_RATE_LIMIT_KEY,
			nowSeconds,
			config.globalWindowSeconds,
			config.globalMaxFailures,
			config.lockSeconds,
		),
	]);

	const rows = await readRows(db, [ipKey, GLOBAL_RATE_LIMIT_KEY]);
	return {
		lock: await checkLock(db, ipKey, nowSeconds, config),
		failedCount: failedCount(rows.get(ipKey), nowSeconds, config.windowSeconds),
	};
}

/**
 * 登录成功后清掉计数。
 *
 * 两行都清：全局那一行不清的话，博主自己反复试错也会把自己锁在门外，
 * 而那是这一层唯一真正的风险。攻击者就算触发了一次成功（即他知道口令），
 * 也已经不需要绕过限流了。
 */
export async function clearFailures(db: D1Database, ipKey: string): Promise<void> {
	await db.batch([
		db.prepare('DELETE FROM login_attempts WHERE ip_hash = ?').bind(ipKey),
		db.prepare('DELETE FROM login_attempts WHERE ip_hash = ?').bind(GLOBAL_RATE_LIMIT_KEY),
	]);
}

export type AttemptResult =
	| { kind: 'locked'; retryAfter: number }
	| { kind: 'ok' }
	| { kind: 'bad'; remaining: number };

/**
 * 一次登录尝试。**登录接口只应该调这一个函数**，不要自己拼流程。
 *
 * `verify` 是一个回调而不是一个布尔值，正是为了强制上面说的那个顺序：
 * 它在通过锁定检查之前**绝不会被调用**。调用方负责在里面做
 * 「SHA-256(verifier) vs 库里的哈希」那次常数时间比较。
 */
export async function attemptLogin(
	db: D1Database,
	opts: {
		ipKey: string;
		nowSeconds: number;
		verify: () => Promise<boolean>;
		config?: RateLimitConfig;
	},
): Promise<AttemptResult> {
	const config = opts.config ?? RATE_LIMIT;

	// ① 先看锁。这一步之前不碰口令。
	const lock = await checkLock(db, opts.ipKey, opts.nowSeconds, config);
	if (lock.locked) return { kind: 'locked', retryAfter: lock.retryAfter };

	// ② 到这里才轮到比对
	const ok = await opts.verify();
	if (ok) {
		await clearFailures(db, opts.ipKey);
		return { kind: 'ok' };
	}

	// ③ 记失败，并回复"这一次"的结果。
	//
	// ⚠️ **刚跨过阈值的那一次仍然回 `bad`，不回 `locked`**，哪怕
	// `recordFailure` 已经在这一步把 `locked_until` 写进去了。
	//
	// 那是刻意的：这一次尝试的结果就是"口令不正确"，锁是它**造成**的后果，
	// 作用在**下一次**。两个理由：
	//
	//   1. §13.11 的验收门写的是「401 ×5、第 6 次 429」。把第 5 次也变成
	//      429 会让那条门（以及它代表的那份规格）与实际行为差一位，
	//      而这种"文档和实现对不上、两边看起来都对"的偏差最难查。
	//   2. 把两种失败合成一个响应之后，客户端就再也没法区分
	//      「我刚打错了一次」和「我早就被锁了」——前者要提示改口令，
	//      后者要提示等待，文案完全不同。
	//
	// `remaining` 在这一刻是 0，所以提示语自然消失，不会出现"还可以再试 0 次"。
	const after = await recordFailure(db, opts.ipKey, opts.nowSeconds, config);
	return { kind: 'bad', remaining: Math.max(0, config.maxFailures - after.failedCount) };
}

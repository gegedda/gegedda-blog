/**
 * `settings` 表的访问层。库那边就是一张 `key TEXT PRIMARY KEY, value TEXT`，
 * 这里给它加上类型和名字。
 *
 * 为什么不给每个配置项单独开一列：这些值绝大多数是**一次写入、偶尔读取**
 * 的（密码哈希、签名密钥），而且互相之间不需要一起查询。键值表的代价是
 * 少了一层编译期检查，收益是加一项配置不用写迁移——用下面的常量把这个
 * 代价补回来：所有 key 都在这里，别处不许写字面量。
 */

/**
 * 后台密码。
 *
 * 格式是 `<saltHex>:<iterations>:<sha256(verifier)Hex>`——
 * **存的是 verifier 的摘要，不是 verifier 本身**，因为 verifier 就是凭证
 * （拿到它就能登录，不需要知道原始密码）。编解码在 `src/lib/auth.ts`，
 * 这里只保管这个 key。
 */
export const KEY_PASSWORD_HASH = 'password_hash';
/** 会话 cookie 的 HMAC 签名密钥。被读取说明它必须存在，缺失时登录接口应当报错。 */
export const KEY_SESSION_SECRET = 'session_secret';
/** 递增即让**所有已签发的会话同时失效**。这是无状态登出的实现方式。 */
export const KEY_SESSION_EPOCH = 'session_epoch';
/** 内容版本号。每次发布递增，用作列表查询缓存的键。 */
export const KEY_CONTENT_REVISION = 'content_revision';
/**
 * 限流表里 IP 哈希的盐（P5 新增，与 session_secret 一起在 setup 时生成）。
 *
 * 没有盐的 IPv4 空间只有 2³²，彩虹表是秒级的——那时候 `login_attempts`
 * 里的 `ip_hash` 就等于一份可反查的访问日志。
 */
export const KEY_IP_SALT = 'ip_salt';

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
	const row = await db
		.prepare('SELECT value FROM settings WHERE key = ? LIMIT 1')
		.bind(key)
		.first<{ value: string }>();
	return row?.value ?? null;
}

export async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
	await db
		.prepare(
			`INSERT INTO settings (key, value) VALUES (?, ?)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
		)
		.bind(key, value)
		.run();
}

/**
 * 读一个整数配置。缺失或不是数字时返回 `fallback`。
 *
 * 缺失不报错是刻意的：`session_epoch` 在第一次用之前本来就不存在，
 * 而把它当作 0 是正确语义（还没有任何一次登出）。真正的错误是
 * 存的**不是数字**——那是写入端写坏了，这里当作 fallback 处理，
 * 但值得在别处（写入端）保证不会发生。
 */
async function getIntSetting(
	db: D1Database,
	key: string,
	fallback: number,
): Promise<number> {
	const raw = await getSetting(db, key);
	if (raw === null) return fallback;
	const n = Number(raw);
	return Number.isFinite(n) ? n : fallback;
}

/**
 * 整数配置 +1 的**唯一一份 SQL 文本**。
 *
 * 为什么要把它抽出来：这条语句有两个消费方——单条执行（这里的
 * `bumpIntSetting`，带 `RETURNING`）和 `db.batch([...])`（写层的发布事务，
 * batch 里不方便用 RETURNING）。各写一份的话两者会漂移，而漂移的表现是
 * 「有的写操作 bump 了、有的没有」→ 缓存不失效 → 「发布后刷新还是旧页面」，
 * **全程不报错**。测试里有一条专门盯着这件事。
 *
 * 行不存在时插入 1（首次发布），已存在时按整数加。`value` 是 TEXT，
 * 所以必须显式 CAST——不转的话 SQLite 会做字符串拼接，'1' + 1 得到 2 是巧合，
 * '10' 之后就会变成 '101'。
 */
const BUMP_INT_SQL = `INSERT INTO settings (key, value) VALUES (?, '1')
 ON CONFLICT(key) DO UPDATE SET value = CAST(settings.value AS INTEGER) + 1`;

/**
 * 原子地 +1 并返回新值。
 *
 * 用一条 UPSERT + RETURNING 而不是「读→加→写」三步：三步之间别的请求
 * 可能也读到了同一个旧值，两个并发发布就会只递增一次。D1 没有交互式事务，
 * 单条语句是唯一的原子单位。
 */
async function bumpIntSetting(db: D1Database, key: string): Promise<number> {
	const row = await db
		.prepare(`${BUMP_INT_SQL} RETURNING CAST(value AS INTEGER) AS n`)
		.bind(key)
		.first<{ n: number }>();
	return row?.n ?? 1;
}

/** 递增语句，给 `db.batch([...])` 用。返回的是未执行的语句，调用方自己 bind 之外的事不用管。 */
export function bumpStatement(db: D1Database, key: string): D1PreparedStatement {
	return db.prepare(BUMP_INT_SQL).bind(key);
}

/**
 * `content_revision` 的递增语句，供写层的发布事务放进 batch。
 *
 * 发布时必须**和其他写操作在同一个 batch 里**：分成两次调用的话，
 * 文章写成功、版本号没加 → 缓存永不失效 →「发布后刷新还是旧页面」，
 * 同样不报错。
 */
export function bumpContentRevisionStatement(db: D1Database): D1PreparedStatement {
	return bumpStatement(db, KEY_CONTENT_REVISION);
}

/**
 * 内容版本号：任何会影响页面输出的写操作之后都要 bump。
 *
 * 它是"缓存该不该失效"的唯一依据。用时间戳的话，同一秒内的两次发布会
 * 得到同一个键；用文章数量的话，改标题（数量不变）不会失效。
 */
export function getContentRevision(db: D1Database): Promise<number> {
	return getIntSetting(db, KEY_CONTENT_REVISION, 0);
}

export function bumpContentRevision(db: D1Database): Promise<number> {
	return bumpIntSetting(db, KEY_CONTENT_REVISION);
}

/** 会话纪元。会话 cookie 里带着签发时的值，对不上即视为已失效。 */
export function getSessionEpoch(db: D1Database): Promise<number> {
	return getIntSetting(db, KEY_SESSION_EPOCH, 0);
}

/** 全端登出：bump 之后所有已签发的 cookie 立刻作废，不需要会话表。 */
export function bumpSessionEpoch(db: D1Database): Promise<number> {
	return bumpIntSetting(db, KEY_SESSION_EPOCH);
}

// ─────────────────────────────────────────────── 语义化取值的几个小包装
//
// 加它们不是为了少打字，是为了让路由里**不出现 key 字面量**——
// 这是本文件开头那条"所有 key 都在这里"的规矩的具体执行方式。
// 拼错一个 key 的表现是"永远读到 null"，即"密码从来没设过"，
// 而且不会有任何报错。

/** 会话签名密钥。为 null 说明还没跑过 `/admin/setup`，此时不应签发任何 cookie。 */
export function getSessionSecret(db: D1Database): Promise<string | null> {
	return getSetting(db, KEY_SESSION_SECRET);
}

/** 限流 IP 哈希的盐。 */
export function getIpSalt(db: D1Database): Promise<string | null> {
	return getSetting(db, KEY_IP_SALT);
}

/** `password_hash` 的原文。用 `parsePasswordHash()`（auth.ts）解析，别自己切串。 */
export function getPasswordHashRaw(db: D1Database): Promise<string | null> {
	return getSetting(db, KEY_PASSWORD_HASH);
}

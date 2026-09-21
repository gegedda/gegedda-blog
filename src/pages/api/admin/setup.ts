/**
 * `POST /api/admin/setup` —— 首次设置后台口令。**只能成功一次。**
 *
 * 请求体：`{ salt, iterations, verifier }`，都由浏览器算好（理由见 login.ts：
 * 服务端跑 PBKDF2 会超 10ms 的 CPU 预算）。
 *
 * ── 三步的顺序是承重的 ────────────────────────────────────────
 *
 *   1. 先生成 `session_secret` 与 `ip_salt`（缺哪个补哪个）
 *   2. 再**原子地**抢占 `password_hash`
 *   3. 抢占成功才签发会话
 *
 * 为什么不是反过来：如果先抢占 `password_hash`、再生成密钥时失败了，
 * 就会进入一个**出不来的状态**——登录说"密钥缺失"，setup 说"已经设过了"，
 * 两边都拒绝，只能手工去 `wrangler d1 execute` 删行。而现在这个顺序下，
 * 最坏情况只是多写了两行无害的配置。
 *
 * ── 抢占用的是 `ON CONFLICT DO NOTHING ... RETURNING` ──────────
 *
 * 不用"先 SELECT 看有没有、再 INSERT"：两步之间有窗口，两个并发请求
 * 会都读到"没有"，然后后一个把前一个覆盖掉——也就是**任何人都能在
 * 博主设置完之后再改一次口令**。`RETURNING` 在冲突时返回 0 行，
 * 于是"我是否抢到了"是一次原子操作的结果。
 *
 * ── ⚠️ 一个已知的、没有技术解法的暴露窗口 ──────────────────────
 *
 * 这个接口在"还没设密码"时对公网开放（否则没法设密码）。也就是说，
 * **从部署完成到博主第一次访问 `/admin/setup` 之间的那段时间，
 * 任何知道这个地址的人都能把口令设成他自己的。**
 *
 * 单作者博客没有第二个身份来源（没有邮箱、没有 OAuth），所以这不是
 * 实现缺陷，是设计取舍。缓解办法只有一个：**部署完立刻去设置口令**。
 * 部署指南里写了这一条。真要更强的保证，得引入一个部署期生成的一次性令牌
 * （`wrangler secret put`），那是独立决定，不在 P5 范围内。
 */

import type { APIRoute } from 'astro';

import { fail, json, readJson } from '../../../lib/api';
import {
	PBKDF2_ITERATIONS,
	formatPasswordHash,
	hashVerifier,
	randomHex,
} from '../../../lib/auth';
import { getDb } from '../../../lib/db';
import { newSessionCookie } from '../../../lib/session';
import {
	KEY_IP_SALT,
	KEY_PASSWORD_HASH,
	KEY_SESSION_SECRET,
	getSessionEpoch,
	getSetting,
} from '../../../lib/settings';

/**
 * 缺则补，然后**读回来**。
 *
 * 读回来而不是直接用传入的值：并发时另一个请求可能已经写了它自己的，
 * 而 `DO NOTHING` 让这次写入静默失败。用传入的值去签会话，就会签出一个
 * 服务端并不认识的密钥的 cookie——登录成功但立刻掉线。
 */
async function ensureSetting(db: D1Database, key: string, value: string): Promise<string> {
	await setSettingIfAbsent(db, key, value);
	return (await getSetting(db, key)) ?? value;
}

async function setSettingIfAbsent(db: D1Database, key: string, value: string): Promise<void> {
	await db
		.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING`)
		.bind(key, value)
		.run();
}

export const POST: APIRoute = async ({ request }) => {
	const db = getDb();

	const body = await readJson(request, 4096);
	if (!body.ok) return body.response;

	const raw = body.value as Record<string, unknown> | null;
	if (typeof raw !== 'object' || raw === null) return fail(400, '请求体必须是一个对象');

	const { salt, iterations, verifier } = raw;

	// salt 是客户端生成的（它要用同一个盐去派生）。校验长度：
	// 太短的盐等于没有盐，而"没有盐"这件事在客户端是看不出来的。
	if (typeof salt !== 'string' || !/^[0-9a-f]{32,}$/.test(salt)) {
		return fail(400, 'salt 必须是至少 16 字节的十六进制串');
	}
	if (iterations !== PBKDF2_ITERATIONS) {
		// ⚠️ **精确相等，不是 `>=`。**
		// 用下界检查等于允许客户端悄悄把轮数降到 1——
		// 那是一次静默的、不可见的 KDF 降级，而它同时会影响后续登录
		// （`parsePasswordHash` 也是精确比较，所以降级后的哈希根本存不进去）。
		return fail(400, `iterations 必须是 ${PBKDF2_ITERATIONS}`);
	}
	if (typeof verifier !== 'string' || !/^[0-9a-f]{64}$/.test(verifier)) {
		return fail(400, 'verifier 必须是 64 个十六进制字符');
	}

	// ① 先生成两把密钥。缺哪个补哪个，都幂等。
	const [secret] = await Promise.all([
		ensureSetting(db, KEY_SESSION_SECRET, randomHex(32)),
		ensureSetting(db, KEY_IP_SALT, randomHex(16)),
	]);

	// ② 原子抢占 password_hash。
	const packed = formatPasswordHash({
		salt,
		iterations: PBKDF2_ITERATIONS,
		hash: await hashVerifier(verifier),
	});

	const claimed = await db
		.prepare(
			`INSERT INTO settings (key, value) VALUES (?, ?)
			 ON CONFLICT(key) DO NOTHING
			 RETURNING value`,
		)
		.bind(KEY_PASSWORD_HASH, packed)
		.first<{ value: string }>();

	if (!claimed) {
		// 已经有人设过了。这不是错误状态，是"你来晚了"。
		return fail(409, '后台密码已经设置过了。如果忘了，见 docs/部署指南.md 的重置步骤。');
	}

	// ③ 顺手把人放进去，省掉一次登录。
	const nowSeconds = Math.floor(Date.now() / 1000);
	return json({ ok: true }, 201, {
		'Set-Cookie': await newSessionCookie(secret, await getSessionEpoch(db), nowSeconds),
	});
};

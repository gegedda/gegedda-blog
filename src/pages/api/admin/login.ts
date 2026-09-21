/**
 * `POST /api/admin/login` —— 口令校验。
 *
 * 请求体：`{ verifier: string }`，是浏览器用 WebCrypto 跑
 * PBKDF2-SHA256(口令, salt, 600000) 的结果的十六进制形式。
 *
 * **口令原文永远不出浏览器。** 理由是 CPU：免费版 Workers 每次请求只有
 * 10ms，600k 轮 PBKDF2 要 12–25ms，在服务端跑会直接抛 Error 1102。
 *
 * ── 这个路由里唯一的"顺序"是承重的 ────────────────────────────
 *
 * 锁定检查必须在口令比对之前。所以这里不自己拼流程，而是调
 * `attemptLogin`，把比对作为回调传给它——回调只在通过锁定检查之后
 * 才会被调用。反过来的话，锁定态就成了 CPU DoS 放大器：
 * 攻击者用错口令把账号锁住，然后继续打，每次仍然要付一次 SHA-256。
 */

import type { APIRoute } from 'astro';

import { fail, json, readJson } from '../../../lib/api';
import { hashVerifier, ipHash, timingSafeEqualHex } from '../../../lib/auth';
import { getDb } from '../../../lib/db';
import { attemptLogin } from '../../../lib/rate-limit';
import { newSessionCookie } from '../../../lib/session';
import { getIpSalt, getPasswordHashRaw, getSessionEpoch, getSessionSecret } from '../../../lib/settings';
import { parsePasswordHash } from '../../../lib/auth';

/** 客户端 IP。只信 `cf-connecting-ip`——`X-Forwarded-For` 客户端可伪造。 */
function clientIp(request: Request): string {
	return request.headers.get('cf-connecting-ip') ?? 'unknown';
}

export const POST: APIRoute = async ({ request }) => {
	const db = getDb();

	const body = await readJson(request, 4096);
	if (!body.ok) return body.response;

	const raw = body.value;
	const verifier =
		typeof raw === 'object' && raw !== null && 'verifier' in raw
			? (raw as { verifier: unknown }).verifier
			: undefined;

	// verifier 的形状：PBKDF2-SHA256 派生 32 字节 → 64 个十六进制字符。
	//
	// 形状不对时**不返回 400，而是当成一次失败的尝试**。理由：
	// 400 是一条不经过限流的快捷路径，一个畸形输入就能绕开计数。
	// 反正它永远不可能对，让它走完限流流程最省心。
	const wellFormed = typeof verifier === 'string' && /^[0-9a-f]{64}$/.test(verifier);

	const [stored, secret, epoch, salt] = await Promise.all([
		getPasswordHashRaw(db).then(parsePasswordHash),
		getSessionSecret(db),
		getSessionEpoch(db),
		getIpSalt(db),
	]);

	if (!stored || !secret || !salt) {
		// 密钥缺失说明还没跑过 `/admin/setup`。
		// 用 409 而不是 401：这不是"口令错了"，是"还没有口令"。
		return fail(409, '还没有设置后台密码，请先访问 /admin/setup');
	}

	const nowSeconds = Math.floor(Date.now() / 1000);
	const ipKey = await ipHash(clientIp(request), salt);

	const result = await attemptLogin(db, {
		ipKey,
		nowSeconds,
		verify: async () => {
			if (!wellFormed) return false;
			// 库里存的是 verifier 的 **SHA-256**，不是 verifier 本身。
			// 因为 verifier 就是凭证——拿到它就能登录，不需要知道原始口令。
			// 摘要由 Worker 算，不收客户端算好的：能从输入重算的东西
			// 就不要接收现成的。
			const candidate = await hashVerifier(verifier);
			return timingSafeEqualHex(candidate, stored.hash);
		},
	});

	if (result.kind === 'locked') {
		return fail(429, `尝试太频繁，请在 ${Math.ceil(result.retryAfter / 60)} 分钟后再试。`, {
			'Retry-After': String(result.retryAfter),
		});
	}

	if (result.kind === 'bad') {
		// 把剩余次数说出来是给博主自己的提示（这个站只有一个用户）。
		// 代价是攻击者也能看到——但他本来就能通过观察 429 是否出现推断出来。
		const hint = result.remaining > 0 ? `还可以再试 ${result.remaining} 次。` : '';
		return fail(401, `口令不正确。${hint}`);
	}

	return json({ ok: true }, 200, {
		'Set-Cookie': await newSessionCookie(secret, epoch, nowSeconds),
	});
};

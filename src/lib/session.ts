/**
 * 会话：无状态的 HMAC 签名 cookie。
 *
 * 没有会话表。载荷里带着签发时刻的 `session_epoch`，与库里当前的值对不上
 * 即视为失效——于是「所有设备一起登出」只是把那个整数 +1，
 * 不需要存任何东西、也不需要能列出"现在有哪些会话"。
 *
 * ── 形状 ───────────────────────────────────────────────────────
 *
 *     v1.<exp>.<epoch>.<hex(HMAC-SHA256(secret, "v1.<exp>.<epoch>"))>
 *
 * 载荷刻意**不用 JSON**：每个后台请求都要验一次签，而 `JSON.parse` 是白付的
 * CPU（免费版只有 10ms）。三段定长字段直接切字符串就够了。
 *
 * 签名用十六进制而不是 base64url，是为了复用 `timingSafeEqualHex`——
 * 全项目只有一种常数时间比较。
 *
 * ── 一条贯穿全文件的规则 ───────────────────────────────────────
 *
 * **任何一步失败都返回 null，绝不抛异常。** 一个畸形 cookie 不能让中间件 500：
 * 那意味着任何人贴一个坏 cookie 就能把自己钉死在错误页上，
 * 而且报错信息里看不出是 cookie 的问题——一种自助式的 DoS。
 */

import { hmacSha256Hex, timingSafeEqualHex } from './auth';

/** cookie 名。`__Host-` 前缀由浏览器强制 Secure + Path=/ + 无 Domain。 */
export const SESSION_COOKIE = '__Host-session';

/** 30 天。 */
export const SESSION_MAX_AGE_SECONDS = 2_592_000;

/** 剩余不足这个时长就滑动续期（15 天）。 */
const RENEW_THRESHOLD_SECONDS = 1_296_000;

/** 版本号。将来改格式时 +1，旧 cookie 会被 `verifySession` 判为无效。 */
const VERSION = 'v1';

/** 签名的十六进制长度（SHA-256 → 32 字节）。 */
const SIGNATURE_HEX_LENGTH = 64;

/** 解析出来的会话。挂在 `Astro.locals.admin` 上给页面读，页面只读不写。 */
export interface AdminSession {
	/** 过期时刻，epoch 秒 */
	exp: number;
	/** 签发时的 session_epoch */
	epoch: number;
}

/** 签名覆盖的原文。改这里等于改协议，`VERSION` 要一起动。 */
function signingInput(exp: number, epoch: number): string {
	return `${VERSION}.${exp}.${epoch}`;
}

/**
 * 签发。
 *
 * 调用方必须先确认 `secret` 存在——`session_secret` 缺失时签名密钥就是
 * 空串，那等于任何人都能伪造 cookie。`settings.ts` 那边把它当作
 * 「读取即必须存在」，这里不重复兜底，但也不假装能用。
 */
export async function signSession(
	secret: string,
	payload: { exp: number; epoch: number },
): Promise<string> {
	const input = signingInput(payload.exp, payload.epoch);
	const signature = await hmacSha256Hex(secret, input);
	return `${input}.${signature}`;
}

/**
 * 验签。任何一步不通过都返回 `null`。
 *
 * `nowSeconds` 与 `currentEpoch` 由调用方传进来而不是在这里取：
 * 时间只能有一处来源（中间件），从库里读 epoch 是一次 D1 查询，
 * 不该被藏在一个看起来纯的函数里。
 *
 * ⚠️ `currentEpoch` **每次都要新读，不能缓存在模块作用域**。
 * 缓存了的话「全端登出」只在部分 isolate 生效——表现是「点了登出，
 * 有的设备还能用」，而且会随着 isolate 的存亡时好时坏。
 */
export async function verifySession(
	cookieValue: string | null | undefined,
	opts: { secret: string; currentEpoch: number; nowSeconds: number },
): Promise<AdminSession | null> {
	if (!cookieValue) return null;

	const parts = cookieValue.split('.');
	if (parts.length !== 4) return null;

	const [version, expRaw, epochRaw, signature] = parts;
	if (version !== VERSION) return null;

	// 只接受非负十进制整数。不用 Number()：它会接受 ''、' '、'1e3'、'0x10'。
	if (!/^[0-9]+$/.test(expRaw) || !/^[0-9]+$/.test(epochRaw)) return null;
	if (signature.length !== SIGNATURE_HEX_LENGTH || !/^[0-9a-f]+$/.test(signature)) return null;

	// 先验签，再信载荷里的任何一个数字。
	const expected = await hmacSha256Hex(opts.secret, signingInput(Number(expRaw), Number(epochRaw)));
	if (!timingSafeEqualHex(signature, expected)) return null;

	const exp = Number(expRaw);
	const epoch = Number(epochRaw);
	if (!Number.isSafeInteger(exp) || !Number.isSafeInteger(epoch)) return null;

	if (exp <= opts.nowSeconds) return null;
	if (epoch !== opts.currentEpoch) return null;

	return { exp, epoch };
}

/** 剩余不足阈值时为 true，中间件据此决定要不要重签。 */
export function needsRenewal(session: AdminSession, nowSeconds: number): boolean {
	return session.exp - nowSeconds < RENEW_THRESHOLD_SECONDS;
}

/**
 * 组装 `Set-Cookie` 的值。
 *
 * ⚠️ **绝不写 `Domain`。** `__Host-` 前缀禁止 Domain，带上之后浏览器会
 * **整条丢弃 cookie 且不报任何错**——症状是「登录提示成功了，
 * 但下一个请求又回到登录页」。同理 `Secure` 与 `Path=/` 都不能省。
 *
 * ⚠️ **绝不按 `import.meta.env.PROD` 之类的构建期常量去关掉 `Secure`。**
 * 那是让 `__Host-` 在开发期被静默丢弃、而生产期看不出来的经典写法。
 * 本地 http 上浏览器到底认不认这个组合，是 P5 要实测的第一条未知
 * （见计划的 §13.12 第 1 条），不靠猜。
 */
export function sessionCookie(value: string, maxAge = SESSION_MAX_AGE_SECONDS): string {
	return [
		`${SESSION_COOKIE}=${value}`,
		'Path=/',
		'HttpOnly',
		'Secure',
		// Lax 不是 Strict：Strict 会让「从外链点进 /admin」看起来像未登录。
		'SameSite=Lax',
		`Max-Age=${maxAge}`,
	].join('; ');
}

/**
 * 清 cookie。`Max-Age=0` 是唯一可靠的删除方式——只把值置空的话，
 * 一个空值 cookie 仍然会被发回来，而 `verifySession` 要额外处理这种形态。
 */
export function clearedSessionCookie(): string {
	return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export const RENEWED_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/**
 * 签发一条全新的会话，返回可以直接写进 `Set-Cookie` 的完整值。
 *
 * 登录、首次设置密码、中间件里的滑动续期三处都要"签一条 + 拼头"，
 * 合并成一个函数是为了让 `exp` 的算法只有一份。三处各写一遍的话，
 * 续期那条很容易写成在**旧的 exp** 上加 30 天，于是 cookie 的有效期
 * 每续一次就缩水一次——那是"用着用着突然要重新登录"的经典成因，
 * 而且会随使用频率变化，很难复现。
 */
export async function newSessionCookie(
	secret: string,
	epoch: number,
	nowSeconds: number,
): Promise<string> {
	const exp = nowSeconds + RENEWED_MAX_AGE_SECONDS;
	return sessionCookie(await signSession(secret, { exp, epoch }));
}

/**
 * 从请求头里取出会话 cookie 的值。
 *
 * 手写解析而不是用 `Astro.cookies`：这个函数要能被单测，
 * 而 `AstroCookies` 需要一个 Astro 的 context。中间件在拿到它之后
 * 仍然走 `verifySession`，两条路径不会漂移。
 *
 * 找不到、或 cookie 头畸形，都返回 null。
 */
export function readSessionCookie(request: Request): string | null {
	const header = request.headers.get('Cookie');
	if (!header) return null;

	for (const part of header.split(';')) {
		const eq = part.indexOf('=');
		if (eq === -1) continue;
		if (part.slice(0, eq).trim() !== SESSION_COOKIE) continue;
		const value = part.slice(eq + 1).trim();
		return value === '' ? null : value;
	}
	return null;
}

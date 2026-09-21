/**
 * 认证的原语：哈希、常数时间比较、密码哈希的编解码、IP 哈希。
 *
 * 这里**只有纯函数**，不碰 D1、不碰 Astro。会话逻辑在 `src/lib/session.ts`，
 * 限流策略在 `src/lib/rate-limit.ts`，HTTP 编排在路由里。
 *
 * ── 为什么 KDF 在浏览器里做 ────────────────────────────────────
 *
 * 免费版 Workers 每次请求只有 10ms CPU。PBKDF2-SHA256 60 万轮要 12–25ms，
 * 在服务端跑会直接抛 Error 1102（CPU 超限）。所以派生放在浏览器，
 * Worker 只做一次 SHA-256 + 一次常数时间比较。
 *
 * 用到的 WebCrypto（`crypto.subtle`）在 workerd 和 Node 24 里都是全局的，
 * 所以这个文件在两端行为一致、可以直接单测。
 */

/** PBKDF2 轮数。后台的校验会要求它**精确等于**这个值（见 parsePasswordHash）。 */
export const PBKDF2_ITERATIONS = 600_000;

/** SHA-256 / HMAC-SHA256 的十六进制长度。 */
const SHA256_HEX_LENGTH = 64;

// ─────────────────────────────────────────────────────────────── 十六进制

export function bytesToHex(bytes: Uint8Array): string {
	let out = '';
	for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
	return out;
}

export function hexToBytes(hex: string): Uint8Array {
	if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/.test(hex)) {
		throw new Error('不是合法的十六进制串');
	}
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i++) {
		out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	}
	return out;
}

/** 随机字节的十六进制。用于 salt 与 session_secret 的生成。 */
export function randomHex(byteLength: number): string {
	const bytes = new Uint8Array(byteLength);
	crypto.getRandomValues(bytes);
	return bytesToHex(bytes);
}

// ─────────────────────────────────────────────────────────────── 哈希

/**
 * 字符串的 SHA-256（十六进制小写）。
 *
 * 输入按 UTF-8 编码。全项目的摘要都由这个函数产出——只要上下游都走它，
 * 「按什么编码」就不会成为一个需要考虑的问题。
 */
export async function sha256Hex(input: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
	return bytesToHex(new Uint8Array(digest));
}

/** HMAC-SHA256（十六进制小写）。会话 cookie 的签名用它。 */
export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		// 密钥只用于签名，不给别的用途
		false,
		['sign'],
	);
	const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
	return bytesToHex(new Uint8Array(signature));
}

// ─────────────────────────────────────────────────────────────── 常数时间比较

/**
 * 两个十六进制串的常数时间比较。
 *
 * ── 为什么不用 crypto.timingSafeEqual ──────────────────────────
 *
 * 它是 **Node-only** 的，workerd 里不存在。调用它得到的是一个
 * `TypeError`，而报错信息里不会出现"时间攻击"这个词——所以这个坑的表现是
 * "线上登录接口 500"，很难联想到是缺一个 API。
 *
 * ── 为什么手写的版本必须长这样 ──────────────────────────────────
 *
 * 1. **长度差先折进结果，循环里不提前 return。**
 *    提前返回会让「前几位对了」和「一位都不对」的耗时可区分，
 *    而那正是攻击者要测的东西。所以差异是**累加**的，最后统一判定。
 *
 * 2. **用 `|=` 而不是 `^=`** 累加。
 *    异或可以被后一位抵消（`0x01 ^ 0x01 === 0`），于是长度不同时理论上
 *    能凑出 diff 为 0；按位或只增不减，不可能抵消。
 *
 * 3. **越界时 `charCodeAt` 返回 NaN，而 `NaN | 0 === 0`。**
 *    于是短的那个串自动按 0 补齐，不需要写补位分支——分支本身就是
 *    要避免的东西。长度差已经由第 1 条折进结果了。
 *
 * 4. 循环次数取两者较长的那个：比较次数不泄露长度信息。
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
	let diff = a.length ^ b.length;
	const len = Math.max(a.length, b.length);
	for (let i = 0; i < len; i++) {
		diff |= (a.charCodeAt(i) | 0) ^ (b.charCodeAt(i) | 0);
	}
	return diff === 0;
}

// ─────────────────────────────────────────────────────────────── 密码哈希

export interface PasswordHash {
	/** 十六进制盐 */
	salt: string;
	iterations: number;
	/** SHA-256(verifier) 的十六进制 */
	hash: string;
}

/**
 * 把浏览器送来的 verifier 变成库里存的东西。
 *
 * ── 为什么不直接存 verifier ────────────────────────────────────
 *
 * 因为 **verifier 本身就是凭证**：拿到它就能登录，不需要知道原始密码。
 * 库里存它的 SHA-256，于是 D1 被读走（或 F 盘镜像泄漏）时拿到的只是
 * 一个 256 位随机值的摘要，原像不可求。代价是每次登录多一次 SHA-256，
 * 微秒级，10ms 的预算里看不出来。
 *
 * ── 为什么哈希由 Worker 算而不是收客户端算好的 ────────────────
 *
 * 能从输入重算的东西就不要接收现成的——和「标签 segment 不信客户端」
 * 是同一条原则。
 *
 * 输入按 UTF-8 编码，也就是对**十六进制字符串的 ASCII 字节**做摘要。
 * 只要 setup 和 login 都走这个函数，具体编码是什么就不重要。
 */
export function hashVerifier(verifier: string): Promise<string> {
	return sha256Hex(verifier);
}

/** 打包成 `<saltHex>:<iterations>:<hashHex>`。 */
export function formatPasswordHash(entry: PasswordHash): string {
	return `${entry.salt}:${entry.iterations}:${entry.hash}`;
}

// ─────────────────────────────────────────────────────────────── 口令派生（浏览器侧）

/**
 * 口令 → verifier。**这个函数只在浏览器里跑**（`/login` 与 `/admin/setup`
 * 的内联脚本 import 它）。
 *
 * ── 为什么和 `hashVerifier` 放在同一个文件 ──────────────────────
 *
 * 这是整个认证方案里唯一有"两端必须用同一套参数"要求的地方。派生用的
 * `iterations`（以及以后可能换的 hash 算法）如果和校验那边对不上，
 * 表现是**口令永远不正确**——没有任何报错，只是登录页一直说密码错。
 * 放在同一个文件里，`PBKDF2_ITERATIONS` 就是同一个常量，对不上这件事
 * 在结构上不可能发生。
 *
 * 顺带一个好处：`src/lib/auth.ts` 是纯函数（只依赖全局的 `crypto.subtle`），
 * 所以浏览器脚本 import 它不会把任何服务端的东西带进客户端 bundle。
 *
 * ⚠️ 600 000 轮在现代机器上要 200–500ms。调用方**必须**给出等待反馈，
 * 否则用户会以为按钮没反应而重复点击。
 */
export async function deriveVerifier(
	passphrase: string,
	saltHex: string,
	iterations: number = PBKDF2_ITERATIONS,
): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(passphrase),
		'PBKDF2',
		// 派生用的密钥不可导出、用途只有派生
		false,
		['deriveBits'],
	);

	const bits = await crypto.subtle.deriveBits(
		{ name: 'PBKDF2', salt: hexToBytes(saltHex), iterations, hash: 'SHA-256' },
		key,
		256,
	);

	return bytesToHex(new Uint8Array(bits));
}

/**
 * 解析 `settings.password_hash`。
 *
 * **解析不出来一律返回 null，绝不抛错。** 这不是宽容，是刻意的：
 * 一个坏掉的字符串如果让登录接口 500，表现就是「密码明明是对的却进不去」，
 * 而错误信息里不会出现 settings 这个词。返回 null 让调用方退回
 * `/admin/setup`（当作"还没设过密码"），那是一个能自己走出来的状态。
 *
 * `iterations` 要求**精确等于** `PBKDF2_ITERATIONS`，不是 `>=`：
 * 用一个下界去检查，等于允许客户端悄悄把轮数降到 1——
 * 那是一次静默的、不可见的 KDF 降级。
 */
export function parsePasswordHash(raw: string | null | undefined): PasswordHash | null {
	if (!raw) return null;

	const parts = raw.split(':');
	if (parts.length !== 3) return null;

	const [salt, iterationsRaw, hash] = parts;
	if (!/^[0-9a-f]+$/.test(salt)) return null;
	if (hash.length !== SHA256_HEX_LENGTH || !/^[0-9a-f]+$/.test(hash)) return null;
	if (!/^[0-9]+$/.test(iterationsRaw)) return null;

	const iterations = Number(iterationsRaw);
	if (iterations !== PBKDF2_ITERATIONS) return null;

	return { salt, iterations, hash };
}

// ─────────────────────────────────────────────────────────────── IP 哈希

/** 全局限流那一行的哨兵键。见 `src/lib/rate-limit.ts` 与迁移文件里的注释。 */
export const GLOBAL_RATE_LIMIT_KEY = '__global__';

/**
 * IP → 限流表的键。
 *
 * **存哈希不存原始 IP**：限流只需要区分"是不是同一个来源"，不需要知道
 * 你是谁。没有盐的 IPv4 空间只有 2³²，彩虹表是秒级的，所以盐不可省。
 *
 * 返回值恒为 64 个十六进制字符，因此**不可能等于 `'__global__'`**——
 * 全局那一行不会被某个真实 IP 撞上。
 */
export function ipHash(ip: string, salt: string): Promise<string> {
	return sha256Hex(`${salt}:${ip}`);
}

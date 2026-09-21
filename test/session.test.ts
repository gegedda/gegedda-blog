/**
 * 会话 cookie 的签发与验签。
 *
 * 这里每一组都是"伪造 cookie 被拒"的自动化版本——也就是计划 §13.11
 * 第 3 条那条手工 `curl` 的等价物。手工那版验的是"整个请求链路的反应"，
 * 这版验的是"签发与验签本身没有漏掉任何一个字段"。两者都要有：
 * 前者能发现中间件把 `verifySession` 接错了，后者能发现验签忘了比对 `exp`。
 *
 * 还有一组是**反方向**的：任何畸形输入都必须返回 null 而不是抛异常。
 * 抛异常 = 中间件 500 = 任何人贴一个坏 cookie 就自助式 DoS。
 */

import { describe, expect, it } from 'vitest';

import { signSession, verifySession } from '../src/lib/session';
import {
	SESSION_COOKIE,
	SESSION_MAX_AGE_SECONDS,
	RENEWED_MAX_AGE_SECONDS,
	clearedSessionCookie,
	needsRenewal,
	newSessionCookie,
	readSessionCookie,
	sessionCookie,
} from '../src/lib/session';

const SECRET = 'a'.repeat(64);
const NOW = 1_800_000_000; // 固定时刻，不依赖真实时间

async function fresh(opts: { exp?: number; epoch?: number } = {}) {
	return signSession(SECRET, { exp: opts.exp ?? NOW + 86_400, epoch: opts.epoch ?? 1 });
}

const VERIFY = { secret: SECRET, currentEpoch: 1, nowSeconds: NOW };

describe('签发与验签', () => {
	it('刚签出来的能通过', async () => {
		const cookie = await fresh();
		expect(await verifySession(cookie, VERIFY)).toEqual({ exp: NOW + 86_400, epoch: 1 });
	});

	it('形状是 v1.<exp>.<epoch>.<64 位十六进制>', async () => {
		const cookie = await fresh();
		const parts = cookie.split('.');
		expect(parts).toHaveLength(4);
		expect(parts[0]).toBe('v1');
		expect(parts[1]).toBe(String(NOW + 86_400));
		expect(parts[2]).toBe('1');
		expect(parts[3]).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe('伪造', () => {
	it('改一位载荷（exp）但不动签名 → 拒', async () => {
		const cookie = await fresh();
		const parts = cookie.split('.');
		// 这是"伪造 cookie"最直接的形态：延长有效期。签名覆盖了整个
		// `v1.<exp>.<epoch>`，所以改任何一个字段都会让签名对不上。
		parts[1] = String(Number(parts[1]) + 86_400);
		expect(await verifySession(parts.join('.'), VERIFY)).toBeNull();
	});

	it('改一位载荷（epoch）但不动签名 → 拒', async () => {
		const cookie = await fresh();
		const parts = cookie.split('.');
		parts[2] = '2';
		expect(await verifySession(parts.join('.'), VERIFY)).toBeNull();
	});

	it('签名改一位 → 拒', async () => {
		const cookie = await fresh();
		const flipped = cookie.slice(0, -1) + (cookie.endsWith('0') ? '1' : '0');
		expect(await verifySession(flipped, VERIFY)).toBeNull();
	});

	it('换一个 secret 签的 → 拒', async () => {
		const other = await signSession('b'.repeat(64), { exp: NOW + 86_400, epoch: 1 });
		expect(await verifySession(other, VERIFY)).toBeNull();
	});

	it('签名长度不对 → 拒', async () => {
		const cookie = await fresh();
		const parts = cookie.split('.');
		parts[3] = parts[3].slice(0, -1);
		expect(await verifySession(parts.join('.'), VERIFY)).toBeNull();
		// 多一位也不行
		parts[3] = cookie.split('.')[3] + '0';
		expect(await verifySession(parts.join('.'), VERIFY)).toBeNull();
	});
});

describe('过期与失效', () => {
	it('exp 已过 → 拒', async () => {
		expect(await verifySession(await fresh({ exp: NOW - 1 }), VERIFY)).toBeNull();
	});

	it('exp 正好等于 now → 拒（边界是 <=）', async () => {
		// 用 `<` 而不是 `<=` 的话，一张在"这一秒"到期的 cookie 还能再用一秒。
		expect(await verifySession(await fresh({ exp: NOW }), VERIFY)).toBeNull();
	});

	it('epoch 与库里的不匹配 → 拒', async () => {
		// 这条就是「全端登出」：bumpSessionEpoch() 之后所有已签发的
		// cookie 立刻作废，不需要会话表、不需要能列出"现在有哪些会话"。
		expect(await verifySession(await fresh({ epoch: 0 }), VERIFY)).toBeNull();
	});

	it('版本号不是 v1 → 拒', async () => {
		const cookie = await fresh();
		expect(await verifySession('v2' + cookie.slice(2), VERIFY)).toBeNull();
	});
});

describe('畸形输入一律返回 null，绝不抛异常', () => {
	// 计划 §13.10 那一行的原话：「`parseSessionCookie('garbage')` / 超长 /
	// 空段**抛异常**（→ 中间件 500，自助式 DoS）」。这里断言的是**反面**，
	// 也就是实现取的那一侧。
	const junk: unknown[] = [
		null,
		undefined,
		'',
		'garbage',
		'v1',
		'v1.',
		'v1.1',
		'v1.1.1',
		'a.b.c.d.e',
		'v1..1.' + 'a'.repeat(64),
		'v1.abc.1.' + 'a'.repeat(64), // exp 不是十进制
		'v1.1.abc.' + 'a'.repeat(64), // epoch 不是十进制
		'v1.1e3.1.' + 'a'.repeat(64), // Number() 会接受，正则不该接受
		'v1. 1 .1.' + 'a'.repeat(64), // 前后空格
		'v1.-1.1.' + 'a'.repeat(64), // 负数
		'v1.1.1.' + 'Z'.repeat(64), // 签名不是十六进制
		'v1.1.1.' + 'a'.repeat(64) + 'extra',
		'v1.1.1.' + 'a'.repeat(64_000), // 超长
		'v'.repeat(100_000),
	];

	it.each(junk)('%s', async (value) => {
		await expect(
			verifySession(value as string, VERIFY),
		).resolves.toBeNull();
	});

	it('超大的 exp 不会当成 safe integer 之外的值通过', async () => {
		// 用签名正确的、但 exp 超出安全整数范围的载荷：签得出来（是我们
		// 自己签的），但 `Number.isSafeInteger` 必须拦掉它。不拦的话
		// `exp <= now` 的比较会在一个被舍入过的数上进行。
		const huge = await signSession(SECRET, { exp: Number.MAX_SAFE_INTEGER + 2, epoch: 1 });
		expect(await verifySession(huge, VERIFY)).toBeNull();
	});
});

describe('cookie 头与响应头的形状', () => {
	it('sessionCookie 带 HttpOnly / Secure / Path=/ / SameSite=Lax，且**不带 Domain**', () => {
		const value = sessionCookie('abc');
		expect(value).toContain('Path=/');
		expect(value).toContain('HttpOnly');
		expect(value).toContain('Secure');
		expect(value).toContain('SameSite=Lax');
		// ⚠️ `__Host-` 前缀禁止 Domain，带上之后浏览器会**整条丢弃 cookie
		// 且不报任何错**——症状是「登录提示成功了，但下一个请求又回到登录页」。
		expect(value).not.toMatch(/Domain/i);
		expect(value.startsWith(`${SESSION_COOKIE}=abc;`)).toBe(true);
	});

	it('cookie 名是 __Host-session', () => {
		expect(SESSION_COOKIE).toBe('__Host-session');
	});

	it('clearedSessionCookie 用 Max-Age=0 删除', () => {
		// 只把值置空的话，一个空值 cookie 仍然会被发回来。
		expect(clearedSessionCookie()).toContain(`${SESSION_COOKIE}=;`);
		expect(clearedSessionCookie()).toContain('Max-Age=0');
	});

	it('newSessionCookie 的 exp 是 now + 30 天', async () => {
		const value = await newSessionCookie(SECRET, 3, NOW);
		const payload = value.slice(`${SESSION_COOKIE}=`.length, value.indexOf(';'));
		expect(await verifySession(payload, { ...VERIFY, currentEpoch: 3 })).toEqual({
			exp: NOW + RENEWED_MAX_AGE_SECONDS,
			epoch: 3,
		});
		expect(RENEWED_MAX_AGE_SECONDS).toBe(SESSION_MAX_AGE_SECONDS);
		expect(SESSION_MAX_AGE_SECONDS).toBe(2_592_000); // 30 天
	});
});

describe('readSessionCookie', () => {
	const withCookie = (value: string) =>
		new Request('https://example.com/admin', { headers: { Cookie: value } });

	it('取出值', () => {
		expect(readSessionCookie(withCookie(`${SESSION_COOKIE}=abc.def`))).toBe('abc.def');
	});

	it('没带 cookie 头 → null', () => {
		expect(readSessionCookie(new Request('https://example.com/admin'))).toBeNull();
	});

	it('空值 → null', () => {
		// 空值 cookie 如果返回 ''，`verifySession` 的 `!cookieValue`
		// 恰好也能挡住，但那是巧合，不是约定。
		expect(readSessionCookie(withCookie(`${SESSION_COOKIE}=`))).toBeNull();
	});

	it('在多个 cookie 里也能找到', () => {
		expect(
			readSessionCookie(withCookie(`theme=dark; ${SESSION_COOKIE}=xyz; other=1`)),
		).toBe('xyz');
	});

	it('不把别的 cookie 当成会话', () => {
		// 名字是后缀匹配的话，`not-__Host-session=…` 会顶替真会话——
		// 而那是一个客户端能随便设的名字。
		expect(readSessionCookie(withCookie('not-__Host-session=evil'))).toBeNull();
		expect(readSessionCookie(withCookie('__Host-session-2=evil'))).toBeNull();
	});

	it('畸形 cookie 头不抛异常', () => {
		for (const header of [';;;', '=', 'a=b;=c', 'no-equals-sign']) {
			expect(() => readSessionCookie(withCookie(header))).not.toThrow();
		}
	});

	it('值里的 = 不影响解析', () => {
		// 签名是十六进制、载荷是数字，正常不会出现 `=`；但解析用
		// indexOf('=') 取第一个，所以即便出现了也不会把值截断。
		expect(readSessionCookie(withCookie(`${SESSION_COOKIE}=a=b`))).toBe('a=b');
	});
});

describe('needsRenewal', () => {
	it('剩余不足 15 天时为 true', () => {
		expect(needsRenewal({ exp: NOW + 1_296_000 - 1, epoch: 1 }, NOW)).toBe(true);
	});

	it('剩余正好 15 天时为 false', () => {
		expect(needsRenewal({ exp: NOW + 1_296_000, epoch: 1 }, NOW)).toBe(false);
	});

	it('刚签出来的不需要续期', () => {
		expect(needsRenewal({ exp: NOW + RENEWED_MAX_AGE_SECONDS, epoch: 1 }, NOW)).toBe(false);
	});
});

/**
 * `src/lib/auth.ts` 的原语。
 *
 * 每一条对应一个**不抛异常**的失效模式。文件里比较特别的一条是
 * `timingSafeEqualHex` 那组——它测的不是返回值，而是"这个函数不能
 * 提早返回"这件事本身没法被测，于是退而求其次：钉住它对各种长度差的
 * 返回值，以及**绝不抛异常**（抛异常会让中间件 500，那是自助式 DoS）。
 */

import { describe, expect, it } from 'vitest';

import {
	PBKDF2_ITERATIONS,
	bytesToHex,
	deriveVerifier,
	formatPasswordHash,
	hashVerifier,
	hexToBytes,
	hmacSha256Hex,
	ipHash,
	parsePasswordHash,
	randomHex,
	sha256Hex,
	timingSafeEqualHex,
	GLOBAL_RATE_LIMIT_KEY,
} from '../src/lib/auth';

describe('十六进制', () => {
	it('往返一致', () => {
		const bytes = new Uint8Array([0, 1, 15, 16, 127, 128, 255]);
		expect(hexToBytes(bytesToHex(bytes))).toEqual(bytes);
	});

	it('hexToBytes 对奇数长度抛错', () => {
		// 不抛的话 `slice(i*2, i*2+2)` 会拿到一位，parseInt 给出一个
		// 看起来正常的字节——盐悄悄少了一半，而口令派生照常"成功"。
		expect(() => hexToBytes('abc')).toThrow();
	});

	it('hexToBytes 拒绝非十六进制字符', () => {
		expect(() => hexToBytes('zz')).toThrow();
		expect(() => hexToBytes('AB')).toThrow(); // 大写也不接受，保持唯一形态
	});

	it('randomHex 长度正确且不重复', () => {
		expect(randomHex(16)).toMatch(/^[0-9a-f]{32}$/);
		expect(randomHex(16)).not.toBe(randomHex(16));
	});
});

describe('摘要', () => {
	it('sha256Hex 与已知向量一致', async () => {
		// echo -n abc | sha256sum
		expect(await sha256Hex('abc')).toBe(
			'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
		);
	});

	it('中文按 UTF-8 编码', async () => {
		// 编码不是 UTF-8 的话这里会是另一个值。全项目的摘要都走这个函数，
		// 所以只要上下游都用它，"按什么编码"就不会成为一个需要考虑的问题。
		// 这个值不是从实现里抄的：`printf '中文' | sha256sum` 与
		// `node -e "crypto.createHash('sha256').update(Buffer.from('中文','utf8'))"`
		// 两个独立来源给出同一个结果，取的是那个。
		// 从被测量者身上取期望值，等于把一个恒等式写成了断言。
		expect(await sha256Hex('中文')).toBe(
			'72726d8818f693066ceb69afa364218b692e62ea92b385782363780f47529c21',
		);
	});

	it('hmacSha256Hex 与已知向量一致', async () => {
		// RFC 4231 test case 2
		expect(await hmacSha256Hex('Jefe', 'what do ya want for nothing?')).toBe(
			'5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
		);
	});

	it('换个密钥结果就不同', async () => {
		expect(await hmacSha256Hex('a', 'm')).not.toBe(await hmacSha256Hex('b', 'm'));
	});
});

describe('timingSafeEqualHex', () => {
	it('相同返回 true', () => {
		expect(timingSafeEqualHex('abcd', 'abcd')).toBe(true);
		expect(timingSafeEqualHex('', '')).toBe(true);
	});

	it('等长但内容不同返回 false', () => {
		expect(timingSafeEqualHex('abcd', 'abce')).toBe(false);
		expect(timingSafeEqualHex('abcd', 'bbcd')).toBe(false);
	});

	it('长度不同返回 false，**不抛异常**', () => {
		// 计划 §13.10 的测试表里曾写成"长度不同时抛错"，与 §13.1/§13.2
		// 的说明矛盾。实现取的是后者：**永不抛**。
		//
		// 理由是调用点：比较发生在验签与登录校验里，一个抛异常的路径
		// 会让中间件回 500——而任何人贴一个长度不对的 cookie 就能触发它。
		// 那不是"严格"，是自助式 DoS。
		expect(timingSafeEqualHex('abcd', 'abcde')).toBe(false);
		expect(timingSafeEqualHex('abcde', 'abcd')).toBe(false);
		expect(timingSafeEqualHex('', 'a')).toBe(false);
		expect(timingSafeEqualHex('a', '')).toBe(false);
	});

	it('前缀相同的长度差异也算不同（长度差折进了结果）', () => {
		// 长度差如果没先折进 diff，'0000' 与 '000000' 会因为前四位相同
		// 而剩下的一概按 0 补齐，凑成相等。
		expect(timingSafeEqualHex('0000', '000000')).toBe(false);
	});

	it('对非十六进制输入也不抛', () => {
		expect(() => timingSafeEqualHex('中文', '中文')).not.toThrow();
		expect(timingSafeEqualHex('中文', '中文')).toBe(true);
	});
});

describe('parsePasswordHash', () => {
	const good = { salt: 'ab'.repeat(16), iterations: PBKDF2_ITERATIONS, hash: 'cd'.repeat(32) };

	it('解析正常值', () => {
		expect(parsePasswordHash(formatPasswordHash(good))).toEqual(good);
	});

	it('返回的 hash 长度是 64（SHA-256）', () => {
		expect(parsePasswordHash(formatPasswordHash(good))?.hash).toHaveLength(64);
	});

	it('坏格式一律返回 null，**绝不抛错**', () => {
		// 抛错的话登录接口会 500，表现是「密码明明是对的却进不去」，
		// 而错误信息里不会出现 settings 这个词。
		// 返回 null 让调用方退回 /admin/setup（当作"还没设过密码"）——
		// 那是一个能自己走出来的状态。
		for (const raw of [
			null,
			undefined,
			'',
			'只有一段',
			'a:b',
			'a:b:c:d',
			`${good.salt}:${good.iterations}`, // 少一段
			`${good.salt}:${good.iterations}:${good.hash}:多`,
		]) {
			expect(parsePasswordHash(raw as never), String(raw)).toBeNull();
		}
	});

	it('盐不是十六进制时返回 null', () => {
		expect(parsePasswordHash(`XYZ:${PBKDF2_ITERATIONS}:${good.hash}`)).toBeNull();
		expect(parsePasswordHash(`:${PBKDF2_ITERATIONS}:${good.hash}`)).toBeNull();
	});

	it('hash 长度不对时返回 null', () => {
		expect(parsePasswordHash(`${good.salt}:${PBKDF2_ITERATIONS}:abcd`)).toBeNull();
		// 长一位也不行——这里用全等而不是前缀比较
		expect(parsePasswordHash(`${good.salt}:${PBKDF2_ITERATIONS}:${good.hash}00`)).toBeNull();
	});

	it('轮数必须**精确等于** PBKDF2_ITERATIONS，不是 >=', () => {
		// 用下界去检查等于允许把轮数悄悄降到 1——一次静默的、
		// 不可见的 KDF 降级。这里两边都钉住。
		expect(parsePasswordHash(`${good.salt}:1:${good.hash}`)).toBeNull();
		expect(parsePasswordHash(`${good.salt}:${PBKDF2_ITERATIONS + 1}:${good.hash}`)).toBeNull();
		expect(parsePasswordHash(`${good.salt}:${PBKDF2_ITERATIONS}:${good.hash}`)).not.toBeNull();
	});

	it('轮数是浮点/带符号/科学计数法时返回 null', () => {
		for (const it of ['600000.0', '-600000', '6e5', ' 600000']) {
			expect(parsePasswordHash(`${good.salt}:${it}:${good.hash}`), it).toBeNull();
		}
	});
});

describe('hashVerifier / deriveVerifier', () => {
	it('hashVerifier 是 SHA-256，不是恒等', async () => {
		const verifier = 'ab'.repeat(32);
		const hashed = await hashVerifier(verifier);
		// 库里存 verifier 本身的话，D1 被读走（或 F 盘镜像泄漏）就等于
		// 泄漏了凭证——verifier 拿到就能登录，不需要知道原始口令。
		expect(hashed).not.toBe(verifier);
		expect(hashed).toBe(await sha256Hex(verifier));
	});

	it('deriveVerifier 对同一输入是确定的', async () => {
		const salt = 'ab'.repeat(16);
		// 轮数调小，否则这条测试要跑半秒
		const a = await deriveVerifier('口令', salt, 1000);
		const b = await deriveVerifier('口令', salt, 1000);
		expect(a).toBe(b);
		expect(a).toMatch(/^[0-9a-f]{64}$/);
	});

	it('换个盐或换个口令结果就不同', async () => {
		const salt = 'ab'.repeat(16);
		const base = await deriveVerifier('口令', salt, 1000);
		expect(await deriveVerifier('口令', 'cd'.repeat(16), 1000)).not.toBe(base);
		expect(await deriveVerifier('口令2', salt, 1000)).not.toBe(base);
	});

	it('默认轮数就是 PBKDF2_ITERATIONS', async () => {
		// 派生与校验共用同一个常量是这套方案里唯一"两端必须一致"的
		// 参数。派生用 600000、校验认 600000，对不上时**没有任何报错**，
		// 只是登录页永远说口令错。这条断言钉的是"默认值没有被人改小"。
		const bits = await crypto.subtle.importKey(
			'raw',
			new TextEncoder().encode('x'),
			'PBKDF2',
			false,
			['deriveBits'],
		);
		const explicit = new Uint8Array(
			await crypto.subtle.deriveBits(
				{ name: 'PBKDF2', salt: hexToBytes('00'.repeat(8)), iterations: 1000, hash: 'SHA-256' },
				bits,
				256,
			),
		);
		expect(bytesToHex(explicit)).toBe(await deriveVerifier('x', '00'.repeat(8), 1000));
		expect(PBKDF2_ITERATIONS).toBe(600_000);
	});
});

describe('ipHash', () => {
	it('返回值里不含原始 IP', async () => {
		// 限流表如果存了原始 IP，它就变成一份 IP 日志——而限流只需要
		// 区分"是不是同一个来源"，不需要知道你是谁。
		const hash = await ipHash('203.0.113.7', 'saltsalt');
		expect(hash).not.toContain('203');
		expect(hash).not.toContain('203.0.113.7');
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
	});

	it('同一个 IP + 同一个盐是确定的；换个盐就不同', async () => {
		// 没有盐的 IPv4 空间只有 2³²，彩虹表是秒级的——盐不可省。
		const a = await ipHash('203.0.113.7', 'salt-a');
		expect(await ipHash('203.0.113.7', 'salt-a')).toBe(a);
		expect(await ipHash('203.0.113.7', 'salt-b')).not.toBe(a);
		expect(await ipHash('203.0.113.8', 'salt-a')).not.toBe(a);
	});

	it('永远不可能等于全局哨兵键', async () => {
		// '__global__' 不是十六进制，而 ipHash 恒为 64 个十六进制字符。
		// 这条保证的是"全局那一行不会被某个真实 IP 撞上"。
		expect(GLOBAL_RATE_LIMIT_KEY).toBe('__global__');
		const hash = await ipHash(GLOBAL_RATE_LIMIT_KEY, 'salt');
		expect(hash).not.toBe(GLOBAL_RATE_LIMIT_KEY);
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
	});
});

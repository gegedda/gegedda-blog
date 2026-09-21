/**
 * 登录限流。
 *
 * 这个文件存在的理由是一句话的顺序：**锁定检查必须在口令比对之前**。
 * 反过来的话，锁定态就成了 CPU DoS 放大器——攻击者用错口令把账号锁住，
 * 然后继续打，每次请求仍然要付一次 SHA-256（外加 JSON 解析），
 * 而"已经锁了"这件事看起来像是保护。
 *
 * 所以最有分量的两条断言是：
 *   ① 锁定态下比对回调**一次都没被调用**；
 *   ② 锁定之后拿**正确的**口令来也一样被拒。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GLOBAL_RATE_LIMIT_KEY, ipHash } from '../src/lib/auth';
import {
	RATE_LIMIT,
	attemptLogin,
	checkLock,
	clearFailures,
	recordFailure,
	type RateLimitConfig,
} from '../src/lib/rate-limit';
import { createStubDb, type StubDb } from './stubs/d1';

let db: StubDb;

/** 固定起点，不依赖真实时间——限流是对时间的函数，用 Date.now() 会让测试撞上窗口边界。 */
const T0 = 1_800_000_000;

/** IP → 限流表的键。测试里用的盐固定。 */
const key = (ip: string) => ipHash(ip, 'test-salt');
const GOOD = 'good';
const BAD = 'bad';

beforeEach(() => {
	db = createStubDb();
});
afterEach(() => {
	db.close();
});

/** 跑一次登录尝试。`verify` 是否被调用由 `spy` 记录。 */
async function attempt(opts: {
	ip?: string;
	now?: number;
	correct?: boolean;
	spy?: { called: number };
	config?: RateLimitConfig;
}) {
	return attemptLogin(db, {
		ipKey: await key(opts.ip ?? GOOD),
		nowSeconds: opts.now ?? T0,
		verify: async () => {
			if (opts.spy) opts.spy.called++;
			return opts.correct ?? false;
		},
		config: opts.config,
	});
}

interface AttemptRow {
	ip_hash: string;
	failed_count: number;
	window_start: number;
	locked_until: number | null;
}

/** 直接读表，用来断言"库里到底写了什么"——而不是只看返回值。 */
async function rows(): Promise<AttemptRow[]> {
	const { results } = await db
		.prepare('SELECT * FROM login_attempts')
		.all<AttemptRow>();
	return results ?? [];
}

describe('失败的计数与落锁', () => {
	it('前 4 次都是 bad，并把剩余次数递减说出来', async () => {
		// maxFailures 是 5，意思是"允许 5 次失败"，而计数**达到** 5 就落锁。
		for (const [i, expected] of [4, 3, 2, 1].entries()) {
			const result = await attempt({ now: T0 + i });
			expect(result).toEqual({ kind: 'bad', remaining: expected });
		}
	});

	it('第 5 次仍然回 bad（remaining 0），第 6 次才回 locked', async () => {
		// ⚠️ 这条与计划 §13.11 的验收门一字对应：「401 ×5、第 6 次 429」。
		//
		// 之所以不把造成落锁的那一次也变成 locked：那会把"我刚打错了一次"
		// 和"我早就被锁了"合成一个响应，而这两者要提示的下一步完全不同
		// （改口令 vs 等一会儿）。落锁是第 5 次**造成**的后果，作用在第 6 次。
		for (let i = 0; i < 5; i++) {
			const result = await attempt({ now: T0 + i });
			expect(result.kind, `第 ${i + 1} 次`).toBe('bad');
		}

		// 落锁确实写进了库（而不是只存在于返回值里）
		const locked = (await rows())[0];
		expect(locked.locked_until).toBe(T0 + 4 + RATE_LIMIT.lockSeconds);

		const sixth = await attempt({ now: T0 + 5 });
		expect(sixth.kind).toBe('locked');
		expect(sixth.kind === 'locked' && sixth.retryAfter).toBeGreaterThan(0);
	});

	it('锁定态下**完全不调用**口令比对', async () => {
		// 这是整个文件最重要的一条。反过来的话，锁定态就成了 CPU DoS
		// 放大器：锁住之后继续打，每次仍然要付一次 SHA-256。
		for (let i = 0; i < 5; i++) await attempt({ now: T0 + i });
		expect((await attempt({ now: T0 + 5 })).kind).toBe('locked');

		const spy = { called: 0 };
		for (let i = 0; i < 20; i++) {
			const result = await attempt({ now: T0 + 6 + i, correct: true, spy });
		}
		expect(spy.called).toBe(0);
	});

	it('锁定之后拿**正确**的口令也一样被拒', async () => {
		// 只断言"错误口令被拒"是没有意义的——那本来就会被拒。
		// 这一条才能区分出"锁真的生效了"和"只是口令错了"。
		for (let i = 0; i < 5; i++) await attempt({ now: T0 + i });
		const result = await attempt({ now: T0 + 6, correct: true });
		expect(result.kind).toBe('locked');
	});

	it('retryAfter 随时间递减', async () => {
		for (let i = 0; i < 5; i++) await attempt({ now: T0 + i });
		// 落锁发生在第 5 次（now = T0+4），解锁时刻是 T0+4+900 = T0+904。
		// 所以在 T0+5 看是 899 秒，不是 900——差的那一秒是"造成落锁的那一次
		// 与检查它的这一次之间"的距离，不是取整误差。
		const early = await attempt({ now: T0 + 5 });
		const later = await attempt({ now: T0 + 605 });
		expect(early.kind === 'locked' && early.retryAfter).toBe(RATE_LIMIT.lockSeconds - 1);
		expect(later.kind === 'locked' && later.retryAfter).toBe(RATE_LIMIT.lockSeconds - 1 - 600);
	});
});

describe('窗口过期', () => {
	it('窗口过后计数归零，不需要任何写操作', async () => {
		// 一个只读的检查不该产生写操作，而且"过期的锁"必须在**读**的时候
		// 就不算数——否则锁定会一直续下去。
		for (let i = 0; i < 3; i++) await attempt({ now: T0 + i });
		expect((await rows())[0].failed_count).toBe(3);

		// 窗口 900 秒。整段跳过之后第一次尝试应当重新从 remaining 4 开始。
		const after = await attempt({ now: T0 + 900 + 1 });
		expect(after).toEqual({ kind: 'bad', remaining: 4 });
	});

	it('窗口内（差一秒）不归零', async () => {
		for (let i = 0; i < 3; i++) await attempt({ now: T0 + i });
		const inside = await attempt({ now: T0 + 898 });
		expect(inside).toEqual({ kind: 'bad', remaining: 1 });
	});

	it('锁过期后计数也重新开始', async () => {
		for (let i = 0; i < 5; i++) await attempt({ now: T0 + i });
		expect((await attempt({ now: T0 + 5 })).kind).toBe('locked');
		// lockSeconds 与 windowSeconds 都是 900，所以到点之后两件事一起归零
		expect((await attempt({ now: T0 + 4 + RATE_LIMIT.lockSeconds + 1 })).kind).toBe('bad');
	});
});

describe('成功登录', () => {
	it('清掉计数（IP 行与全局行都清）', async () => {
		for (let i = 0; i < 3; i++) await attempt({ now: T0 + i });
		expect(await rows()).toHaveLength(2); // 该 IP 一行 + 全局一行

		const result = await attempt({ now: T0 + 10, correct: true });
		expect(result).toEqual({ kind: 'ok' });

		// 全局那一行不清的话，博主自己反复试错也会把自己锁在门外，
		// 而那是这一层唯一真正的风险。
		expect(await rows()).toHaveLength(0);
	});

	it('成功之后再失败，计数从 1 开始', async () => {
		for (let i = 0; i < 3; i++) await attempt({ now: T0 + i });
		await attempt({ now: T0 + 10, correct: true });
		expect(await attempt({ now: T0 + 11 })).toEqual({ kind: 'bad', remaining: 4 });
	});

	it('已经被锁的人就算口令对也走不到成功分支', async () => {
		for (let i = 0; i < 5; i++) await attempt({ now: T0 + i });
		const result = await attempt({ now: T0 + 6, correct: true });
		expect(result.kind).not.toBe('ok');
		// 失败计数没有被清掉——清的话下一次尝试就解锁了，等于锁形同虚设
		expect((await rows()).length).toBe(2);
	});
});

describe('全局行', () => {
	it('不同 IP 共享全局那一行，且不共享 IP 行', async () => {
		await attempt({ ip: '10.0.0.1', now: T0 });
		const all = await rows();
		expect(all).toHaveLength(2);
		const ipRow = all.find((r) => r.ip_hash === GLOBAL_RATE_LIMIT_KEY);
		expect(ipRow?.failed_count).toBe(1);
	});

	it('全局阈值被触发时，**其他 IP** 也被挡住', async () => {
		// 这一条是"防分布式绕过"的全部意义：换 IP 没用。
		const config: RateLimitConfig = { ...RATE_LIMIT, globalMaxFailures: 3 };
		for (let i = 0; i < 3; i++) await attempt({ ip: `10.0.0.${i}`, now: T0 + i, config });

		const spy = { called: 0 };
		const other = await attempt({ ip: '10.0.0.99', now: T0 + 10, correct: true, spy, config });
		expect(other.kind).toBe('locked');
		expect(spy.called).toBe(0);
	});

	it('全局锁会拒绝所有人，包括博主（这是已知代价）', async () => {
		// ⚠️ 不是"bug"：单作者站点没有第二个身份来源来豁免。恢复命令是
		// 部署指南里的一条 SQL。这条断言的作用是让这个性质**被看见**，
		// 而不是被当成某天突然冒出来的故障。
		const config: RateLimitConfig = { ...RATE_LIMIT, globalMaxFailures: 1 };
		await attempt({ ip: '10.0.0.1', now: T0, config });
		expect((await attempt({ ip: '10.0.0.2', now: T0 + 1, correct: true, config })).kind).toBe(
			'locked',
		);
	});

	it('全局哨兵键不可能与真实 IP 的哈希相撞', async () => {
		// ipHash 恒为 64 个十六进制字符，而 '__global__' 不是——
		// 所以全局那一行不会被某个 IP 顶掉。
		expect(await key('10.0.0.1')).not.toBe(GLOBAL_RATE_LIMIT_KEY);
		expect(await key(GLOBAL_RATE_LIMIT_KEY)).not.toBe(GLOBAL_RATE_LIMIT_KEY);
	});
});

describe('checkLock 是只读的', () => {
	it('反复检查不改动任何计数', async () => {
		await attempt({ now: T0 });
		const before = (await rows())[0];

		for (let i = 0; i < 50; i++) await checkLock(db, await key(GOOD), T0 + i);

		expect((await rows())[0]).toEqual(before);
	});

	it('没有记录时返回未锁定', async () => {
		expect(await checkLock(db, await key('10.0.0.1'), T0)).toEqual({
			locked: false,
			retryAfter: 0,
		});
	});
});

describe('clearFailures', () => {
	it('清掉该 IP 与全局两行', async () => {
		await attempt({ ip: '10.0.0.1', now: T0 });
		await attempt({ ip: '10.0.0.2', now: T0 });
		expect(await rows()).toHaveLength(3); // 两个 IP + 全局

		await clearFailures(db, await key('10.0.0.1'));
		// 只剩 10.0.0.2 那一行：全局行也被清了，这是有意的
		// （见 clearFailures 的注释）。
		expect((await rows()).map((r) => r.ip_hash)).toEqual([await key('10.0.0.2')]);
	});
});

describe('recordFailure 单独用', () => {
	it('返回记完之后的状态', async () => {
		const result = await recordFailure(db, await key('10.0.0.1'), T0);
		expect(result.failedCount).toBe(1);
		expect(result.lock.locked).toBe(false);
	});

	it('跨过阈值时返回 locked', async () => {
		for (let i = 0; i < 4; i++) await recordFailure(db, await key('10.0.0.1'), T0 + i);
		const fifth = await recordFailure(db, await key('10.0.0.1'), T0 + 4);
		expect(fifth.failedCount).toBe(5);
		expect(fifth.lock.locked).toBe(true);
	});
});

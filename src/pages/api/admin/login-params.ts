/**
 * `GET /api/admin/login-params` —— 登录页要用的两个公开参数。
 *
 * 返回 `{ salt, iterations }`，**两个都不是秘密**：
 *
 *   - `salt` 是给 PBKDF2 用的，它的作用是让同样的口令在不同站点派生出不同的
 *     verifier（防彩虹表），不是为了保密。
 *   - `iterations` 是轮数。公布它是刻意的——客户端必须用**服务端认定的**
 *     轮数来派生，否则升级轮数时旧客户端会算出对不上的 verifier，
 *     表现是"密码没变但登不进去"。
 *
 * 两者其实也已经内联在 `/login` 的 HTML 里了（省掉一次往返）。这个接口是
 * 给脚本和无 JavaScript 的场景留的，也方便 `curl` 做验收。
 *
 * 没设过密码时 404：这时客户端唯一该去的地方是 `/admin/setup`。
 */

import type { APIRoute } from 'astro';

import { PBKDF2_ITERATIONS, parsePasswordHash } from '../../../lib/auth';
import { fail, json } from '../../../lib/api';
import { getDb } from '../../../lib/db';
import { getPasswordHashRaw } from '../../../lib/settings';

export const GET: APIRoute = async () => {
	const db = getDb();
	const stored = parsePasswordHash(await getPasswordHashRaw(db));

	if (!stored) {
		// 解析不出来和没设过走同一条路：都当作"还没设密码"。
		// 这个判断和 `parsePasswordHash` 的宽容策略是一致的——
		// 一个坏掉的字符串不该让登录接口永远 500。
		return fail(404, '还没有设置后台密码，请先访问 /admin/setup');
	}

	return json({
		salt: stored.salt,
		iterations: PBKDF2_ITERATIONS,
	});
};

/**
 * D1 句柄。
 *
 * **全项目唯一**碰 `cloudflare:workers` 的文件。数据访问层一律通过参数接收
 * `D1Database`，不自己来取——这样 repo 可以在 workerd 之外被测试，
 * 也换不掉底下的库。
 *
 * 为什么不走 `Astro.locals.runtime.env`：adapter v13+ 已经移除了它，
 * 访问会直接抛错，不是返回 undefined。`cloudflare:workers` 的 `env`
 * 是现在唯一受支持的运行时注入方式，而且它在模块作用域里是惰性求值的，
 * 在 workerd 之外 import 这个文件不会立刻炸（但调 getDb() 会）。
 */

import { env } from 'cloudflare:workers';

export function getDb(): D1Database {
	const db = (env as unknown as { DB?: D1Database }).DB;
	if (!db) {
		// 绑定名写错时的表现是"所有页面都 500"，报错信息里不会出现 DB 这个词，
		// 于是很容易去查数据而不是查 wrangler.jsonc。这里明确点出来。
		throw new Error('D1 绑定 DB 不存在。检查 wrangler.jsonc 的 d1_databases[].binding');
	}
	return db;
}

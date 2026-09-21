/**
 * `App.Locals` 的声明合并。
 *
 * Astro 7 给应用扩展 `Astro.locals` 的唯一方式是往里塞一个空的
 * `interface Locals {}`（见 `node_modules/astro/dist/types/public/extendables.d.ts`），
 * 声明合并把字段加进去。
 *
 * ── 为什么必须写 `declare global` ──────────────────────────────
 *
 * 这个文件 import 了类型，因此它在 TS 眼里是一个**模块**，而模块里的
 * `namespace App` 不再是全局的命名空间——合并会失败，`Astro.locals.admin`
 * 的类型退化成 `unknown`，**而 TS 不报错**。
 *
 * 更麻烦的是本项目的 `npm run verify` 里既没有 `astro check` 也没有 `tsc`，
 * 所以类型错了连构建都不会失败。它只会表现为：页面里写
 * `Astro.locals.admin.exp` 编译期通过、运行时炸，或者防御写成了 `any` 而没人发现。
 *
 * 所以这三行（`declare global` / `export {}`）是承重的，不是风格。
 */

import type { AdminSession } from './lib/session';

declare global {
	namespace App {
		interface Locals {
			/**
			 * 已验签的后台会话。**由 `src/middleware.ts` 写入，页面只读。**
			 *
			 * 可选而不是必填：绝大多数路由（对读者开放的页面）压根不经过鉴权分支，
			 * 对它们来说这个字段永远是 undefined。后台页面自己检查——
			 * 拿不到就抛错，见下面 `src/pages/admin/*` 里的用法。
			 */
			admin?: AdminSession;
		}
	}
}

export {};

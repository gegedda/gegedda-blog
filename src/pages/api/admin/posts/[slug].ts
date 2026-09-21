/**
 * `PUT` / `DELETE /api/admin/posts/[slug]` —— 更新与删除。
 *
 * ── 路径形状 ───────────────────────────────────────────────────
 *
 * 用 `[slug]` 而不是 `[...slug]`：slug 由 `validatePostInput` 保证是
 * `^[a-z0-9]+(?:-[a-z0-9]+)*$`，不含 `/`，`[...slug]` 的额外能力用不上，
 * 而它会让 `/api/admin/posts/a/b` 这类路径也命中同一个处理器。
 *
 * 新建不在这里：`POST /api/admin/posts` 与 `/admin/new` 的对应关系
 * 与 `PUT /admin/posts/[slug]` 无关，刻意不共用路径段——
 * 理由见计划 §13.7（静态段胜过动态段，`/admin/posts/new` 会永远
 * 吃不到 `slug === 'new'` 的文章）。
 */

import type { APIRoute } from 'astro';

import { getDb } from '../../../../lib/db';
import { json } from '../../../../lib/api';
import { handlePostWrite } from '../../../../lib/post-endpoint';
import { deletePost } from '../../../../data/posts.write';

export const PUT: APIRoute = async ({ request, params }) =>
	handlePostWrite(request, { mode: 'update', urlSlug: params.slug });

/**
 * 删除。**成功返回 200 而不是 204。**
 *
 * 204 是对的 HTTP 语义（没有响应体），但 `fetch` 之后要读 body 的客户端
 * 得为它单独写一个分支，而返回 `{}` 的成本是一个 `Content-Length: 2`。
 * 六行客户端代码换两字节，值。
 *
 * ── 不读请求体 ─────────────────────────────────────────────────
 *
 * 中间件的 CSRF 检查要求 `Content-Type: application/json`，而客户端
 * 发的是 `body: '{}'`（浏览器在 DELETE 上不带 body 时很难设置这个头）。
 * 这里**不解析它**——`readJson` 对空体会返回 400，而 DELETE 本来就没有
 * 需要读的东西。不管客户端发的是 `{}` 还是什么都不发，行为一致。
 */
export const DELETE: APIRoute = async ({ params }) => {
	const db = getDb();
	const slug = params.slug;
	if (!slug) return json({ error: '缺少 slug' }, 400);

	const removed = await deletePost(db, slug, { nowSeconds: Math.floor(Date.now() / 1000) });
	if (!removed) return json({ error: `没有找到 slug 为「${slug}」的文章。` }, 404);

	return json({ ok: true, slug });
};

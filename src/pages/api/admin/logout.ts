/**
 * `POST /api/admin/logout` —— 只登出**这台设备**。
 *
 * ── 为什么是两个端点，不是一个带 `all` 标志的端点 ──────────────
 *
 * `POST /logout {all:true}` 更省代码，但它把「把所有设备踢下线」这件事
 * 挂在了一个字段拼写正确与否上。客户端那边一个 `all: ture` 的笔误，
 * 表现是**什么都没发生**——用户以为自己在别的机器上的会话已经断了，
 * 而它还在。破坏性更强的操作值得有它自己的 URL：拼错 URL 会 404，
 * 是一个能被看见的失败。
 *
 * 这个端点**不动 epoch**：另一台设备上正在写的稿子不该因为这边点了
 * 登出而丢。要全端失效是 `/api/admin/logout-all`。
 *
 * 请求体不需要（但客户端仍要发 `body: '{}'` —— 中间件的 CSRF 检查要求
 * `Content-Type: application/json`，而 DELETE/POST 不带 body 时很难让
 * 浏览器发出那个头，见 §13.3）。
 */

import type { APIRoute } from 'astro';

import { json } from '../../../lib/api';
import { clearedSessionCookie } from '../../../lib/session';

export const POST: APIRoute = async () => {
	// 不读 body、不查库、不验签——能走到这里说明中间件已经验过了。
	// 这里唯一做的事是把 cookie 清掉。
	return json({ ok: true }, 200, { 'Set-Cookie': clearedSessionCookie() });
};

/**
 * `POST /api/admin/logout-all` —— **所有设备**一起登出。
 *
 * 实现就是 `session_epoch += 1`。所有已签发的 cookie 里都带着签发时刻的
 * epoch 值，而中间件每次请求都会拿库里的当前值去比——对不上即视为失效。
 * 于是"全端登出"不需要会话表，也不需要能列出"现在有哪些会话"。
 *
 * 用在「怀疑密码或 cookie 泄漏」的场景。日常登出请用 `/api/admin/logout`：
 * 这个端点会把你自己的其他设备也一起踢掉。
 *
 * ── bump 与清 cookie 的先后 ───────────────────────────────────
 *
 * 先 bump，再清。反过来（先清 cookie 再 bump）的话，如果中间那一步失败，
 * 用户看到的是"登出成功了"（cookie 没了），但**其他设备上的会话仍然有效**
 * ——而"我以为已经全端登出了"正是这个端点的全部意义。
 *
 * 现在这个顺序下，最坏情况是本地 cookie 没清掉、下次请求被中间件拒掉
 * 并跳回登录页，行为上等于登出成功。
 *
 * ⚠️ 加"改密码"功能时必须一并 bump（否则旧 cookie 仍然有效）。P5 不做
 * 改密码，见计划 §13.13。
 */

import type { APIRoute } from 'astro';

import { json } from '../../../lib/api';
import { getDb } from '../../../lib/db';
import { clearedSessionCookie } from '../../../lib/session';
import { bumpSessionEpoch } from '../../../lib/settings';

export const POST: APIRoute = async () => {
	const db = getDb();
	await bumpSessionEpoch(db);

	return json({ ok: true }, 200, { 'Set-Cookie': clearedSessionCookie() });
};

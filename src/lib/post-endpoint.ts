/**
 * `POST /api/admin/posts` 与 `PUT /api/admin/posts/[slug]` 共用的那一段：
 * 读体 → 校验 → 写库 → 把领域错误翻译成 HTTP。
 *
 * ── 为什么要抽出来 ─────────────────────────────────────────────
 *
 * 两个路由的差别**只有**"存不存在"那一个判断，其余逐字相同。分开写的话，
 * 最先漂移的会是最后那个 `catch`——而它的内容恰好是
 * 「**只**捕获 `TagCollisionError`，其余照抛」。抄漏一个 `instanceof`
 * 判断，表现是 D1 挂掉时返回 409「标签重名」，把排查方向带偏。
 * 这种"复制粘贴时会漏掉的那一句"值得只有一份。
 *
 * ── POST 与 PUT 的语义是分开的，不是同一个 upsert 的两个入口 ────
 *
 * | 动词 | 语义 | slug 已存在 | slug 不存在 |
 * |---|---|---|---|
 * | `POST` | 新建 | **409** | 201 |
 * | `PUT` | 更新 | 200 | **404** |
 *
 * 写层只有 `upsertPost` 一个函数（SQL 层面 INSERT 与 UPDATE 的语句差别
 * 在 SQLite 里就是一条 UPSERT），所以"该不该存在"由这一层来判。
 *
 * 不让 POST 直接覆盖已有文章，是因为那是一条**静默改写别人内容**的路径：
 * 编辑器的"新建"页上 slug 是从标题生成的，撞上一个老文章的 slug 完全可能，
 * 而那一刻用户心里想的是"新建"。返回 409 让他知道撞车了，比悄悄把
 * 一篇已发布文章换成草稿强。
 */

import { fail, json, readJson } from './api';
import { getDb } from './db';
import { validatePostInput } from '../domain/post-input';
import { getPostBySlugForAdmin } from '../data/posts.repo';
import { TagCollisionError, upsertPost } from '../data/posts.write';

export type WriteMode = 'create' | 'update';

/** `urlSlug` 只在 `update` 模式下用：PUT 的 slug 必须等于 URL 里的那一段。 */
export async function handlePostWrite(
	request: Request,
	opts: { mode: WriteMode; urlSlug?: string },
): Promise<Response> {
	const db = getDb();

	const body = await readJson(request);
	if (!body.ok) return body.response;

	const parsed = validatePostInput(body.value);
	if (!parsed.ok) return fail(parsed.status, parsed.message);

	const input = parsed.value;

	if (opts.mode === 'update' && (!opts.urlSlug || input.slug !== opts.urlSlug)) {
		// 改 slug 等于改 URL。要做得无损，得先写一条 301 才能不丢外链，
		// 那是独立决定（计划 §13.7），P5 不做——所以这里直接拒绝，
		// 而不是让它悄悄变成"新建了另一篇、旧的还在"。
		return fail(400, `slug 不能改：URL 里是「${opts.urlSlug ?? ''}」，正文里是「${input.slug}」。`);
	}

	// 先看存在与否，再写。**两种模式都需要这一次查询**，理由各不相同：
	//
	//   - `create`：`upsertPost` 是一条 UPSERT，slug 撞上时它会**覆盖**。
	//     不查的话，"新建一篇 hello-world"会把已有的 hello-world 整篇换掉，
	//     而用户以为自己新建了一篇。
	//   - `update`：不查的话，PUT 一个拼错的 slug 会静默多出一篇文章，
	//     而不是 404。
	const existing = await getPostBySlugForAdmin(db, input.slug);

	if (opts.mode === 'create' && existing) {
		return fail(409, `slug「${input.slug}」已经有一篇文章了。换一个 slug，或去编辑那一篇。`);
	}
	if (opts.mode === 'update' && !existing) {
		return fail(404, `没有找到 slug 为「${input.slug}」的文章。`);
	}

	const nowSeconds = Math.floor(Date.now() / 1000);

	let created: boolean;
	try {
		({ created } = await upsertPost(db, input, { nowSeconds }));
	} catch (err) {
		// ⚠️ **只捕获这一个类型。** 宽泛的 catch 会把 D1 的连接错误、
		// 磁盘错误也吞成 409，于是"数据库挂了"在界面上显示为"标签重名"，
		// 而用户会去改标签——一个永远修不好的方向。
		if (err instanceof TagCollisionError) return fail(409, err.message);
		throw err;
	}

	return json(
		{ ok: true, slug: input.slug, created },
		opts.mode === 'create' ? 201 : 200,
	);
}

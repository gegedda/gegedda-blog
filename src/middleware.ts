/**
 * 中间件。四件事，顺序是承重的：
 *
 *   1. 三条历史 301 规则（必须排在最前）
 *   2. `/api/` 写方法的 CSRF 检查（必须在 `next()` **之前**）
 *   3. 后台路径的鉴权门禁
 *   4. `next()` 之后的缓存头、noindex、滑动续期
 *
 * ── 关于第 1 条 ────────────────────────────────────────────────
 *
 * 三条 301 规则从 `public/_redirects` 搬进了代码。`_redirects` 是 Workers
 * Static Assets 的特性，而它在 `output: 'server'` 下对 splat 语法的支持
 * 没有把握；更要紧的是**改错了没法回滚**——外部世界（搜索索引、书签、
 * RSS 订阅器）已经记住了旧地址，这几条规则是唯一把旧地址接回新站的东西。
 * 放在代码里，它跟着版本走、能被测试、出问题能立刻改回去。
 *
 * `public/_redirects` 保留着，作为静态资源那条快速路径（不经 Worker、
 * 不占 CPU 额度）。两处规则要一起改，以这里为准。
 *
 * ── 关于第 2 条为什么必须在 next() 之前 ────────────────────────
 *
 * 这是唯一一处"位置即正确性"的检查：放到 `next()` 之后就等于
 * 先让写接口跑完、再判断这个请求该不该被允许。
 */

import { defineMiddleware } from 'astro:middleware';

import {
	isAdminApiPath,
	isJsonRequest,
	isPrivatePath,
	isProtectedApi,
	isProtectedPage,
	isWriteMethod,
	normalizePathname,
	safeNextPath,
} from './lib/admin-paths';
import { getDb } from './lib/db';
import {
	needsRenewal,
	readSessionCookie,
	sessionCookie,
	signSession,
	verifySession,
} from './lib/session';
import { getSessionEpoch, getSessionSecret } from './lib/settings';

/** 未登录的 `fetch` 拿到它才知道要跳去登录页。 */
const UNAUTHORIZED = JSON.stringify({ error: '未登录' });

/**
 * 客户端 IP。**只信 `cf-connecting-ip`。**
 *
 * 那个头由 Cloudflare 的边缘节点写入，请求方伪造不了。`X-Forwarded-For`
 * 正相反——它是一串客户端可以随便填的字符串，拿它做限流的键等于
 * 让攻击者自己选桶。
 *
 * 本地 `wrangler dev` 没有这个头，退化成 `'unknown'`：开发时所有请求
 * 共用一个桶，正好符合预期。
 */
function clientIp(request: Request): string {
	return request.headers.get('cf-connecting-ip') ?? 'unknown';
}

/**
 * 补上"按路径来的"两个头：缓存策略与 noindex。
 *
 * ⚠️ **提前 return 的响应也必须走这一道。**
 *
 * 中间件里有三条出口是不经过 `next()` 的：三条历史 301、未登录的 401、
 * 未登录的 302。它们原本直接 return，于是第 5、6 步完全没执行到——
 * 实测结果是 `/admin` 未登录时的 302 **一个 `Cache-Control` 都没有**，
 * 也没有 `X-Robots-Tag`。
 *
 * 那不是"少一个头"那么轻：
 *
 *   - 302/301 在默认规则下**是可以被中间缓存存下来的**。一个被缓存住的
 *     「/admin → /login」表现是某人从此被钉在登录页上，清 cookie 也不管用。
 *   - 这类响应**只在未登录时出现**，所以本地一直登着的时候永远复现不了。
 *
 * 抽成一个函数而不是复制两份：两处写法一旦漂移，漂移的又是"只在某个
 * 登录状态下才看得见"的那一份。规则本身与第 5、6 步逐字相同——
 * 「路由自己设过的一律不动」这条也一并带过来。
 */
function applyPathHeaders(response: Response, path: string): Response {
	if (!response.headers.has('Cache-Control')) {
		response.headers.set(
			'Cache-Control',
			isPrivatePath(path) ? 'private, no-store' : 'public, max-age=0, must-revalidate',
		);
	}
	if (isPrivatePath(path)) {
		response.headers.set('X-Robots-Tag', 'noindex, nofollow');
	}
	return response;
}

export const onRequest = defineMiddleware(async (context, next) => {
	const { pathname } = new URL(context.request.url);

	// ── 1. 历史 301 ──────────────────────────────────────────────
	//
	// 顺序要紧：`/blog/` 必须先判，否则会被下面的 /blog/ 前缀规则吃掉，
	// splat 为空 → 跳去 /posts/，而那里没有列表页（列表在 `/`）。
	if (pathname === '/blog' || pathname === '/blog/') {
		return applyPathHeaders(context.redirect('/', 301), pathname);
	}

	// 订阅地址改名
	if (pathname === '/rss.xml') {
		return applyPathHeaders(context.redirect('/feed.xml', 301), pathname);
	}

	// 文章从 /blog/<slug>/ 迁到 /posts/<slug>/
	// 用 startsWith 而不是 glob：这里要能明确处理「前缀匹配但剩余部分是空的」
	// 这种边界，而 glob 的 `*` 匹配空串，写起来反而要多一个分支。
	if (pathname.startsWith('/blog/')) {
		const rest = pathname.slice('/blog/'.length);
		if (rest) {
			return applyPathHeaders(context.redirect(`/posts/${rest}`, 301), pathname);
		}
	}

	// 归一化之后再做所有路径判定。`/login/` 与 `/login` 是同一个路由，
	// 但 pathname 保留末尾斜杠——不归一化的话 `/login/` 会绕过白名单。
	const path = normalizePathname(pathname);

	// ── 2. CSRF（写请求，在 next() 之前）─────────────────────────
	//
	// 放这里而不是各个写接口自己查：写接口有六个，逐个记得检查是那种
	// "漏一个不报错、只是那个接口可以被跨站调用"的问题。
	// 放中间件里结构上漏不掉——和 `publishedWhere()` 是同一种手法。
	//
	// 体积上限、统一错误形状那些**按路由不同**的东西在 `src/lib/api.ts`，
	// 两块互补。
	if (path.startsWith('/api/') && isWriteMethod(context.request.method)) {
		const origin = context.request.headers.get('Origin');
		if (origin === null) {
			// ⚠️ 缺失 Origin 与"Origin 不匹配"**必须给不同的提示**。
			//
			// 按 Fetch 规范，同源的非 GET 请求应当带上 Origin，所以正常情况下
			// 走不到这一支。走到这里基本只有两种可能：旧式表单（没有 Origin），
			// 或者某个浏览器对同源请求不发 Origin——那会让**整个后台的保存功能
			// 全部失效**，而且是在某一个人的浏览器上、别处都复现不了。
			//
			// 两者都拒，但这一支的话要能让人一眼看出该往哪查。混在一句
			// 「跨站请求被拒绝」里，下一个人会去查 CSRF 攻击，而真正的问题是
			// 他用的浏览器不发这个头。
			return new Response(
				JSON.stringify({
					error:
						'请求里没有 Origin 头，无法确认是否同源，已拒绝。' +
						'这通常意味着所用的浏览器/工具对同源请求也不发送 Origin（或用了旧式表单提交）。',
				}),
				{ status: 403, headers: { 'Content-Type': 'application/json; charset=utf-8' } },
			);
		}
		if (origin !== context.url.origin) {
			return new Response(JSON.stringify({ error: '跨站请求被拒绝' }), {
				status: 403,
				headers: { 'Content-Type': 'application/json; charset=utf-8' },
			});
		}

		if (!isJsonRequest(context.request)) {
			// 跨站表单**无法**在不触发预检的情况下设置 Content-Type: application/json，
			// 所以这一条是实质性的第二道锁，不是重复。
			return new Response(
				JSON.stringify({ error: 'Content-Type 必须是 application/json（DELETE 也要带上）' }),
				{
					status: 415,
					headers: { 'Content-Type': 'application/json; charset=utf-8' },
				},
			);
		}
	}

	// ── 3. 后台门禁 ──────────────────────────────────────────────
	//
	// ⚠️ 这一整段**只在命中后台路径时才执行**。公开页面完全不碰 `settings`——
	// 否则首页每来一个访客都会多一次 D1 读取，而读者侧根本不需要知道
	// 任何登录状态（P5 的公开页面里也没有"编辑此文"入口）。
	let renewal: { value: string } | null = null;

	if (isProtectedPage(path) || isProtectedApi(path)) {
		const db = getDb();
		const nowSeconds = Math.floor(Date.now() / 1000);

		// epoch **每次新读**，不缓存。缓存了的话"全端登出"只在部分 isolate
		// 生效，表现是「点了登出，有的设备还能用」，而且时好时坏。
		const [secret, currentEpoch] = await Promise.all([
			getSessionSecret(db),
			getSessionEpoch(db),
		]);

		const session = secret
			? await verifySession(readSessionCookie(context.request), {
					secret,
					currentEpoch,
					nowSeconds,
				})
			: null;

		if (!session) {
			if (isAdminApiPath(path)) {
				// ⚠️ **必须是 401 JSON，不能是 302。**
				//
				// `fetch()` 默认跟随重定向。返回 302 → /login 的话，
				// 浏览器会拿到一个 **200 的 HTML 登录页**，
				// 而编辑器的保存逻辑会把它当成"保存成功"——
				// 正是本项目最忌讳的那类「不报错，只是内容悄悄没保存」。
				return applyPathHeaders(
					new Response(UNAUTHORIZED, {
						status: 401,
						headers: { 'Content-Type': 'application/json; charset=utf-8' },
					}),
					path,
				);
			}

			const next = safeNextPath(context.url.pathname + context.url.search);
			return applyPathHeaders(
				context.redirect(`/login?next=${encodeURIComponent(next)}`, 302),
				path,
			);
		}

		context.locals.admin = session;

		// 滑动续期：剩余不足 15 天时重签。放在 next() 之后写进响应头，
		// 因为这里拿不到它。
		if (needsRenewal(session, nowSeconds) && secret) {
			renewal = {
				value: await signSession(secret, {
					exp: nowSeconds + 30 * 24 * 60 * 60,
					epoch: currentEpoch,
				}),
			};
		}
	}

	// ── 4. 交给路由 ──────────────────────────────────────────────
	const response = await next();

	// ── 5. 缓存头与 noindex ──────────────────────────────────────
	//
	// 见 `applyPathHeaders` 的注释：
	//
	//   - 缓存头是**兜底而不是覆盖**——路由自己设过的一律不动。这样新加一个
	//     路由时忘了设头不会退化成"没有头"（浏览器的启发式缓存会拿一个
	//     不确定的值），也不会把某个路由刻意的选择压掉。现在自己设头的有
	//     `/sitemap-*.xml`；静态资源不走这里，由 public/_headers 管
	//     （已实测生效：CSS 拿到 immutable，且响应带 CF-Cache-Status: HIT）。
	//   - noindex 与 robots.txt 的 Disallow **语义不同，两条都要**：robots
	//     防的是抓取，这个头防的是收录。一个被外链指向的后台页面仍然可能
	//     进索引，而那一页不该出现在搜索结果里。
	applyPathHeaders(response, path);

	// ── 7. 滑动续期 ──────────────────────────────────────────────
	//
	// 用 append 而不是 set：这个响应上可能已经有别的 Set-Cookie
	// （比如登录接口自己写的那个）。set 会把它压掉。
	if (renewal) {
		response.headers.append('Set-Cookie', sessionCookie(renewal.value));
	}

	return response;
});

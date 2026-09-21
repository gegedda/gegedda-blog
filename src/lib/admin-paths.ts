/**
 * 后台路径的判定规则。**纯函数**，单独一个文件是为了能直接单测——
 * `src/middleware.ts` 需要 Astro 的 context，测起来代价远大于收益，
 * 但"哪些路径要鉴权、哪些不用"这部分是纯粹的逻辑，值得钉住。
 *
 * ── 这里的每一条都对应一种**不报错**的错法 ──────────────────────
 *
 * 路径判定写错的共同点是：不会有任何异常，只会安静地放行或安静地挡住。
 * 所以下面每条规则都写成"宁可多挡、不可漏放"的方向。
 */

/**
 * 去掉末尾斜杠（根路径除外）。
 *
 * Astro 默认 `trailingSlash: 'ignore'`，`/login/` 与 `/login` 是**同一个路由**，
 * 但 `URL.pathname` 保留末尾的 `/`。不归一化的话，`/login/` 会绕过
 * 白名单走进鉴权分支——表现是"从某个链接进来时永远在登录页之间打转"。
 * （既有的 `/blog` 与 `/blog/` 那条 301 规则也是显式判了两种形态的，
 * 是同一条约定。）
 */
export function normalizePathname(pathname: string): string {
	if (pathname.length > 1 && pathname.endsWith('/')) {
		return pathname.replace(/\/+$/, '') || '/';
	}
	return pathname;
}

/**
 * 是不是后台页面。
 *
 * **不用 `pathname.startsWith('/admin')`**：那会把 `/administrator`、
 * `/admin-panel` 之类也算成后台。多挡几个不存在的路径没什么损失，
 * 但那种写法会让人以为它是精确的，从而在别处放松警惕。
 */
export function isAdminPath(pathname: string): boolean {
	return pathname === '/admin' || pathname.startsWith('/admin/');
}

/** 是不是后台的 JSON 接口。 */
export function isAdminApiPath(pathname: string): boolean {
	return pathname === '/api/admin' || pathname.startsWith('/api/admin/');
}

/**
 * 免鉴权的后台页面。
 *
 * ⚠️ **精确匹配的集合，不是前缀。** 前缀会让 `/admin/setup-anything`
 * 也变成公开的——而那个路径将来完全可能被有意建出来。
 * `test/middleware-paths.test.ts` 里有一条专门盯 `/admin/setup2`。
 *
 * `/login` 不在 `isAdminPath` 的范围内（它没有 `/admin` 前缀），
 * 但仍要在这里列出来，因为缓存头那一节要按它分支。
 */
const PUBLIC_ADMIN_PAGES = new Set(['/login', '/admin/setup']);

/**
 * 免鉴权的后台接口。
 *
 * `/api/admin/login` 与 `/api/admin/login-params` 是登录本身，
 * `/api/admin/setup` 是首次设密码——**这三个必须在设密码之前可用**。
 * 除此之外 `setup` 会在路由内部自己检查"是不是已经设过了"并 404。
 */
const PUBLIC_ADMIN_APIS = new Set([
	'/api/admin/login',
	'/api/admin/login-params',
	'/api/admin/setup',
]);

/** 需要登录才能访问的后台页面。 */
export function isProtectedPage(pathname: string): boolean {
	return isAdminPath(pathname) && !PUBLIC_ADMIN_PAGES.has(pathname);
}

/** 需要登录才能访问的后台接口。 */
export function isProtectedApi(pathname: string): boolean {
	return isAdminApiPath(pathname) && !PUBLIC_ADMIN_APIS.has(pathname);
}

/** `/login` 这个路径本身不要求登录（否则就是死循环）。 */
export function isPublicPage(pathname: string): boolean {
	return PUBLIC_ADMIN_PAGES.has(pathname);
}

/** 所有需要挂 `private, no-store` 与 `noindex` 的路径。 */
export function isPrivatePath(pathname: string): boolean {
	return isAdminPath(pathname) || pathname === '/login' || pathname.startsWith('/api/');
}

/**
 * 写方法。
 *
 * ⚠️ **`DELETE` 也在里面**，而它会带来一个必须接受的副作用：
 * 客户端发 DELETE 时也要带 `Content-Type: application/json` 与一个
 * `'{}'` 的 body（见下面 `isJsonRequest`）。错误信息里得写清这点，
 * 否则「删除报 415」会变成一个查不出原因的问题。
 */
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function isWriteMethod(method: string): boolean {
	return WRITE_METHODS.has(method.toUpperCase());
}

/**
 * 请求体是不是 JSON。
 *
 * 允许 `application/json` 后面带 `; charset=utf-8`，所以用 startsWith
 * 而不是全等——各浏览器和 `fetch` 实现带的参数不完全一样，
 * 全等会让一部分客户端莫名其妙地 415。
 */
export function isJsonRequest(request: Request): boolean {
	const contentType = request.headers.get('Content-Type');
	if (!contentType) return false;
	return contentType.trim().toLowerCase().startsWith('application/json');
}

/**
 * `?next=` 的值能不能用。
 *
 * ⚠️ **不校验就是一个可用的开放重定向**：`/login?next=//evil.example`
 * 登录成功后会跳到外站，而那个 URL 的域名是我们自己的——
 * 是一块完美的钓鱼跳板。
 *
 * 只接受以 `/admin` **开头**的相对路径，且第二个字符不能是 `/`
 * （`//host` 是协议相对 URL，浏览器会当成跨域跳转）。
 * 其它一律回落到 `/admin`。
 */
export function safeNextPath(raw: string | null): string {
	if (!raw) return '/admin';
	if (!raw.startsWith('/')) return '/admin';
	if (raw.startsWith('//')) return '/admin';
	if (raw !== '/admin' && !raw.startsWith('/admin/') && !raw.startsWith('/admin?')) {
		return '/admin';
	}
	return raw;
}

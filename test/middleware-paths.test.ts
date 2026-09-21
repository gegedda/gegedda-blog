/**
 * 路径判定规则。
 *
 * `src/middleware.ts` 本身不进单测——它需要 Astro 的 context，代价远大于
 * 收益，改由 §13.11 的 `curl` 门去验。但"哪些路径要鉴权、哪些不用"
 * 是纯粹的逻辑，而它写错的共同点是**不会有任何异常**：只会安静地放行
 * 或安静地挡住。所以这部分单独抽成 `src/lib/admin-paths.ts` 钉在这里。
 */

import { describe, expect, it } from 'vitest';

import {
	isAdminApiPath,
	isAdminPath,
	isJsonRequest,
	isPrivatePath,
	isProtectedApi,
	isProtectedPage,
	isPublicPage,
	isWriteMethod,
	normalizePathname,
	safeNextPath,
} from '../src/lib/admin-paths';

describe('normalizePathname', () => {
	it('去掉末尾斜杠', () => {
		expect(normalizePathname('/login/')).toBe('/login');
		expect(normalizePathname('/admin/posts/x/')).toBe('/admin/posts/x');
	});

	it('多个末尾斜杠一起去掉', () => {
		expect(normalizePathname('/login///')).toBe('/login');
	});

	it('根路径保持为 /', () => {
		// 归一化时把根也变成 '' 的话，`isPrivatePath('')` 之类的判定
		// 会在首页上做出奇怪的决定。
		expect(normalizePathname('/')).toBe('/');
	});

	it('没有末尾斜杠时原样返回', () => {
		expect(normalizePathname('/admin')).toBe('/admin');
		expect(normalizePathname('')).toBe('');
	});
});

describe('isAdminPath / isAdminApiPath', () => {
	it('认后台路径', () => {
		expect(isAdminPath('/admin')).toBe(true);
		expect(isAdminPath('/admin/')).toBe(true);
		expect(isAdminPath('/admin/posts/x')).toBe(true);
	});

	it('**不认** /administrator 与 /admin-panel', () => {
		// `startsWith('/admin')` 的写法会把这些也算成后台。多挡几个
		// 不存在的路径没什么损失，但那种写法会让人以为它是精确的，
		// 从而在别处放松警惕。
		expect(isAdminPath('/administrator')).toBe(false);
		expect(isAdminPath('/admin-panel')).toBe(false);
		expect(isAdminPath('/adminfoo')).toBe(false);
	});

	it('/login 不是后台路径', () => {
		// 它没有 /admin 前缀，但仍要在白名单里单列——缓存头那一节按它分支。
		expect(isAdminPath('/login')).toBe(false);
		expect(isAdminApiPath('/login')).toBe(false);
	});

	it('认后台接口', () => {
		expect(isAdminApiPath('/api/admin')).toBe(true);
		expect(isAdminApiPath('/api/admin/posts')).toBe(true);
		expect(isAdminApiPath('/api/adminx')).toBe(false);
		expect(isAdminApiPath('/api/posts')).toBe(false);
	});
});

describe('白名单是精确匹配，不是前缀', () => {
	it('/admin/setup 公开', () => {
		expect(isPublicPage('/admin/setup')).toBe(true);
		expect(isProtectedPage('/admin/setup')).toBe(false);
	});

	it('/admin/setup2 **不**公开', () => {
		// 前缀匹配会让 `/admin/setup-anything` 也变成公开的——而那个路径
		// 将来完全可能被有意建出来（比如 `/admin/setup-help`）。
		expect(isPublicPage('/admin/setup2')).toBe(false);
		expect(isProtectedPage('/admin/setup2')).toBe(true);
		expect(isPublicPage('/admin/setup/extra')).toBe(false);
		expect(isProtectedPage('/admin/setup/extra')).toBe(true);
	});

	it('/login 公开，但它不要求登录（否则是死循环）', () => {
		expect(isPublicPage('/login')).toBe(true);
		expect(isProtectedPage('/login')).toBe(false);
	});

	it('三个接口公开，其余后台接口都受保护', () => {
		for (const p of ['/api/admin/login', '/api/admin/login-params', '/api/admin/setup']) {
			expect(isProtectedApi(p), p).toBe(false);
		}
		// ⚠️ 这条是承重的：写接口必须是受保护的。真实路径是
		// `/api/admin/posts`（新建）与 `/api/admin/posts/<slug>`（改/删），
		// 两者都**不在**白名单里。
		for (const p of [
			'/api/admin/posts',
			'/api/admin/posts/hello-world',
			'/api/admin/logout',
			'/api/admin/logout-all',
			'/api/admin',
		]) {
			expect(isProtectedApi(p), p).toBe(true);
		}
	});

	it('/api/admin/login2 之类的白名单前缀变体都受保护', () => {
		for (const p of ['/api/admin/login2', '/api/admin/setup2', '/api/admin/login/extra']) {
			expect(isProtectedApi(p), p).toBe(true);
		}
	});
});

describe('isPrivatePath（挂 no-store 与 noindex 的范围）', () => {
	it('后台、登录、以及所有 /api/ 都是 private', () => {
		for (const p of ['/admin', '/admin/new', '/login', '/api/admin/posts', '/api/anything']) {
			expect(isPrivatePath(p), p).toBe(true);
		}
	});

	it('读者侧页面不是 private', () => {
		// 这条盯着的是反向错误：把首页也纳入 no-store 的话，静态资源
		// 之外的一切都失去缓存，而**页面看起来完全正常**，只是变慢。
		for (const p of ['/', '/posts/x', '/tags/', '/archives', '/about']) {
			expect(isPrivatePath(p), p).toBe(false);
		}
	});
});

describe('isWriteMethod', () => {
	it('四种写方法', () => {
		for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
			expect(isWriteMethod(m), m).toBe(true);
		}
	});

	it('大小写不敏感', () => {
		expect(isWriteMethod('post')).toBe(true);
		expect(isWriteMethod('Delete')).toBe(true);
	});

	it('读方法不是写方法', () => {
		for (const m of ['GET', 'HEAD', 'OPTIONS']) {
			expect(isWriteMethod(m), m).toBe(false);
		}
	});

	it('DELETE 也在里面，这是有意的', () => {
		// 副作用是客户端发 DELETE 时也要带 Content-Type: application/json
		// 和一个 '{}' 的 body。不这么做的话「删除报 415」会变成一个
		// 查不出原因的问题——所以它的错误信息里要写清这一点。
		expect(isWriteMethod('DELETE')).toBe(true);
	});
});

describe('isJsonRequest', () => {
	const req = (contentType?: string) =>
		new Request('https://example.com/api/admin/posts', {
			method: 'POST',
			headers: contentType ? { 'Content-Type': contentType } : {},
		});

	it('接受 application/json', () => {
		expect(isJsonRequest(req('application/json'))).toBe(true);
	});

	it('接受带 charset 的形态', () => {
		// 用 startsWith 而不是全等：各浏览器和 fetch 实现带的参数
		// 不完全一样，全等会让一部分客户端莫名其妙地 415。
		expect(isJsonRequest(req('application/json;charset=utf-8'))).toBe(true);
		expect(isJsonRequest(req('application/json; charset=utf-8'))).toBe(true);
		expect(isJsonRequest(req('APPLICATION/JSON'))).toBe(true);
	});

	it('拒绝跨站表单能设的三种 Content-Type', () => {
		// 这是 CSRF 的第二道锁：跨站表单**无法**在不触发预检的情况下
		// 设置 application/json。所以这几种必须被拒。
		for (const ct of [
			'text/plain',
			'application/x-www-form-urlencoded',
			'multipart/form-data',
		]) {
			expect(isJsonRequest(req(ct)), ct).toBe(false);
		}
	});

	it('没有 Content-Type → 不是 JSON 请求', () => {
		expect(isJsonRequest(req())).toBe(false);
	});

	it('拒绝 application/jsonish 这类前缀伪装', () => {
		// 必须写 `application/json`，不能只是以它开头吗？——实际上
		// `application/jsonish` 会通过 startsWith。这里**照实记录**这个
		// 已知的宽松点：它不构成风险（那不是一个合法媒体类型，浏览器
		// 也不会替跨站表单生成它），但不要假装它是精确的。
		expect(isJsonRequest(req('application/jsonish'))).toBe(true);
	});
});

describe('safeNextPath', () => {
	it('接受 /admin 与它下面的路径', () => {
		expect(safeNextPath('/admin')).toBe('/admin');
		expect(safeNextPath('/admin/posts/x')).toBe('/admin/posts/x');
		expect(safeNextPath('/admin?tab=1')).toBe('/admin?tab=1');
	});

	it('空值回落到 /admin', () => {
		expect(safeNextPath(null)).toBe('/admin');
		expect(safeNextPath('')).toBe('/admin');
	});

	it('拒绝协议相对 URL（钓鱼跳板）', () => {
		// `/login?next=//evil.example` 登录后会跳到外站，而那个 URL 的
		// 域名是**我们自己的**——是一块完美的钓鱼跳板。
		expect(safeNextPath('//evil.example')).toBe('/admin');
		expect(safeNextPath('//evil.example/admin')).toBe('/admin');
	});

	it('拒绝绝对 URL', () => {
		expect(safeNextPath('https://evil.example')).toBe('/admin');
		expect(safeNextPath('http://evil.example/admin')).toBe('/admin');
		expect(safeNextPath('javascript:alert(1)')).toBe('/admin');
	});

	it('拒绝不相关的站内路径', () => {
		// 只放行 /admin 开头的：把 /logout 之类的路径也放过的话，
		// 将来任何新增的"带副作用的 GET"都会变成一个可利用的跳转目标。
		for (const p of ['/', '/posts/x', '/login', '/administrator', '/admin2']) {
			expect(safeNextPath(p), p).toBe('/admin');
		}
	});

	it('拒绝反斜杠形态（某些浏览器把 \\ 当成 /）', () => {
		// `/\evil.example` 在不做归一化时会被部分浏览器当成 `//evil.example`。
		// 它不以 `//` 开头，但也不以 `/admin` 开头，所以被下面那条挡掉。
		expect(safeNextPath('/\\evil.example')).toBe('/admin');
	});

	it('不做 URL 解码——解码是调用方的事', () => {
		// `%2F%2Fevil.example` 在解码前不以 `/` 开头 → 拒绝。
		// 解码**之后**再判就晚了：那一步会把 `%2F` 变成 `/`。
		expect(safeNextPath('%2F%2Fevil.example')).toBe('/admin');
	});
});

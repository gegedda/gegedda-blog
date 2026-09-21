/**
 * 写接口的几个共用零件：统一的 JSON 回复、带体积上限的请求体读取。
 *
 * ── 与中间件的分工 ─────────────────────────────────────────────
 *
 * 中间件管「谁都别忘」的那两条（Origin 与 Content-Type，见 `src/middleware.ts`
 * 的 CSRF 一节）；这里管「每个路由自己的参数」——体积上限、错误形状。
 *
 * 两块互补，不是二选一。把 Origin 检查放这里等于给六个写接口各留一次
 * 忘记的机会；把体积上限放中间件里等于用一个全局数字去管所有路由。
 */

/** 请求体上限。校验清单里的 900 000 是正文本身，这里留出 JSON 信封的余量。 */
export const MAX_BODY_BYTES = 1_200_000;

/**
 * 统一的 JSON 回复。
 *
 * 不在这里设 `Cache-Control`：那是中间件兜底的事，路由自己设的话
 * 就绕过了那条"兜底而不是覆盖"的规则（`/api/*` 一律 `private, no-store`）。
 */
export function json(data: unknown, status = 200, headers?: HeadersInit): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			'Content-Type': 'application/json; charset=utf-8',
			...(headers ?? {}),
		},
	});
}

/**
 * 错误回复。形状固定为 `{ error: string }`。
 *
 * `message` 会原样给到浏览器并显示在编辑器里，所以**不要**把 SQL、
 * 绑定名、堆栈之类的东西放进来。面向使用者的短句，诊断信息留在服务端日志。
 */
export function fail(status: number, message: string, headers?: HeadersInit): Response {
	return json({ error: message }, status, headers);
}

/**
 * 读 JSON 请求体。
 *
 * 两道体积检查：`Content-Length` 先看一眼（能省掉一次读），再对**实际读到的
 * 文本**量一次长度。只信前者是不行的——那个头可以缺失，也可以撒谎；
 * 而 `JSON.parse` 一个 50MB 的串会直接吃掉 CPU 预算。
 *
 * 返回判别联合而不是抛异常：调用方必须显式处理失败那一支，
 * 否则就得写 try/catch，而"忘了 catch"的表现是 500 而不是 400。
 */
export async function readJson(
	request: Request,
	maxBytes = MAX_BODY_BYTES,
): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
	const declared = request.headers.get('Content-Length');
	if (declared !== null) {
		const n = Number(declared);
		if (Number.isFinite(n) && n > maxBytes) {
			return { ok: false, response: tooLarge(maxBytes) };
		}
	}

	let text: string;
	try {
		text = await request.text();
	} catch {
		return { ok: false, response: fail(400, '读取请求体失败') };
	}

	// 按**字节**算而不是按字符：中文在 UTF-8 下是 3 字节，
	// 用 text.length 去比会让中文正文的上限变成实际的三倍。
	const size = new TextEncoder().encode(text).length;
	if (size > maxBytes) {
		return { ok: false, response: tooLarge(maxBytes) };
	}

	if (text.trim() === '') {
		return { ok: false, response: fail(400, '请求体是空的') };
	}

	try {
		return { ok: true, value: JSON.parse(text) as unknown };
	} catch {
		return { ok: false, response: fail(400, '请求体不是合法的 JSON') };
	}
}

function tooLarge(maxBytes: number): Response {
	const mb = Math.round((maxBytes / 1_000_000) * 10) / 10;
	return fail(413, `内容太大了（上限约 ${mb} MB）。把长文拆成两篇，或把大段内容放到图床/外链。`);
}

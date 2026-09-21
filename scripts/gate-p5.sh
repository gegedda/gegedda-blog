#!/usr/bin/env bash
# P5 验收门（计划 §13.11），能 curl 的那部分。
#
# 前提：`npx wrangler dev` 已经在 8787 上跑着，且本地库还没设过口令。
# 全部断言都是"看 HTTP 响应"，不看日志、不看代码。
#
# 为什么这些检查**不能**写成单元测试：中间件要 Astro 的 context，
# 造一个假的等于把被测对象自己实现一遍。curl 打真服务器才是真证据。

set -uo pipefail

S="http://localhost:8787"
PASS=0
FAIL=0

# 一份格式合法的起步数据。verifier 是 64 个十六进制字符（服务端只做格式校验，
# 真正的口令派生在浏览器里做，这里不需要真口令）。
SALT="0123456789abcdef0123456789abcdef"
ITER=600000
VERIFIER_GOOD="$(printf 'a%.0s' {1..64})"
VERIFIER_BAD="$(printf '0%.0s' {1..64})"

ok()   { PASS=$((PASS+1)); printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31m✗\033[0m %s\n' "$1"; printf '      %s\n' "$2"; }
# ⚠️ 这个函数**原来叫 `head`**，它把同名工具整个遮住了：脚本里那句
# `case "$(head -1 文件)" in SAME) …` 根本没读文件 —— 它调用的是这个函数，
# 拿到的是 `── -1 ──`，于是**永远**落到 `*` 分支。表现是一条恒失败的断言，
# 而它打印出来的"实际值"（另一处 `tr` 读的同一个文件）明明是 SAME。
#
# 教训不是"记得用 `command head`"，是**别用标准工具的名字给函数命名**：
# 被遮住之后 `head` / `tail` / `sort` / `test` 这类调用不会报错，只会**做别的事**。
section() { printf '\n\033[1m── %s\033[0m\n' "$1"; }

# 期望值 | 说明 | 实际值
expect() {
	if [ "$1" = "$3" ]; then ok "$2"; else bad "$2" "期望 [$1] 实际 [$3]"; fi
}

# 只取状态码。**必须 -o /dev/null**，否则响应体混进 stdout 把比较搞乱。
code() {
	curl -s -o /dev/null -w '%{http_code}' "$@"
}

# ── 把本地库恢复到"还没设过口令"的状态 ─────────────────────────
#
# 这一门是**一次性**的：B 段一旦设了口令，A 段的期望值就全变了。
# 所以要么每次跑之前重置，要么就只能跑一次。重置比"只能跑一次"有用得多。
if [ "${1:-}" = '--reset' ]; then
	printf '重置本地库…\n'
	npx wrangler d1 execute gegedda-blog-db --local --command \
		"DELETE FROM settings; DELETE FROM login_attempts; DELETE FROM posts WHERE slug = 'gate-test-post'; DELETE FROM post_revisions WHERE post_slug = 'gate-test-post'; DELETE FROM post_tags WHERE post_slug = 'gate-test-post';" \
		>/dev/null 2>&1 && printf '  ok\n'
fi

# 取某个响应头。`-D -` 打印头，`-o /dev/null` 丢掉体。
hdr() { # $1=头名, 其余=curl 参数
	local name="$1"; shift
	curl -s -D - -o /dev/null "$@" 2>/dev/null |
		tr -d '\r' |
		awk -v n="$name" 'BEGIN{IGNORECASE=1} tolower($0) ~ "^" tolower(n) ":" {sub(/^[^:]*:[ ]*/,""); print; exit}'
}

J='Content-Type: application/json'
O="Origin: $S"

printf '\033[1mP5 验收门 @ %s\033[0m\n' "$S"

# ════════════════════════════════════════════════════════════════
# A. 没设口令时（必须最先跑：B 一旦设了口令，这里就全变了）
# ════════════════════════════════════════════════════════════════
section "A. 未设口令 / 未登录"

expect 200 '/admin/setup 可用（还没设口令）' "$(code "$S/admin/setup")"

# 还没设口令时 `/login` 是 **302 → /admin/setup**（`src/pages/login.astro:55`）。
# 这里要断言的是"它没被鉴权门拦住"，不是"它直接渲染"——按 200 去判的话，
# 在**没设口令**这一段它会 302、在设完之后又会 200，一条断言两种结果。
#
# 尾斜杠那条同理：要证的是"`/login/` 没被门禁弹去 `/login?next=…`"
# （中间件先 `normalizePathname` 再判白名单，正是为了这个），
# 而不是它渲染不渲染。
loc="$(hdr Location "$S/login")"
expect '/admin/setup' '未设口令时 /login → /admin/setup（不是被门禁弹回自己）' "$loc"
loc="$(hdr Location "$S/login/")"
expect '/admin/setup' '/login/ 与 /login 同为公开（尾斜杠绕不过白名单）' "$loc"

# 鉴权跳转：必须是 302 到 /login?next=…，且 next 是**编码过的**
loc="$(hdr Location "$S/admin")"
expect '302' '/admin 未登录 → 302' "$(code "$S/admin")"
expect '/login?next=%2Fadmin' '/admin 跳到 /login?next=%2Fadmin' "$loc"

# 开放重定向：next 指向外站时**不能**采用。
#
# ⚠️ 这一段是**弱版本**，因为此刻还没有会话：`login.astro` 只有在
# 「已设口令 + 验签通过」时才用 `next` 跳转，没会话时它只会渲染表单，
# 所以这里恒过一个"Location 里没有 evil.example"的断言（Location 是
# `/admin/setup`）。真正有杀伤力的版本在 B 段拿到 cookie 之后，
# 那一条才是 `safeNextPath` 的证据。
loc="$(hdr Location "$S/login?next=//evil.example")"
case "$loc" in
	*evil.example*) bad '/login?next=//evil.example 不回外站（无会话）' "Location [$loc] 里出现了 evil.example" ;;
	*) ok '/login?next=//evil.example 不回外站（无会话，弱）' ;;
esac

# 白名单必须精确匹配，不能前缀匹配
expect 302 '/admin/setup2 需要鉴权（白名单是精确匹配）' "$(code "$S/admin/setup2")"
expect 404 '/administrator 不是后台路径' "$(code "$S/administrator")"

# 未登录的写接口必须是 **401 JSON**，不是 302
# （302 → fetch 会跟到登录页拿到 200 HTML，编辑器会以为保存成功）
expect 401 'POST /api/admin/posts 未登录 → 401（不是 302）' \
	"$(code -X POST "$S/api/admin/posts" -H "$O" -H "$J" -d '{}')"
ct="$(hdr Content-Type -X POST "$S/api/admin/posts" -H "$O" -H "$J" -d '{}')"
case "$ct" in *application/json*) ok '401 的响应体是 JSON' ;; *) bad '401 的响应体是 JSON' "Content-Type [$ct]" ;; esac

# ── CSRF ────────────────────────────────────────────────────────
section "A2. CSRF（在 next() 之前，所以不需要登录就能测）"

expect 403 '跨站 Origin → 403' \
	"$(code -X POST "$S/api/admin/posts" -H 'Origin: https://evil.example' -H "$J" -d '{}')"
expect 415 'Content-Type: text/plain → 415' \
	"$(code -X POST "$S/api/admin/posts" -H "$O" -H 'Content-Type: text/plain' -d '{}')"
expect 403 '完全没有 Origin → 403' \
	"$(code -X POST "$S/api/admin/posts" -H 'Origin:' -H "$J" -d '{}')"
msg="$(curl -s -X POST "$S/api/admin/posts" -H 'Origin:' -H "$J" -d '{}')"
case "$msg" in
	*Origin*) ok '缺 Origin 的报错里点明了 Origin（而不是含糊的"跨站请求"）' ;;
	*) bad '缺 Origin 的报错里点明了 Origin' "body [$msg]" ;;
esac

# ── 伪造 cookie ─────────────────────────────────────────────────
section "A3. 伪造 / 畸形 cookie（全程不能出现 500）"

expect 302 'Cookie: __Host-session=garbage → 302 且不 500' \
	"$(code -H 'Cookie: __Host-session=garbage' "$S/admin")"
expect 302 '空 cookie 值 → 302' \
	"$(code -H 'Cookie: __Host-session=' "$S/admin")"
expect 302 '三段都空 → 302' \
	"$(code -H 'Cookie: __Host-session=..' "$S/admin")"
expect 302 '超长 cookie → 302' \
	"$(code -H "Cookie: __Host-session=$(printf 'x%.0s' {1..5000})" "$S/admin")"
# 全 0 的签名：格式合法、长度正确，只有值不对 —— 这是"伪造"而不是"畸形"
expect 302 '格式合法但签名不对 → 302' \
	"$(code -H "Cookie: __Host-session=v1.9999999999.1.$(printf '0%.0s' {1..64})" "$S/admin")"

# ── 缓存头 / noindex ────────────────────────────────────────────
section "A4. 缓存头与 noindex"

expect 'private, no-store' '/admin 的 Cache-Control' "$(hdr Cache-Control "$S/admin")"
expect 'private, no-store' '/login 的 Cache-Control（它渲染的是口令输入框）' "$(hdr Cache-Control "$S/login")"
expect 'private, no-store' '未登录写接口的 Cache-Control' \
	"$(hdr Cache-Control -X POST "$S/api/admin/posts" -H "$O" -H "$J" -d '{}')"
expect 'private, no-store' '/admin/setup 的 Cache-Control' "$(hdr Cache-Control "$S/admin/setup")"
# 关键的反面：首页**不能**被后台规则污染
expect 'public, max-age=0, must-revalidate' '首页的 Cache-Control 没被污染' "$(hdr Cache-Control "$S/")"
expect 'noindex, nofollow' '/admin 的 X-Robots-Tag' "$(hdr X-Robots-Tag "$S/admin")"
expect 'noindex, nofollow' '/login 的 X-Robots-Tag' "$(hdr X-Robots-Tag "$S/login")"

# ── 301 规则 ────────────────────────────────────────────────────
section "A5. 历史 301"

expect 301 '/blog/ → /' "$(code "$S/blog/")"
expect '/' '/blog/ 的 Location' "$(hdr Location "$S/blog/")"
expect 301 '/rss.xml → /feed.xml' "$(code "$S/rss.xml")"
expect '/feed.xml' '/rss.xml 的 Location' "$(hdr Location "$S/rss.xml")"
expect 301 '/blog/hello-world/ → /posts/hello-world/' "$(code "$S/blog/hello-world/")"
expect '/posts/hello-world/' '/blog/<slug>/ 的 Location' "$(hdr Location "$S/blog/hello-world/")"

# ── 404 而不是 200 ──────────────────────────────────────────────
section "A6. 不存在的路径"

expect 404 '不存在的文章 → 404（不是 200 的空页面）' "$(code "$S/posts/no-such-post/")"
expect 404 '不存在的路径 → 404' "$(code "$S/no-such-page/")"

# ════════════════════════════════════════════════════════════════
# B. 设置口令 → 登录
# ════════════════════════════════════════════════════════════════
section "B. 设置口令与会话"

HDRS="$(mktemp)"
RESP="$(mktemp)"
# `GATE_TMP` 要到 C 段才建，所以这里用 `${GATE_TMP:-}` 而不是直接引用——
# `set -u` 下引用一个还不存在的变量会让脚本在 trap 里再炸一次。
GATE_TMP=''
trap 'rm -rf "$GATE_TMP" "$HDRS" "$RESP"' EXIT

expect 400 'iterations 不是 600000 → 400（防静默的 KDF 降级）' \
	"$(code -X POST "$S/api/admin/setup" -H "$O" -H "$J" \
		-d "{\"salt\":\"$SALT\",\"iterations\":1,\"verifier\":\"$VERIFIER_GOOD\"}")"
expect 400 'verifier 不是 64 位十六进制 → 400' \
	"$(code -X POST "$S/api/admin/setup" -H "$O" -H "$J" \
		-d "{\"salt\":\"$SALT\",\"iterations\":$ITER,\"verifier\":\"short\"}")"

# ⚠️ 头必须在**这一次**请求上抓。再发一次去取头的话，那时口令已经设过，
# 拿到的是 409 且**没有 Set-Cookie** —— 一条永远失败的断言，
# 而且看起来像"服务端没发 cookie"。
st="$(curl -s -o /dev/null -D "$HDRS" -w '%{http_code}' -X POST "$S/api/admin/setup" \
	-H "$O" -H "$J" -d "{\"salt\":\"$SALT\",\"iterations\":$ITER,\"verifier\":\"$VERIFIER_GOOD\"}")"
expect 201 '设置口令成功 → 201' "$st"
sc="$(tr -d '\r' <"$HDRS" | awk 'BEGIN{IGNORECASE=1} /^set-cookie:/ {sub(/^[^:]*:[ ]*/,""); print; exit}')"

expect 409 '重复设置 → 409（ON CONFLICT DO NOTHING 抢占）' \
	"$(code -X POST "$S/api/admin/setup" -H "$O" -H "$J" \
		-d "{\"salt\":\"$SALT\",\"iterations\":$ITER,\"verifier\":\"$VERIFIER_GOOD\"}")"
expect 404 '设完之后 /admin/setup → 404' "$(code "$S/admin/setup")"

# ⚠️ 逐项判，**不判顺序**。原来写成一条`'__Host-session='*'HttpOnly'*'Secure'*…`
# 的模式，那是在断言属性的排列顺序——而实测顺序是
# `Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=…`，于是它失败了，
# 报出来却是"Set-Cookie 的形态不对"，看着像服务端少发了属性。
# 顺序本来也不是协议要求的东西，逐项判既对又更好读。
case "$sc" in
	'__Host-session='*) ok 'Set-Cookie 的名字是 __Host-session' ;;
	*) bad 'Set-Cookie 的名字是 __Host-session' "[$sc]" ;;
esac
for attr in 'HttpOnly' 'Secure' 'SameSite=Lax' 'Path=/'; do
	case "$sc" in
		*"$attr"*) ok "Set-Cookie 带 $attr" ;;
		*) bad "Set-Cookie 带 $attr" "[$sc]" ;;
	esac
done
case "$sc" in
	*'Domain='*) bad 'Set-Cookie 不带 Domain（带了浏览器会整条丢弃）' "[$sc]" ;;
	*) ok 'Set-Cookie 不带 Domain' ;;
esac

# ── 会话在本地 http 上真的生效吗 ────────────────────────────────
#
# ⚠️ **刻意不用 `-c/-b` 的 cookie jar。** curl 会遵守 `Secure` 属性，
# 在 `http://` 上**不发**这条 cookie —— 那测的是 curl 的策略，
# 不是服务端的验签。这里显式把值塞回 `Cookie:` 头，测的是**服务端认不认**。
#
# 而"浏览器认不认（`__Host-` + `Secure` 在 `http://localhost` 上是否豁免）"
# 是计划 §13.12 第 1 条，**curl 测不了**，只能在浏览器里看
# DevTools → Application → Cookies。这里如实标出来，不假装覆盖了。
COOKIE_VALUE="$(printf '%s' "$sc" | sed -n 's/^__Host-session=\([^;]*\).*/\1/p')"
CK="Cookie: __Host-session=$COOKIE_VALUE"

if [ -n "$COOKIE_VALUE" ]; then
	expect 200 '把这个 cookie 带上去访问 /admin → 200（服务端验签通过）' "$(code -H "$CK" "$S/admin")"
else
	bad '从 Set-Cookie 里取出会话值' "[$sc]"
fi

# ⭐ 开放重定向的**强版本**：现在有会话了，`login.astro` 会真的去用 `next`。
# 不防的话 `/login?next=//evil.example` 就是一个可用的钓鱼跳板——
# 域名看起来是你的，落点是别人的。
loc="$(hdr Location -H "$CK" "$S/login?next=//evil.example")"
case "$loc" in
	*evil.example*) bad '/login?next=//evil.example 带会话也不回外站' "Location [$loc] 里出现了 evil.example" ;;
	*) ok "/login?next=//evil.example 带会话也不回外站（落在 [$loc]）" ;;
esac
# 只认 `/admin` 开头的 next，其余一律回落到 /admin —— 顺带证明它**没有**变成不跳。
loc="$(hdr Location -H "$CK" "$S/login?next=%2Fadmin%2Fposts%2Fhello-world")"
expect '/admin/posts/hello-world' '合法的 next（/admin 开头）会被采用' "$loc"

# 改一位签名就不认了（"伪造 cookie"的正向版本）
TAMPERED="$(printf '%s' "$COOKIE_VALUE" | sed 's/\(.*\)\(.\)\(.\)$/\1X\3/')"
expect 302 '把签名改一位 → 302（验签真的在看签名）' \
	"$(code -H "Cookie: __Host-session=$TAMPERED" "$S/admin")"

# ⚠️ 注意：**只是把载荷里的 exp 改大、签名不动，也必须被拒**。
# 这一条才是"签名覆盖了载荷"的证据；只改签名那一条在"签名根本没被检查"
# 的实现下也会通过（因为那时 cookie 会被整条乱解析而恰好失败）。
FORGED="v1.9999999999.1.$(printf '%s' "$COOKIE_VALUE" | sed -n 's/.*\.//p')"
expect 302 '只改 exp、签名不动的伪造 cookie → 302' \
	"$(code -H "Cookie: __Host-session=$FORGED" "$S/admin")"

# ════════════════════════════════════════════════════════════════
# C. 发表链路（含源码不动点）
# ════════════════════════════════════════════════════════════════
section "C. 发表链路"

SLUG="gate-test-post"
GATE_TMP="$(mktemp -d)"
PAYLOAD="$GATE_TMP/payload.json"
EXPECT_BODY="$GATE_TMP/expect-body.txt"

# 请求体由 `scripts/gate-payload.mjs` 从**文件内的字面量**生成。
#
# ⚠️ 不要在 shell 里拼这段 JSON。踩过一次：`node -e '…' "$BODY"` 里的中文
# 在 Windows + Git Bash 上会经 `GetCommandLineW` 按控制台代码页解一次，
# 到 Node 里已经是乱码，而整条链路不报错——不动点断言报 DIFF，
# 看起来像"服务端把中文写坏了"。所以 argv 里只留 ASCII（slug/日期/草稿开关），
# 中文全部待在 gate-payload.mjs 的文件里。
#
# 顺带：`GATE_EXPECT_BODY` 让期望正文与请求体**同源**，
# 不动点断言不需要在 shell 里再抄一份正文（抄了就会漂移）。
payload() { # $1=slug $2=pubDateRaw $3=draft → 打印请求体文件路径
	GATE_EXPECT_BODY="$EXPECT_BODY" \
		node scripts/gate-payload.mjs "$PAYLOAD" "$1" "$2" "$3" || exit 1
	printf '%s' "$PAYLOAD"
}

# ⚠️ 用 `--data-binary @文件` 而不是 `-d "$(cat 文件)"`：
# `-d` 会**吃掉数据里的换行**（curl 的文档行为），而这里靠的是 JSON 里
# 没有裸换行才碰巧没事——不该把正确性寄托在"碰巧"上。
expect 400 'bad slug（大写）→ 400' \
	"$(code -H "$CK" -X POST "$S/api/admin/posts" -H "$O" -H "$J" \
		--data-binary "@$(payload 'Bad Slug' '2026-09-21' false)")"
expect 400 '2026-02-31 → 400（Date.parse 对它宽容，会悄悄变成 3 月 3 日）' \
	"$(code -H "$CK" -X POST "$S/api/admin/posts" -H "$O" -H "$J" \
		--data-binary "@$(payload "$SLUG" '2026-02-31' false)")"
CREATE_ST="$(code -H "$CK" -X POST "$S/api/admin/posts" -H "$O" -H "$J" \
	--data-binary "@$(payload "$SLUG" '2026-09-21' false)")"
expect 201 '新建文章 → 201' "$CREATE_ST"
if [ "$CREATE_ST" != '201' ]; then
	# 说清楚，而不是让下面那些"草稿不可见 / 删掉之后 404"变成假绿——
	# 它们在一篇**根本没建出来**的文章上也会通过。
	printf '  \033[33m! 新建没成功（%s），C 段剩下的断言都在一篇不存在的文章上跑，不算数。\033[0m\n' "$CREATE_ST"
	printf '  \033[33m  先看这一条为什么失败，别读下面的结果。\033[0m\n'
fi
expect 409 '新建一个已存在的 slug → 409（换 slug 或去编辑，不静默覆盖）' \
	"$(code -H "$CK" -X POST "$S/api/admin/posts" -H "$O" -H "$J" \
		--data-binary "@$(payload "$SLUG" '2026-09-21' false)")"

# ── 不动点 ──────────────────────────────────────────────────────
#
# 计划 §13.11 第 11 条要求"发布 → 读回编辑器 → 与发布时的 Markdown 逐字节相同"。
# 这里**走真页面** `/admin/posts/<slug>`，从它的 `data-post` 属性里把 body 取回来
# ——那正是编辑器 `JSON.parse(el.dataset.post)` 吃的那份数据。
#
# ⚠️ 两个都容易写错的地方：
#
#   1. 不能直接拿 HTML 原文去比：属性的值经过 HTML 转义（`"` → `&#34;` 等），
#      所以要先反转义再比。这一步不做的话，比的是转义后的字节，恒不相等。
#   2. 反转义要**一趟扫完**，不能按实体挨个 `replace`。挨个替换的话，
#      正文里本来就有的 `&amp;` 会被转义成 `&#38;amp;`，而 `&#38;`→`&`
#      先跑，结果 `&amp;`→`&` 又把它吃一次，于是"原文没变"的正文被判成变了。
#      现在的语料里没有 `&`，所以两种写法都过——**这正是它会留下来的原因**。
#
# 期望正文从 `$EXPECT_BODY` **文件**里读，不走 argv：它全是中文，
# 走 argv 会在 Windows 上被控制台代码页解坏（见 payload() 上方的注释）。
curl -s -H "$CK" "$S/admin/posts/$SLUG" -o "$GATE_TMP/editor.html"
node -e '
	const fs = require("fs");
	const expected = fs.readFileSync(process.argv[1], "utf8");
	const html = fs.readFileSync(process.argv[2], "utf8");
	const m = html.match(/data-post="([^"]*)"/);
	if (!m) { console.log("NOMATCH"); process.exit(0); }
	const unescaped = m[1].replace(
		/&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|(amp|lt|gt|quot|apos|#39));/g,
		(_, dec, hex, named) => {
			if (dec) return String.fromCodePoint(Number(dec));
			if (hex) return String.fromCodePoint(parseInt(hex, 16));
			switch (named.toLowerCase()) {
				case "amp": return "&";
				case "lt": return "<";
				case "gt": return ">";
				case "quot": return "\"";
				// ⚠️ 撇号只能写成 fromCharCode(39)，不能写字面量。
				// 这段 JS 整体裹在 shell 的**单引号**里，一个撇号就会把引号提前闭合，
				// 而报错是「unexpected EOF while looking for matching `"`」——指到别处去。
				default: return String.fromCharCode(39);
			}
		},
	);
	let body;
	try { body = JSON.parse(unescaped).body; } catch (e) { console.log("BADJSON"); process.exit(0); }
	if (body === expected) { console.log("SAME"); process.exit(0); }
	console.log("DIFF");
	console.log("  期望 " + JSON.stringify(expected).slice(0, 120));
	console.log("  实际 " + JSON.stringify(body).slice(0, 120));
' "$EXPECT_BODY" "$GATE_TMP/editor.html" >"$GATE_TMP/fixpoint.txt"
case "$(head -1 "$GATE_TMP/fixpoint.txt")" in
	SAME) ok '不动点：读回编辑器的正文与发布时**逐字节相同**' ;;
	*)    bad '不动点：读回编辑器的正文' "$(tr '\n' ' ' <"$GATE_TMP/fixpoint.txt")" ;;
esac

# 再发一次同样的内容，库里不该多一行（PUT 是更新，不是插入）
st="$(code -H "$CK" -X PUT "$S/api/admin/posts/$SLUG" -H "$O" -H "$J" \
	--data-binary "@$(payload "$SLUG" '2026-09-21' false)")"
expect 200 'PUT 同 slug 更新 → 200（不是 404）' "$st"
n="$(npx wrangler d1 execute gegedda-blog-db --local --json --command \
	"SELECT COUNT(*) AS n FROM posts WHERE slug = '$SLUG'" 2>/dev/null |
	node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s)[0].results[0].n)}catch(e){console.log("?")}})')"
expect 1 '反复保存后 posts 里仍然只有一行（不是 INSERT 堆叠）' "$n"

expect 400 'PUT 的 slug 与 URL 参数不一致 → 400（slug 不可改）' \
	"$(code -H "$CK" -X PUT "$S/api/admin/posts/other-slug" -H "$O" -H "$J" \
		--data-binary "@$(payload "$SLUG" '2026-09-21' false)")"

# 读者侧：发布后立刻可见（这是整个改造要买的东西）
expect 200 '读者侧 /posts/gate-test-post/ 立即可见' "$(code "$S/posts/gate-test-post/")"
expect 200 '首页 200' "$(code "$S/")"

# 草稿：设成草稿后**连直接输 URL 都不可见**（坑 #1）
code -H "$CK" -X PUT "$S/api/admin/posts/$SLUG" -H "$O" -H "$J" \
	--data-binary "@$(payload "$SLUG" '2026-09-21' true)" >/dev/null
expect 404 '草稿：直接输 URL → 404（SSR 下详情页不再自动过滤，靠 publishedWhere）' \
	"$(code "$S/posts/gate-test-post/")"
if curl -s "$S/feed.xml" | grep -qF 'gate-test-post'; then
	bad '草稿不出现在 feed 里' 'feed 里有 gate-test-post'
else
	ok '草稿不出现在 feed 里'
fi
if curl -s "$S/sitemap-0.xml" | grep -qF 'gate-test-post'; then
	bad '草稿不出现在 sitemap 里' 'sitemap 里有 gate-test-post'
else
	ok '草稿不出现在 sitemap 里'
fi
# 改回发布
code -H "$CK" -X PUT "$S/api/admin/posts/$SLUG" -H "$O" -H "$J" \
	--data-binary "@$(payload "$SLUG" '2026-09-21' false)" >/dev/null

# 删除 → post_revisions 必须留着（删了还能捞回来）
expect 200 'DELETE → 200' \
	"$(code -H "$CK" -X DELETE "$S/api/admin/posts/$SLUG" -H "$O" -H "$J" -d '{}')"
expect 404 '删掉之后读者侧 404' "$(code "$S/posts/gate-test-post/")"

# ════════════════════════════════════════════════════════════════
# D. 限流（放最后：跑完这个 IP 就被锁 15 分钟）
# ════════════════════════════════════════════════════════════════
section "D. 限流（跑完本地这个桶就被锁 15 分钟）"

getparams="$(curl -s "$S/api/admin/login-params")"
case "$getparams" in
	*'"iterations":600000'*) ok 'login-params 返回 iterations' ;;
	*) bad 'login-params' "$getparams" ;;
esac

for i in 1 2 3 4 5; do
	st="$(code -X POST "$S/api/admin/login" -H "$O" -H "$J" -d "{\"verifier\":\"$VERIFIER_BAD\"}")"
	expect 401 "第 $i 次错口令 → 401（计数达到阈值仍回 401）" "$st"
done

st="$(code -X POST "$S/api/admin/login" -H "$O" -H "$J" -d "{\"verifier\":\"$VERIFIER_BAD\"}")"
expect 429 '第 6 次 → 429（锁在第 6 次生效，不是第 5 次）' "$st"
ra="$(hdr Retry-After -X POST "$S/api/admin/login" -H "$O" -H "$J" -d "{\"verifier\":\"$VERIFIER_BAD\"}")"
if [ -n "$ra" ] && [ "$ra" -gt 0 ] 2>/dev/null; then
	ok "429 带 Retry-After: $ra"
else
	bad '429 带 Retry-After' "[$ra]"
fi

# ⭐ 最重要的一条：锁定之后拿**正确的** verifier 也一样被拒。
# 只断言"错口令被拒"没有意义——那本来就会被拒。
st="$(code -X POST "$S/api/admin/login" -H "$O" -H "$J" -d "{\"verifier\":\"$VERIFIER_GOOD\"}")"
expect 429 '锁定后用【正确的】verifier 也是 429（证明锁在校验之前）' "$st"

# ════════════════════════════════════════════════════════════════
printf '\n\033[1m═══ 通过 %d / 失败 %d ═══\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]

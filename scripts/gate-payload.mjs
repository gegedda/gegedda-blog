/**
 * 给 `scripts/gate-p5.sh` 生成一份写接口的请求体。
 *
 * 用法：`node scripts/gate-payload.mjs <输出文件> <slug> <pubDateRaw> <draft>`
 *
 * ── 为什么要单独一个文件，而不是在 shell 里拼 ────────────────────
 *
 * 因为**中文不能走 argv**。
 *
 * 在 Windows + Git Bash 上，`node -e '…' "$BODY"` 里的中文会在
 * `GetCommandLineW` → Node 的那一步被按控制台代码页解一次，于是
 * 「验收门测试」到了 Node 里已经是「��ղ��」。而它是**悄悄发生**的：
 * 请求发出去、服务端存下来、页面渲染出来，整条链路都不报错，
 * 只是内容变成了乱码——看起来像"服务端把中文写坏了"。
 *
 * 这个坑在第一次跑验收门时真的踩到了：不动点断言报 DIFF，
 * 期望是中文、实际是乱码，第一反应是"写层有 bug"。
 * 换成"从文件读"之后逐字节相同 —— 说明写层没问题，是这段 shell 的问题。
 *
 * 所以这里的中文全部写成**文件内的字面量**，argv 里只留 ASCII
 * （slug / 日期 / 草稿开关）。
 */

import { writeFileSync } from 'node:fs';

const [outFile, slug, pubDateRaw, draftFlag] = process.argv.slice(2);

if (!outFile || !slug || !pubDateRaw) {
	console.error('用法：node scripts/gate-payload.mjs <输出文件> <slug> <pubDateRaw> <draft>');
	process.exit(2);
}

/** 正文：带中文、行内代码、围栏代码块、引用、表格。 */
const BODY = `# 验收门测试

中文段落，带 \`行内代码\`。

\`\`\`js
const x = 1;
\`\`\`

> 引用

| 列 | 列 |
| --- | --- |
| 值 | 值 |
`;

/**
 * 渲染后的 HTML。
 *
 * 是手写的一份**最小形状**，不是真管线产出的——这一门测的是
 * "HTTP 层收发与入库有没有走样"，不是渲染。渲染的逐字节一致性由
 * `npm run verify:render` 拿冻结样本守着（那一条才是真管线）。
 */
const BODY_HTML =
	'<h1 id="验收门测试">验收门测试</h1>' +
	'<p>中文段落，带 <code>行内代码</code>。</p>' +
	'<pre class="astro-code" data-language="js"><code>const x = 1;</code></pre>' +
	'<blockquote><p>引用</p></blockquote>' +
	'<table><thead><tr><th>列</th><th>列</th></tr></thead>' +
	'<tbody><tr><td>值</td><td>值</td></tr></tbody></table>';

const payload = {
	slug,
	title: '验收门测试',
	description: '验收门用的测试文章',
	pubDateRaw,
	updatedDateRaw: null,
	heroImage: null,
	draft: draftFlag === 'true',
	body: BODY,
	bodyHtml: BODY_HTML,
	headingsJson: JSON.stringify([{ depth: 1, slug: '验收门测试', text: '验收门测试' }]),
	words: 42,
	minutes: 1,
	tags: ['验收', '门'],
	categories: [],
};

// 显式 utf-8：不写的话 Node 按 locale 走，在中文 Windows 上可能是 GBK。
writeFileSync(outFile, JSON.stringify(payload), 'utf8');

// 顺带把期望的正文导出一份，给不动点断言用 —— 两边同源，不靠 shell 里的重复字面量。
if (process.env.GATE_EXPECT_BODY) {
	writeFileSync(process.env.GATE_EXPECT_BODY, BODY, 'utf8');
}

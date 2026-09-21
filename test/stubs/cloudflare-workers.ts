/**
 * `cloudflare:workers` 的测试替身（见 vitest.config.ts 的 alias）。
 *
 * 只有 workerd 认识 `cloudflare:workers` 这个协议，Node 直接解析会报
 * "Cannot find module"。而 `src/utils/posts.ts` 经由 `src/lib/db.ts` 引到它，
 * 于是同一文件里的纯函数就没法测了。
 *
 * `env` 是空对象**是刻意的**：`getDb()` 会因此抛「D1 绑定 DB 不存在」。
 * 那条路径在测试里就该是死的——仓储层的测试一律直接传一个 stub db 进去，
 * 不经过 getDb()。真被调到说明测试走错了路，报错比返回 undefined 好。
 */

export const env: Record<string, unknown> = {};

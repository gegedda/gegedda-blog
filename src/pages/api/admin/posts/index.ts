/**
 * `POST /api/admin/posts` —— 新建一篇。
 *
 * 校验、写库、错误翻译都在 `src/lib/post-endpoint.ts`，这里只剩路由本身。
 * 鉴权由中间件负责（`/api/admin/*` 不在白名单里），所以这个文件里
 * 看不到任何会话相关的代码——那是刻意的，见 `src/lib/admin-paths.ts`。
 */

import type { APIRoute } from 'astro';

import { handlePostWrite } from '../../../../lib/post-endpoint';

export const POST: APIRoute = async ({ request }) => handlePostWrite(request, { mode: 'create' });

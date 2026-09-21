/**
 * 仓储层测试，跑在真的 SQLite 上（见 test/stubs/d1.ts）。
 *
 * 这里每一条断言对应一个**不会报错**的失效模式。不是凑覆盖率：
 * 改造前是纯静态 SSG，详情页靠 `getStaticPaths` 继承了列表的草稿过滤，
 * 所以"草稿可按 URL 直达"这个 bug 在结构上不可能发生；改成 SSR 之后
 * 它变得完全可能，而且只表现为内容泄露，不会留下任何日志。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
	countPublishedPosts,
	countPublishedPostsByTag,
	getPostBySlugForAdmin,
	getPublishedPostBySlug,
	listPublishedPosts,
	listPublishedPostsByTag,
	listPublishedPostsWithContent,
	listTagCounts,
} from '../src/data/posts.repo';
import { attachTag, createStubDb, insertPost, type StubDb } from './stubs/d1';

let db: StubDb;

beforeEach(() => {
	db = createStubDb();
});
afterEach(() => {
	db.close();
});

describe('草稿过滤', () => {
	beforeEach(() => {
		insertPost(db, { slug: 'published', pubDate: '2026-03-01' });
		insertPost(db, { slug: 'secret-draft', pubDate: '2026-03-02', draft: true });
	});

	it('列表里没有草稿', async () => {
		const posts = await listPublishedPosts(db);
		expect(posts.map((p) => p.id)).toEqual(['published']);
	});

	it('草稿不能按 slug 直达', async () => {
		// 这是整次改造里风险最高的一条断言。列表过滤了、单篇没过滤，
		// 是 SSR 化最容易漏掉的地方：草稿在任何列表里都不出现，
		// 所以你不会发现它能被直接打开。
		expect(await getPublishedPostBySlug(db, 'secret-draft')).toBeNull();
	});

	it('但后台能取到草稿', async () => {
		const post = await getPostBySlugForAdmin(db, 'secret-draft');
		expect(post?.id).toBe('secret-draft');
		expect(post?.data.draft).toBe(true);
	});

	it('总数与列表口径一致', async () => {
		expect(await countPublishedPosts(db)).toBe(1);
	});
});

describe('全序与分页', () => {
	beforeEach(() => {
		// 三篇同一时刻发布。没有兜底键时 LIMIT/OFFSET 的顺序是未定义的，
		// 于是同一篇可能在两页里都出现、或者从两页里都消失。
		for (const slug of ['a-post', 'b-post', 'c-post']) {
			insertPost(db, { slug, pubDate: '2026-05-05' });
		}
	});

	it('三篇同日期时仍是一个全序', async () => {
		const page1 = await listPublishedPosts(db, { limit: 1, offset: 0 });
		const page2 = await listPublishedPosts(db, { limit: 1, offset: 1 });
		const page3 = await listPublishedPosts(db, { limit: 1, offset: 2 });

		const ids = [
			page1[0]?.id,
			page2[0]?.id,
			page3[0]?.id,
		];

		// 不重：三页是三个不同的 slug
		expect(new Set(ids).size).toBe(3);
		// 不漏：正好是全部三篇
		expect(ids.sort()).toEqual(['a-post', 'b-post', 'c-post']);
	});

	it('兜底键是 slug DESC，与索引一致', async () => {
		const posts = await listPublishedPosts(db);
		expect(posts.map((p) => p.id)).toEqual(['c-post', 'b-post', 'a-post']);
	});

	it('offset 超出范围返回空数组而不是报错', async () => {
		expect(await listPublishedPosts(db, { limit: 10, offset: 99 })).toEqual([]);
	});
});

describe('标签', () => {
	beforeEach(() => {
		insertPost(db, { slug: 'tagged', pubDate: '2026-04-01' });
		insertPost(db, { slug: 'draft-tagged', pubDate: '2026-04-02', draft: true });
		// position 刻意与字母序相反：顺序错了要能看出来
		attachTag(db, 'tagged', '前端', encodeURIComponent('前端'), 0);
		attachTag(db, 'tagged', 'Hello World', 'hello-world', 1);
		attachTag(db, 'tagged', 'CSS 布局', encodeURIComponent('CSS 布局'), 2);
		attachTag(db, 'draft-tagged', '草稿专属', encodeURIComponent('草稿专属'), 0);
	});

	it('标签顺序按 position，不按标签名也不按 id', async () => {
		const [post] = await listPublishedPosts(db);
		expect(post?.data.tags).toEqual(['前端', 'Hello World', 'CSS 布局']);
	});

	it('单篇查询也带标签，且顺序一致', async () => {
		const post = await getPublishedPostBySlug(db, 'tagged');
		expect(post?.data.tags).toEqual(['前端', 'Hello World', 'CSS 布局']);
	});

	it('没有标签的文章是空数组而不是 undefined', async () => {
		insertPost(db, { slug: 'untagged', pubDate: '2026-04-03' });
		const posts = await listPublishedPosts(db);
		const untagged = posts.find((p) => p.id === 'untagged');
		expect(untagged?.data.tags).toEqual([]);
	});

	it('标签计数不含草稿的标签', async () => {
		const counts = await listTagCounts(db);
		expect(counts.map((c) => c.tag)).not.toContain('草稿专属');
	});

	it('按标签筛选只返回公开文章', async () => {
		const posts = await listPublishedPostsByTag(db, encodeURIComponent('草稿专属'));
		expect(posts).toEqual([]);
		expect(await countPublishedPostsByTag(db, encodeURIComponent('草稿专属'))).toBe(0);
	});

	it('按 segment 而不是显示名筛选', async () => {
		const posts = await listPublishedPostsByTag(db, 'hello-world');
		expect(posts.map((p) => p.id)).toEqual(['tagged']);
	});
});

describe('行到领域对象的映射', () => {
	it('缓存列为 NULL 时退化而不抛错', async () => {
		// 库里允许缓存列为 NULL（表示尚未渲染）。这里抛错的话，
		// 一篇还没渲染的文章会让整个列表页 500，而不是只让那一篇看着空。
		db.exec(
			`INSERT INTO posts (slug, title, description, pub_date_raw, pub_date_utc,
				draft, body, body_html, headings_json, words, minutes, categories_json,
				created_at, updated_at)
			 VALUES ('unrendered', 't', 'd', '2026-06-01', 0, 0, '# hi',
				NULL, NULL, NULL, NULL, '[]', 0, 0)`,
		);
		const post = await getPublishedPostBySlug(db, 'unrendered');
		expect(post?.bodyHtml).toBe('');
		expect(post?.headings).toEqual([]);
		expect(post?.words).toBe(0);
		expect(post?.minutes).toBe(1);
	});

	it('headings_json 坏掉时退化成空目录，而不是让整页挂掉', async () => {
		insertPost(db, { slug: 'bad-json', pubDate: '2026-06-02', headingsJson: '{不是 JSON' });
		const post = await getPublishedPostBySlug(db, 'bad-json');
		expect(post?.headings).toEqual([]);
	});

	it('updatedDate 与 heroImage 缺省时是 undefined', async () => {
		insertPost(db, { slug: 'minimal', pubDate: '2026-06-03' });
		const post = await getPublishedPostBySlug(db, 'minimal');
		expect(post?.data.updatedDate).toBeUndefined();
		expect(post?.data.heroImage).toBeUndefined();
	});

	it('日期按 raw 原文解析，不受 UTC 存储值影响', async () => {
		insertPost(db, { slug: 'dated', pubDate: '2026-07-08', updatedDate: '2026-08-09' });
		const post = await getPublishedPostBySlug(db, 'dated');
		// 用 UTC 取年月日，避免测试自己依赖运行机器的时区
		expect(post?.data.pubDate.toISOString().slice(0, 10)).toBe('2026-07-08');
		expect(post?.data.updatedDate?.toISOString().slice(0, 10)).toBe('2026-08-09');
	});

	it('列表行不含 body_html（省掉每张卡片一次大字段读取）', async () => {
		insertPost(db, { slug: 'big', pubDate: '2026-06-04', bodyHtml: '<p>很长</p>' });
		const [post] = await listPublishedPosts(db);
		expect(post?.bodyHtml).toBe('');
		// 但正文 HTML 本身存着，单篇查询能取到
		expect((await getPublishedPostBySlug(db, 'big'))?.bodyHtml).toBe('<p>很长</p>');
	});

	it('带正文的列表确实带上了正文（RSS 的取数路径）', async () => {
		// 这条是为了一个**真实发生过**的 bug：feed.xml 用了不带上文的
		// listPublishedPosts，于是每篇都输出 <content:encoded/> 空条目——
		// 文件合法、订阅器里什么都没有，而且不报错。
		insertPost(db, { slug: 'feed-a', pubDate: '2026-06-05', bodyHtml: '<p>正文 A</p>' });
		insertPost(db, { slug: 'feed-b', pubDate: '2026-06-06', bodyHtml: '<p>正文 B</p>' });

		const posts = await listPublishedPostsWithContent(db);
		expect(posts.map((p) => p.bodyHtml)).toEqual(['<p>正文 B</p>', '<p>正文 A</p>']);
	});

	it('带正文的列表同样过滤草稿、同样带标签', async () => {
		insertPost(db, { slug: 'feed-ok', pubDate: '2026-06-07', bodyHtml: '<p>ok</p>' });
		insertPost(db, { slug: 'feed-draft', pubDate: '2026-06-08', draft: true, bodyHtml: '<p>secret</p>' });
		attachTag(db, 'feed-ok', '前端', encodeURIComponent('前端'), 0);

		const posts = await listPublishedPostsWithContent(db);
		expect(posts.map((p) => p.id)).toEqual(['feed-ok']);
		expect(posts[0]?.data.tags).toEqual(['前端']);
	});

	it('带正文的列表受 limit 约束（feed 不该拖全表）', async () => {
		for (let i = 0; i < 5; i++) {
			insertPost(db, { slug: `feed-n-${i}`, pubDate: '2026-06-09', bodyHtml: `<p>${i}</p>` });
		}
		expect((await listPublishedPostsWithContent(db, { limit: 3 })).length).toBe(3);
	});
});

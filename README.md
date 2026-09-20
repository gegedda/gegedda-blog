# gegedda · 个人博客

基于 [Astro](https://astro.build/) 构建的个人博客。内容以 Markdown 写作，通过 Git 管理，部署在 Cloudflare Pages（规划中）。

## 功能现状

- ✅ 文章列表（首页最新 3 篇 + `/blog` 全部）
- ✅ 文章详情页（Markdown / MDX 渲染）
- ✅ RSS（`/rss.xml`）与 Sitemap
- ✅ 响应式布局
- ⏳ 规划中：标签/分类、站内搜索、评论、访问统计、自定义域名

## 项目结构

```text
blog/
├── public/                 # 静态资源
├── src/
│   ├── assets/             # 图片等（文章可引用）
│   ├── components/         # 组件（Header / Footer / BaseHead 等）
│   ├── content/blog/       # ★ 文章目录（Markdown / MDX）
│   ├── layouts/            # 页面布局
│   ├── pages/              # 路由页面（index / blog / about / rss）
│   ├── consts.ts           # ★ 站点全局配置（站名、副标题）
│   ├── content.config.ts   # 文章 frontmatter 校验
│   └── styles/global.css   # 全局样式
├── astro.config.mjs        # ★ Astro 配置（site 地址等）
└── package.json
```

## 快速开始

```sh
npm install        # 安装依赖
npm run dev        # 本地开发，打开 http://localhost:4321
npm run build      # 构建生产版本到 ./dist/
npm run preview    # 本地预览构建产物
```

## 写作一篇新文章

1. 在 `src/content/blog/` 新建 `.md` 文件；
2. 文件头部填写 frontmatter：

```yaml
---
title: '文章标题'
description: '文章摘要'
pubDate: '2026-09-20'
heroImage: '../../assets/xxx.jpg'   # 可选，封面图
---
```

3. `npm run dev` 本地预览 → `npm run build` 确认构建通过 → `git push` 自动上线。

## 部署（待完成）

- [ ] 在 GitHub 创建仓库并推送代码
- [ ] 在 Cloudflare Pages 关联仓库，构建命令 `npm run build`，输出目录 `dist`
- [ ] 将 `astro.config.mjs` 中 `site` 改为正式网址
- [ ] 绑定自定义域名（可选）

## 参考

- [Astro 文档](https://docs.astro.build/zh-cn/)
- 模板基于 [Astro Blog Starter](https://astro.build/themes/)

# blog · 站点源码

gegedda 个人博客的 Astro 源码。项目总览、本地预览、写作流程、部署方式都在根目录文档里：

- [../README.md](../README.md) — **本地预览（不重新部署看效果）**、页面路由、写作流程、常用命令
- [../docs/项目说明.md](../docs/项目说明.md) — 技术栈、功能进度、内容模型、工程约定
- [../docs/部署指南.md](../docs/部署指南.md) — 部署现状与日常发布

## 目录

```text
blog/
├── public/                 # 原样复制的静态资源
│   ├── _redirects          # ★ 旧地址 301（仅 Cloudflare Pages 生效）
│   └── _headers            # /_astro/ 长缓存
├── src/
│   ├── assets/             # 图片（走 astro:assets 优化）
│   ├── components/         # 组件：导航、侧栏文章树、TOC、标签、主题切换、分页…
│   ├── content/blog/       # ★ 文章目录（Markdown / MDX）
│   ├── layouts/            # BaseLayout / PageLayout / PostLayout / DocsLayout
│   ├── pages/              # ★ 路由（见下）
│   ├── styles/global.css   # 全局样式 + 设计令牌（Tailwind v4）
│   ├── utils/posts.ts      # ★ 文章读取、排序、URL、标签、日期分组、阅读时长
│   ├── utils/toc.ts        # 目录（TOC）生成
│   ├── consts.ts           # ★ 站点全局配置（站名、导航、每页条数、作者）
│   └── content.config.ts   # ★ 文章 frontmatter 校验（字段以它为准）
└── astro.config.mjs        # ★ Astro 配置（site、Shiki 双主题、sitemap 过滤）
```

### 路由文件

```text
src/pages/
├── [...page].astro         # 首页 = 文章列表 + 分页（/2/、/3/…）
├── posts/[...slug].astro   # 文章详情 → /posts/:slug/
├── tags/index.astro        # 标签总览 → /tags/
├── tags/[tag].astro        # 单标签   → /tags/:tag/
├── archives.astro          # 归档     → /archives/
├── about.astro             # 关于     → /about/
├── feed.xml.js             # RSS      → /feed.xml
└── 404.astro               # 404
```

> 改路由时**只改 `src/utils/posts.ts` 里的 `postUrl()` / `tagUrl()`**，不要在页面里手拼路径。

## 常用命令

```sh
npm install        # 安装依赖
npm run dev        # 开发服务器 → http://localhost:4321
npm run build      # 构建到 ./dist/
npm run preview    # 预览构建产物（改完源码要重新 build）
```

> 仓库只跟踪源码：`dist/`、`.astro/`、`node_modules/` 均已在 `.gitignore` 中忽略。

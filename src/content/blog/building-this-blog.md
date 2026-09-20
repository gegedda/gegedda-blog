---
title: '如何从零搭建这个博客'
description: '记录本博客的技术选型、项目结构与写作发布流程，方便以后维护和复现。'
pubDate: '2026-09-20'
heroImage: '../../assets/blog-placeholder-4.jpg'
---

这个博客从零搭建的过程，本身就是一篇值得记录的文章。这篇文章记录当前的技术方案与工作流。

## 技术栈

| 组件 | 选择 | 说明 |
| --- | --- | --- |
| 站点框架 | Astro | 静态生成，默认零 JS，性能好 |
| 内容 | Markdown + MDX | 本地文件，随 Git 版本管理 |
| 代码高亮 | Shiki | Astro 内置支持 |
| 托管 | Cloudflare Pages | 免费、全球 CDN，Git push 自动部署 |
| 评论 / 搜索 / 统计 | 规划中 | 上线后按需接入 |

## 项目结构

```
blog/
├── src/
│   ├── content/blog/   # 文章（Markdown）
│   ├── layouts/        # 页面布局
│   ├── components/     # 组件（导航、页脚等）
│   ├── pages/          # 路由页面
│   ├── consts.ts       # 站点全局配置
│   └── styles/         # 全局样式
├── astro.config.mjs    # Astro 配置
└── package.json
```

## 写作与发布流程

1. 在 `src/content/blog/` 新建 Markdown 文件，填写 frontmatter（标题、日期、描述等）
2. 本地预览：`npm run dev`
3. 推送 Git：`git push`，Cloudflare Pages 自动构建上线

## 后续计划

- [ ] 标签与分类系统
- [ ] 站内搜索（Pagefind）
- [ ] 评论系统
- [ ] 访问统计
- [ ] 自定义域名

这个列表会持续更新，具体进度可以看首页的更新。

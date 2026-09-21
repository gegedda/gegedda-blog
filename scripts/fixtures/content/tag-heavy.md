---
title: '标签、草稿与更新时间的往返测试'
description: '覆盖现有两篇文章没走到的路径：tags（含中文、空格、大小写混合）、draft、updatedDate。'
pubDate: '2026-01-01'
updatedDate: '2026-02-02'
draft: true
tags: ['前端', 'Hello World', 'CSS 布局', 'a  b']
---

这篇夹具存在的唯一目的是**覆盖现有文章没走到的代码路径**。

现有两篇文章的 frontmatter 都只有 title / description / pubDate / heroImage，
所以 tags、draft、updatedDate 三条路径从来没有被验证过。而这三条恰恰是最容易
出问题的：

- `tags` 要经过 `tags` 表 + `post_tags` 表，还要按 `position` 保住顺序
- `draft` 是 SQLite 里的 0/1，与 YAML 的 true/false 之间要来回转
- `updatedDate` 是可空列，null 与字符串两种状态都要能回去

## 标签顺序

`['前端', 'Hello World', 'CSS 布局', 'a  b']` 这个顺序必须原样保留：
TagChips 是按数组顺序渲染的，存进数据库再取出来如果变成别的顺序，
页面上看不出来，但 diff 会一直抖。

最后一个标签带两个连续空格。它在两条路径上的表现**故意不同**：

- 显示名保留原样：`a  b`（`tags.name` 列）
- URL 片段折叠成一个连字符：`a-b`（`tags.segment` 列）

因为 `tagSegment` 用的是 `\s+` 而不是 `\s`，一次匹配整段空白。
两条路径各走各的：显示用 name，链接用 segment。混用会让标签页 404，
而列表页看起来完全正常。

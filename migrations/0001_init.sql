-- D1 初始 schema
--
-- 核心决策：库里永远只存 Markdown 源码（posts.body）。body_html / headings_json /
-- words / minutes 都是**可重建的缓存列**——渲染管线换了、编辑器换了，重建一遍即可，
-- 不需要数据迁移。这条锁死了「现有文章无损导入」和「将来换编辑器不动数据库」。
--
-- D1 注意：D1 拒绝显式 BEGIN/COMMIT，需要原子性的地方用 db.batch([...])。
-- 因此本文件里不写事务语句。

-- ---------------------------------------------------------------- posts

CREATE TABLE posts (
  -- slug 同时是主键和 URL 片段（= 原来的 post.id）。
  -- 用 slug 当主键而不是自增 id，是为了让 postUrl() 的现有行为一字不改。
  slug             TEXT    PRIMARY KEY,

  title            TEXT    NOT NULL,
  description      TEXT    NOT NULL,

  -- 日期双列。raw 是真源，utc 只服务 ORDER BY，两者不可互相替代。
  --
  -- 为什么不直接在 SQL 里算出年月日：src/utils/posts.ts 里那三段
  -- Asia/Shanghai 的 Intl.DateTimeFormat 是承重的不变量，分组一律走它们。
  -- 在 SQL 里再实现一遍就会出现第二份时区实现，两者迟早漂移，
  -- 而漂移的表现是「侧栏、归档、正文三处日期对不上」且只在特定时刻复现。
  --
  -- 存 raw 原文还有个直接好处：F 盘反解出的 Markdown 能做到逐字节一致。
  pub_date_raw     TEXT    NOT NULL,
  pub_date_utc     INTEGER NOT NULL,
  updated_date_raw TEXT,
  updated_date_utc INTEGER,

  -- 封面图在 frontmatter 里的相对路径原文（如 '../../assets/x.jpg'）。
  -- 不解析成绝对地址：换图床（P6 上 R2）时只需要改解析处，不用改数据。
  hero_image       TEXT,

  -- SQLite 没有 boolean，用 0/1
  draft            INTEGER NOT NULL DEFAULT 0,

  -- ↓ Markdown 源码，唯一真源
  body             TEXT    NOT NULL,

  -- ↓ 以下全部是可重建的缓存列，允许为 NULL（表示尚未渲染）
  body_html        TEXT,
  headings_json    TEXT,
  words            INTEGER,
  minutes          INTEGER,

  -- content.config.ts 里声明了 categories 却从未实现，现有文章也没有。
  -- 仍然无损保留：导入时丢掉数据是不可逆的，将来删这个字段应当是一个独立决定。
  categories_json  TEXT    NOT NULL DEFAULT '[]',

  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

-- 列表与分页：ORDER BY pub_date_utc DESC, slug DESC
--
-- slug 这个兜底键不是可有可无的。现有两篇文章的 pubDate 完全相同（都是
-- 2026-09-20），没有全序时 LIMIT/OFFSET 会让同一篇跨页重复出现或整个消失。
CREATE INDEX idx_posts_pubdate ON posts (pub_date_utc DESC, slug DESC);

-- 草稿过滤后的列表：WHERE draft = 0 ORDER BY pub_date_utc DESC, slug DESC
CREATE INDEX idx_posts_draft_pubdate ON posts (draft, pub_date_utc DESC, slug DESC);

-- ---------------------------------------------------------------- tags

CREATE TABLE tags (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 显示名，原样保留大小写与空格（'Hello World' 就显示成 Hello World）
  name    TEXT    NOT NULL UNIQUE,
  -- URL 片段：src/utils/posts.ts 里 tagSegment() 的规范形式（小写、空格转连字符）。
  --
  -- 单独一列并加唯一约束，是为了堵掉一个现有实现里的静默 bug：
  -- 'Hello World' 和 'hello-world' 两个 tag 会算出同一个 URL，
  -- 于是两个标签页互相覆盖，而列表页看起来完全正常。
  segment TEXT    NOT NULL UNIQUE
);

-- ---------------------------------------------------------------- post_tags

CREATE TABLE post_tags (
  post_slug TEXT    NOT NULL REFERENCES posts(slug) ON DELETE CASCADE,
  tag_id    INTEGER NOT NULL REFERENCES tags(id)    ON DELETE CASCADE,
  -- frontmatter 里 tags 数组的顺序。TagChips.astro 按 .map() 顺序渲染，
  -- 不存这一列的话标签会按 join 顺序乱掉，每次查询顺序还不一定一样。
  position  INTEGER NOT NULL,
  PRIMARY KEY (post_slug, tag_id)
);

-- 反查某个标签下有哪些文章（/tags/:tag/ 就是这条）
CREATE INDEX idx_post_tags_tag ON post_tags (tag_id);

-- ---------------------------------------------------------------- post_revisions

-- 替代 Git 的「内容回滚」。D1 成为真源后 git revert 救不回正文——
-- 这个表是唯一的退路，每次保存写一行。
--
-- 故意不加 REFERENCES posts(slug)：修订记录必须比文章活得久，
-- 删了文章还能从修订里捞回来。加了外键就会跟着一起被删掉。
CREATE TABLE post_revisions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  post_slug  TEXT    NOT NULL,
  title      TEXT    NOT NULL,
  body       TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_revisions_slug ON post_revisions (post_slug, created_at DESC);

-- ---------------------------------------------------------------- settings

-- 键值对。存 password_hash / session_secret / session_epoch / content_revision。
--
-- ⚠️ 这张表**不进 F 盘镜像**（导出时用 --table 排除）：
-- 里面的 password_hash 和 session_secret 是明文，而 F 盘是未加密的 NTFS。
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ---------------------------------------------------------------- login_attempts

-- 登录限流。按 IP 的哈希记录，**不存原始 IP**——限流不需要知道你是谁。
CREATE TABLE login_attempts (
  -- SHA-256(cf-connecting-ip + salt) 的十六进制
  --
  -- 保留值 '__global__'：用作全局限流那一行（防分布式绕过，如 100 次失败/小时）。
  -- 它不可能是合法的十六进制哈希，所以不会和真实 IP 冲突。
  ip_hash      TEXT    PRIMARY KEY,
  failed_count INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL,
  locked_until INTEGER
);

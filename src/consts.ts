// 站点全局配置：在这里修改站名、副标题等信息，全站自动生效。

export const SITE_TITLE = 'gegedda';
export const SITE_DESCRIPTION = '记录技术学习与个人思考的个人博客。';

/** <html lang> 与 RSS <language> 共用 */
export const SITE_LANG = 'zh-CN';
/** og:locale 用下划线形式 */
export const SITE_LOCALE = 'zh_CN';
/** 仓库地址：关于页与页脚引用 */
export const SITE_REPO = 'https://github.com/gegedda/gegedda-blog';

/**
 * 侧栏导航。注意这里**不含「文章」**：列表页就是 `/`，和「首页」同址，
 * 两项都放进去会导致同一次访问有两个菜单项同时高亮。
 * 文章树本身就在左栏，也不需要额外一个入口。
 */
export const NAV_ITEMS = [
	{ href: '/', label: '首页' },
	{ href: '/archives/', label: '归档' },
	{ href: '/tags/', label: '标签' },
	{ href: '/about/', label: '关于' },
] as const;

/** 列表页每页文章数 */
export const PAGE_SIZE = 10;

/** 作者信息。留空则相关区块整体不渲染，不会出现 TODO 字样。 */
export const AUTHOR = {
	name: '',
	avatar: '',
	bio: '',
};

/** 社交链接。空数组时整块不渲染。 */
export const SOCIAL_LINKS: { label: string; href: string }[] = [];

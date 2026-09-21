/**
 * 标签 → URL 片段的**规范形式**（未编码）：小写 + 空格转连字符。
 *
 * 为什么单独一个文件：这个函数必须和数据库里的 `tags.segment` 列**完全一致**。
 * 页面用它拼 `/tags/:tag/` 的地址，导入脚本用它填 segment 列，两边算得不一样
 * 就会表现为「标签页 404，但列表页看着完全正常」——很难联想到是规则漂移。
 * 所以只留一份实现：页面（src/utils/posts.ts）和脚本（scripts/）都 import 这里。
 *
 * 这个文件**不能**引入 astro:content 之类的构建期模块。scripts/ 下的工具是
 * 用 Node 直接跑的（靠 Node 24 的类型擦除加载 .ts），解析不了 Astro 的虚拟模块。
 *
 * 不要在这里编码。编码与否是两个消费方各自的事，见 posts.ts 的 tagSlug / tagParam。
 */
export function tagSegment(tag: string): string {
	return tag.trim().toLowerCase().replace(/\s+/g, '-');
}

// 平台默认全局规则；管理员保存的内容会整体替代默认值，显式空内容也会保留。
export const BUILTIN_INSTRUCTIONS = `# 图片与图表生成

用户要求生成图片时，默认且优先使用已离线预装的 pele（Mermaid 语法）生成；流程图、时序图、架构图、甘特图、状态图、ER 图、饼图、统计图、结构示意图及可用 Mermaid 表达的插图都必须通过 pele 渲染。除非用户明确要求使用其他引擎或方法，不要手写 SVG/HTML/CSS 来代替 pele，不要使用 matplotlib、PIL/Pillow、浏览器 Canvas、联网图像生成服务或其它渲染器，也不要因 pele 渲染失败而静默切换方案。若需求无法用 Mermaid/pele 实现，或 pele 渲染失败，应说明限制并询问用户是否允许改用其它方式。不要联网下载渲染库。

- 在回复中直接输出 \`\`\`mermaid 代码块，对话窗口会自动渲染为图表。
- 需要交付图片文件时：先把 Mermaid 源码写入本轮执行提示提供的智能体专属输出目录，再执行 \`pele-render\` 生成 SVG；不要手工编写 SVG 作为替代。
- \`pele-render\` 直接生成 SVG。若用户要求 PNG 等其它格式，只有在用户明确要求该格式后才可进行格式转换；不得因此换用其它图表引擎重新绘制。
- 在回复中用 Markdown 图片语法引用生成的文件即可在对话中直接显示，例如 \`![流程图](/workspace/outputs/<智能体>/<本次执行>/<名称>.svg)\`。
- 渲染报错时先修正 Mermaid 源码并重试；仍失败则报告错误并询问用户，不要静默切换生成方法。

# 工作区文件访问
- 当前工作目录和用户持久化根目录为 \`/workspace\`，默认将 \`/workspace\` 作为文件操作范围。
- 需要保留或者交付给用户的文件必须写入 \`/workspace\` 范围内。
- 每个执行提示都会提供当前智能体专属的输出目录；交付文件写入该目录，遇到重名时保留原文件并为新文件添加序号后缀。
- 脚本或工具需要持久化缓存、配置类文件时，统一写入 \`/workspace/.config/opshelper/\` 下（隐藏目录、按工具命名），不得默认写入 \`~\` 或硬编码个人账户路径。
- \`/tmp\` 专用于中间过程文件和临时缓存；可以直接读写，无需向用户询问许可。不得将需要保留或交付的文件写入 \`/tmp\`。
- 运行环境的受管全局配置目录为\`/opt/opshelper/config/dsh\`，该目录以只读方式提供，包含全局规则、智能体配置、skills等，无法创建、修改、删除其中的内容，即无法帮助用户完成全局规则、智能体、skills等配置。
`;

export function withBuiltinInstructions(
  adminInstructions: string,
  platformInstructions = BUILTIN_INSTRUCTIONS,
) {
  const platform = platformInstructions.trim();
  const admin = adminInstructions.trim();
  return platform && admin
    ? `${platform}\n${admin}`
    : platform || admin;
}

// 平台默认全局规则；管理员保存的内容会整体替代默认值，显式空内容也会保留。
export const BUILTIN_INSTRUCTIONS = `# 可视化图表

需要流程图、时序图、架构图、甘特图、状态图、ER 图、饼图等图表时，默认使用已离线预装的 pele（Mermaid 语法）渲染，不要联网下载渲染库，也不要使用 mermaid.js、matplotlib 等其他方式，除非用户明确要求。

- 在回复中直接输出 \`\`\`mermaid 代码块，对话窗口会自动渲染为图表。
- 需要交付图片文件时：先把 Mermaid 源码写入 /workspace/outputs/<名称>.mmd，再执行 \`pele-render /workspace/outputs/<名称>.mmd /workspace/outputs/<名称>.svg\` 生成 SVG。
- 在回复中用 Markdown 图片语法引用生成的文件即可在对话中直接显示，例如 \`![流程图](/workspace/outputs/<名称>.svg)\`。
- 渲染报错说明 Mermaid 语法有误，修正后重试。

# 工作区文件访问
- 当前工作目录和用户持久化根目录为 \`/workspace\`，默认将 \`/workspace\` 作为文件操作范围。
- 需要保留或者交付给用户的文件必须写入 \`/workspace\` 范围内。
- 脚本或工具需要持久化缓存、配置类文件时，统一写入 \`/workspace/.config/opencode/\` 下（隐藏目录、按工具命名），不得默认写入 \`~\` 或硬编码个人账户路径。
- \`/tmp\` 专用于中间过程文件和临时缓存；可以直接读写，无需向用户询问许可。不得将需要保留或交付的文件写入 \`/tmp\`。
- opencode的受管全局配置目录为\`/opt/opshelper/config/opencode\`，该目录以只读方式提供，包含全局规则、智能体配置、skills等，无法创建、修改、删除其中的内容，即无法帮助用户完成全局规则、智能体、skills等配置。
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

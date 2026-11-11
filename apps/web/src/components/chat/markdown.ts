import MarkdownIt from "markdown-it";
import { render as renderDiagram } from "pele";

const lineBreakTag = /^<br\s*\/?\s*>$/i;

const markdown = new MarkdownIt({ html: true, linkify: true, breaks: true });

const codeLanguageLabels: Record<string, string> = {
  bash: "Bash",
  c: "C",
  cpp: "C++",
  "c++": "C++",
  csharp: "C#",
  css: "CSS",
  diff: "Diff",
  go: "Go",
  html: "HTML",
  java: "Java",
  javascript: "JavaScript",
  js: "JavaScript",
  json: "JSON",
  jsx: "JSX",
  markdown: "Markdown",
  md: "Markdown",
  plain: "纯文本",
  plaintext: "纯文本",
  powershell: "PowerShell",
  py: "Python",
  python: "Python",
  rust: "Rust",
  sh: "Bash",
  shell: "Bash",
  sql: "SQL",
  text: "纯文本",
  ts: "TypeScript",
  tsx: "TSX",
  typescript: "TypeScript",
  txt: "纯文本",
  xml: "XML",
  yaml: "YAML",
  yml: "YAML",
  mermaid: "Mermaid",
};

function codeLanguageLabel(info: string) {
  const language = info.trim().split(/\s+/)[0] ?? "";
  return codeLanguageLabels[language.toLowerCase()] ?? (language || "纯文本");
}

const CODE_LANGUAGE_ICON =
  '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m8 7-5 5 5 5M16 7l5 5-5 5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const CODE_COPY_ICON =
  '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2" stroke="currentColor" stroke-width="1.7"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" stroke="currentColor" stroke-width="1.7"/></svg>';

function wrapCodeBlock(label: string, code: string) {
  const escapedLabel = markdown.utils.escapeHtml(label);
  return `<div class="opshelper-code-block"><div class="opshelper-code-header"><span class="opshelper-code-language">${CODE_LANGUAGE_ICON}<span>${escapedLabel}</span></span><button type="button" class="opshelper-code-copy" data-code-copy aria-label="复制代码" title="复制代码">${CODE_COPY_ICON}</button></div>${code}</div>\n`;
}

function renderSafeHtml(tokens: { content: string }[], index: number) {
  const content = tokens[index]?.content ?? "";
  return lineBreakTag.test(content.trim()) ? "<br>" : markdown.utils.escapeHtml(content);
}

// Model output occasionally uses <br> inside Markdown tables. Allow that one
// presentation-only tag while escaping every other HTML fragment.
markdown.renderer.rules.html_inline = renderSafeHtml;
markdown.renderer.rules.html_block = renderSafeHtml;

// 宽表格自己横向滚动，不要带着整个页面一起滚。外面套一层专用容器而不是给
// .opshelper-markdown 加 overflow：后者会把正文里的其它溢出也一并裁掉。
const defaultTokenRule =
  (markdown.renderer.rules.table_open) ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
const defaultCloseRule =
  (markdown.renderer.rules.table_close) ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));

markdown.renderer.rules.table_open = (tokens, idx, options, env, self) =>
  `<div class="opshelper-table-scroll">${defaultTokenRule(tokens, idx, options, env, self)}`;
markdown.renderer.rules.table_close = (tokens, idx, options, env, self) =>
  `${defaultCloseRule(tokens, idx, options, env, self)}</div>`;

// ```mermaid 代码块用 pele 同步渲染为 SVG（pele 会转义文本并过滤链接/样式）。
// 语法不完整（如流式输出中途）或渲染失败时回退为普通代码块。
const defaultFenceRule =
  markdown.renderer.rules.fence ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
const defaultCodeBlockRule =
  markdown.renderer.rules.code_block ??
  ((tokens, idx, _options, _env, _self) =>
    `<pre><code>${markdown.utils.escapeHtml(tokens[idx].content)}</code></pre>\n`);

markdown.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const language = token.info.trim().split(/\s+/)[0]?.toLowerCase();
  if (language === "mermaid") {
    // 同一条回答已用图片引用了生成的图时，不再重复渲染一遍源码图。
    if ((env as { hasWorkspaceImage?: boolean } | undefined)?.hasWorkspaceImage) return "";
    try {
      return `<div class="opshelper-diagram" role="button" tabindex="0" aria-label="查看图表">${renderDiagram(token.content).svg}</div>\n`;
    } catch {
      return wrapCodeBlock("Mermaid", `<pre><code>${markdown.utils.escapeHtml(token.content)}</code></pre>\n`);
    }
  }
  const code = defaultFenceRule(tokens, idx, options, env, self);
  return wrapCodeBlock(codeLanguageLabel(token.info), code);
};

markdown.renderer.rules.code_block = (tokens, idx, options, env, self) =>
  wrapCodeBlock("纯文本", defaultCodeBlockRule(tokens, idx, options, env, self));

// 助手用 ![说明](/workspace/outputs/x.svg) 引用工作区里的图片（如 pele 生成的 SVG），
// 改写为带登录态的文件下载地址；其它外链图片保持原样。
const FILES_API = "/v1/users/me/files";
const defaultImageRule =
  markdown.renderer.rules.image ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
const defaultLinkRule =
  markdown.renderer.rules.link_open ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));

// 工作区文件链接改写为带登录态的下载地址；外部链接保持原样。
markdown.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  let href = token.attrGet("href") ?? "";
  try {
    href = decodeURIComponent(href);
  } catch {
    return defaultLinkRule(tokens, idx, options, env, self);
  }
  if (/^\/workspace\/[^?#]+$/.test(href) && !href.split("/").includes("..")) {
    token.attrSet("href", `${FILES_API}/download?path=${encodeURIComponent(href)}`);
  }
  return defaultLinkRule(tokens, idx, options, env, self);
};

markdown.renderer.rules.image = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  token.attrSet("tabindex", "0");
  token.attrSet("role", "button");
  token.attrSet("aria-label", "查看图片");
  // markdown-it 已把非 ASCII 字符（如中文文件名）百分号编码，先还原再编码，避免双重编码。
  let src = token.attrGet("src") ?? "";
  try {
    src = decodeURIComponent(src);
  } catch {
    return defaultImageRule(tokens, idx, options, env, self);
  }
  if (/^\/workspace\/[^?#]+$/.test(src) && !src.split("/").includes("..")) {
    token.attrSet("src", `${FILES_API}/download?path=${encodeURIComponent(src)}&inline=1`);
    token.attrSet("class", "opshelper-workspace-image");
    token.attrSet("loading", "lazy");
  }
  return defaultImageRule(tokens, idx, options, env, self);
};

export function renderAssistantMarkdown(value: string) {
  const env: { hasWorkspaceImage?: boolean } = {};
  const tokens = markdown.parse(value, env);
  env.hasWorkspaceImage = tokens.some((block) =>
    block.children?.some((child) => child.type === "image" && /^\/workspace\//.test(child.attrGet("src") ?? "")),
  );
  return markdown.renderer.render(tokens, markdown.options, env);
}

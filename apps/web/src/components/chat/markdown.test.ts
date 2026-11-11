import assert from "node:assert/strict";
import test from "node:test";

import { renderAssistantMarkdown } from "./markdown";

test("Markdown 表格中的 br 标签渲染为换行", () => {
  const rendered = renderAssistantMarkdown("| 项目 | 说明 |\n| --- | --- |\n| A | 第一行<br>第二行 |");

  assert.match(rendered, /第一行<br>第二行/);
  assert.doesNotMatch(rendered, /&lt;br&gt;/);
});

test("宽表格套一层可横向滚动的容器，闭合标签成对", () => {
  const rendered = renderAssistantMarkdown("| 项目 | 说明 |\n| --- | --- |\n| A | B |");

  assert.match(rendered, /<div class="opshelper-table-scroll"><table>/);
  assert.match(rendered, /<\/table>\s*<\/div>/);
});

test("除 br 外的模型 HTML 仍按文本转义", () => {
  const rendered = renderAssistantMarkdown("<img src=x onerror=alert(1)>");

  assert.match(rendered, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(rendered, /<img/);
});

test("代码块中的 br 保持代码文本", () => {
  const rendered = renderAssistantMarkdown("```html\n<br>\n```");

  assert.match(rendered, /&lt;/);
  assert.doesNotMatch(rendered, /<br>/);
});

test("代码块显示语言标签和可供复制的按钮", () => {
  const bash = renderAssistantMarkdown("```bash\nnpm install example\n```");
  assert.match(bash, /class="opshelper-code-block"/);
  assert.match(bash, /opshelper-code-language[\s\S]*<span>Bash<\/span>/);
  assert.match(bash, /data-code-copy aria-label="复制代码"/);
  assert.match(bash, /npm install example/);

  const cpp = renderAssistantMarkdown("```cpp\nstd::cout << \"hello\";\n```");
  assert.match(cpp, /<span>C\+\+<\/span>/);
});

test("未标注语言的代码块显示为纯文本", () => {
  const rendered = renderAssistantMarkdown("```\njust text\n```");

  assert.match(rendered, /<span>纯文本<\/span>/);
  assert.match(rendered, /just text/);
  assert.match(renderAssistantMarkdown("    indented code"), /<span>纯文本<\/span>/);
});

test("mermaid 代码块渲染为 SVG 图表", () => {
  const rendered = renderAssistantMarkdown("```mermaid\nflowchart LR\n  A[开始] --> B[结束]\n```");

  assert.match(rendered, /<div class="opshelper-diagram" role="button" tabindex="0" aria-label="查看图表"><svg/);
  assert.doesNotMatch(rendered, /<pre>/);
});

test("无法解析的 mermaid 代码块回退为普通代码块", () => {
  const rendered = renderAssistantMarkdown("```mermaid\nflowchart LR\n  A -->\n```");

  assert.match(rendered, /<pre>/);
  assert.doesNotMatch(rendered, /class="opshelper-diagram"/);
});

test("工作区图片改写为内联下载地址，且拒绝路径穿越", () => {
  const ok = renderAssistantMarkdown("![流程](/workspace/outputs/a.svg)");
  assert.match(ok, /src="\/v1\/users\/me\/files\/download\?path=%2Fworkspace%2Foutputs%2Fa\.svg&amp;inline=1"/);
  assert.match(ok, /class="opshelper-workspace-image"/);
  assert.match(ok, /tabindex="0" role="button" aria-label="查看图片"/);

  const bad = renderAssistantMarkdown("![x](/workspace/../etc/passwd)");
  assert.doesNotMatch(bad, /files\/download/);
});

test("工作区文件链接改写为下载地址，且拒绝路径穿越", () => {
  const ok = renderAssistantMarkdown("[下载报告](/workspace/outputs/report.docx)");
  assert.match(ok, /href="\/v1\/users\/me\/files\/download\?path=%2Fworkspace%2Foutputs%2Freport\.docx"/);

  const bad = renderAssistantMarkdown("[下载文件](/workspace/../etc/passwd)");
  assert.doesNotMatch(bad, /files\/download/);
});

test("外链图片也可通过键盘打开预览", () => {
  const rendered = renderAssistantMarkdown("![图](https://example.com/image.png)");
  assert.match(rendered, /src="https:\/\/example\.com\/image\.png"/);
  assert.match(rendered, /tabindex="0" role="button" aria-label="查看图片"/);
});

test("中文文件名的工作区图片只编码一次", () => {
  const rendered = renderAssistantMarkdown("![图](/workspace/outputs/市场调研流程图.svg)");
  const expected = encodeURIComponent("/workspace/outputs/市场调研流程图.svg");

  assert.ok(rendered.includes(`download?path=${expected}&amp;inline=1`));
  assert.doesNotMatch(rendered, /%25E5/);
});

test("中文文件名的工作区下载链接只编码一次", () => {
  const rendered = renderAssistantMarkdown("[下载模板](/workspace/outputs/自我介绍模板.docx)");
  const expected = encodeURIComponent("/workspace/outputs/自我介绍模板.docx");

  assert.ok(rendered.includes(`download?path=${expected}"`));
  assert.doesNotMatch(rendered, /%25E5/);
});

test("编码形式的路径穿越同样被拒绝", () => {
  assert.doesNotMatch(renderAssistantMarkdown("![x](/workspace/%2e%2e/etc/passwd)"), /files\/download/);
  assert.doesNotMatch(renderAssistantMarkdown("[x](/workspace/%2e%2e/etc/passwd)"), /files\/download/);
});

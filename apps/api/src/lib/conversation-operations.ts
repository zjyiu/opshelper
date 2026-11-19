export interface ConversationOperationEvent {
  id: string;
  label: string;
  target: string | null;
  status: "pending" | "running" | "completed" | "failed";
}

type Row = Record<string, unknown>;

function row(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}

function text(value: unknown, limit = 160): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return clipped(normalized, limit);
}

function clipped(value: string, limit: number) {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function firstText(source: unknown, keys: string[]) {
  const value = row(source);
  for (const key of keys) {
    const candidate = text(value[key]);
    if (candidate) return candidate;
  }
  return null;
}

function commandText(input: Row) {
  for (const key of ["command", "cmd"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return clipped(value.trim(), 160);
  }
  return firstText(input, ["description", "title"]);
}

function operationKind(name: string) {
  const normalized = name.trim().toLowerCase().replace(/[.-]/g, "_");
  if (/(^|_)(skill)(_|$)/.test(normalized)) return "skill";
  if (/(^|_)(task|delegate|subagent)(_|$)/.test(normalized)) return "delegate";
  if (/(^|_)(webfetch|websearch|web_search|http|fetch|browser|crawl|scrape)(_|$)/.test(normalized)) return "network";
  if (/^[a-z][a-z0-9]*-[a-z0-9-]+_[a-z0-9]/i.test(name.trim())) return "integration";
  if (/(^|_)(read|cat|open_file|list|ls)(_|$)/.test(normalized)) return "read";
  if (/(^|_)(glob|grep|search|find|ripgrep)(_|$)/.test(normalized)) return "search";
  if (/(^|_)(write|edit|patch|apply_patch|delete|remove|move|rename)(_|$)/.test(normalized)) return "change";
  if (/(^|_)(bash|shell|command|terminal|exec|execute)(_|$)/.test(normalized)) return "command";
  return "other";
}

function targetFor(kind: string, part: Row) {
  const state = row(part.state);
  const input = row(state.input);
  const display = row(row(state.metadata).display);
  if (kind === "read" || kind === "change") {
    const path = firstText(display, ["path"]) ?? firstText(input, ["filePath", "filepath", "path", "filename", "destination"]);
    return path?.replace(/^\/workspace\/outputs\/[^/]+(?:\/[^/]+)?/, "结果文件") ?? null;
  }
  if (kind === "search") {
    return firstText(input, ["pattern", "query", "search", "text"]);
  }
  if (kind === "skill") {
    return firstText(input, ["name", "skill", "skillName", "id"]);
  }
  if (kind === "delegate" || kind === "integration") {
    return firstText(input, ["description", "title", "query", "name"]);
  }
  if (kind === "network") {
    return firstText(input, ["description", "query", "title"]);
  }
  if (kind === "command") {
    return commandText(input);
  }
  return firstText(input, ["description", "title", "name"]);
}

function operationStatus(value: unknown): ConversationOperationEvent["status"] {
  const status = typeof value === "string" ? value.toLowerCase() : "";
  if (["error", "failed", "cancelled", "canceled", "denied", "rejected"].includes(status)) return "failed";
  if (["running", "in_progress", "in-progress"].includes(status)) return "running";
  if (["completed", "complete", "success", "succeeded", "done"].includes(status)) return "completed";
  return "pending";
}

export class ConversationOperationProjector {
  private ids = new Map<string, string>();
  private signatures = new Map<string, string>();

  update(messages: unknown[]): ConversationOperationEvent[] {
    const result: ConversationOperationEvent[] = [];
    for (const message of messages) {
      const info = row(row(message).info);
      if (info.role !== "assistant") continue;
      const messageId = typeof info.id === "string" ? info.id : "";
      for (const rawPart of Array.isArray(row(message).parts) ? row(message).parts as unknown[] : []) {
        const part = row(rawPart);
        if (part.type !== "tool") continue;
        const state = row(part.state);
        const name = typeof part.tool === "string" ? part.tool : "tool";
        const kind = operationKind(name);
        const key = `${messageId}:${String(part.id ?? "")}`;
        let id = this.ids.get(key);
        if (!id) {
          id = `operation-${this.ids.size + 1}`;
          this.ids.set(key, id);
        }
        const operation = {
          id,
          label: ({
            read: "查看文件",
            search: "搜索文件或内容",
            change: "修改文件",
            command: "执行命令",
            network: "联网操作",
            integration: "调用扩展工具",
            skill: "使用技能",
            delegate: "委派协作任务",
            other: "执行工具",
          } as const)[kind],
          target: targetFor(kind, part),
          status: operationStatus(state.status),
        };
        const signature = JSON.stringify(operation);
        if (this.signatures.get(id) === signature) continue;
        this.signatures.set(id, signature);
        result.push(operation);
      }
    }
    return result;
  }
}

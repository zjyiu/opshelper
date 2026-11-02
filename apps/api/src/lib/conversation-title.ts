import { getModelSettings } from "./admin-config-service";
import { prisma } from "./prisma";

export const TITLE_SUMMARY_THRESHOLD = 24;
const TITLE_MAX_LENGTH = 24;

export function fallbackConversationTitle(text: string) {
  return text.trim().replace(/\s+/g, " ").slice(0, 60);
}

export function needsTitleSummary(text: string) {
  return fallbackConversationTitle(text).length > TITLE_SUMMARY_THRESHOLD;
}

export function cleanSummaryTitle(raw: string) {
  const title = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean)
    ?.replace(/^(标题|对话标题)\s*[:：]\s*/, "")
    .replace(/^["'“”‘’「」『』《》\s]+|["'“”‘’「」『』《》。.\s]+$/g, "");
  return title ? title.slice(0, TITLE_MAX_LENGTH) : "";
}

async function summarizeTitle(text: string, model?: string | null) {
  const settings = await getModelSettings();
  const requested = model?.startsWith("custom/") ? model.slice("custom/".length) : "";
  const modelId = settings.models.some((entry) => entry.id === requested)
    ? requested
    : settings.defaultModel;
  if (!settings.baseURL || !modelId) return "";
  const response = await fetch(`${settings.baseURL.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(settings.apiKey ? { authorization: `Bearer ${settings.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: modelId,
      temperature: 0.2,
      max_tokens: 60,
      stream: false,
      messages: [
        {
          role: "system",
          content: `把用户的问题概括为不超过${TITLE_MAX_LENGTH}个字的对话标题。只输出标题本身，不要标点、引号或解释。`,
        },
        { role: "user", content: text.slice(0, 2000) },
      ],
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) return "";
  const body = await response.json() as { choices?: { message?: { content?: unknown } }[] };
  const content = body.choices?.[0]?.message?.content;
  return typeof content === "string" ? cleanSummaryTitle(content) : "";
}

/** Best effort: failures keep the truncated fallback title. */
export async function summarizeConversationTitle(input: {
  conversationId: string;
  text: string;
  model?: string | null;
}) {
  try {
    const fallback = fallbackConversationTitle(input.text);
    const title = await summarizeTitle(input.text, input.model);
    if (!title) return;
    await prisma.conversation.updateMany({
      where: { id: input.conversationId, title: fallback },
      data: { title },
    });
  } catch {
    // keep fallback title
  }
}

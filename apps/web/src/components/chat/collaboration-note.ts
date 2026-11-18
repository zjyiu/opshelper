import type { ConversationCollaboration } from "@opshelper/shared";

export type CollaborationTone = "running" | "waiting" | "failed" | "completed";

export interface CollaborationNote {
  tone: CollaborationTone;
  label: string;
}

export function nextCollaborationPanelOpen(
  previousActiveIds: string[] | null,
  activeIds: string[],
  currentlyOpen: boolean,
  reading = false,
): boolean {
  if (activeIds.length === 0) {
    return previousActiveIds?.length && !reading ? false : currentlyOpen;
  }
  if (previousActiveIds === null || activeIds.some((id) => !previousActiveIds.includes(id))) return true;
  return currentlyOpen;
}

/**
 * 失败和待处理的交互比执行中的任务更需要关注。
 */
export function collaborationNote(
  collaborations: Pick<ConversationCollaboration, "status">[],
): CollaborationNote | null {
  if (collaborations.length === 0) return null;
  const count = (status: ConversationCollaboration["status"]) =>
    collaborations.filter((item) => item.status === status).length;
  const failed = count("failed");
  if (failed > 0) return { tone: "failed", label: `${failed} 项失败` };
  const questions = count("waiting_input");
  const permissions = count("waiting_permission");
  if (questions || permissions) {
    return { tone: "waiting", label: [
      ...(questions ? [`${questions} 项等待回答`] : []),
      ...(permissions ? [`${permissions} 项等待授权`] : []),
    ].join("，") };
  }
  const running = count("running");
  if (running > 0) return { tone: "running", label: `${running} 项执行中` };
  return { tone: "completed", label: "全部已完成" };
}

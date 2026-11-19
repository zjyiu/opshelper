import { ArchivedConversations } from "@/components/chat/archived-conversations";
import { IconArchive } from "@/components/chat/icons";
import { WorkspaceMenuButton } from "@/components/workspace-shell";

export default function ArchivedConversationsPage() {
  return (
    <main className="opshelper-main opshelper-workspace-main">
      <header className="opshelper-topbar opshelper-page-topbar">
        <WorkspaceMenuButton />
        <span className="opshelper-page-icon" aria-hidden="true"><IconArchive /></span>
        <div className="opshelper-topbar-meta">
          <h1 className="opshelper-topbar-title">已归档的对话</h1>
          <div className="opshelper-topbar-sub">搜索、筛选、恢复或永久删除对话</div>
        </div>
      </header>
      <ArchivedConversations />
    </main>
  );
}

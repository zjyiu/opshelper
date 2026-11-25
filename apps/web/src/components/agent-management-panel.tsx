"use client";

import type {
  AdminUsersSnapshot,
  AgentDetail,
  AgentSummary,
  SkillRepositorySkillSummary,
  UserAgentAssignmentsSnapshot,
} from "@opshelper/shared";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";

import {
  checkAgent,
  createAgent,
  getAgentUserAssignments,
  getSkillRepositorySkill,
  deleteAgent,
  getAgent,
  getUserAgentAssignments,
  importAgentSkillPackage,
  listSkillRepository,
  listAgents,
  reconcileUserAgentAssignments,
  replaceAgentUserAssignments,
  replaceUserAgentAssignments,
  setAgentEnabled,
  updateAgent,
} from "@/lib/browser-api";
import { toast } from "@/lib/toast";
import {
  base64ByteLength,
  buildAgentFileTree,
  countLines,
  formatAgentFileSize,
  parseAgentReferences,
  removeAgentSkillReference,
  textByteLength,
  type AgentSkillGroup,
  type AgentTreeNode,
} from "@/lib/agent-directory";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { confirm as confirmDialog, prompt as promptDialog } from "@/components/ui/dialog-host";
import { ModelManager } from "@/components/model-manager";
import { GlobalInstructionsManager } from "@/components/global-instructions-manager";
import { AgentMark } from "@/components/chat/assistant";
import {
  agentAssignmentLabel,
  agentCatalogCount,
  agentCheckView,
  agentEnabledView,
  agentModeView,
} from "@/lib/agent-status";
import {
  IconChevronDown,
  IconChevronRight,
  IconFolder,
  IconTrash,
  getFileIcon,
} from "@/components/file-icons";
import { SkillDetailModal } from "@/components/skill-detail-modal";
import { IconAlert, IconCheck, IconClose, IconSearch, IconSkill } from "@/components/chat/icons";
import { usePageRefresh } from "@/components/navigation-refresh";
import { insertEditorIndent } from "@/components/agent-editor-keys";

type Tab = "catalog" | "assignments" | "models" | "instructions";
type EditorMode = "catalog" | "create" | "edit";
type UserItem = AdminUsersSnapshot["users"][number];

const NEW_AGENT_TEMPLATE = `---
name: 新智能体
description: 说明这个智能体负责的运维范围
mode: all
---

你是一名运维智能体。先核对事实和影响范围，再执行变更。
`;

const EMPTY_MCP_CONFIGURATION = `{
  "example": {
    "type": "remote",
    "url": "https://mcp.example.com/mcp",
    "enabled": false,
    "oauth": false,
    "headers": {}
  }
}
`;

function addSkillReference(document: string, skillName: string) {
  const closing = document.indexOf("\n---", 4);
  if (closing < 0) return document;
  const frontmatter = document.slice(0, closing);
  if (new RegExp(`^\\s*-\\s+${skillName}\\s*$`, "m").test(frontmatter)) return document;
  const inline = /^(skills:\s*)(\[[^\n]*\])\s*$/m.exec(frontmatter);
  if (inline) {
    try {
      const values = JSON.parse(inline[2]) as unknown;
      if (Array.isArray(values) && values.every((value) => typeof value === "string")) {
        const next = JSON.stringify([...values, skillName]);
        return document.replace(inline[0], `${inline[1]}${next}`);
      }
    } catch {
      return document;
    }
  }
  if (/^skills:\s*$/m.test(frontmatter)) {
    return document.replace(/^skills:\s*$/m, `skills:\n  - ${skillName}`);
  }
  return `${document.slice(0, closing)}\nskills:\n  - ${skillName}${document.slice(closing)}`;
}

const statusLabels = {
  draining: "等待当前任务",
  revoking: "正在撤销",
  applying: "正在装配",
  ready: "已就绪",
  frozen: "已冻结",
} as const;

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

// 左侧目录树的一行文件：图标 + 文件名 + 二进制标记，缩进由深度决定。
function AgentTreeFile({
  path,
  label,
  depth,
  selected,
  binary,
  onSelect,
}: {
  path: string;
  label: string;
  depth: number;
  selected: boolean;
  binary: boolean;
  onSelect: (path: string) => void;
}) {
  return (
    <button
      className={`agent-tree-file${selected ? " selected" : ""}`}
      style={{ "--agent-tree-depth": depth } as CSSProperties}
      type="button"
      aria-current={selected ? "true" : undefined}
      onClick={() => onSelect(path)}
    >
      <span className="agent-tree-icon">{getFileIcon(path)}</span>
      <span className="agent-tree-label" title={path}>{label}</span>
      {binary ? <span className="agent-tree-badge">二进制</span> : null}
    </button>
  );
}

/** 目录行徽标用的文件数：递归统计，不把子目录算成文件。 */
function countTreeFiles(nodes: AgentTreeNode[]): number {
  return nodes.reduce(
    (total, node) => total + (node.children.length ? countTreeFiles(node.children) : 1),
    0,
  );
}

// 目录树递归渲染：目录行可折叠，文件行交给右侧编辑器。
// 技能包里的 scripts/、assets/ 等子目录都走这里，不再拍平到一层。
function AgentTreeNodes({
  nodes,
  depth,
  selectedFile,
  binaryFiles,
  isOpen,
  onToggle,
  onSelect,
}: {
  nodes: AgentTreeNode[];
  depth: number;
  selectedFile: string;
  binaryFiles: Record<string, string>;
  isOpen: (key: string) => boolean;
  onToggle: (key: string) => void;
  onSelect: (path: string) => void;
}) {
  return (
    <>
      {nodes.map((node) => {
        const path = node.file ?? node.path;
        if (!node.children.length) {
          return (
            <AgentTreeFile
              key={path}
              path={path}
              label={node.name}
              depth={depth}
              selected={selectedFile === path}
              binary={Object.hasOwn(binaryFiles, path)}
              onSelect={onSelect}
            />
          );
        }
        return (
          <div className="agent-tree-branch" key={path}>
            <button
              className="agent-tree-folder"
              type="button"
              aria-expanded={isOpen(path)}
              style={{ "--agent-tree-depth": depth } as CSSProperties}
              onClick={() => onToggle(path)}
            >
              <span className="agent-tree-chevron">{isOpen(path) ? <IconChevronDown /> : <IconChevronRight />}</span>
              <span className="agent-tree-icon"><IconFolder /></span>
              <span className="agent-tree-label" title={path}>{node.name}</span>
              <span className="agent-tree-group-count">{countTreeFiles(node.children)}</span>
            </button>
            {isOpen(path) ? (
              <AgentTreeNodes
                nodes={node.children}
                depth={depth + 1}
                selectedFile={selectedFile}
                binaryFiles={binaryFiles}
                isOpen={isOpen}
                onToggle={onToggle}
                onSelect={onSelect}
              />
            ) : null}
          </div>
        );
      })}
    </>
  );
}

export function AgentManagementPanel({
  initialAgents,
  users,
  scope = "admin",
  initialCreate = false,
  onPersonalAgentsChanged,
}: {
  initialAgents: AgentSummary[];
  users: UserItem[];
  scope?: "admin" | "user";
  initialCreate?: boolean;
  onPersonalAgentsChanged?: () => Promise<void>;
}) {
  const adminScope = scope === "admin";
  const [tab, setTab] = useState<Tab>("catalog");
  const [agents, setAgents] = useState(initialAgents);
  const catalogRefreshRef = useRef(0);
  const [query, setQuery] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const [deleteHintDismissed, setDeleteHintDismissed] = useState(false);
  const [editorMode, setEditorMode] = useState<EditorMode>(
    initialCreate || !initialAgents.length ? "create" : "catalog",
  );
  const [agentKey, setAgentKey] = useState("");
  const [files, setFiles] = useState<Record<string, string>>({ "agent.md": NEW_AGENT_TEMPLATE });
  const [binaryFiles, setBinaryFiles] = useState<Record<string, string>>({});
  const [selectedFile, setSelectedFile] = useState("agent.md");
  // 只记录“已展开”的目录：默认全部折叠，文件多时列表更清爽。
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const skillUploadRef = useRef<HTMLInputElement>(null);
  const [newFilePath, setNewFilePath] = useState("");
  const automaticCreateRef = useRef(!initialCreate && initialAgents.length === 0);
  const pristineCreateRef = useRef(true);
  pristineCreateRef.current = editorMode === "create" && !agentKey && !newFilePath &&
    Object.keys(files).length === 1 && files["agent.md"] === NEW_AGENT_TEMPLATE &&
    Object.keys(binaryFiles).length === 0;
  const [busy, setBusy] = useState(false);
  const [skillRepositoryOpen, setSkillRepositoryOpen] = useState(false);
  const [repositoryBusy, setRepositoryBusy] = useState(false);
  const [repositorySkills, setRepositorySkills] = useState<SkillRepositorySkillSummary[]>([]);
  const [repositoryQuery, setRepositoryQuery] = useState("");
  const [selectedRepositorySkills, setSelectedRepositorySkills] = useState<string[]>([]);
  const [activeRepositorySkill, setActiveRepositorySkill] = useState<SkillRepositorySkillSummary | null>(null);
  const [disableTarget, setDisableTarget] = useState<AgentDetail | null>(null);
  const [skillDeleteTarget, setSkillDeleteTarget] = useState<AgentSkillGroup | null>(null);

  const activeUsers = useMemo(
    () => users
      .filter((user) => user.isActive)
      .sort((a, b) => a.username.localeCompare(b.username, undefined, { sensitivity: "base" })),
    [users],
  );
  const [userQuery, setUserQuery] = useState("");
  const filteredActiveUsers = useMemo(() => {
    const keyword = userQuery.trim().toLowerCase();
    if (!keyword) return activeUsers;
    return activeUsers.filter((user) =>
      user.name.toLowerCase().includes(keyword) || user.username.toLowerCase().includes(keyword),
    );
  }, [activeUsers, userQuery]);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(activeUsers[0]?.id ?? null);
  const [assignment, setAssignment] = useState<UserAgentAssignmentsSnapshot | null>(null);
  const [draftAgentIds, setDraftAgentIds] = useState<string[]>([]);
  const [assignmentBusy, setAssignmentBusy] = useState(false);

  const [assignAgentTarget, setAssignAgentTarget] = useState<AgentSummary | null>(null);
  const [assignInitialUserIds, setAssignInitialUserIds] = useState<string[]>([]);
  const [assignDraftUserIds, setAssignDraftUserIds] = useState<string[]>([]);
  const [assignUserQuery, setAssignUserQuery] = useState("");
  const [assignLoading, setAssignLoading] = useState(false);
  const [assignSaving, setAssignSaving] = useState(false);
  const assignRequestRef = useRef(0);
  const filteredAssignUsers = useMemo(() => {
    const keyword = assignUserQuery.trim().toLowerCase();
    if (!keyword) return activeUsers;
    return activeUsers.filter((user) =>
      user.name.toLowerCase().includes(keyword) || user.username.toLowerCase().includes(keyword),
    );
  }, [activeUsers, assignUserQuery]);
  const assignDirty = useMemo(() => {
    const a = [...assignDraftUserIds].sort().join("|");
    const b = [...assignInitialUserIds].sort().join("|");
    return a !== b;
  }, [assignDraftUserIds, assignInitialUserIds]);
  const assignCanAdd = Boolean(
    assignAgentTarget && assignAgentTarget.isEnabled && assignAgentTarget.checkStatus === "ready",
  );

  const editorDirty = useMemo(() => {
    if (editorMode === "create") {
      return Boolean(agentKey.trim()) ||
        Object.keys(files).length !== 1 ||
        files["agent.md"] !== NEW_AGENT_TEMPLATE ||
        Object.keys(binaryFiles).length > 0;
    }
    if (editorMode === "edit" && detail) {
      const baseFiles = detail.files;
      const baseBin = detail.binaryFiles ?? {};
      const fileKeys = Object.keys(files);
      const baseKeys = Object.keys(baseFiles);
      if (fileKeys.length !== baseKeys.length) return true;
      for (const key of fileKeys) {
        if (files[key] !== baseFiles[key]) return true;
      }
      const binKeys = Object.keys(binaryFiles);
      const baseBinKeys = Object.keys(baseBin);
      if (binKeys.length !== baseBinKeys.length) return true;
      for (const key of binKeys) {
        if (binaryFiles[key] !== baseBin[key]) return true;
      }
    }
    return false;
  }, [agentKey, binaryFiles, detail, editorMode, files]);

  const editorFileNames = useMemo(
    () => [...new Set([...Object.keys(files), ...Object.keys(binaryFiles)])].sort(),
    [binaryFiles, files],
  );

  const references = useMemo(
    () => parseAgentReferences(files["agent.md"] ?? ""),
    [files],
  );
  const fileTree = useMemo(
    () => buildAgentFileTree(editorFileNames, references.skills),
    [editorFileNames, references.skills],
  );
  const selectedIsBinary = Object.hasOwn(binaryFiles, selectedFile);
  const selectedSize = selectedIsBinary
    ? formatAgentFileSize(base64ByteLength(binaryFiles[selectedFile] ?? ""))
    : formatAgentFileSize(textByteLength(files[selectedFile] ?? ""));
  const selectedLines = selectedIsBinary ? null : countLines(files[selectedFile] ?? "");
  const agentDirectory = detail?.key ?? (agentKey.trim() || "新智能体");

  function groupOpen(key: string) {
    return Boolean(openGroups[key]);
  }

  function toggleGroup(key: string) {
    setOpenGroups((current) => ({ ...current, [key]: !current[key] }));
  }

  // 目录默认折叠，选中文件时才展开它所在的各级目录，避免树收起后“打开但看不见”。
  function selectFile(path: string) {
    setSelectedFile(path);
    const parts = path.split("/");
    const opened: string[] = [];
    if (parts.length === 1) {
      opened.push("root");
    } else if (parts[0] === "skills") {
      opened.push("skills");
    } else if (parts[0] === "scripts") {
      opened.push("scripts");
    }
    // 技能包和脚本目录还能再嵌套，逐级补上中间目录。
    for (let index = 2; index < parts.length; index += 1) {
      opened.push(parts.slice(0, index).join("/"));
    }
    if (!opened.length) return;
    setOpenGroups((current) => {
      const next = { ...current };
      for (const key of opened) next[key] = true;
      return next;
    });
  }

  const filteredAgents = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return agents;
    return agents.filter((agent) =>
      [agent.key, agent.displayName, agent.description].some((value) => value.toLowerCase().includes(needle)),
    );
  }, [agents, query]);
  const privateAgents = useMemo(
    () => filteredAgents.filter((agent) => agent.canManage),
    [filteredAgents],
  );
  const assignedAgents = useMemo(
    () => filteredAgents.filter((agent) => !agent.canManage),
    [filteredAgents],
  );
  const filteredRepositorySkills = useMemo(() => {
    const needle = repositoryQuery.trim().toLowerCase();
    if (!needle) return repositorySkills;
    return repositorySkills.filter((skill) => skill.name.toLowerCase().includes(needle));
  }, [repositoryQuery, repositorySkills]);
  const visibleRepositorySkillNames = filteredRepositorySkills.map((skill) => skill.name);
  const allVisibleRepositorySkillsSelected = visibleRepositorySkillNames.length > 0 &&
    visibleRepositorySkillNames.every((name) => selectedRepositorySkills.includes(name));
  const searching = query.trim().length > 0;

  // 目录与详情在同一个画布里切换：进详情后列表不再占位，画布滚动高度骤降。
  // 记住离开列表时的位置，返回时按原位恢复，连续处理多个智能体不用重新找。
  const catalogScrollRef = useRef(0);

  function rememberCatalogScroll() {
    catalogScrollRef.current =
      document.querySelector<HTMLElement>(".opshelper-page-body")?.scrollTop ?? 0;
  }

  function restoreCatalogScroll() {
    const container = document.querySelector<HTMLElement>(".opshelper-page-body");
    if (!container) return;
    const top = catalogScrollRef.current;
    // 等列表重新回到布局里再设位置，否则会被夹回 0。
    requestAnimationFrame(() => { container.scrollTop = top; });
  }

  async function refreshAgents(preferredKey?: string | null) {
    const sequence = ++catalogRefreshRef.current;
    const snapshot = await listAgents(scope);
    if (sequence !== catalogRefreshRef.current) return;
    setAgents(snapshot.agents);
    if (preferredKey === null) {
      setSelectedKey(null);
      return;
    }
    const nextKey = preferredKey ?? selectedKey;
    if (nextKey && snapshot.agents.some((agent) => agent.key === nextKey)) {
      setSelectedKey(nextKey);
    } else {
      setSelectedKey(null);
    }
  }

  async function refreshCatalog() {
    const sequence = ++catalogRefreshRef.current;
    const snapshot = await listAgents(scope);
    if (sequence !== catalogRefreshRef.current) return;
    setAgents(snapshot.agents);
    if (automaticCreateRef.current && pristineCreateRef.current && snapshot.agents.length > 0) {
      automaticCreateRef.current = false;
      setEditorMode("catalog");
    }
  }

  useEffect(() => {
    void refreshCatalog().catch((error) => toast.error(errorMessage(error, "刷新智能体目录失败")));
    return () => { catalogRefreshRef.current += 1; };
  }, [scope]); // eslint-disable-line react-hooks/exhaustive-deps

  usePageRefresh(() => {
    void refreshCatalog().catch((error) => toast.error(errorMessage(error, "刷新智能体目录失败")));
  });

  useEffect(() => {
    if (!selectedKey || editorMode === "create") {
      setDetail(null);
      return;
    }
    let active = true;
    getAgent(selectedKey, scope)
      .then(({ agent }) => {
        if (!active) return;
        setDetail(agent);
        setFiles(agent.files);
        setBinaryFiles(agent.binaryFiles ?? {});
        setOpenGroups({});
        setSelectedFile("agent.md");
      })
      .catch((error) => toast.error(errorMessage(error, "读取智能体失败")));
    return () => { active = false; };
  }, [editorMode, scope, selectedKey]);

  useEffect(() => {
    if (!adminScope || tab !== "assignments" || !selectedUserId) return;
    let active = true;
    setAssignmentBusy(true);
    getUserAgentAssignments(selectedUserId)
      .then((snapshot) => {
        if (!active) return;
        setAssignment(snapshot);
        setDraftAgentIds(snapshot.assignedAgentIds);
      })
      .catch((error) => toast.error(errorMessage(error, "读取分配状态失败")))
      .finally(() => { if (active) setAssignmentBusy(false); });
    return () => { active = false; };
  }, [adminScope, selectedUserId, tab]);

  const assignmentStatus = assignment?.configuration.status;
  useEffect(() => {
    if (!adminScope || tab !== "assignments" || !selectedUserId) return;
    if (assignmentStatus !== "draining" && assignmentStatus !== "revoking" && assignmentStatus !== "applying") {
      return;
    }
    let active = true;
    const timer = window.setInterval(() => {
      void getUserAgentAssignments(selectedUserId)
        .then((snapshot) => {
          if (!active) return;
          setAssignment(snapshot);
        })
        .catch(() => undefined);
    }, 2000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [adminScope, assignmentStatus, selectedUserId, tab]);

  function beginCreate() {
    automaticCreateRef.current = false;
    setEditorMode("create");
    setSkillRepositoryOpen(false);
    setSelectedKey(null);
    setDetail(null);
    setAgentKey("");
    setFiles({ "agent.md": NEW_AGENT_TEMPLATE });
    setBinaryFiles({});
    setOpenGroups({});
    setSelectedFile("agent.md");
  }

  function selectAgent(key: string) {
    const agent = agents.find((item) => item.key === key);
    if (!adminScope && !agent?.canManage) return;
    rememberCatalogScroll();
    setSkillRepositoryOpen(false);
    setDetail(null);
    setSelectedKey(key);
    setEditorMode("edit");
  }

  function closeAgentDetail() {
    setSkillRepositoryOpen(false);
    setSelectedKey(null);
    setDetail(null);
    setEditorMode("catalog");
    restoreCatalogScroll();
    void refreshCatalog().catch((error) => toast.error(errorMessage(error, "刷新智能体目录失败")));
  }

  async function requestCloseAgentDetail() {
    if (editorDirty) {
      const ok = await confirmDialog({
        title: "放弃未保存的修改？",
        description: "当前智能体配置有未保存的改动，离开后将丢失这些修改。",
        confirmLabel: "放弃修改",
        variant: "danger",
      });
      if (!ok) return;
    }
    closeAgentDetail();
  }

  function addSupportingFile() {
    const path = newFilePath.trim();
    if (!/^scripts\/[A-Za-z0-9._-]+$/.test(path)) {
      toast.error("文件需为 scripts/<文件名>");
      return;
    }
    if (Object.hasOwn(files, path) || Object.hasOwn(binaryFiles, path)) {
      toast.error("该文件已存在");
      return;
    }
    setFiles((current) => ({ ...current, [path]: "" }));
    selectFile(path);
    setNewFilePath("");
  }

  function configureMcp() {
    setFiles((current) => Object.hasOwn(current, "mcp.json")
      ? current
      : { ...current, "mcp.json": EMPTY_MCP_CONFIGURATION });
    selectFile("mcp.json");
  }

  function mergeImportedSkills(importedSkills: Array<{ skillName: string; files: Record<string, string>; binaryFiles: Record<string, string> }>) {
    const nextFiles: Record<string, string> = { ...files };
    const nextBinaryFiles: Record<string, string> = { ...binaryFiles };
    let nextAgentDocument = nextFiles["agent.md"] ?? NEW_AGENT_TEMPLATE;

    for (const imported of importedSkills) {
      for (const [name, content] of Object.entries(imported.files)) {
        if (Object.hasOwn(nextFiles, name) || Object.hasOwn(nextBinaryFiles, name)) {
          throw new Error(`技能文件已存在：${name}`);
        }
        nextFiles[name] = content;
      }
      for (const [name, content] of Object.entries(imported.binaryFiles)) {
        if (Object.hasOwn(nextFiles, name) || Object.hasOwn(nextBinaryFiles, name)) {
          throw new Error(`技能文件已存在：${name}`);
        }
        nextBinaryFiles[name] = content;
      }
      nextAgentDocument = addSkillReference(nextAgentDocument, imported.skillName);
    }

    nextFiles["agent.md"] = nextAgentDocument;
    setFiles(nextFiles);
    setBinaryFiles(nextBinaryFiles);
  }

  async function uploadSkillPackage(file: File) {
    setBusy(true);
    try {
      const imported = await importAgentSkillPackage(file, scope);
      mergeImportedSkills([imported]);
      selectFile(`skills/${imported.skillName}/SKILL.md`);
      toast.success(`已导入 Skill「${imported.skillName}」，仅保存到当前智能体，不进入仓库`);
    } catch (error) {
      toast.error(errorMessage(error, "上传 Skill 包失败"));
    } finally {
      setBusy(false);
    }
  }

  async function loadSkillRepository() {
    setRepositoryBusy(true);
    try {
      const snapshot = await listSkillRepository();
      setRepositorySkills(snapshot.skills);
      setSelectedRepositorySkills((current) =>
        current.filter((name) => snapshot.skills.some((skill) => skill.name === name)),
      );
    } finally {
      setRepositoryBusy(false);
    }
  }

  async function openSkillRepository() {
    setSkillRepositoryOpen(true);
    setRepositoryQuery("");
    setActiveRepositorySkill(null);
    try {
      await loadSkillRepository();
    } catch (error) {
      toast.error(errorMessage(error, "读取 Skill 仓库失败"));
    }
  }

  function closeSkillRepository() {
    setSkillRepositoryOpen(false);
    setActiveRepositorySkill(null);
    setSelectedRepositorySkills([]);
    setRepositoryQuery("");
  }

  function toggleRepositorySkill(name: string) {
    setSelectedRepositorySkills((current) =>
      current.includes(name) ? current.filter((item) => item !== name) : [...current, name],
    );
  }

  function toggleAllVisibleRepositorySkills() {
    setSelectedRepositorySkills((current) => {
      if (allVisibleRepositorySkillsSelected) {
        const visible = new Set(visibleRepositorySkillNames);
        return current.filter((name) => !visible.has(name));
      }
      return [...new Set([...current, ...visibleRepositorySkillNames])];
    });
  }

  async function importSkillsFromRepository(names: string[]) {
    if (!names.length) return;
    setActiveRepositorySkill(null);
    setBusy(true);
    setRepositoryBusy(true);
    try {
      const importedSkills: Array<{ skillName: string; files: Record<string, string>; binaryFiles: Record<string, string> }> = [];
      for (const name of names) {
        importedSkills.push(await getSkillRepositorySkill(name));
      }
      mergeImportedSkills(importedSkills);
      selectFile(`skills/${importedSkills[0].skillName}/SKILL.md`);
      closeSkillRepository();
      toast.success(`已导入 ${importedSkills.length} 个 Skill，保存后生效`);
    } catch (error) {
      toast.error(errorMessage(error, "从 Skill 仓库导入失败"));
    } finally {
      setBusy(false);
      setRepositoryBusy(false);
    }
  }

  function removeSupportingFile(name: string) {
    setFiles((current) => {
      const next = { ...current };
      delete next[name];
      return next;
    });
    setBinaryFiles((current) => {
      const next = { ...current };
      delete next[name];
      return next;
    });
    selectFile("agent.md");
  }

  function removeSkillDirectory(skill: AgentSkillGroup) {
    const prefix = `skills/${skill.name}/`;
    setFiles((current) => {
      const next = Object.fromEntries(
        Object.entries(current).filter(([name]) => !name.startsWith(prefix)),
      );
      next["agent.md"] = removeAgentSkillReference(next["agent.md"] ?? "", skill.name);
      return next;
    });
    setBinaryFiles((current) => Object.fromEntries(
      Object.entries(current).filter(([name]) => !name.startsWith(prefix)),
    ));
    if (selectedFile.startsWith(prefix)) selectFile("agent.md");
    setOpenGroups((current) => Object.fromEntries(
      Object.entries(current).filter(([key]) => key !== prefix.slice(0, -1) && !key.startsWith(prefix)),
    ));
    setSkillDeleteTarget(null);
    toast.success(`已移除 Skill「${skill.name}」，保存后生效`);
  }

  async function saveAgent() {
    setBusy(true);
    try {
      if (editorMode === "create") {
        const response = await createAgent({ key: agentKey.trim(), files, binaryFiles }, scope);
        toast.success(adminScope ? "智能体已创建并通过检查" : "智能体已创建，正在装配到你的运行环境");
        setEditorMode("edit");
        await refreshAgents(response.agent.key);
        if (!adminScope) await onPersonalAgentsChanged?.();
      } else if (detail) {
        await updateAgent(detail.key, { files, binaryFiles }, scope);
        toast.success(adminScope ? "目录已保存，受影响用户正在应用新配置" : "智能体已保存，正在更新你的运行环境");
        const { agent } = await getAgent(detail.key, scope);
        setDetail(agent);
        setFiles(agent.files);
        setBinaryFiles(agent.binaryFiles ?? {});
        setEditorMode("edit");
        await refreshAgents(detail.key);
        if (!adminScope) await onPersonalAgentsChanged?.();
      }
    } catch (error) {
      toast.error(errorMessage(error, "保存智能体失败"));
    } finally {
      setBusy(false);
    }
  }

  async function runCheck() {
    if (!detail) return;
    setBusy(true);
    try {
      await checkAgent(detail.key, scope);
      await refreshAgents(detail.key);
      const response = await getAgent(detail.key, scope);
      setDetail(response.agent);
      toast.success("模型、工具、技能和脚本检查通过");
    } catch (error) {
      toast.error(errorMessage(error, "依赖检查失败"));
      await refreshAgents(detail.key).catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  async function changeEnabled(agent: AgentDetail, enabled: boolean) {
    setBusy(true);
    try {
      await setAgentEnabled(agent.key, enabled, scope);
      await refreshAgents(agent.key);
      const response = await getAgent(agent.key, scope);
      setDetail(response.agent);
      toast.success(enabled ? "智能体已启用" : "智能体已停用，相关用户环境正在重新装配");
      if (!adminScope) await onPersonalAgentsChanged?.();
    } catch (error) {
      toast.error(errorMessage(error, enabled ? "启用失败" : "停用失败"));
    } finally {
      setBusy(false);
      setDisableTarget(null);
    }
  }

  async function deleteSelectedAgent(agent: AgentDetail) {
    const blockedByAssignments = adminScope
      ? agent.assignmentCount > 0
      : agent.assignmentCount > 1;
    if (blockedByAssignments) {
      toast.error(adminScope
        ? `该智能体仍分配给 ${agent.assignmentCount} 位用户，请先撤销分配`
        : "该智能体仍分配给其他用户，请先在用户分配中撤销");
      return;
    }
    const typed = await promptDialog({
      title: `删除智能体 ${agent.displayName}`,
      description: (
        <>
          该操作会永久删除目录 <span className="mono">data/agents/{agent.key}</span> 和智能体记录；历史会话与个人文件会保留。请输入 <strong>{agent.key}</strong> 确认。
        </>
      ),
      placeholder: agent.key,
      confirmLabel: "删除智能体",
      autoSelect: "none",
      validate: (value) => value === agent.key ? null : "智能体 key 不一致",
    });
    if (typed === null) return;

    setBusy(true);
    try {
      await deleteAgent(agent.key, scope);
      setAgents((current) => current.filter((item) => item.key !== agent.key));
      setSelectedKey(null);
      setDetail(null);
      setEditorMode("catalog");
      toast.success(`已删除智能体 ${agent.displayName}`);
      await refreshAgents(null).catch(() => {
        toast.error("智能体已删除，但目录刷新失败，请重新载入页面");
      });
      if (!adminScope) await onPersonalAgentsChanged?.();
    } catch (error) {
      toast.error(errorMessage(error, "删除智能体失败"));
    } finally {
      setBusy(false);
    }
  }

  async function saveAssignments() {
    if (!assignment || !selectedUserId) return;
    setAssignmentBusy(true);
    try {
      const snapshot = await replaceUserAgentAssignments(
        selectedUserId,
        draftAgentIds,
        assignment.configuration.desiredGeneration,
      );
      setAssignment(snapshot);
      setDraftAgentIds(snapshot.assignedAgentIds);
      await refreshCatalog();
      toast.success(snapshot.configuration.status === "ready" ? "分配已生效" : "分配已保存，运行环境正在处理");
    } catch (error) {
      toast.error(errorMessage(error, "保存分配失败"));
      const latest = await getUserAgentAssignments(selectedUserId).catch(() => null);
      if (latest) {
        setAssignment(latest);
        setDraftAgentIds(latest.assignedAgentIds);
      }
    } finally {
      setAssignmentBusy(false);
    }
  }

  useEffect(() => {
    if (!assignAgentTarget) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !assignSaving) {
        event.preventDefault();
        setAssignAgentTarget(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [assignAgentTarget, assignSaving]);

  async function openAgentAssignDialog(agent: AgentSummary) {
    const requestId = ++assignRequestRef.current;
    setAssignAgentTarget(agent);
    setAssignUserQuery("");
    setAssignInitialUserIds([]);
    setAssignDraftUserIds([]);
    setAssignLoading(true);
    try {
      const snapshot = await getAgentUserAssignments(agent.key);
      if (requestId !== assignRequestRef.current) return;
      setAssignAgentTarget(snapshot.agent);
      setAssignInitialUserIds(snapshot.assignedUserIds);
      setAssignDraftUserIds(snapshot.assignedUserIds);
    } catch (error) {
      if (requestId !== assignRequestRef.current) return;
      toast.error(errorMessage(error, "读取智能体分配用户失败"));
      setAssignAgentTarget(null);
    } finally {
      if (requestId === assignRequestRef.current) setAssignLoading(false);
    }
  }

  function closeAgentAssignDialog() {
    if (assignSaving) return;
    assignRequestRef.current += 1;
    setAssignAgentTarget(null);
    setAssignLoading(false);
  }

  function toggleAssignUser(userId: string) {
    setAssignDraftUserIds((current) =>
      current.includes(userId) ? current.filter((id) => id !== userId) : [...current, userId],
    );
  }

  async function saveAgentUserAssignments() {
    if (!assignAgentTarget || assignSaving || assignLoading) return;
    setAssignSaving(true);
    try {
      const snapshot = await replaceAgentUserAssignments(assignAgentTarget.key, assignDraftUserIds);
      setAgents((current) =>
        current.map((item) => (item.id === snapshot.agent.id ? snapshot.agent : item)),
      );
      setAssignInitialUserIds(snapshot.assignedUserIds);
      setAssignDraftUserIds(snapshot.assignedUserIds);
      setAssignAgentTarget(null);
      toast.success(`已更新「${snapshot.agent.displayName}」的用户分配（当前 ${snapshot.agent.assignmentCount} 人获配）`);
      void refreshCatalog().catch(() => undefined);
    } catch (error) {
      toast.error(errorMessage(error, "保存用户分配失败"));
    } finally {
      setAssignSaving(false);
    }
  }

  async function retryConfiguration() {
    if (!selectedUserId) return;
    setAssignmentBusy(true);
    try {
      const snapshot = await reconcileUserAgentAssignments(selectedUserId);
      setAssignment(snapshot);
      setDraftAgentIds(snapshot.assignedAgentIds);
      toast.success(snapshot.configuration.status === "ready" ? "运行环境已恢复" : "已开始重新处理");
    } catch (error) {
      toast.error(errorMessage(error, "重新处理失败"));
    } finally {
      setAssignmentBusy(false);
    }
  }

  const assignmentDirty = assignment
    ? [...draftAgentIds].sort().join("|") !== [...assignment.assignedAgentIds].sort().join("|")
    : false;
  const assignmentHasLead = assignment
    ? draftAgentIds.length === 0 || assignment.agents.some((agent) =>
      draftAgentIds.includes(agent.id) && agent.mode !== "subagent")
    : false;
  const agentActions = detail && editorMode === "edit" && (adminScope || detail.canManage) ? (
    <div className="agent-editor-management-actions">
      <button className="button-secondary" type="button" disabled={busy} onClick={runCheck}>重新检查</button>
      {detail.isEnabled ? (
        <button className="button-warning" type="button" disabled={busy} onClick={() => setDisableTarget(detail)}>停用</button>
      ) : (
        <button className="button" type="button" disabled={busy || detail.checkStatus !== "ready"} onClick={() => changeEnabled(detail, true)}>启用</button>
      )}
      <span
        className="agent-delete-trigger"
        tabIndex={(adminScope ? detail.assignmentCount > 0 : detail.assignmentCount > 1) ? 0 : undefined}
        role={(adminScope ? detail.assignmentCount > 0 : detail.assignmentCount > 1) ? "group" : undefined}
        aria-label={(adminScope ? detail.assignmentCount > 0 : detail.assignmentCount > 1) ? "删除不可用" : undefined}
        aria-describedby={(adminScope ? detail.assignmentCount > 0 : detail.assignmentCount > 1) ? "agent-delete-hint" : undefined}
        data-hint-dismissed={deleteHintDismissed}
        onMouseEnter={() => setDeleteHintDismissed(false)}
        onFocus={() => setDeleteHintDismissed(false)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setDeleteHintDismissed(true);
        }}
      >
        <button
          className="button-danger"
          type="button"
          disabled={busy || (adminScope ? detail.assignmentCount > 0 : detail.assignmentCount > 1)}
          onClick={() => { void deleteSelectedAgent(detail); }}
        >
          {busy ? "处理中…" : "删除"}
        </button>
        {(adminScope ? detail.assignmentCount > 0 : detail.assignmentCount > 1) ? (
          <span className="agent-delete-hint" id="agent-delete-hint" role="tooltip">
            {adminScope
              ? `仍分配给 ${detail.assignmentCount} 位用户，请先在“用户分配”中撤销。`
              : "该智能体仍分配给其他用户，请先在“用户分配”中撤销。"}
          </span>
        ) : null}
      </span>
    </div>
  ) : null;

  return (
    <div className="agent-admin">
      {adminScope ? (
        <div className="agent-admin-tabs" role="tablist" aria-label="智能体管理">
          <button
            role="tab"
            aria-selected={tab === "catalog"}
            className={tab === "catalog" ? "active" : ""}
            type="button"
            onClick={() => {
              if (tab === "catalog") {
                if (selectedKey !== null || editorMode !== "catalog") {
                  void requestCloseAgentDetail();
                  return;
                }
              } else {
                setTab("catalog");
                if (!editorDirty && (selectedKey !== null || editorMode !== "catalog")) {
                  closeAgentDetail();
                  return;
                }
              }
              void refreshCatalog().catch((error) => toast.error(errorMessage(error, "刷新智能体目录失败")));
            }}
          >
            智能体目录
          </button>
          <button
            role="tab"
            aria-selected={tab === "assignments"}
            className={tab === "assignments" ? "active" : ""}
            type="button"
            onClick={() => setTab("assignments")}
          >
            用户分配
          </button>
          <button
            role="tab"
            aria-selected={tab === "models"}
            className={tab === "models" ? "active" : ""}
            type="button"
            onClick={() => setTab("models")}
          >
            模型连接
          </button>
          <button
            role="tab"
            aria-selected={tab === "instructions"}
            className={tab === "instructions" ? "active" : ""}
            type="button"
            onClick={() => setTab("instructions")}
          >
            全局规则
          </button>
        </div>
      ) : null}

      {tab === "catalog" ? (
        <div className={`agent-admin-layout ${editorMode === "create" || selectedKey ? "agent-admin-detail-mode" : "agent-admin-list-mode"}`}>
          <section className="agent-catalog" aria-label="智能体目录">
            <div className="agent-catalog-heading">
              <div>
                <h2>智能体目录</h2>
                <p>{adminScope ? "管理团队共用的智能体" : "创建并查看智能体目录"}</p>
              </div>
              <span>{agentCatalogCount(agents.length, filteredAgents.length, searching)}</span>
            </div>
            <div className="agent-admin-toolbar">
              <div className="agent-catalog-search">
                <IconSearch />
                <input
                  className="field-input"
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="搜索名称或标识"
                  aria-label="搜索智能体名称或标识"
                />
                {searching ? (
                  <button
                    className="agent-catalog-search-clear"
                    type="button"
                    aria-label="清除搜索"
                    title="清除搜索"
                    onClick={() => setQuery("")}
                  >
                    <IconClose />
                  </button>
                ) : null}
              </div>
              <button className="button" type="button" onClick={beginCreate}>新建智能体</button>
            </div>
            {adminScope ? (
              <div className="agent-catalog-list">
                {filteredAgents.map((agent) => {
                  const enabled = agentEnabledView(agent.isEnabled);
                  const check = agentCheckView(agent.checkStatus);
                  return (
                    <div
                      key={agent.id}
                      role="button"
                      tabIndex={0}
                      className={`agent-catalog-card${selectedKey === agent.key ? " selected" : ""}`}
                      onClick={() => selectAgent(agent.key)}
                      onKeyDown={(event) => {
                        if (event.target !== event.currentTarget) return;
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          selectAgent(agent.key);
                        }
                      }}
                    >
                      <span className="agent-catalog-card-head">
                        <AgentMark id={agent.key} name={agent.displayName} description={agent.description} />
                        <strong className="agent-catalog-card-name">{agent.displayName}</strong>
                      </span>
                      <span className="agent-catalog-card-desc">
                        {agent.description || "未填写职责说明"}
                      </span>
                      {/* 技术标识排在中文职责之后：先看懂它负责什么，再核对它是哪个 key。 */}
                      <code className="agent-catalog-card-key" title={agent.key}>{agent.key}</code>
                      <span className="agent-catalog-card-foot">
                        <span className="agent-catalog-states">
                          <span className="agent-catalog-state neutral">{agentModeView(agent.mode).label}</span>
                          <span className={`agent-catalog-state ${enabled.tone}`}>
                            <span className="agent-catalog-dot" aria-hidden="true" />
                            {enabled.label}
                          </span>
                          <span className={`agent-catalog-state ${check.tone}`}>
                            {check.tone === "positive" ? <IconCheck /> : null}
                            {check.tone === "danger" ? <IconAlert /> : null}
                            {check.label}
                          </span>
                        </span>
                        <button
                          className="agent-catalog-assign-btn"
                          type="button"
                          title={`分配「${agent.displayName}」给用户`}
                          aria-label={`分配 ${agent.displayName}，当前 ${agentAssignmentLabel(agent.assignmentCount)}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            void openAgentAssignDialog(agent);
                          }}
                        >
                          {agentAssignmentLabel(agent.assignmentCount)}
                        </button>
                      </span>
                    </div>
                  );
                })}
                {!filteredAgents.length ? (
                  <div className="agent-catalog-empty">
                    {searching ? (
                      <>
                        <strong>没有找到匹配的智能体</strong>
                        <span>换个名称或标识试试，也可以直接新建</span>
                        <button className="button-secondary" type="button" onClick={() => setQuery("")}>清除搜索</button>
                      </>
                    ) : (
                      <>
                        <strong>还没有智能体</strong>
                        <span>创建一个智能体，配置职责后再分配给用户</span>
                        <button className="button" type="button" onClick={beginCreate}>新建智能体</button>
                      </>
                    )}
                  </div>
                ) : null}
              </div>
            ) : searching && !filteredAgents.length ? (
              <div className="agent-catalog-list">
                <div className="agent-catalog-empty">
                  <strong>没有找到匹配的智能体</strong>
                  <span>换个名称或标识试试，也可以直接新建</span>
                  <button className="button-secondary" type="button" onClick={() => setQuery("")}>清除搜索</button>
                </div>
              </div>
            ) : (
              <div className="agent-catalog-sections">
                {(!searching || privateAgents.length > 0) ? (
                  <div className="agent-catalog-section" aria-label="我的私有智能体">
                    <div className="agent-catalog-section-head">
                      <div className="agent-catalog-section-title-group">
                        <h3 className="agent-catalog-section-title">我的私有智能体</h3>
                        <span className="agent-catalog-section-count">{privateAgents.length} 个</span>
                      </div>
                      <p className="agent-catalog-section-desc">由你创建，可随时编辑配置、启停或删除</p>
                    </div>
                    <div className="agent-catalog-list">
                      {privateAgents.map((agent) => {
                        const enabled = agentEnabledView(agent.isEnabled);
                        const check = agentCheckView(agent.checkStatus);
                        return (
                          <button
                            key={agent.id}
                            className={`agent-catalog-card${selectedKey === agent.key ? " selected" : ""}`}
                            type="button"
                            onClick={() => selectAgent(agent.key)}
                          >
                            <span className="agent-catalog-card-head">
                              <AgentMark id={agent.key} name={agent.displayName} description={agent.description} />
                              <strong className="agent-catalog-card-name">{agent.displayName}</strong>
                            </span>
                            <span className="agent-catalog-card-desc">
                              {agent.description || "未填写职责说明"}
                            </span>
                            <code className="agent-catalog-card-key" title={agent.key}>{agent.key}</code>
                            <span className="agent-catalog-card-foot">
                              <span className="agent-catalog-states">
                                <span className="agent-catalog-state neutral">{agentModeView(agent.mode).label}</span>
                                <span className={`agent-catalog-state ${enabled.tone}`}>
                                  <span className="agent-catalog-dot" aria-hidden="true" />
                                  {enabled.label}
                                </span>
                                <span className={`agent-catalog-state ${check.tone}`}>
                                  {check.tone === "positive" ? <IconCheck /> : null}
                                  {check.tone === "danger" ? <IconAlert /> : null}
                                  {check.label}
                                </span>
                              </span>
                            </span>
                          </button>
                        );
                      })}
                      {!privateAgents.length ? (
                        <div className="agent-catalog-empty agent-catalog-section-empty">
                          <strong>还没有私有智能体</strong>
                          <span>创建一个专属智能体，配置职责、技能与工具</span>
                          <button className="button" type="button" onClick={beginCreate}>新建智能体</button>
                        </div>
                      ) : null}
                    </div>
                  </div>
                ) : null}

                {(!searching || assignedAgents.length > 0) ? (
                  <div className="agent-catalog-section" aria-label="管理员分配的智能体">
                    <div className="agent-catalog-section-head">
                      <div className="agent-catalog-section-title-group">
                        <h3 className="agent-catalog-section-title">管理员分配的智能体</h3>
                        <span className="agent-catalog-section-count">{assignedAgents.length} 个</span>
                      </div>
                      <p className="agent-catalog-section-desc">由管理员统一维护并分配给你使用</p>
                    </div>
                    <div className="agent-catalog-list">
                      {assignedAgents.map((agent) => {
                        const enabled = agentEnabledView(agent.isEnabled);
                        const check = agentCheckView(agent.checkStatus);
                        return (
                          <div
                            key={agent.id}
                            className="agent-catalog-card agent-catalog-card-readonly"
                          >
                            <span className="agent-catalog-card-head">
                              <AgentMark id={agent.key} name={agent.displayName} description={agent.description} />
                              <strong className="agent-catalog-card-name">{agent.displayName}</strong>
                            </span>
                            <span className="agent-catalog-card-desc">
                              {agent.description || "未填写职责说明"}
                            </span>
                            <code className="agent-catalog-card-key" title={agent.key}>{agent.key}</code>
                            <span className="agent-catalog-card-foot">
                              <span className="agent-catalog-states">
                                <span className="agent-catalog-state neutral">{agentModeView(agent.mode).label}</span>
                                <span className={`agent-catalog-state ${enabled.tone}`}>
                                  <span className="agent-catalog-dot" aria-hidden="true" />
                                  {enabled.label}
                                </span>
                                <span className={`agent-catalog-state ${check.tone}`}>
                                  {check.tone === "positive" ? <IconCheck /> : null}
                                  {check.tone === "danger" ? <IconAlert /> : null}
                                  {check.label}
                                </span>
                              </span>
                            </span>
                          </div>
                        );
                      })}
                      {!assignedAgents.length ? (
                        <div className="agent-catalog-empty agent-catalog-section-empty">
                          <strong>暂未分配团队智能体</strong>
                          <span>如需使用团队共用智能体，请联系管理员分配</span>
                        </div>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </div>
            )}
          </section>

          <section className="agent-editor panel" aria-label="智能体编辑器">
            {editorMode === "create" || detail ? (
              <>
                <button className="agent-back-button" type="button" onClick={() => void requestCloseAgentDetail()} aria-label="返回智能体目录">← 返回智能体目录</button>
                <div className="panel-header agent-editor-header">
                  <div className="agent-editor-heading">
                    <div className="panel-title agent-editor-title-row">
                      <span>{editorMode === "create" ? "新建智能体" : `编辑 ${detail?.displayName ?? "智能体"}`}</span>
                      {editorDirty ? <span className="agent-dirty-badge">未保存</span> : null}
                    </div>
                    {detail ? <div className="muted mono" title={detail.contentHash ? `内容 hash：${detail.contentHash}` : undefined}>{detail.key}</div> : <div className="muted">{adminScope ? "配置基本信息、能力包与外部工具，保存检查通过后再分配给用户。" : "配置基本信息、能力包与外部工具，保存后系统会自动分配给你。"}</div>}
                  </div>
                  {agentActions}
                </div>

                {detail?.checkError ? <div className="agent-alert agent-alert-error"><strong>依赖检查失败</strong><span>{detail.checkError}</span></div> : null}

                <div className="stack">
                    {editorMode === "create" ? (
                      <label className="field"><span className="field-label">目录 key</span><input className="field-input mono" value={agentKey} onChange={(event) => setAgentKey(event.target.value)} placeholder="network-ops" /></label>
                    ) : null}
                    <p className="muted">智能体名称和职责说明请在下方 <span className="mono">agent.md</span> 的 frontmatter 中设置与修改。</p>
                    <div className="agent-editor-actions">
                      <button className="button-secondary" type="button" disabled={busy || repositoryBusy} onClick={() => { void openSkillRepository(); }}>技能仓库</button>
                      <input
                        ref={skillUploadRef}
                        hidden
                        type="file"
                        accept=".zip,application/zip"
                        onChange={(event) => {
                          const file = event.currentTarget.files?.[0];
                          event.currentTarget.value = "";
                          if (file) void uploadSkillPackage(file);
                        }}
                      />
                      <button className="button-secondary" type="button" disabled={busy} onClick={() => skillUploadRef.current?.click()}>
                        上传 Skill 包
                      </button>
                      <button className="button-secondary" type="button" disabled={busy} onClick={configureMcp}>配置 MCP</button>
                      <span className="muted">上传的 Skill 仅属于当前智能体，不会进入仓库。</span>
                    </div>
                    {skillRepositoryOpen ? (
                      <section className="panel">
                        <div className="panel-header">
                          <div>
                            <div className="panel-title">技能仓库</div>
                            <div className="muted">按 name 模糊搜索，支持一次导入多个技能；点击技能名查看详情。</div>
                          </div>
                          <div className="mono muted">{repositoryBusy ? "加载中…" : `共 ${repositorySkills.length} 个`}</div>
                        </div>
                        <div className="agent-admin-toolbar">
                          <div className="agent-catalog-search">
                            <IconSearch />
                            <input
                              className="field-input"
                              type="search"
                              value={repositoryQuery}
                              onChange={(event) => setRepositoryQuery(event.target.value)}
                              placeholder="按技能名称搜索"
                              aria-label="按技能名称搜索"
                            />
                          </div>
                          <label className="skill-repository-select-all">
                            <input
                              type="checkbox"
                              checked={allVisibleRepositorySkillsSelected}
                              disabled={busy || repositoryBusy || !filteredRepositorySkills.length}
                              onChange={toggleAllVisibleRepositorySkills}
                            />
                            <span>全选</span>
                          </label>
                        </div>
                        <div className="stack skill-repository-grid">
                          {filteredRepositorySkills.map((skill) => {
                            const checked = selectedRepositorySkills.includes(skill.name);
                            return (
                              <div key={skill.name} className={`skill-repository-item${checked ? " checked" : ""}`}>
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  disabled={busy || repositoryBusy}
                                  aria-label={`选择 ${skill.name}`}
                                  onChange={() => toggleRepositorySkill(skill.name)}
                                />
                                <button
                                  className="skill-repository-item-name"
                                  type="button"
                                  disabled={busy || repositoryBusy}
                                  onClick={() => setActiveRepositorySkill(skill)}
                                >
                                  <span className="skill-repository-item-title">{skill.name}</span>
                                  <span className="skill-repository-item-desc">{skill.description}</span>
                                </button>
                              </div>
                            );
                          })}
                          {!filteredRepositorySkills.length ? (
                            <div className="agent-catalog-empty">
                              <strong>没有匹配的技能</strong>
                              <span>尝试更短的关键字。</span>
                            </div>
                          ) : null}
                        </div>
                        <div className="inline-actions" style={{ marginTop: 14 }}>
                          <button
                            className="button"
                            type="button"
                            disabled={busy || repositoryBusy || !selectedRepositorySkills.length}
                            onClick={() => { void importSkillsFromRepository(selectedRepositorySkills); }}
                          >
                            导入选中（{selectedRepositorySkills.length}）
                          </button>
                          <button className="button-secondary" type="button" disabled={busy || repositoryBusy} onClick={closeSkillRepository}>
                            取消
                          </button>
                        </div>
                        {activeRepositorySkill ? (
                          <SkillDetailModal
                            name={activeRepositorySkill.name}
                            description={activeRepositorySkill.description}
                            fileCount={activeRepositorySkill.fileCount}
                            updatedAt={activeRepositorySkill.updatedAt}
                            actionLabel="导入"
                            actionVariant="button"
                            busy={busy || repositoryBusy}
                            onAction={() => { void importSkillsFromRepository([activeRepositorySkill.name]); }}
                            onClose={() => setActiveRepositorySkill(null)}
                          />
                        ) : null}
                      </section>
                    ) : (
                      <>
                        <div className="agent-file-workspace">
                      <aside className="agent-file-tree" aria-label="智能体文件">
                        <div className="agent-tree-head">
                          <span>智能体文件</span>
                          <span className="agent-tree-head-count">{fileTree.skills.length} 技能 · {fileTree.scriptCount} 脚本</span>
                        </div>
                        <div className="agent-tree-body">
                          <button className="agent-tree-group" type="button" aria-expanded={groupOpen("root")} onClick={() => toggleGroup("root")}>
                            <span className="agent-tree-chevron">{groupOpen("root") ? <IconChevronDown /> : <IconChevronRight />}</span>
                            <span className="agent-tree-icon"><IconFolder /></span>
                            <span className="agent-tree-label">定义与配置</span>
                            <span className="agent-tree-group-count">{fileTree.rootFiles.length}</span>
                          </button>
                          {groupOpen("root") ? fileTree.rootFiles.map((name) => (
                            <AgentTreeFile
                              key={name}
                              path={name}
                              label={name}
                              depth={1}
                              selected={selectedFile === name}
                              binary={Object.hasOwn(binaryFiles, name)}
                              onSelect={selectFile}
                            />
                          )) : null}

                          <button className="agent-tree-group" type="button" aria-expanded={groupOpen("skills")} onClick={() => toggleGroup("skills")}>
                            <span className="agent-tree-chevron">{groupOpen("skills") ? <IconChevronDown /> : <IconChevronRight />}</span>
                            <span className="agent-tree-icon agent-tree-icon-skill"><IconSkill /></span>
                            <span className="agent-tree-label">技能</span>
                            <span className="agent-tree-group-count">{fileTree.skills.length}</span>
                          </button>
                          {groupOpen("skills") ? (fileTree.skills.length ? fileTree.skills.map((skill) => {
                            const groupKey = `skills/${skill.name}`;
                            return (
                              <div className="agent-tree-branch" key={groupKey}>
                                <div className="agent-tree-skill-row">
                                  <button className="agent-tree-folder" type="button" aria-expanded={groupOpen(groupKey)} style={{ "--agent-tree-depth": 1 } as CSSProperties} onClick={() => toggleGroup(groupKey)}>
                                    <span className="agent-tree-chevron">{groupOpen(groupKey) ? <IconChevronDown /> : <IconChevronRight />}</span>
                                    <span className="agent-tree-icon"><IconFolder /></span>
                                    <span className="agent-tree-label" title={`skills/${skill.name}`}>{skill.name}</span>
                                    <span className={`agent-tree-badge${skill.referenced ? " agent-tree-badge-on" : ""}`}>{skill.referenced ? "已引用" : "未引用"}</span>
                                    <span className="agent-tree-group-count">{skill.fileCount}</span>
                                  </button>
                                  <button
                                    className="agent-tree-skill-delete"
                                    type="button"
                                    aria-label={`删除技能 ${skill.name}`}
                                    title={`删除技能 ${skill.name}`}
                                    onClick={() => setSkillDeleteTarget(skill)}
                                  >
                                    <IconTrash />
                                  </button>
                                </div>
                                {groupOpen(groupKey) ? (
                                  <AgentTreeNodes
                                    nodes={skill.nodes}
                                    depth={2}
                                    selectedFile={selectedFile}
                                    binaryFiles={binaryFiles}
                                    isOpen={groupOpen}
                                    onToggle={toggleGroup}
                                    onSelect={selectFile}
                                  />
                                ) : null}
                              </div>
                            );
                          }) : <p className="agent-tree-empty">还没有技能。请通过“技能仓库”导入。</p>) : null}

                          <button className="agent-tree-group" type="button" aria-expanded={groupOpen("scripts")} onClick={() => toggleGroup("scripts")}>
                            <span className="agent-tree-chevron">{groupOpen("scripts") ? <IconChevronDown /> : <IconChevronRight />}</span>
                            <span className="agent-tree-icon"><IconFolder /></span>
                            <span className="agent-tree-label">脚本</span>
                            <span className="agent-tree-group-count">{fileTree.scriptCount}</span>
                          </button>
                          {groupOpen("scripts") ? (fileTree.scripts.length ? (
                            <AgentTreeNodes
                              nodes={fileTree.scripts}
                              depth={1}
                              selectedFile={selectedFile}
                              binaryFiles={binaryFiles}
                              isOpen={groupOpen}
                              onToggle={toggleGroup}
                              onSelect={selectFile}
                            />
                          ) : <p className="agent-tree-empty">还没有脚本文件。</p>) : null}

                          {fileTree.others.length ? fileTree.others.map((path) => (
                            <AgentTreeFile
                              key={path}
                              path={path}
                              label={path}
                              depth={1}
                              selected={selectedFile === path}
                              binary={Object.hasOwn(binaryFiles, path)}
                              onSelect={selectFile}
                            />
                          )) : null}
                        </div>
                        <div className="agent-tree-add">
                          <input
                            className="field-input mono"
                            value={newFilePath}
                            onChange={(event) => setNewFilePath(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key !== "Enter") return;
                              event.preventDefault();
                              addSupportingFile();
                            }}
                            placeholder="scripts/run.sh"
                            aria-label="新增文件路径"
                          />
                          <button className="button-secondary" type="button" onClick={addSupportingFile}>添加</button>
                        </div>
                      </aside>

                      <section className="agent-file-pane" aria-label={`${selectedFile} 编辑器`}>
                        <header className="agent-file-pane-head">
                          <div className="agent-file-crumbs">
                            <span className="agent-file-crumb-root">data/agents/{agentDirectory}</span>
                            <span className="agent-file-crumb-sep" aria-hidden="true">/</span>
                            <span className="agent-file-crumb-current">{selectedFile}</span>
                          </div>
                          <div className="agent-file-pane-tools">
                            <span className="muted">{selectedSize}{selectedLines === null ? "" : ` · ${selectedLines} 行`}</span>
                            {selectedFile !== "agent.md" ? <button className="text-button danger" type="button" onClick={() => removeSupportingFile(selectedFile)}>删除文件</button> : null}
                          </div>
                        </header>
                        <div className="agent-file-pane-body">
                          {selectedIsBinary ? (
                            <div className="agent-binary-file">
                              <strong>二进制资源</strong>
                              <span className="muted">该文件来自导入技能，不能在线编辑；保存时会按原内容写入。</span>
                              <span className="mono">{selectedSize}</span>
                            </div>
                          ) : (
                            <textarea
                              className="field-textarea mono agent-source-editor"
                              aria-label={`编辑 ${selectedFile}`}
                              value={files[selectedFile] ?? ""}
                              onChange={(event) => setFiles((current) => ({ ...current, [selectedFile]: event.target.value }))}
                              onKeyDown={(event) => {
                                if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
                                  event.preventDefault();
                                  if (!busy && files["agent.md"]?.trim()) void saveAgent();
                                  return;
                                }
                                if (event.key !== "Tab") return;
                                event.preventDefault();
                                const target = event.currentTarget;
                                const result = insertEditorIndent(target.value, target.selectionStart, target.selectionEnd);
                                setFiles((current) => ({ ...current, [selectedFile]: result.value }));
                                requestAnimationFrame(() => target.setSelectionRange(result.selectionStart, result.selectionEnd));
                              }}
                              spellCheck={false}
                            />
                          )}
                        </div>
                        <footer className="agent-file-pane-foot">
                          保存前检查模型、工具、Skill、脚本和 MCP；每个 Skill 仅授权给所属智能体，MCP 服务名会在运行时加上智能体 key 前缀。
                          {selectedFile === "mcp.json" ? " mcp.json 顶层是服务名到 OpenCode MCP 配置的对象；凭据会进入获配用户的只读运行时配置。" : ""}
                        </footer>
                      </section>
                    </div>
                    <div className="inline-actions">
                      <button className="button" type="button" disabled={busy || !files["agent.md"]?.trim()} onClick={saveAgent}>{busy ? "保存中…" : "保存并检查"}</button>
                      <button className="button-secondary" type="button" disabled={busy} onClick={() => {
                        if (skillRepositoryOpen) {
                          closeSkillRepository();
                          return;
                        }
                        void requestCloseAgentDetail();
                      }}>取消</button>
                      <span className="muted" style={{ marginLeft: "auto", fontSize: 12 }}>Ctrl+S 保存 · Tab 缩进</span>
                    </div>
                  </>
                )}
              </div>
              </>
            ) : (
              <div className="um-detail-placeholder agent-detail-loading">
                <button className="agent-back-button" type="button" onClick={closeAgentDetail}>← 返回智能体目录</button>
                <div className="muted">正在读取智能体详情…</div>
              </div>
            )}
          </section>
        </div>
      ) : adminScope && tab === "assignments" ? (
        <div className="agent-assignment-layout">
          <section className="agent-user-list" aria-label="用户列表">
            {activeUsers.length > 0 ? (
              <div className="agent-user-search">
                <IconSearch />
                <input
                  type="search"
                  className="field-input"
                  value={userQuery}
                  onChange={(event) => setUserQuery(event.target.value)}
                  placeholder="搜索用户..."
                  aria-label="搜索待分配用户"
                />
                {userQuery ? (
                  <button
                    type="button"
                    className="agent-user-search-clear"
                    aria-label="清除搜索"
                    onClick={() => setUserQuery("")}
                  >
                    <IconClose />
                  </button>
                ) : null}
              </div>
            ) : null}
            {filteredActiveUsers.map((user) => (
              <button className={`agent-user-row${selectedUserId === user.id ? " selected" : ""}`} key={user.id} type="button" onClick={() => setSelectedUserId(user.id)}>
                <strong>{user.name}</strong>
                <span className="muted">@{user.username}</span>
              </button>
            ))}
            {!activeUsers.length ? (
              <div className="um-empty">没有可分配的启用用户。</div>
            ) : !filteredActiveUsers.length ? (
              <div className="um-empty">没有匹配的用户。</div>
            ) : null}
          </section>
          <section className="agent-assignment-detail panel">
            {assignment ? (
              <>
                <div className="panel-header">
                  <div><div className="panel-title">{assignment.user.name}</div><div className="muted">@{assignment.user.username}</div></div>
                  <span className={`agent-config-status status-${assignment.configuration.status}`}>{statusLabels[assignment.configuration.status]}</span>
                </div>
                <div className="agent-config-strip">
                  <div><span>配置代次</span><strong>{assignment.configuration.appliedGeneration} / {assignment.configuration.desiredGeneration}</strong></div>
                  <div><span>期望清单</span><strong>{assignment.configuration.expectedAgentKeys.length} 个</strong></div>
                  <div><span>实际清单</span><strong>{assignment.configuration.actualAgentKeys.length} 个</strong></div>
                </div>
                {assignment.configuration.error ? <div className="agent-alert agent-alert-error"><strong>运行环境保持冻结</strong><span>{assignment.configuration.error}</span></div> : null}
                <div className="agent-assignment-options">
                  {assignment.agents.map((agent) => {
                    const checked = draftAgentIds.includes(agent.id);
                    const disabled = !agent.canManage || (!checked && (!agent.isEnabled || agent.checkStatus !== "ready"));
                    return (
                      <label className={`agent-assignment-option${checked ? " checked" : ""}${disabled ? " disabled" : ""}`} key={agent.id}>
                        <input type="checkbox" checked={checked} disabled={disabled || assignmentBusy} onChange={(event) => setDraftAgentIds((current) => event.target.checked ? [...current, agent.id] : current.filter((id) => id !== agent.id))} />
                        <span><strong>{agent.displayName}</strong><small className="mono">{agent.key} · {agentModeView(agent.mode).label}</small><small>{agent.canManage ? agent.description : "用户私有智能体；管理员不能调整此项分配。"}</small></span>
                      </label>
                    );
                  })}
                </div>
                <div className="agent-assignment-foot">
                  <span className={assignmentHasLead ? "muted" : "agent-assignment-warning"}>{assignmentHasLead ? "同一用户的智能体共享该用户固定环境；子智能体仅用于协作调用。" : "至少选择一个主智能体或主/子智能体。"}</span>
                  <div className="inline-actions">
                    {assignment.configuration.action === "retry" ? <button className="button-secondary" type="button" disabled={assignmentBusy} onClick={retryConfiguration}>重新装配</button> : null}
                    <button className="button" type="button" disabled={!assignmentDirty || assignmentBusy || !assignmentHasLead} onClick={saveAssignments}>{assignmentBusy ? "处理中…" : "保存并应用"}</button>
                  </div>
                </div>
              </>
            ) : <div className="um-detail-placeholder"><div className="muted">{assignmentBusy ? "正在读取分配状态…" : "选择一个用户分配智能体。"}</div></div>}
          </section>
        </div>
      ) : adminScope && tab === "models" ? (
        <section className="panel agent-model-panel">
          <div className="panel-header">
            <div>
              <div className="panel-title">平台模型连接</div>
              <div className="muted">保存后，系统逐个更新受影响的用户环境。</div>
            </div>
          </div>
          <ModelManager onDirty={() => toast.info("模型配置已保存，用户环境正在更新")} />
        </section>
      ) : adminScope ? (
        <section className="panel global-instructions-panel">
          <div className="panel-header">
            <div>
              <div className="panel-title">全局规则</div>
              <div className="muted">统一约束所有用户与智能体；任务明确指定的目录和要求仍应优先遵循。</div>
            </div>
          </div>
          <GlobalInstructionsManager />
        </section>
      ) : null}

      <ConfirmDialog
        open={skillDeleteTarget !== null}
        title={`删除技能 ${skillDeleteTarget?.name ?? ""}`}
        description={skillDeleteTarget ? `将删除该技能目录中的 ${skillDeleteTarget.fileCount} 个文件${skillDeleteTarget.referenced ? "，并从 agent.md 中移除引用" : ""}。保存并检查后生效。` : undefined}
        confirmLabel="删除技能"
        variant="danger"
        onCancel={() => setSkillDeleteTarget(null)}
        onConfirm={() => { if (skillDeleteTarget) removeSkillDirectory(skillDeleteTarget); }}
      />

      <ConfirmDialog
        open={disableTarget !== null}
        title={`停用 ${disableTarget?.displayName ?? "智能体"}`}
        description={adminScope
          ? "相关用户会立即停止当前协作任务并重建运行环境；历史会话和个人文件会保留。"
          : "停用后该智能体将从你的可用列表中移除；重新启用后会再次装配到你的运行环境。"}
        confirmLabel={adminScope ? "停用并重新装配" : "停用智能体"}
        variant="danger"
        busy={busy}
        onCancel={() => setDisableTarget(null)}
        onConfirm={() => { if (disableTarget) void changeEnabled(disableTarget, false); }}
      />

      {adminScope && assignAgentTarget && typeof document !== "undefined" ? createPortal(
        <div
          className="file-dialog-backdrop"
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget) closeAgentAssignDialog();
          }}
        >
          <div
            className="file-dialog agent-assign-dialog"
            role="dialog"
            aria-modal="true"
            aria-busy={assignLoading || assignSaving}
            aria-labelledby="agent-assign-dialog-title"
          >
            <div className="agent-assign-dialog-head">
              <div>
                <div className="file-dialog-title" id="agent-assign-dialog-title">
                  分配智能体 · {assignAgentTarget.displayName}
                </div>
                <div className="muted agent-assign-dialog-sub">
                  选择可以使用 <span className="mono">{assignAgentTarget.key}</span> 的启用用户
                </div>
              </div>
              <button
                type="button"
                className="agent-assign-dialog-close"
                aria-label="关闭"
                disabled={assignSaving}
                onClick={closeAgentAssignDialog}
              >
                <IconClose />
              </button>
            </div>

            {!assignCanAdd ? (
              <div className="agent-alert agent-alert-error" style={{ marginBottom: 12 }}>
                <strong>当前不可新增分配</strong>
                <span>该智能体尚未启用或检查未通过，仅可取消已有用户的分配。</span>
              </div>
            ) : null}

            <div className="agent-assign-dialog-toolbar">
              <div className="agent-catalog-search">
                <IconSearch />
                <input
                  type="search"
                  className="field-input"
                  value={assignUserQuery}
                  onChange={(event) => setAssignUserQuery(event.target.value)}
                  placeholder="搜索姓名或用户名..."
                  aria-label="搜索用户"
                  disabled={assignLoading || assignSaving}
                />
                {assignUserQuery ? (
                  <button
                    type="button"
                    className="agent-catalog-search-clear"
                    aria-label="清除搜索"
                    onClick={() => setAssignUserQuery("")}
                  >
                    <IconClose />
                  </button>
                ) : null}
              </div>
              <div className="agent-assign-dialog-quick">
                <button
                  type="button"
                  className="text-button"
                  disabled={assignLoading || assignSaving || !assignCanAdd || !filteredAssignUsers.length}
                  onClick={() => {
                    const visibleIds = filteredAssignUsers.map((user) => user.id);
                    setAssignDraftUserIds((current) => Array.from(new Set([...current, ...visibleIds])));
                  }}
                >
                  全选
                </button>
                <button
                  type="button"
                  className="text-button"
                  disabled={assignLoading || assignSaving || !assignDraftUserIds.length}
                  onClick={() => {
                    const visibleSet = new Set(filteredAssignUsers.map((user) => user.id));
                    setAssignDraftUserIds((current) => current.filter((id) => !visibleSet.has(id)));
                  }}
                >
                  取消全选
                </button>
              </div>
            </div>

            <div className="agent-assign-dialog-list">
              {assignLoading ? (
                <div className="um-empty">正在读取当前分配情况…</div>
              ) : !activeUsers.length ? (
                <div className="um-empty">没有可分配的启用用户。</div>
              ) : !filteredAssignUsers.length ? (
                <div className="um-empty">没有匹配的用户。</div>
              ) : (
                filteredAssignUsers.map((user) => {
                  const checked = assignDraftUserIds.includes(user.id);
                  const originallyAssigned = assignInitialUserIds.includes(user.id);
                  const disabled = assignSaving || (!checked && !originallyAssigned && !assignCanAdd);
                  return (
                    <label
                      key={user.id}
                      className={`agent-assign-user-item${checked ? " checked" : ""}${disabled ? " disabled" : ""}`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={disabled}
                        onChange={() => toggleAssignUser(user.id)}
                      />
                      <span className="agent-assign-user-info">
                        <strong>{user.name}</strong>
                        <span className="muted">@{user.username}</span>
                      </span>
                      {user.role === "admin" ? (
                        <span className="agent-assign-user-role">管理员</span>
                      ) : null}
                    </label>
                  );
                })
              )}
            </div>

            <div className="agent-assign-dialog-foot">
              <span className="muted">
                已选 {assignDraftUserIds.length} / {activeUsers.length} 位用户
              </span>
              <div className="inline-actions">
                <button
                  className="button-secondary"
                  type="button"
                  disabled={assignSaving}
                  onClick={closeAgentAssignDialog}
                >
                  取消
                </button>
                <button
                  className="button"
                  type="button"
                  disabled={assignLoading || assignSaving || !assignDirty}
                  onClick={() => { void saveAgentUserAssignments(); }}
                >
                  {assignSaving ? "保存中…" : "保存分配"}
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
    </div>
  );
}

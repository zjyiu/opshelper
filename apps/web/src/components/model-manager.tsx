"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import { IconClose, IconSearch } from "./chat/icons";
import { confirm as confirmDialog } from "./ui/dialog-host";
import { toast } from "@/lib/toast";

const API_BASE = "/v1/admin/runtime/models";
// 与后端 MODEL_ID_RE 一致：厂商模型 id 常见字符（点/冒号/斜杠），不含空白。
const MODEL_ID_RE = /^[A-Za-z0-9._:/-]{1,128}$/;

interface ModelRow {
  /** 稳定的行 key（新增行没有天然 id，用它驱动 React 列表）。 */
  key: string;
  id: string;
  name: string;
}

interface ModelSettings {
  baseURL: string;
  apiKey: string;
  models: { id: string; name: string }[];
  defaultModel: string;
}

async function readError(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as { message?: string };
    return data.message || `请求失败（${response.status}）`;
  } catch {
    return `请求失败（${response.status}）`;
  }
}

let rowSeq = 0;
function newRowKey(): string {
  rowSeq += 1;
  return `row-${Date.now()}-${rowSeq}`;
}

/**
 * 模型管理：维护共享配置里唯一的 openai 兼容自定义模型组（provider.custom）——
 * 组级 baseURL + API Key，组内若干模型（id + 显示名 + 默认标记）。整组覆盖式
 * 保存。后端会冻结新任务，并逐个重建受影响的用户运行环境。
 */
export function ModelManager({ onDirty }: { onDirty: () => void }) {
  const [loaded, setLoaded] = useState(false);
  const [baseURL, setBaseURL] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [rows, setRows] = useState<ModelRow[]>([]);
  const [defaultKey, setDefaultKey] = useState<string | null>(null);
  const [savedSnapshot, setSavedSnapshot] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [discoveredModels, setDiscoveredModels] = useState<Array<{ id: string; name: string }> | null>(null);
  const [selectedDiscoveredIds, setSelectedDiscoveredIds] = useState<string[]>([]);
  const [discoverQuery, setDiscoverQuery] = useState("");

  const currentSnapshot = useMemo(() => {
    const defaultModel = rows.find((m) => m.key === defaultKey)?.id ?? rows[0]?.id ?? "";
    return JSON.stringify({
      baseURL: baseURL.trim(),
      apiKey: apiKey.trim(),
      models: rows.map((m) => ({ id: m.id.trim(), name: m.name.trim() })),
      defaultModel: defaultModel.trim(),
    });
  }, [apiKey, baseURL, defaultKey, rows]);
  const dirty = loaded && savedSnapshot !== "" && currentSnapshot !== savedSnapshot;

  const load = useCallback(async () => {
    try {
      const response = await fetch(API_BASE, { cache: "no-store" });
      if (!response.ok) throw new Error(await readError(response));
      const data = (await response.json()) as ModelSettings;
      setBaseURL(data.baseURL);
      setApiKey(data.apiKey);
      const nextRows = data.models.map(
        (m): ModelRow => ({ key: newRowKey(), id: m.id, name: m.name }),
      );
      setRows(nextRows);
      const nextDefaultKey =
        nextRows.find((r) => r.id === data.defaultModel)?.key ?? null;
      setDefaultKey(nextDefaultKey);
      const resolvedDefault = nextRows.find((r) => r.key === nextDefaultKey)?.id ?? nextRows[0]?.id ?? "";
      setSavedSnapshot(JSON.stringify({
        baseURL: data.baseURL.trim(),
        apiKey: data.apiKey.trim(),
        models: nextRows.map((m) => ({ id: m.id.trim(), name: m.name.trim() })),
        defaultModel: resolvedDefault.trim(),
      }));
      setLoaded(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "加载模型配置失败");
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const updateRow = useCallback(
    (key: string, patch: Partial<Pick<ModelRow, "id" | "name">>) => {
      setRows((prev) =>
        prev.map((row) => (row.key === key ? { ...row, ...patch } : row)),
      );
    },
    [],
  );

  const addRow = useCallback(() => {
    const row: ModelRow = { key: newRowKey(), id: "", name: "" };
    setRows((prev) => [...prev, row]);
    // 第一行自动成为默认模型，省一次点击。
    setDefaultKey((prev) => prev ?? row.key);
  }, []);

  const removeRow = useCallback((key: string) => {
    setRows((prev) => {
      const next = prev.filter((row) => row.key !== key);
      setDefaultKey((current) =>
        current === key ? (next[0]?.key ?? null) : current,
      );
      return next;
    });
  }, []);

  const existingModelIds = useMemo(
    () => new Set(rows.map((row) => row.id.trim()).filter(Boolean)),
    [rows],
  );

  const filteredDiscoveredModels = useMemo(() => {
    if (!discoveredModels) return [];
    const keyword = discoverQuery.trim().toLowerCase();
    if (!keyword) return discoveredModels;
    return discoveredModels.filter((model) =>
      model.id.toLowerCase().includes(keyword) || model.name.toLowerCase().includes(keyword),
    );
  }, [discoveredModels, discoverQuery]);

  const selectableFilteredIds = useMemo(
    () => filteredDiscoveredModels
      .filter((model) => !existingModelIds.has(model.id))
      .map((model) => model.id),
    [existingModelIds, filteredDiscoveredModels],
  );

  useEffect(() => {
    if (!discoveredModels) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setDiscoveredModels(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [discoveredModels]);

  const discoverModels = useCallback(async () => {
    const trimmedBase = baseURL.trim();
    if (!/^https?:\/\/.+/.test(trimmedBase)) {
      toast.error("请先填写以 http:// 或 https:// 开头的接口地址 (baseURL)");
      return;
    }
    setDiscovering(true);
    try {
      const response = await fetch(`${API_BASE}/discover`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseURL: trimmedBase,
          apiKey: apiKey.trim(),
        }),
      });
      if (!response.ok) throw new Error(await readError(response));
      const data = (await response.json()) as { models?: Array<{ id: string; name: string }> };
      const models = Array.isArray(data.models) ? data.models : [];
      if (models.length === 0) {
        toast.info("接口未返回可用模型，请手动添加");
        return;
      }
      const addable = models.filter((model) => !existingModelIds.has(model.id));
      if (addable.length === 0) {
        toast.info(`共获取到 ${models.length} 个模型，已全部在当前列表中`);
        return;
      }
      setDiscoverQuery("");
      setDiscoveredModels(models);
      // 列表为空且数量不多时默认全选，减少一次勾选操作。
      setSelectedDiscoveredIds(
        existingModelIds.size === 0 && addable.length <= 5
          ? addable.map((model) => model.id)
          : [],
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "自动加载模型失败");
    } finally {
      setDiscovering(false);
    }
  }, [apiKey, baseURL, existingModelIds]);

  const importSelectedModels = useCallback(() => {
    if (!discoveredModels || selectedDiscoveredIds.length === 0) return;
    const selectedSet = new Set(selectedDiscoveredIds);
    const toAdd = discoveredModels.filter(
      (model) => selectedSet.has(model.id) && !existingModelIds.has(model.id),
    );
    if (toAdd.length === 0) {
      setDiscoveredModels(null);
      return;
    }
    const newRows: ModelRow[] = toAdd.map((model) => ({
      key: newRowKey(),
      id: model.id,
      name: model.name || model.id,
    }));
    setRows((prev) => {
      const cleaned = prev.filter((row) => row.id.trim().length > 0 || row.name.trim().length > 0);
      return [...cleaned, ...newRows];
    });
    setDefaultKey((prev) => prev ?? newRows[0]?.key ?? null);
    setDiscoveredModels(null);
    setSelectedDiscoveredIds([]);
    toast.success(`已导入 ${newRows.length} 个模型，请点击「保存」生效`);
  }, [discoveredModels, existingModelIds, selectedDiscoveredIds]);

  const save = useCallback(async () => {
    const models = rows
      .map((row) => ({ ...row, id: row.id.trim(), name: row.name.trim() }))
      .filter((row) => row.id.length > 0 || row.name.length > 0);
    for (const row of models) {
      if (!MODEL_ID_RE.test(row.id)) {
        toast.error(
          `模型 ID「${row.id || "（空）"}」不合法：仅允许字母、数字与 . _ : / -，不含空白`,
        );
        return;
      }
    }
    if (new Set(models.map((m) => m.id)).size !== models.length) {
      toast.error("模型 ID 不能重复");
      return;
    }
    if (models.length > 0 && !/^https?:\/\//.test(baseURL.trim())) {
      toast.error("接口地址 (baseURL) 需以 http:// 或 https:// 开头");
      return;
    }
    const defaultModel =
      models.find((m) => m.key === defaultKey)?.id ?? models[0]?.id ?? "";
    if (models.length === 0) {
      const ok = await confirmDialog({
        title: "清空模型组？",
        description:
          "保存后将移除自定义模型组：聊天界面不再显示模型选择器，容器内也没有默认模型，重启后用户将无法对话，请尽快重新配置。",
        confirmLabel: "清空并保存",
        variant: "danger",
      });
      if (!ok) return;
    }
    setSaving(true);
    try {
      const response = await fetch(API_BASE, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseURL: baseURL.trim(),
          apiKey: apiKey.trim(),
          models: models.map((m) => ({ id: m.id, name: m.name })),
          defaultModel,
        }),
      });
      if (!response.ok) throw new Error(await readError(response));
      toast.success("已保存");
      onDirty();
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }, [rows, baseURL, apiKey, defaultKey, load, onDirty]);

  if (!loaded) {
    return <div className="opshelper-skill-empty">加载中…</div>;
  }

  return (
    <div className="opshelper-skill-editor opshelper-model-manager">
      <div className="opshelper-skill-files-hint">
        所有模型共用同一个 OpenAI 兼容接口地址与 API
        Key，仅模型 ID 不同。保存后，正在执行任务的用户会先等待本次任务结束，
        空闲用户会直接更新配置；更新期间不能开始新任务。
      </div>

      <label className="opshelper-skill-field">
        <span>接口地址 (baseURL，OpenAI 兼容，通常以 /v1 结尾)</span>
        <input
          value={baseURL}
          placeholder="例如 https://dashscope.aliyuncs.com/compatible-mode/v1"
          onChange={(e) => setBaseURL(e.target.value)}
        />
      </label>

      <label className="opshelper-skill-field">
        <span>API Key（留空表示该接口无需鉴权）</span>
        <div className="opshelper-model-key-row">
          <input
            type={showKey ? "text" : "password"}
            value={apiKey}
            placeholder="sk-…"
            autoComplete="off"
            onChange={(e) => setApiKey(e.target.value)}
          />
          <button
            type="button"
            className="opshelper-skill-btn small"
            onClick={() => setShowKey((v) => !v)}
          >
            {showKey ? "隐藏" : "显示"}
          </button>
        </div>
      </label>

      <div className="opshelper-skill-field">
        <span>模型列表（默认模型用于新用户与未手动切换的用户）</span>
        {rows.length === 0 ? (
          <div className="opshelper-skill-files-hint">
            还没有模型。点击「新增模型」添加第一个。
          </div>
        ) : (
          <div className="opshelper-model-rows">
            <div className="opshelper-model-row opshelper-model-row-head">
              <span className="opshelper-model-col-default">默认</span>
              <span className="opshelper-model-col-id">模型 ID（接口的 model 参数）</span>
              <span className="opshelper-model-col-name">显示名（用户在聊天界面看到的）</span>
              <span className="opshelper-model-col-actions" />
            </div>
            {rows.map((row, index) => (
              <div key={row.key} className="opshelper-model-row">
                <label className="opshelper-model-col-default">
                  <input
                    type="radio"
                    name="opshelper-default-model"
                    checked={defaultKey === row.key}
                    onChange={() => setDefaultKey(row.key)}
                    aria-label={`设为默认模型（第 ${index + 1} 行）`}
                  />
                  <span className="opshelper-model-mobile-label">默认模型</span>
                </label>
                <label className="opshelper-model-col-id">
                  <span className="opshelper-model-mobile-label">模型 ID</span>
                  <input
                    aria-label={`模型 ID（第 ${index + 1} 行）`}
                    value={row.id}
                    placeholder="例如 qwen-plus"
                    spellCheck={false}
                    onChange={(e) => updateRow(row.key, { id: e.target.value })}
                  />
                </label>
                <label className="opshelper-model-col-name">
                  <span className="opshelper-model-mobile-label">显示名</span>
                  <input
                    aria-label={`显示名（第 ${index + 1} 行）`}
                    value={row.name}
                    placeholder="留空使用模型 ID"
                    onChange={(e) => updateRow(row.key, { name: e.target.value })}
                  />
                </label>
                <span className="opshelper-model-col-actions">
                  <button
                    type="button"
                    className="opshelper-skill-btn small danger"
                    onClick={() => removeRow(row.key)}
                  >
                    删除
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}
        <div className="opshelper-skill-toolbar">
          <button type="button" className="opshelper-skill-btn small" onClick={addRow}>
            新增模型
          </button>
          <button
            type="button"
            className="opshelper-skill-btn small"
            onClick={() => void discoverModels()}
            disabled={discovering || saving || !baseURL.trim()}
            title="从接口地址的 /models 自动获取可用模型列表"
          >
            {discovering ? "加载中…" : "自动加载模型"}
          </button>
        </div>
      </div>

      <div className="opshelper-skill-editor-actions">
        {dirty ? (
          <span className="agent-dirty-badge" style={{ marginRight: "auto" }}>有未保存修改</span>
        ) : null}
        {dirty ? (
          <button
            type="button"
            className="opshelper-skill-btn"
            onClick={() => void load()}
            disabled={saving}
          >
            撤销修改
          </button>
        ) : null}
        <button
          type="button"
          className="opshelper-skill-btn primary"
          onClick={() => void save()}
          disabled={saving}
        >
          {saving ? "保存中…" : "保存"}
        </button>
      </div>

      {discoveredModels && typeof document !== "undefined" ? createPortal(
        <div
          className="file-dialog-backdrop"
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget) setDiscoveredModels(null);
          }}
        >
          <div
            className="file-dialog agent-assign-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="model-discover-dialog-title"
          >
            <div className="agent-assign-dialog-head">
              <div>
                <div className="file-dialog-title" id="model-discover-dialog-title">
                  选择要导入的模型
                </div>
                <div className="muted agent-assign-dialog-sub">
                  从接口共获取到 {discoveredModels.length} 个模型，勾选后导入到当前模型列表
                </div>
              </div>
              <button
                type="button"
                className="agent-assign-dialog-close"
                aria-label="关闭"
                onClick={() => setDiscoveredModels(null)}
              >
                <IconClose />
              </button>
            </div>

            <div className="agent-assign-dialog-toolbar">
              <div className="agent-catalog-search">
                <IconSearch />
                <input
                  type="search"
                  className="field-input"
                  value={discoverQuery}
                  onChange={(event) => setDiscoverQuery(event.target.value)}
                  placeholder="搜索模型 ID 或名称..."
                  aria-label="搜索模型"
                />
                {discoverQuery ? (
                  <button
                    type="button"
                    className="agent-catalog-search-clear"
                    aria-label="清除搜索"
                    onClick={() => setDiscoverQuery("")}
                  >
                    <IconClose />
                  </button>
                ) : null}
              </div>
              <div className="agent-assign-dialog-quick">
                <button
                  type="button"
                  disabled={!selectableFilteredIds.length}
                  onClick={() =>
                    setSelectedDiscoveredIds((current) =>
                      Array.from(new Set([...current, ...selectableFilteredIds])),
                    )
                  }
                >
                  全选
                </button>
                <button
                  type="button"
                  disabled={!selectedDiscoveredIds.length}
                  onClick={() => {
                    const visibleSet = new Set(selectableFilteredIds);
                    setSelectedDiscoveredIds((current) =>
                      current.filter((id) => !visibleSet.has(id)),
                    );
                  }}
                >
                  取消全选
                </button>
              </div>
            </div>

            <div className="agent-assign-dialog-list">
              {!filteredDiscoveredModels.length ? (
                <div className="um-empty">没有匹配的模型。</div>
              ) : (
                filteredDiscoveredModels.map((model) => {
                  const alreadyAdded = existingModelIds.has(model.id);
                  const checked = alreadyAdded || selectedDiscoveredIds.includes(model.id);
                  return (
                    <label
                      key={model.id}
                      className={`agent-assign-user-item${checked ? " checked" : ""}${alreadyAdded ? " disabled" : ""}`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={alreadyAdded}
                        onChange={() =>
                          setSelectedDiscoveredIds((current) =>
                            current.includes(model.id)
                              ? current.filter((id) => id !== model.id)
                              : [...current, model.id],
                          )
                        }
                      />
                      <span className="agent-assign-user-info">
                        <strong className="mono">{model.id}</strong>
                        {model.name && model.name !== model.id ? (
                          <span className="muted">{model.name}</span>
                        ) : null}
                      </span>
                      {alreadyAdded ? (
                        <span className="agent-assign-user-role">已添加</span>
                      ) : null}
                    </label>
                  );
                })
              )}
            </div>

            <div className="agent-assign-dialog-foot">
              <span className="muted">
                已选 {selectedDiscoveredIds.length} 个新模型
              </span>
              <div className="inline-actions">
                <button
                  className="button-secondary"
                  type="button"
                  onClick={() => setDiscoveredModels(null)}
                >
                  取消
                </button>
                <button
                  className="button"
                  type="button"
                  disabled={selectedDiscoveredIds.length === 0}
                  onClick={importSelectedModels}
                >
                  导入选中（{selectedDiscoveredIds.length}）
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

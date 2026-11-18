"use client";

import { useEffect, useRef, useState } from "react";

import {
  createUserApiToken,
  deleteUserApiToken,
  listUserApiTokens,
  type UserApiToken,
} from "@/lib/browser-api";
import { copyText } from "./file-manager/utils";
import { confirm } from "./ui/dialog-host";

export function UserApiTokens({ onCreatingChange }: { onCreatingChange: (creating: boolean) => void }) {
  const [tokens, setTokens] = useState<UserApiToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState("");
  const creatingRef = useRef(false);
  const revokingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    void listUserApiTokens().then((result) => {
      if (!cancelled) setTokens(result.tokens);
    }).catch((nextError: unknown) => {
      if (!cancelled) setLoadError(nextError instanceof Error ? nextError.message : "读取 API Token 失败");
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [refreshKey]);

  async function createToken() {
    if (creatingRef.current) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setError("请输入 Token 名称");
      return;
    }
    setError(null);
    creatingRef.current = true;
    setCreating(true);
    onCreatingChange(true);
    try {
      const created = await createUserApiToken(trimmed);
      setTokens((current) => [{ id: created.id, name: created.name, createdAt: created.createdAt }, ...current]);
      setNewToken(created.token);
      setCopyStatus("");
      setName("");
    } catch (nextError) {
      setError(`${nextError instanceof Error ? nextError.message : "创建 API Token 失败"}。如连接中断，请先检查列表，避免重复创建。`);
    } finally {
      creatingRef.current = false;
      setCreating(false);
      onCreatingChange(false);
    }
  }

  async function revokeToken(token: UserApiToken) {
    if (revokingRef.current) return;
    revokingRef.current = true;
    const confirmed = await confirm({
      title: "撤销 API Token",
      description: `确定撤销「${token.name}」吗？使用此 Token 的系统将无法再发起请求；已受理的执行不会自动停止。`,
      confirmLabel: "撤销 Token",
      variant: "danger",
    });
    if (!confirmed) {
      revokingRef.current = false;
      return;
    }
    setError(null);
    setRevoking(token.id);
    try {
      await deleteUserApiToken(token.id);
      setTokens((current) => current.filter((item) => item.id !== token.id));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "撤销 API Token 失败");
    } finally {
      revokingRef.current = false;
      setRevoking(null);
    }
  }

  async function copyToken() {
    if (!newToken) return;
    try {
      await copyText(newToken);
      setCopyStatus("已复制 Token");
    } catch {
      setCopyStatus("复制失败，请手动选择并复制 Token");
    }
  }

  return (
    <div className="profile-token-content">
      <p className="muted profile-token-intro">
        Token 代表你的账号供外部系统调用已分配的智能体，不会自动过期。请仅交给可信系统，泄露后立即撤销。
      </p>
      {newToken ? (
        <div className="profile-token-created">
          <strong>Token 已创建，请立即保存</strong>
          <p className="muted">明文只显示这一次，关闭或确认后无法再次查看。请勿发送到日志或公开位置。</p>
          <label className="field">
            <span className="field-label">API Token</span>
            <textarea className="field-textarea mono" rows={3} readOnly value={newToken} onFocus={(event) => event.currentTarget.select()} />
          </label>
          <div role="status" aria-live="polite">{copyStatus}</div>
          <div className="inline-actions">
            <button className="button-secondary" type="button" onClick={() => { setNewToken(null); setCopyStatus(""); }}>已保存</button>
            <button className="button" type="button" onClick={() => void copyToken()}>复制 Token</button>
          </div>
        </div>
      ) : (
        <form className="profile-token-create" onSubmit={(event) => { event.preventDefault(); void createToken(); }}>
          <label className="field">
            <span className="field-label">Token 名称</span>
            <input className="field-input" value={name} onChange={(event) => setName(event.target.value)} maxLength={80} required placeholder="例如：告警平台" disabled={creating || loading || Boolean(loadError)} />
          </label>
          <button className="button" type="submit" disabled={creating || loading || Boolean(loadError)}>
            {creating ? "创建中…" : "创建 Token"}
          </button>
        </form>
      )}
      {error ? <div className="flash flash-error" role="alert">{error}</div> : null}
      <div className="profile-token-list">
        <strong>已创建的 Token</strong>
        {loading ? <div className="muted" role="status">正在读取 Token…</div> : loadError ? (
          <div className="profile-settings-error" role="alert">
            <span>{loadError}</span>
            <button className="button-secondary" type="button" onClick={() => setRefreshKey((key) => key + 1)}>重试</button>
          </div>
        ) : tokens.length === 0 ? <div className="muted">尚未创建 Token</div> : (
          <ul>
            {tokens.map((token) => (
              <li key={token.id}>
                <div className="profile-token-details">
                  <strong>{token.name}</strong>
                  <span className="muted">创建于 {new Date(token.createdAt).toLocaleString("zh-CN")}</span>
                </div>
                <button className="button-secondary" type="button" disabled={creating || revoking !== null || newToken !== null} onClick={() => void revokeToken(token)}>
                  {revoking === token.id ? "撤销中…" : "撤销"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

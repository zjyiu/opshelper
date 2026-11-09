"use client";

import React, { useEffect, useRef, useState } from "react";
import type { UserSummary } from "@opshelper/shared";

export function filterSsoUsers(users: UserSummary[], query: string) {
  const search = query.trim().toLowerCase();
  return users.filter((user) =>
    user.username.toLowerCase().includes(search) ||
    user.name.toLowerCase().includes(search),
  );
}

export function SsoUserPicker({
  users,
  existingAccounts,
  onAdd,
  onClose,
}: {
  users: UserSummary[];
  existingAccounts: string[];
  onAdd: (accounts: string[]) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const visibleUsers = filterSsoUsers(users, query);
  const exceedsLimit = existingAccounts.length + selected.length > 500;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    searchRef.current?.focus();
    return () => dialog.close();
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className="file-dialog sso-user-dialog"
      aria-labelledby="sso-user-dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="file-dialog-title" id="sso-user-dialog-title">添加用户</div>
      <label className="field">
        <span className="field-label">搜索用户</span>
        <input
          ref={searchRef}
          className="field-input"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="按用户名或显示名称搜索"
        />
      </label>
      <div className="muted">已选择 {selected.length} 个用户；已添加和已停用的用户不可重复添加。</div>
      <div className="sso-picker-list" role="group" aria-label="选择要添加的用户">
        {visibleUsers.map((user) => {
          const alreadyAdded = existingAccounts.includes(user.username);
          const inactive = !user.isActive;
          return (
            <label className="sso-picker-option" key={user.id}>
              <input
                type="checkbox"
                checked={selected.includes(user.username)}
                disabled={alreadyAdded || inactive}
                onChange={(event) => {
                  const checked = event.target.checked;
                  setSelected((current) => checked
                    ? [...current, user.username]
                    : current.filter((account) => account !== user.username));
                }}
              />
              <span>
                <strong>{user.name}</strong>
                <small className="mono">
                  {user.username}{alreadyAdded ? " · 已添加" : ""}{inactive ? " · 已停用" : ""}
                </small>
              </span>
            </label>
          );
        })}
        {!visibleUsers.length ? (
          <div className="muted">{query.trim() ? "没有匹配的用户。" : "暂无用户。"}</div>
        ) : null}
      </div>
      {exceedsLimit ? <div className="flash flash-error">白名单最多支持 500 个账号。</div> : null}
      <div className="inline-actions file-dialog-actions">
        <button className="button-secondary" type="button" onClick={onClose}>取消</button>
        <button
          className="button"
          type="button"
          disabled={!selected.length || exceedsLimit}
          onClick={() => onAdd(selected)}
        >
          添加（{selected.length}）
        </button>
      </div>
    </dialog>
  );
}

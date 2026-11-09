"use client";

import React, { useEffect, useRef, useState } from "react";
import type { SsoTokenResponse } from "@opshelper/shared";

import { copyText } from "./file-manager/utils";

export function SsoTokenDialog({
  result,
  userName,
  onClose,
}: {
  result: SsoTokenResponse;
  userName: string;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [copyStatus, setCopyStatus] = useState("");

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    return () => dialog.close();
  }, []);

  async function copyToken() {
    try {
      await copyText(result.token);
      setCopyStatus("已复制令牌");
    } catch {
      setCopyStatus("复制失败，请手动选择并复制令牌");
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="file-dialog sso-token-dialog"
      aria-labelledby="sso-token-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="file-dialog-title" id="sso-token-title">获取 account 令牌</div>
      <div className="stack">
        <div>用户：{userName}</div>
        <div className="muted">令牌使用当前已保存的密钥生成，每次生成的值不同。请妥善保管，不要转发或记录。</div>
        {!result.isActive || !result.isWhitelisted ? (
          <div className="flash flash-error">
            {!result.isActive ? "用户已停用；" : ""}
            {!result.isWhitelisted ? "用户未加入已保存的白名单；" : ""}
            当前无法使用该令牌免密登录。
          </div>
        ) : null}
        <label className="field">
          <span className="field-label">account 令牌</span>
          <textarea className="field-textarea mono" rows={3} readOnly value={result.token} onFocus={(event) => event.currentTarget.select()} />
        </label>
        <div role="status" aria-live="polite">{copyStatus}</div>
        <div className="inline-actions file-dialog-actions">
          <button className="button-secondary" type="button" onClick={onClose}>关闭</button>
          <button className="button" type="button" onClick={() => void copyToken()}>复制令牌</button>
        </div>
      </div>
    </dialog>
  );
}

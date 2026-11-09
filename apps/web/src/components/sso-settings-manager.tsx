"use client";

import React, { useState } from "react";
import type {
  SsoSettingsSnapshot,
  SsoTokenResponse,
  UserSummary,
} from "@opshelper/shared";

import { generateSsoToken, updateSsoSecret, updateSsoWhitelist } from "@/lib/browser-api";
import { SsoTokenDialog } from "./sso-token-dialog";
import { SsoUserPicker } from "./sso-user-picker";

export function SsoSettingsManager({
  initialSettings,
  users,
}: {
  initialSettings: SsoSettingsSnapshot;
  users: UserSummary[];
}) {
  const [settings, setSettings] = useState(initialSettings);
  const [accounts, setAccounts] = useState(initialSettings.accountWhitelist);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [secret, setSecret] = useState("");
  const [secretSaving, setSecretSaving] = useState(false);
  const [whitelistSaving, setWhitelistSaving] = useState(false);
  const [secretError, setSecretError] = useState<string | null>(null);
  const [whitelistError, setWhitelistError] = useState<string | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [secretSuccess, setSecretSuccess] = useState(false);
  const [whitelistSuccess, setWhitelistSuccess] = useState(false);
  const [tokenLoading, setTokenLoading] = useState(false);
  const [tokenResult, setTokenResult] = useState<{ userName: string; result: SsoTokenResponse } | null>(null);
  async function saveSecret() {
    setSecretSaving(true);
    setSecretError(null);
    setSecretSuccess(false);
    try {
      const result = await updateSsoSecret(secret);
      setSettings((current) => ({ ...current, secretConfigured: result.secretConfigured }));
      setSecret("");
      setSecretSuccess(true);
    } catch (nextError) {
      setSecretError(nextError instanceof Error ? nextError.message : "保存共享密钥失败");
    } finally {
      setSecretSaving(false);
    }
  }

  async function saveWhitelist(nextAccounts: string[]) {
    setWhitelistSaving(true);
    setWhitelistError(null);
    setWhitelistSuccess(false);
    try {
      const result = await updateSsoWhitelist(nextAccounts);
      setAccounts(result.accountWhitelist);
      setWhitelistSuccess(true);
    } catch (nextError) {
      const message = nextError instanceof Error ? nextError.message : "未知错误";
      setWhitelistError(`保存白名单失败，请刷新页面核对后重试：${message}`);
    } finally {
      setWhitelistSaving(false);
    }
  }

  async function getToken(user: UserSummary) {
    setTokenLoading(true);
    setTokenError(null);
    try {
      const result = await generateSsoToken(user.id);
      setTokenResult({ userName: user.name, result });
    } catch (nextError) {
      setTokenError(nextError instanceof Error ? nextError.message : "获取令牌失败");
    } finally {
      setTokenLoading(false);
    }
  }

  return (
    <div className="stack">
      <article className="panel panel-form">
        <div className="panel-header">
          <div className="panel-title">共享密钥</div>
        </div>
        <div className="stack">
          <div className={`flash ${settings.secretConfigured ? "flash-success" : "flash-error"}`}>
            {settings.secretConfigured
              ? "共享密钥已配置。出于安全原因，旧密钥不会显示；输入新密钥可轮换。"
              : "尚未配置共享密钥。请先在部署环境配置初始密钥，或在下方设置新密钥。"}
          </div>
          <label className="field">
            <span className="field-label">新共享密钥</span>
            <input
              className="field-input"
              type="password"
              autoComplete="new-password"
              maxLength={4096}
              disabled={secretSaving}
              value={secret}
              onChange={(event) => {
                setSecret(event.target.value);
                setSecretSuccess(false);
              }}
              placeholder="留空表示不修改当前密钥"
            />
          </label>
          {!settings.encryptionKeyConfigured ? (
            <div className="flash flash-error">
              管理界面设置密钥前，部署环境必须配置至少 32 字节的 OPSHELPER_SSO_ENCRYPTION_KEY。
            </div>
          ) : null}
          <div className="muted">
            管理界面保存的密钥会加密后存入数据库；加密密钥只保存在部署环境中，不能丢失或更换，否则无法解密已保存的密钥。
          </div>
          {secretError ? <div className="flash flash-error" role="alert">{secretError}</div> : null}
          {secretSuccess ? <div className="flash flash-success" role="status">共享密钥已保存</div> : null}
          <div className="inline-actions">
            <button
              className="button"
              type="button"
              disabled={secretSaving || whitelistSaving || tokenLoading || !secret || !settings.encryptionKeyConfigured}
              onClick={() => void saveSecret()}
            >
              {secretSaving ? "保存中…" : "保存密钥"}
            </button>
          </div>
        </div>
      </article>

      <article className="panel panel-form">
        <div className="panel-header">
          <div className="panel-title">账号白名单</div>
        </div>
        <div className="stack">
          <div className="muted">
            从现有用户中选择允许免密登录的账号，添加或移除后自动保存。对端账号必须与所选用户名匹配；已停用或不存在的账号无法登录。列表为空时将拒绝所有免密登录。
          </div>
          <div className="sso-list-header">
            <div className="field-label">允许登录的账号（{accounts.length}）</div>
            <button
              className="button-secondary"
              type="button"
              disabled={whitelistSaving || tokenLoading || Boolean(whitelistError)}
              onClick={() => setPickerOpen(true)}
            >
              添加用户
            </button>
          </div>
          <div className="agent-assignment-options" role="group" aria-label="免密登录白名单">
            {accounts.map((account) => {
              const user = users.find((entry) => entry.username === account);
              return (
                <div className="sso-user-row" key={account}>
                  <div className="sso-user-info">
                    <strong>{user?.name ?? account}</strong>
                    {!user ? <small>用户不存在</small> : !user.isActive ? <small>已停用</small> : null}
                  </div>
                  {user ? (
                    <button
                      className="button-secondary"
                      type="button"
                      disabled={secretSaving || whitelistSaving || tokenLoading}
                      aria-label={`获取 ${user.name} 的令牌`}
                      onClick={() => void getToken(user)}
                    >
                      获取令牌
                    </button>
                  ) : null}
                  <button
                    className="button-secondary"
                    type="button"
                    disabled={whitelistSaving || tokenLoading || Boolean(whitelistError)}
                    aria-label={`移除 ${user?.name ?? account}`}
                    onClick={() => void saveWhitelist(accounts.filter((entry) => entry !== account))}
                  >
                    移除
                  </button>
                </div>
              );
            })}
            {!accounts.length ? (
              <div className="muted">白名单为空，请点击“添加用户”。</div>
            ) : null}
          </div>
          {accounts.length > 500 ? (
            <div className="flash flash-error">白名单最多支持 500 个账号。</div>
          ) : null}
          {whitelistError ? <div className="flash flash-error" role="alert">{whitelistError}</div> : null}
          {tokenError ? <div className="flash flash-error" role="alert">{tokenError}</div> : null}
          {whitelistSaving ? <div className="muted" role="status">正在保存白名单…</div> : null}
          {whitelistSuccess ? <div className="flash flash-success" role="status">账号白名单已保存</div> : null}
        </div>
      </article>
      {pickerOpen ? (
        <SsoUserPicker
          users={users}
          existingAccounts={accounts}
          onAdd={(selected) => {
            setPickerOpen(false);
            void saveWhitelist([...new Set([...accounts, ...selected])]);
          }}
          onClose={() => setPickerOpen(false)}
        />
      ) : null}
      {tokenResult ? (
        <SsoTokenDialog
          userName={tokenResult.userName}
          result={tokenResult.result}
          onClose={() => setTokenResult(null)}
        />
      ) : null}
    </div>
  );
}

"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { UserPortalSnapshot } from "@opshelper/shared";

import { getUserPortalSnapshot, logout } from "@/lib/browser-api";
import { toast } from "@/lib/toast";
import { confirm as confirmDialog } from "./ui/dialog-host";
import { AdminAccountSettings } from "./admin-account-settings";
import { ContainerActions, startActionState, stopActionState } from "./container-actions";
import { IconClose, IconContainer, IconSliders } from "./chat/icons";
import { StatusPill } from "./status-pill";
import { ThemeToggle } from "./theme-toggle";
import { UserProfileName } from "./user-profile-name";

type ProfileUser = {
  name: string;
  username: string;
  role: string;
};

type ProfilePanel = "container" | "account";

export function UserProfileMenu({ user }: { user: ProfileUser }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [panel, setPanel] = useState<ProfilePanel | null>(null);
  const [snapshot, setSnapshot] = useState<UserPortalSnapshot | null>(null);
  const [containerLoading, setContainerLoading] = useState(false);
  const [containerError, setContainerError] = useState<string | null>(null);
  const [containerRefreshKey, setContainerRefreshKey] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const closeDialogRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const dialogTitleId = useId();

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setMenuOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    requestAnimationFrame(() => menuRef.current?.querySelector("button")?.focus());
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (panel !== "container") return;
    let cancelled = false;
    setSnapshot(null);
    setContainerError(null);
    setContainerLoading(true);
    void getUserPortalSnapshot()
      .then((result) => {
        if (!result) throw new Error("无法读取工作台容器信息，请重新登录后重试");
        if (!cancelled) setSnapshot(result);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setContainerError(error instanceof Error ? error.message : "读取工作台容器信息失败");
        }
      })
      .finally(() => {
        if (!cancelled) setContainerLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [containerRefreshKey, panel]);

  useEffect(() => {
    if (!panel) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    requestAnimationFrame(() => closeDialogRef.current?.focus());
    const focusable = () => Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]',
    ) ?? []);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setPanel(null);
      } else if (event.key === "Tab") {
        const elements = focusable();
        const first = elements[0];
        const last = elements[elements.length - 1];
        if (!first) {
          event.preventDefault();
          dialogRef.current?.focus();
        } else if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    const containFocus = (event: FocusEvent) => {
      if (document.querySelector(".ui-confirm-dialog, .ui-prompt-dialog")) return;
      if (!dialogRef.current?.contains(event.target as Node)) {
        (focusable()[0] ?? dialogRef.current)?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("focusin", containFocus);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("focusin", containFocus);
      if (previousFocus?.isConnected) previousFocus.focus();
      else triggerRef.current?.focus();
    };
  }, [panel]);

  const openPanel = (nextPanel: ProfilePanel) => {
    setMenuOpen(false);
    setPanel(nextPanel);
  };

  const requestLogout = async () => {
    setMenuOpen(false);
    const confirmed = await confirmDialog({
      title: "退出登录",
      description: "确定退出当前账号并返回登录页吗？",
      confirmLabel: "退出登录",
      variant: "danger",
    });
    if (!confirmed) return;
    try {
      await logout();
      window.location.href = "/gateway/login";
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "退出登录失败，请重试");
    }
  };

  const container = snapshot?.container;

  return (
    <div className="opshelper-user-profile" ref={rootRef}>
      <button
        ref={triggerRef}
        className="opshelper-userbar-link"
        type="button"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-controls={menuOpen ? menuId : undefined}
        title="用户菜单"
        onClick={() => setMenuOpen((open) => !open)}
      >
        <UserProfileName name={user.name} username={user.username} />
      </button>
      {menuOpen ? (
        <div className="opshelper-user-menu" id={menuId} role="menu" aria-label="用户菜单" ref={menuRef}>
          <button type="button" role="menuitem" onClick={() => openPanel("container")}>
            <IconContainer />
            <span>我的工作台容器</span>
          </button>
          <button type="button" role="menuitem" onClick={() => openPanel("account")}>
            <IconSliders />
            <span>账户信息</span>
          </button>
          <ThemeToggle />
          <button className="opshelper-user-menu-logout" type="button" role="menuitem" onClick={() => void requestLogout()}>
            <span>退出登录</span>
          </button>
        </div>
      ) : null}
      {panel && typeof document !== "undefined" ? createPortal(
        <div
          className="file-dialog-backdrop profile-dialog-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setPanel(null);
          }}
        >
          <section
            ref={dialogRef}
            className="file-dialog profile-settings-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby={dialogTitleId}
            tabIndex={-1}
          >
            <header className="profile-settings-dialog-header">
              <h2 id={dialogTitleId}>{panel === "container" ? "我的工作台容器" : "账户信息"}</h2>
              <button
                ref={closeDialogRef}
                className="profile-settings-dialog-close"
                type="button"
                aria-label="关闭"
                onClick={() => setPanel(null)}
              >
                <IconClose />
              </button>
            </header>
            {panel === "container" ? (
              containerLoading ? (
                <div className="muted" role="status">正在读取工作台容器信息…</div>
              ) : containerError ? (
                <div className="profile-settings-error" role="alert">
                  <span>{containerError}</span>
                  <button
                    className="button-secondary"
                    type="button"
                    onClick={() => setContainerRefreshKey((key) => key + 1)}
                  >
                    重试
                  </button>
                </div>
              ) : container ? (
                <div className="profile-container-content">
                  <div className="profile-container-status">
                    <span>容器状态</span>
                    <StatusPill status={container.status} />
                  </div>
                  <div className="field">
                    <span className="field-label">最近活动</span>
                    <div className="mono">{container.lastActivityAtLabel}</div>
                  </div>
                  <ContainerActions
                    actions={[
                      {
                        label: "启动",
                        path: "/v1/users/me/container/start",
                        ...startActionState(container.status),
                      },
                      {
                        label: "停止",
                        path: "/v1/users/me/container/stop",
                        confirm: "确定停止你的工作台容器吗？需先完成当前执行或处理恢复状态；文件与聊天记录会保留。",
                        ...stopActionState(container.status),
                      },
                      {
                        label: "重启",
                        path: "/v1/users/me/container/restart",
                        confirm: "确定重启你的工作台容器吗？需先完成当前执行或处理恢复状态；文件与聊天记录会保留。",
                      },
                    ]}
                    onActionComplete={() => setContainerRefreshKey((key) => key + 1)}
                  />
                </div>
              ) : (
                <div className="muted">
                  尚未创建容器。打开工作台聊天页时会自动为你创建并启动。
                </div>
              )
            ) : (
              <AdminAccountSettings username={user.username} showTitle={false} />
            )}
          </section>
        </div>,
        document.body,
      ) : null}
    </div>
  );
}

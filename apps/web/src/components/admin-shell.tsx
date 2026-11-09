"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
  type CSSProperties,
} from "react";

import {
  IconAgent,
  IconArrowLeft,
  IconContainer,
  IconClose,
  IconMenu,
  IconShield,
  IconSkill,
  IconUsers,
} from "./chat/icons";
import { UserProfileMenu } from "./user-profile-menu";

// 与 chat.css 里侧栏改为抽屉的断点保持一致。
const DRAWER_MEDIA_QUERY = "(max-width: 640px)";
const SIDEBAR_WIDTH = { min: 220, max: 420, fallback: 280 };
const SIDEBAR_WIDTH_KEY = "opshelper.sideWidth";

type AdminUser = {
  name: string;
  username: string;
  role: string;
};

type AdminNavItem = {
  href: string;
  label: string;
  description: string;
  icon: ReactNode;
};

// 管理控制台与工作台共用同一副外壳（.opshelper-shell / .opshelper-sidebar），
// 只有侧栏内容按区域替换；工作台返回入口放在侧栏底部。
// 账户设置不作为独立分区，从右下角用户名进入。
const ADMIN_NAV: AdminNavItem[] = [
  {
    href: "/admin/users",
    label: "用户管理",
    description: "账号、角色与容器保活",
    icon: <IconUsers />,
  },
  {
    href: "/admin/agents",
    label: "智能体与分配",
    description: "目录、分配与模型连接",
    icon: <IconAgent />,
  },
  {
    href: "/admin/containers",
    label: "容器管理",
    description: "状态、日志与生命周期",
    icon: <IconContainer />,
  },
  {
    href: "/admin/skill-repository",
    label: "技能仓库",
    description: "技能新增、删除与检索",
    icon: <IconSkill />,
  },
  {
    href: "/admin/sso",
    label: "免密登录",
    description: "共享密钥与账号白名单",
    icon: <IconShield />,
  },
];

interface AdminShellContextValue {
  showSidebar: boolean;
  openSidebar: () => void;
  closeSidebar: () => void;
  menuButtonRef: RefObject<HTMLButtonElement | null>;
}

const AdminShellContext = createContext<AdminShellContextValue | null>(null);

function useAdminShell() {
  const value = useContext(AdminShellContext);
  if (!value) throw new Error("useAdminShell must be used inside AdminShell");
  return value;
}

function isActivePath(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AdminShell({
  user,
  children,
}: Readonly<{
  user: AdminUser;
  children: ReactNode;
}>) {
  const pathname = usePathname();
  const [showSidebar, setShowSidebar] = useState(false);
  const [isDrawer, setIsDrawer] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_WIDTH.fallback);
  const sidebarRef = useRef<HTMLElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef(false);

  useEffect(() => {
    try {
      const savedWidth = localStorage.getItem(SIDEBAR_WIDTH_KEY);
      if (savedWidth) {
        const width = Number(savedWidth);
        setSidebarWidth(Number.isFinite(width)
          ? Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, Math.round(width)))
          : SIDEBAR_WIDTH.fallback);
      }
    } catch {
      // Match the workspace default when browser storage is unavailable.
    }
  }, []);

  // 抽屉只在窄屏成立：宽屏下侧栏常驻，不需要焦点管理。
  useEffect(() => {
    const media = window.matchMedia(DRAWER_MEDIA_QUERY);
    const sync = () => {
      setIsDrawer(media.matches);
      if (!media.matches) setShowSidebar(false);
    };
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    setShowSidebar(false);
  }, [pathname]);

  const closeSidebar = useCallback(() => {
    restoreFocusRef.current = true;
    setShowSidebar(false);
  }, []);

  // 抽屉打开时把焦点移进导航；关闭时在提交后把焦点交还顶栏触发按钮。
  useEffect(() => {
    if (!isDrawer) return;
    if (showSidebar) {
      sidebarRef.current
        ?.querySelector<HTMLElement>("a[href], button:not([disabled])")
        ?.focus();
      return;
    }
    if (restoreFocusRef.current) {
      restoreFocusRef.current = false;
      menuButtonRef.current?.focus();
    }
  }, [isDrawer, showSidebar]);

  useEffect(() => {
    if (!isDrawer || !showSidebar) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeSidebar();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeSidebar, isDrawer, showSidebar]);

  const contextValue = useMemo<AdminShellContextValue>(
    () => ({
      showSidebar,
      openSidebar: () => setShowSidebar(true),
      closeSidebar,
      menuButtonRef,
    }),
    [closeSidebar, showSidebar],
  );

  return (
    <AdminShellContext.Provider value={contextValue}>
      <div
        className={`opshelper-shell opshelper-console-shell${showSidebar ? " opshelper-sidebar-open" : ""}`}
        style={{ "--g-side-user": `${sidebarWidth}px` } as CSSProperties}
      >
        <aside
          ref={sidebarRef}
          className="opshelper-sidebar"
          id="opshelper-console-sidebar"
          aria-label="管理控制台导航"
          // 抽屉收起时侧栏仍在 DOM 里（位移到视口外），必须显式移出 Tab 顺序。
          inert={isDrawer && !showSidebar}
        >
          <div className="opshelper-brand">
            <span className="opshelper-brand-name">小信运维助手</span>
          </div>

          <nav className="opshelper-nav" aria-label="管理控制台">
            <div className="opshelper-console-group">
              <div className="opshelper-console-label">管理控制台</div>
              {ADMIN_NAV.map((item) => {
                const active = isActivePath(pathname, item.href);
                return (
                  <Link
                    key={item.href}
                    className={`opshelper-assistant${active ? " active-page" : ""}`}
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    onClick={() => setShowSidebar(false)}
                  >
                    <span className="opshelper-lib-icon">{item.icon}</span>
                    <span className="opshelper-assistant-text">
                      <span className="opshelper-assistant-name">{item.label}</span>
                      <span className="opshelper-assistant-desc">{item.description}</span>
                    </span>
                  </Link>
                );
              })}
            </div>

          </nav>

          <div className="opshelper-userbar">
            <UserProfileMenu user={user} />
            <Link
              className="opshelper-admin-return-link"
              href="/chat"
              aria-label="返回对话"
              title="返回对话"
              onClick={() => setShowSidebar(false)}
            >
              <IconArrowLeft />
            </Link>
          </div>
        </aside>

        <button
          className="opshelper-sidebar-scrim"
          type="button"
          aria-label="关闭导航"
          onClick={closeSidebar}
        />

        <main
          className="opshelper-main opshelper-workspace-main"
          ref={mainRef}
          // 抽屉展开时锁住主内容，Tab 只能在侧栏与遮罩之间移动。
          inert={isDrawer && showSidebar}
        >
          {children}
        </main>
      </div>
    </AdminShellContext.Provider>
  );
}

export function AdminMenuButton() {
  const { showSidebar, openSidebar, menuButtonRef } = useAdminShell();
  return (
    <button
      ref={menuButtonRef}
      className="opshelper-mobile-nav"
      type="button"
      aria-label="打开导航"
      aria-controls="opshelper-console-sidebar"
      aria-expanded={showSidebar}
      onClick={openSidebar}
    >
      <IconMenu />
    </button>
  );
}

// 页面统一结构：区域顶栏（图标 + 标题 + 说明）加一整块可滚动画布。
export function AdminPage({
  title,
  subtitle,
  icon,
  children,
}: Readonly<{
  title: string;
  subtitle: string;
  icon: ReactNode;
  children: ReactNode;
}>) {
  return (
    <>
      <header className="opshelper-topbar opshelper-page-topbar">
        <AdminMenuButton />
        <span className="opshelper-page-icon" aria-hidden="true">{icon}</span>
        <div className="opshelper-topbar-meta">
          <h1 className="opshelper-topbar-title">{title}</h1>
          <div className="opshelper-topbar-sub">{subtitle}</div>
        </div>
        <Link className="opshelper-admin-close" href="/chat" aria-label="返回对话" title="返回对话">
          <IconClose />
        </Link>
      </header>
      <div className="opshelper-page-body">
        {children}
      </div>
    </>
  );
}

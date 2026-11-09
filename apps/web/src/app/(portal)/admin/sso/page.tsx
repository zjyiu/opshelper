import { redirect } from "next/navigation";

import { AdminPage } from "@/components/admin-shell";
import { SsoSettingsManager } from "@/components/sso-settings-manager";
import { IconShield } from "@/components/chat/icons";
import { getAdminUsersSnapshot, getSsoSettings } from "@/lib/api";

export default async function AdminSsoPage() {
  const [settings, users] = await Promise.all([
    getSsoSettings(),
    getAdminUsersSnapshot(),
  ]);

  if (!settings || !users) {
    redirect("/login");
  }

  return (
    <AdminPage
      title="免密登录"
      subtitle="维护共享密钥与允许免密登录的 opshelper 账号"
      icon={<IconShield />}
    >
      <SsoSettingsManager initialSettings={settings} users={users.users} />
    </AdminPage>
  );
}

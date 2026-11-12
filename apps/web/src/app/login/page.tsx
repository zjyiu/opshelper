import { redirect } from "next/navigation";

import { BrandLogo } from "@/components/chat/icons";
import { LoginForm } from "@/components/login-form";
import { getSession } from "@/lib/api";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ ssoError?: string | string[] }>;
}) {
  const session = await getSession();

  if (session.authenticated && session.user) {
    redirect("/chat");
  }

  const params = await searchParams;
  const ssoError = params.ssoError === "failed" || params.ssoError === "unavailable"
    ? params.ssoError
    : undefined;

  return (
    <div className="shell shell-sidebar-hidden shell-headerless login-shell">
      <main className="main">
        <div className="content content-wide">
          <div className="login-wrapper login-wrapper-standalone">
            <div className="login-card">
              <article className="panel">
                <div className="login-header">
                  <BrandLogo size={88} className="login-brand-mark" />
                  <div className="panel-title">小信运维助手</div>
                </div>
                <LoginForm ssoError={ssoError} />
              </article>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

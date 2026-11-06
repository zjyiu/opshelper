import { redirect } from "next/navigation";

import { BrandLogo } from "@/components/chat/icons";
import { LoginForm } from "@/components/login-form";
import { getSession } from "@/lib/api";

export default async function LoginPage() {
  const session = await getSession();

  if (session.authenticated && session.user) {
    redirect("/chat");
  }


  return (
    <div className="shell shell-sidebar-hidden shell-headerless">
      <main className="main">
        <div className="content content-wide">
          <div className="login-wrapper login-wrapper-standalone">
            <div className="login-card">
              <article className="panel">
                <div className="login-header">
                  <BrandLogo size={88} className="login-brand-mark" />
                  <div className="panel-title">小信运维助手</div>
                </div>
                <LoginForm />
              </article>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

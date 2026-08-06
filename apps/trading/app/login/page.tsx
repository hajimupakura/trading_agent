import { ShieldCheck, Zap } from "lucide-react";
import { createAdminClient } from "@/lib/supabase/admin";
import { login, signup } from "./actions";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string; message?: string }> }) {
  const params = await searchParams;
  const { data } = await createAdminClient().auth.admin.listUsers({ page: 1, perPage: 1 });
  const ownerExists = Boolean(data?.users.length);
  return <main className="auth-shell">
    <section className="auth-card">
      <div className="auth-brand"><Zap size={18} fill="currentColor" /> VELOCITY</div>
      <p className="eyebrow">PRIVATE OPTIONS DESK</p>
      <h1>{ownerExists ? "Welcome back" : "Create the owner account"}</h1>
      <p className="auth-copy">Secure access to SPX and SPY research and Alpaca paper-trading approvals.</p>
      {params.error ? <div className="auth-alert error">{params.error}</div> : null}
      {params.message ? <div className="auth-alert">{params.message}</div> : null}
      <form className="auth-form">
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" autoComplete="email" required />
        <label htmlFor="password">Password</label>
        <input id="password" name="password" type="password" autoComplete={ownerExists ? "current-password" : "new-password"} minLength={ownerExists ? 6 : 12} required />
        {!ownerExists ? <><label htmlFor="setupCode">Owner setup code</label><input id="setupCode" name="setupCode" type="password" autoComplete="off" required /></> : null}
        <button formAction={ownerExists ? login : signup}>{ownerExists ? "Log in" : "Create private account"}</button>
      </form>
      <div className="auth-security"><ShieldCheck size={16}/><span>Only the first account can register. Use TRADING_OWNER_SETUP_CODE or your current CRON_SECRET once; it is never stored.</span></div>
    </section>
  </main>;
}

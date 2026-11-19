import { KeyRound, Zap } from "lucide-react";
import { updatePassword } from "@/app/login/actions";

// Reached from the emailed recovery link via /auth/confirm, which has already
// signed the browser in with a recovery session — updateUser just needs the
// new password. Opening this page cold (no session) fails in the action with
// a pointer back to the login page.
export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const params = await searchParams;
  return <main className="auth-shell">
    <section className="auth-card">
      <div className="auth-brand"><Zap size={18} fill="currentColor" /> VELOCITY</div>
      <p className="eyebrow">PRIVATE OPTIONS DESK</p>
      <h1>Set a new password</h1>
      <p className="auth-copy">You are signed in through the emailed reset link. Choose a new password for future logins.</p>
      {params.error ? <div className="auth-alert error">{params.error}</div> : null}
      <form className="auth-form">
        <label htmlFor="password">New password</label>
        <input id="password" name="password" type="password" autoComplete="new-password" minLength={12} required />
        <label htmlFor="confirm">Confirm new password</label>
        <input id="confirm" name="confirm" type="password" autoComplete="new-password" minLength={12} required />
        <button formAction={updatePassword}>Save and open the dashboard</button>
      </form>
      <div className="auth-security"><KeyRound size={16} /><span>At least 12 characters. The reset link is single-use; request a fresh one from the login page if this fails.</span></div>
    </section>
  </main>;
}

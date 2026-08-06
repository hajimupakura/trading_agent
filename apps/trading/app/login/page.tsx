import { login, signup } from "./actions";

export default async function LoginPage({ searchParams }: { searchParams:Promise<{ error?:string;message?:string }> }) {
  const { error, message } = await searchParams;
  return <main className="login"><section className="panel login-card"><h1>Options Command Center</h1><p className="muted">Private SPX/SPY paper-research workspace</p>{error ? <div className="alert error">{error}</div> : null}{message ? <div className="alert">{message}</div> : null}<form><label>Email<input className="field" type="email" name="email" autoComplete="email" required /></label><label>Password<input className="field" type="password" name="password" autoComplete="current-password" minLength={8} required /></label><div className="grid"><button className="button active full" formAction={login}>Sign in</button><button className="button full" formAction={signup}>Create account</button></div></form></section></main>;
}

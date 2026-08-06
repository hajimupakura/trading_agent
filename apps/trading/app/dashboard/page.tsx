import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { logout } from "@/app/login/actions";
import { CommandCenterView } from "./command-center";

export default async function DashboardPage() {
  const supabase = await createClient(); const { data } = await supabase.auth.getClaims();
  if (!data?.claims?.sub) redirect("/login");
  return <><header className="header"><div className="header-inner"><div><div className="brand">0–2 DTE Options Command Center</div><div className="subtitle">SPX / SPY · deterministic research · no live orders</div></div><form action={logout}><button className="button danger">Sign out</button></form></div></header><main className="shell"><CommandCenterView /></main></>;
}

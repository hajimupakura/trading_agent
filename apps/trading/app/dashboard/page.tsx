import { CommandCenterView } from "./command-center";
import { redirect } from "next/navigation";
import { getAuthenticatedUser } from "@/lib/supabase/auth";

export default async function DashboardPage() {
  const user = await getAuthenticatedUser();
  if (!user) redirect("/login");
  return <CommandCenterView userEmail={user.email} />;
}

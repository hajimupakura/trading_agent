import { redirect } from "next/navigation";
import { getAuthenticatedUser } from "@/lib/supabase/auth";
import { RobinhoodDesk } from "./robinhood-desk";

export const dynamic = "force-dynamic";

export default async function RobinhoodPage() {
  const user = await getAuthenticatedUser();
  if (!user) redirect("/login");
  return <RobinhoodDesk userEmail={user.email ?? null} />;
}

import "server-only";
import { createClient } from "./server";

export async function getAuthenticatedUser() {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getClaims();
  const claims = data?.claims;
  if (error || !claims?.sub) return null;
  return { id: String(claims.sub), email: typeof claims.email === "string" ? claims.email : null };
}

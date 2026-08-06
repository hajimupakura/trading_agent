"use server";
import { timingSafeEqual } from "node:crypto";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

function validSetupCode(value:string) {
  const expected = process.env.TRADING_OWNER_SETUP_CODE ?? process.env.CRON_SECRET;
  if (!expected) return false;
  const actualBuffer = Buffer.from(value); const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

export async function login(formData: FormData) {
  const supabase = await createClient();
  const email = String(formData.get("email") ?? ""); const password = String(formData.get("password") ?? "");
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) redirect(`/login?error=${encodeURIComponent(error.message)}`);
  redirect("/dashboard");
}
export async function signup(formData: FormData) {
  const admin = createAdminClient();
  const { data: users, error: ownerCheckError } = await admin.auth.admin.listUsers({ page: 1, perPage: 1 });
  if (ownerCheckError) redirect(`/login?error=${encodeURIComponent("Could not verify owner setup")}`);
  if (users.users.length > 0) redirect(`/login?error=${encodeURIComponent("Owner account already exists. Log in instead.")}`);
  if (!validSetupCode(String(formData.get("setupCode") ?? ""))) redirect(`/login?error=${encodeURIComponent("Invalid owner setup code")}`);
  const supabase = await createClient();
  const email = String(formData.get("email") ?? ""); const password = String(formData.get("password") ?? "");
  if (password.length < 12) redirect(`/login?error=${encodeURIComponent("Use a password of at least 12 characters")}`);
  const { error } = await supabase.auth.signUp({ email, password });
  if (error) redirect(`/login?error=${encodeURIComponent(error.message)}`);
  redirect("/login?message=Check%20your%20email%20to%20confirm%20the%20account");
}
export async function logout() { const supabase = await createClient(); await supabase.auth.signOut(); redirect("/login"); }

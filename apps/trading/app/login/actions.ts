"use server";
import { timingSafeEqual } from "node:crypto";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
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

// PASSWORD RESET (2026-11-18): the desk launched with no recovery path — a lost
// password meant hand-editing auth.users. Flow: email a Supabase recovery link
// that lands on /auth/confirm (which exchanges the token for a session) and
// forwards to /reset-password, where updateUser sets the new password. The
// redirect URL must be allow-listed in Supabase Auth -> URL Configuration.
export async function requestPasswordReset(formData: FormData) {
  const email = String(formData.get("email") ?? "").trim();
  if (!email) redirect(`/login?error=${encodeURIComponent("Type your email above, then press the reset button")}`);
  // Reset-poisoning guard (security review): the emailed link's origin must come
  // from platform config, never request headers an attacker can spoof. The
  // Vercel-set production domain is canonical; headers are only a localhost
  // dev fallback. Supabase's redirect allowlist remains the server-side backstop.
  const productionDomain = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  const devHost = (await headers()).get("host") ?? "";
  const origin = productionDomain ? `https://${productionDomain}`
    : /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(devHost) ? `http://${devHost}` : null;
  if (!origin) redirect(`/login?error=${encodeURIComponent("Reset is not configured on this deployment")}`);
  const supabase = await createClient();
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${origin}/auth/confirm?next=/reset-password` });
  if (error) redirect(`/login?error=${encodeURIComponent(error.message)}`);
  redirect(`/login?message=${encodeURIComponent("Reset link sent — open the email, click the link, and set a new password.")}`);
}
export async function updatePassword(formData: FormData) {
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");
  if (password.length < 12) redirect(`/reset-password?error=${encodeURIComponent("Use a password of at least 12 characters")}`);
  if (password !== confirm) redirect(`/reset-password?error=${encodeURIComponent("The two passwords do not match")}`);
  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ password });
  if (error) redirect(`/reset-password?error=${encodeURIComponent(`${error.message} — request a fresh reset link from the login page`)}`);
  redirect("/dashboard");
}

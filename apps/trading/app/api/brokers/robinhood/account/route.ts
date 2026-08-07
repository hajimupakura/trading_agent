import { getAuthenticatedUser } from "@/lib/supabase/auth";
import { robinhoodConnectionStatus } from "@/lib/brokers/robinhood";
import { getRobinhoodAccounts, getRobinhoodOptionUpgradeUrl, getRobinhoodOverview } from "@/lib/brokers/robinhood-trading";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(request: Request) {
  const user = await getAuthenticatedUser();
  if (!user) return Response.json({ error:"Unauthorized" }, { status:401 });
  try {
    const status = await robinhoodConnectionStatus(user.id);
    if (!status.connected) return Response.json({ connected:false }, { status:200 });
    const accounts = await getRobinhoodAccounts(user.id);
    const requested = new URL(request.url).searchParams.get("account");
    const agentic = accounts.find((account:any) => account?.agentic_allowed === true);
    const accountNumber = requested ?? (agentic?.account_number ? String(agentic.account_number) : null);
    const optionLevel = String(agentic?.option_level ?? "");
    const optionsEnabled = optionLevel !== "" && optionLevel !== "option_level_0";
    const [overview, upgradeUrl] = await Promise.all([
      accountNumber ? getRobinhoodOverview(user.id, accountNumber) : Promise.resolve(null),
      accountNumber && !optionsEnabled ? getRobinhoodOptionUpgradeUrl(user.id, accountNumber) : Promise.resolve(null),
    ]);
    return Response.json({
      connected:true, accountNumber,
      nickname: agentic?.nickname ?? null, optionLevel, optionsEnabled, upgradeUrl,
      overview,
    }, { headers:{ "Cache-Control":"no-store" } });
  } catch (error) {
    return Response.json({ connected:true, error:error instanceof Error ? error.message : "Robinhood account unavailable" }, { status:502 });
  }
}

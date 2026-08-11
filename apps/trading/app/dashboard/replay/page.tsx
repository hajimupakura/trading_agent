import { redirect } from "next/navigation";
import { getAuthenticatedUser } from "@/lib/supabase/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { ReplayLabView, type ResearchStudy } from "./replay-lab";

export default async function ReplayPage(){
  const user=await getAuthenticatedUser();if(!user)redirect("/login");
  const { data } = await createAdminClient().from("research_studies").select("slug,title,verdict,verdict_tone,summary,sample,concluded_on").order("concluded_on",{ascending:false});
  return <ReplayLabView userEmail={user.email} studies={(data??[]) as ResearchStudy[]}/>;
}

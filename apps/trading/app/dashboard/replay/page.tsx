import { redirect } from "next/navigation";
import { getAuthenticatedUser } from "@/lib/supabase/auth";
import { ReplayLabView } from "./replay-lab";

export default async function ReplayPage(){const user=await getAuthenticatedUser();if(!user)redirect("/login");return <ReplayLabView userEmail={user.email}/>;}

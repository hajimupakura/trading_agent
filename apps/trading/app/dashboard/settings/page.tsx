import {redirect} from "next/navigation";
import {getAuthenticatedUser} from "@/lib/supabase/auth";
import {createClient} from "@/lib/supabase/server";
import {settingsFromRow} from "@/lib/settings/config";
import {SettingsView} from "./settings-view";

export default async function SettingsPage(){const user=await getAuthenticatedUser();if(!user)redirect("/login");const supabase=await createClient();const {data,error}=await supabase.from("user_settings").select("*").eq("user_id",user.id).single();if(error)throw new Error(`Risk settings: ${error.message}`);return <SettingsView userEmail={user.email} initial={settingsFromRow(data)}/>;}

import {getAuthenticatedUser} from "@/lib/supabase/auth";
import {beginRobinhoodOAuth} from "@/lib/brokers/robinhood";
export const dynamic="force-dynamic";
export async function GET(request:Request){const user=await getAuthenticatedUser();if(!user)return Response.json({error:"Unauthorized"},{status:401});try{const origin=new URL(request.url).origin;return Response.redirect(await beginRobinhoodOAuth({userId:user.id,origin}));}catch(error){return Response.json({error:error instanceof Error?error.message:"Could not connect Robinhood"},{status:502});}}

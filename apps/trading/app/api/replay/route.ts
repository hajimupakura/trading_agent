import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuthenticatedUser } from "@/lib/supabase/auth";
import { runHistoricalReplay } from "@/lib/replay/service";

export const maxDuration=60;
const schema=z.object({underlying:z.enum(["SPY","SPX"]),sessionDate:z.iso.date(),dte:z.number().int().min(0).max(2)});

export async function POST(request:Request){
  const user=await getAuthenticatedUser(); if(!user) return NextResponse.json({error:"Unauthorized"},{status:401});
  const parsed=schema.safeParse(await request.json().catch(()=>null)); if(!parsed.success) return NextResponse.json({error:"Choose a valid date, symbol, and 0–2 DTE expiration."},{status:400});
  const selected=new Date(`${parsed.data.sessionDate}T12:00:00Z`); const today=new Date(); today.setUTCHours(0,0,0,0);
  if(selected>=today) return NextResponse.json({error:"Replay dates must be completed sessions before today."},{status:400});
  if(selected.getUTCDay()===0||selected.getUTCDay()===6) return NextResponse.json({error:"Choose a weekday market session."},{status:400});
  try{return NextResponse.json(await runHistoricalReplay({ownerId:user.id,...parsed.data}));}
  catch(error){return NextResponse.json({error:error instanceof Error?error.message:"Historical replay failed"},{status:502});}
}

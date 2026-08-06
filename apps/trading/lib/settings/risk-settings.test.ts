import {describe,expect,it} from "vitest";
import {riskSettingsSchema,settingsFromRow} from "./config";
describe("risk settings",()=>{
  it("maps database numeric strings and defaults",()=>expect(settingsFromRow({max_option_ask:"7.50",allowed_dte:[0,1]})).toMatchObject({maxOptionAsk:7.5,allowedDte:[0,1],paperTradingEnabled:true}));
  it("rejects an inverted trading window",()=>expect(riskSettingsSchema.safeParse({...settingsFromRow(null),entryStartMinutes:900,entryEndMinutes:800}).success).toBe(false));
  it("requires at least one underlying and DTE",()=>expect(riskSettingsSchema.safeParse({...settingsFromRow(null),allowedDte:[]}).success).toBe(false));
});

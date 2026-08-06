import {afterEach,describe,expect,it} from "vitest";
import {decryptBrokerSecret,encryptBrokerSecret} from "./token-crypto";

const original=process.env.BROKER_TOKEN_ENCRYPTION_KEY;
afterEach(()=>{if(original===undefined)delete process.env.BROKER_TOKEN_ENCRYPTION_KEY;else process.env.BROKER_TOKEN_ENCRYPTION_KEY=original;});
describe("broker credential encryption",()=>{
  it("round trips without storing plaintext",()=>{process.env.BROKER_TOKEN_ENCRYPTION_KEY=Buffer.alloc(32,7).toString("base64");const encrypted=encryptBrokerSecret("refresh-token-value");expect(encrypted).not.toContain("refresh-token-value");expect(decryptBrokerSecret(encrypted)).toBe("refresh-token-value");});
  it("rejects a key that is not 32 bytes",()=>{process.env.BROKER_TOKEN_ENCRYPTION_KEY=Buffer.from("short").toString("base64");expect(()=>encryptBrokerSecret("secret")).toThrow("exactly 32 bytes");});
  it("detects ciphertext tampering",()=>{process.env.BROKER_TOKEN_ENCRYPTION_KEY=Buffer.alloc(32,3).toString("base64");const encrypted=encryptBrokerSecret("secret");expect(()=>decryptBrokerSecret(`${encrypted.slice(0,-1)}A`)).toThrow();});
});

import "server-only";
import {createHash,randomBytes} from "node:crypto";
import {auth,type OAuthClientProvider} from "@modelcontextprotocol/sdk/client/auth.js";
import type {OAuthClientInformationMixed,OAuthTokens} from "@modelcontextprotocol/sdk/shared/auth.js";
import {createAdminClient} from "@/lib/supabase/admin";
import {decryptBrokerSecret,encryptBrokerSecret} from "@/lib/brokers/token-crypto";

const MCP_URL="https://agent.robinhood.com/mcp/trading";
const TOKEN_URL="https://api.robinhood.com/oauth2/token/";
const RESOURCE=MCP_URL;
const hash=(value:string)=>createHash("sha256").update(value).digest("base64url");
const random=()=>randomBytes(32).toString("base64url");

type TokenPayload={access_token:string;refresh_token?:string;expires_in?:number;token_type?:string};
type ConnectionRow={user_id:string;oauth_client_id:string;access_token_ciphertext:string;refresh_token_ciphertext:string|null;token_expires_at:string|null;status:string};

async function checkedJson<T>(response:Response,label:string):Promise<T>{const body=await response.json().catch(()=>null);if(!response.ok)throw new Error(`${label} failed (${response.status})${body?.error_description?`: ${body.error_description}`:body?.error?`: ${body.error}`:""}`);return body as T;}

function oauthProvider(input:{redirectUri:string;state?:string;clientInformation?:OAuthClientInformationMixed;codeVerifier?:string}){
  let clientInformation=input.clientInformation;
  let codeVerifier=input.codeVerifier;
  let authorizationUrl:URL|undefined;
  let tokens:OAuthTokens|undefined;
  const provider:OAuthClientProvider={
    redirectUrl:input.redirectUri,
    clientMetadata:{
      client_name:"Velocity Options Desk",
      client_uri:new URL(input.redirectUri).origin,
      redirect_uris:[input.redirectUri],
      grant_types:["authorization_code","refresh_token"],
      response_types:["code"],
      token_endpoint_auth_method:"none",
      scope:"internal"
    },
    state:()=>input.state??random(),
    clientInformation:()=>clientInformation,
    saveClientInformation:value=>{clientInformation=value;},
    tokens:()=>undefined,
    saveTokens:value=>{tokens=value;},
    redirectToAuthorization:url=>{authorizationUrl=url;},
    saveCodeVerifier:value=>{codeVerifier=value;},
    codeVerifier:()=>{if(!codeVerifier)throw new Error("Robinhood PKCE verifier is missing");return codeVerifier;}
  };
  return {provider,result:()=>({clientInformation,codeVerifier,authorizationUrl,tokens})};
}

export async function beginRobinhoodOAuth(input:{userId:string;origin:string}){
  const redirectUri=`${input.origin}/api/brokers/robinhood/callback`;
  const state=random();
  const flow=oauthProvider({redirectUri,state});
  const result=await auth(flow.provider,{serverUrl:MCP_URL,scope:"internal"});
  const oauth=flow.result();
  if(result!=="REDIRECT"||!oauth.authorizationUrl)throw new Error("Robinhood did not start an authorization redirect");
  if(!oauth.clientInformation?.client_id)throw new Error("Robinhood registration did not return a client ID");
  if(!oauth.codeVerifier)throw new Error("Robinhood did not create a PKCE verifier");
  const admin=createAdminClient();
  await admin.from("broker_oauth_states").delete().eq("user_id",input.userId).eq("broker","robinhood");
  const {error}=await admin.from("broker_oauth_states").insert({state_hash:hash(state),user_id:input.userId,broker:"robinhood",oauth_client_id:oauth.clientInformation.client_id,code_verifier_ciphertext:encryptBrokerSecret(oauth.codeVerifier),redirect_uri:redirectUri,expires_at:new Date(Date.now()+10*60_000).toISOString()});if(error)throw error;
  return oauth.authorizationUrl.toString();
}
export async function completeRobinhoodOAuth(input:{state:string;code:string}){const admin=createAdminClient();const {data:pending,error}=await admin.from("broker_oauth_states").select("user_id,oauth_client_id,code_verifier_ciphertext,redirect_uri,expires_at").eq("state_hash",hash(input.state)).eq("broker","robinhood").maybeSingle();if(error)throw error;if(!pending||Date.parse(pending.expires_at)<Date.now())throw new Error("Robinhood authorization request expired or is invalid");
  const flow=oauthProvider({redirectUri:pending.redirect_uri,clientInformation:{client_id:pending.oauth_client_id},codeVerifier:decryptBrokerSecret(pending.code_verifier_ciphertext)});
  const result=await auth(flow.provider,{serverUrl:MCP_URL,authorizationCode:input.code,scope:"internal"});
  const token=flow.result().tokens;
  if(result!=="AUTHORIZED"||!token?.access_token)throw new Error("Robinhood did not return an access token");
  const {error:upsertError}=await admin.from("broker_connections").upsert({user_id:pending.user_id,broker:"robinhood",status:"connected",oauth_client_id:pending.oauth_client_id,access_token_ciphertext:encryptBrokerSecret(token.access_token),refresh_token_ciphertext:token.refresh_token?encryptBrokerSecret(token.refresh_token):null,token_expires_at:token.expires_in?new Date(Date.now()+token.expires_in*1000).toISOString():null,last_error:null,updated_at:new Date().toISOString()},{onConflict:"user_id,broker"});if(upsertError)throw upsertError;await admin.from("broker_oauth_states").delete().eq("state_hash",hash(input.state));return pending.user_id as string;}

async function connection(userId:string){const {data,error}=await createAdminClient().from("broker_connections").select("user_id,oauth_client_id,access_token_ciphertext,refresh_token_ciphertext,token_expires_at,status").eq("user_id",userId).eq("broker","robinhood").maybeSingle();if(error)throw error;return data as ConnectionRow|null;}
async function refresh(row:ConnectionRow){if(!row.refresh_token_ciphertext)throw new Error("Robinhood authorization expired; reconnect the account");const form=new URLSearchParams({grant_type:"refresh_token",refresh_token:decryptBrokerSecret(row.refresh_token_ciphertext),client_id:row.oauth_client_id,resource:RESOURCE});const token=await checkedJson<TokenPayload>(await fetch(TOKEN_URL,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:form,signal:AbortSignal.timeout(12_000)}),"Robinhood token refresh");const access=encryptBrokerSecret(token.access_token);const refreshToken=token.refresh_token?encryptBrokerSecret(token.refresh_token):row.refresh_token_ciphertext;const expires=token.expires_in?new Date(Date.now()+token.expires_in*1000).toISOString():null;const {error}=await createAdminClient().from("broker_connections").update({access_token_ciphertext:access,refresh_token_ciphertext:refreshToken,token_expires_at:expires,status:"connected",last_error:null,updated_at:new Date().toISOString()}).eq("user_id",row.user_id).eq("broker","robinhood");if(error)throw error;return token.access_token;}
async function accessToken(userId:string){const row=await connection(userId);if(!row||row.status!=="connected")throw new Error("Robinhood is not connected");if(row.token_expires_at&&Date.parse(row.token_expires_at)<=Date.now()+60_000)return refresh(row);return decryptBrokerSecret(row.access_token_ciphertext);}

function parseMcp(text:string){if(!text.trim())return null;if(text.trim().startsWith("{"))return JSON.parse(text);const data=text.split(/\r?\n/).filter(line=>line.startsWith("data:")).map(line=>line.slice(5).trim()).filter(Boolean).at(-1);return data?JSON.parse(data):null;}
async function rpc(token:string,body:unknown,sessionId?:string){const response=await fetch(MCP_URL,{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json",Accept:"application/json, text/event-stream",...(sessionId?{"Mcp-Session-Id":sessionId}:{})},body:JSON.stringify(body),signal:AbortSignal.timeout(15_000)});const text=await response.text();if(!response.ok)throw new Error(`Robinhood MCP failed (${response.status})`);const payload=parseMcp(text);if(payload?.error)throw new Error(payload.error.message??"Robinhood MCP error");return {payload,sessionId:response.headers.get("mcp-session-id")??sessionId};}
export async function listRobinhoodTools(userId:string){const token=await accessToken(userId);const initialized=await rpc(token,{jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2025-06-18",capabilities:{},clientInfo:{name:"velocity-options-desk",version:"1.0.0"}}});await rpc(token,{jsonrpc:"2.0",method:"notifications/initialized"},initialized.sessionId);const listed=await rpc(token,{jsonrpc:"2.0",id:2,method:"tools/list",params:{}},initialized.sessionId);const tools=(listed.payload?.result?.tools??[]) as Array<{name:string;description?:string;inputSchema?:Record<string,unknown>}>;const {error}=await createAdminClient().from("broker_connections").update({capabilities:{tools:tools.map(tool=>({name:tool.name,description:tool.description??null,inputSchema:tool.inputSchema??{}})),discoveredAt:new Date().toISOString()},last_error:null,updated_at:new Date().toISOString()}).eq("user_id",userId).eq("broker","robinhood");if(error)throw error;return tools;}
export async function robinhoodConnectionStatus(userId:string){const row=await connection(userId);if(!row)return {connected:false as const};return {connected:row.status==="connected",status:row.status,expiresAt:row.token_expires_at};}
export async function disconnectRobinhood(userId:string){const {error}=await createAdminClient().from("broker_connections").delete().eq("user_id",userId).eq("broker","robinhood");if(error)throw error;}

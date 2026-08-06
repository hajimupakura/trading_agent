import { createServer } from "node:http";
import { config } from "./config.js";
import { PositionManager } from "./manager.js";

const manager = new PositionManager(); manager.start();
const server = createServer((request,response) => {
  if (request.url !== "/health") { response.writeHead(404).end("Not found"); return; }
  const age = manager.lastCycleAt == null ? Infinity : Date.now()-manager.lastCycleAt;
  const healthy = age < Math.max(30_000,config.POSITION_POLL_INTERVAL_MS*4) && !manager.lastError;
  response.writeHead(healthy?200:503,{"Content-Type":"application/json"}); response.end(JSON.stringify({healthy,mode:"paper",autoExitsConfigured:config.exitsEnabled,managedPositions:manager.managedCount,lastCycleAt:manager.lastCycleAt == null?null:new Date(manager.lastCycleAt).toISOString(),error:manager.lastError}));
});
server.listen(config.PORT,()=>console.log(JSON.stringify({event:"worker_started",port:config.PORT,mode:"paper",autoExitsConfigured:config.exitsEnabled})));
const shutdown = () => { manager.stop(); server.close(()=>process.exit(0)); setTimeout(()=>process.exit(1),5000).unref(); };
process.on("SIGTERM",shutdown); process.on("SIGINT",shutdown);

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.ts';
import { Store } from './store.ts';
import { Runner } from './runner.ts';
import { startMcpServer } from './mcp.ts';
import { startApi } from './api.ts';
import { Devices } from './devices.ts';
import { startRemote } from './remote.ts';

mkdirSync(config.dataDir, { recursive: true });
const store = new Store(join(config.dataDir, 'pagent.db'));
const runner = new Runner(store);
const devices = new Devices(store);

runner.recover();
const mcp = startMcpServer(store, runner, config.mcpPort);
const api = startApi(store, runner, devices, config.sock);
const remote = startRemote(store, runner, devices, config.webDir, config.remotePort);

let stopping = false;
function shutdown(sig: string) {
  if (stopping) return;
  stopping = true;
  const active = runner.activeRuns();
  console.log(`${sig}：中断 ${active.length} 个进行中的 run 后退出`);
  for (const id of active) runner.interrupt(id);
  api.close();
  remote.close();
  mcp.close();
  setTimeout(() => process.exit(0), active.length ? 3000 : 0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.ts';
import { Store } from './store.ts';
import { Approvals } from './approvals.ts';
import { Runner } from './runner.ts';
import { startHookServer } from './hooks.ts';
import { startApi } from './api.ts';

mkdirSync(config.dataDir, { recursive: true });
const store = new Store(join(config.dataDir, 'pagent.db'));
const approvals = new Approvals(store, config.approvalTtlSec);
const runner = new Runner(store, approvals);

runner.recover();
const hookServer = startHookServer(store, approvals, config.hookPort);
const api = startApi(store, runner, approvals, config.sock);

let stopping = false;
function shutdown(sig: string) {
  if (stopping) return;
  stopping = true;
  const active = runner.activeRuns();
  console.log(`${sig}：中断 ${active.length} 个进行中的 run 后退出`);
  for (const id of active) runner.interrupt(id);
  api.close();
  hookServer.close();
  setTimeout(() => process.exit(0), active.length ? 3000 : 0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

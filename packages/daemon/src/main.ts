import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.ts';
import { Store } from './store.ts';
import { Runner } from './runner.ts';
import { startMcpServer } from './mcp.ts';
import { startApi } from './api.ts';
import { Devices } from './devices.ts';
import { startRemote } from './remote.ts';
import { BoxLink } from './box.ts';
import { writeUpstreams } from './settings.ts';
import { startScheduler } from './routines.ts';
import { pushFor } from './push.ts';
import { bus } from './store.ts';
import { LocalExec } from './localexec.ts';
import { afterRunCollab, sweepAssignments } from './collab.ts';

mkdirSync(config.dataDir, { recursive: true });
const store = new Store(join(config.dataDir, 'pagent.db'));
const runner = new Runner(store);
const devices = new Devices(store);
writeUpstreams(store);

const link = new BoxLink(store, (ev) => runner.onBoxEvent(ev), (boot) => runner.onBoxBoot(boot));
// 先对账（盒子里还在跑的轮次重新挂上），再开始续传盒子的事件
runner.recover().catch((e) => console.error('recover failed', e)).finally(() => link.start());
const localExec = new LocalExec(store);
const mcp = startMcpServer(store, { requestNewSession: (id, r) => runner.requestNewSession(id, r), localExec, runner }, config.mcpPort);
runner.hooks.afterRun = (ref, bot, status, text, metas) => afterRunCollab(store, runner, bot, ref.runId, status, text, metas);
const collabSweep = setInterval(() => { try { sweepAssignments(store, runner); } catch (e) { console.error('collab sweep', e); } }, 60_000);
const scheduler = startScheduler(store, runner);
bus.on('event', (e) => pushFor(store, e));
const api = startApi(store, runner, devices, config.sock);
const remote = startRemote(store, runner, devices, config.webDir, config.remotePort, localExec);

let stopping = false;
function shutdown(sig: string) {
  if (stopping) return;
  stopping = true;
  // 不中断进行中的轮次：它们在盒子里接着跑，pagentd 回来后按游标补齐事件
  console.log(`${sig}：退出（${runner.activeRuns().length} 个轮次留在盒子里继续）`);
  link.stop();
  clearInterval(scheduler);
  clearInterval(collabSweep);
  api.close();
  remote.close();
  mcp.close();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

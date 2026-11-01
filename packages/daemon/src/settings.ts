// 整个 PersonAgent 的设置（不属于某个 Agent 的）：出口线路等。存在 kv 表里。
import { renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.ts';
import type { Store } from './store.ts';
import { BOX_NAME } from './box.ts';
import { ServiceError } from './service.ts';

/** egress 读的上游代理表：开了"走家里线路"时盒子的公网流量经 PAGENT_HOME_PROXY 出去 */
export function writeUpstreams(store: Store): void {
  const on = store.getKv('egress.viaHome') === '1' && !!config.homeProxy;
  const f = join(config.dataDir, 'egress-upstreams.json');
  writeFileSync(`${f}.tmp`, JSON.stringify(on ? { [BOX_NAME]: config.homeProxy } : {}), { mode: 0o600 });
  renameSync(`${f}.tmp`, f);
}

export function getSettings(store: Store) {
  return {
    egress: { viaHome: store.getKv('egress.viaHome') === '1', homeAvailable: !!config.homeProxy },
  };
}

export function patchSettings(store: Store, patch: any) {
  if (patch?.egress && 'viaHome' in patch.egress) {
    if (patch.egress.viaHome && !config.homeProxy) throw new ServiceError(400, '服务器上没有配置家里线路（PAGENT_HOME_PROXY）');
    store.setKv('egress.viaHome', patch.egress.viaHome ? '1' : '0');
    writeUpstreams(store);
  }
  return getSettings(store);
}

// pagentd 配置全部来自环境变量（见 deploy/compose.yaml）。
// 路径都是宿主路径：pagentd 通过 docker.sock 创建 worker，挂载用的是宿主上的路径，所以 pagentd 容器内同路径挂载。
const env = (k: string, d?: string): string => {
  const v = process.env[k] ?? d;
  if (v === undefined || v === '') throw new Error(`缺少环境变量 ${k}`);
  return v;
};

export const config = {
  dataDir: env('PAGENT_DATA'),
  sock: env('PAGENT_SOCK'),
  assetsDir: env('PAGENT_ASSETS'),
  egressRulesFile: env('PAGENT_EGRESS_RULES'),
  hookHost: env('PAGENT_HOOK_HOST', 'pagentd'),
  hookPort: Number(env('PAGENT_HOOK_PORT', '7701')),
  workerImage: env('PAGENT_WORKER_IMAGE', 'pagent-worker'),
  workerUser: env('PAGENT_WORKER_USER', '10001:10001'),
  workerMemory: env('PAGENT_WORKER_MEMORY', '1500m'),
  workerAllow: env('PAGENT_WORKER_ALLOW', 'api.anthropic.com:443').split(','),
  hostCred: process.env.PAGENT_HOST_CRED || null,
  sandboxNet: env('PAGENT_SANDBOX_NET', 'pagent_sandbox'),
  approvalTtlSec: Number(env('PAGENT_APPROVAL_TTL', '540')),
};

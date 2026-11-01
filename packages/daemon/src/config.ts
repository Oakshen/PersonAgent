// pagentd 配置全部来自环境变量（见 deploy/compose.yaml）。
// 路径都是宿主路径：pagentd 通过 docker.sock 创建盒子，挂载用的是宿主上的路径，所以 pagentd 容器内同路径挂载。
const env = (k: string, d?: string): string => {
  const v = process.env[k] ?? d;
  if (v === undefined || v === '') throw new Error(`缺少环境变量 ${k}`);
  return v;
};

export const config = {
  dataDir: env('PAGENT_DATA'),
  sock: env('PAGENT_SOCK'),
  // 盒子里网关的源码目录（只读挂进盒子）
  hostSrc: env('PAGENT_HOST_SRC'),
  egressRulesFile: env('PAGENT_EGRESS_RULES'),
  // 盒子经沙箱网络访问 pagentd 提供的 MCP（remember / ask_user / new_session）
  mcpHost: env('PAGENT_MCP_HOST', 'pagentd'),
  mcpPort: Number(env('PAGENT_MCP_PORT', '7701')),
  boxImage: env('PAGENT_BOX_IMAGE', 'pagent-box'),
  boxMemory: env('PAGENT_BOX_MEMORY', '2500m'),
  boxCpus: env('PAGENT_BOX_CPUS', '2'),
  // 盒子出网：默认放行公网（局域网和元数据地址由 egress 代理挡住）
  boxAllow: env('PAGENT_BOX_ALLOW', '*').split(','),
  hostCred: process.env.PAGENT_HOST_CRED || null,
  // 可选：家里住宅线路的 HTTP 代理（带认证），设置里打开"走家里线路"后盒子的公网流量经它出去
  homeProxy: process.env.PAGENT_HOME_PROXY || null,
  sandboxNet: env('PAGENT_SANDBOX_NET', 'pagent_sandbox'),
  remotePort: Number(env('PAGENT_REMOTE_PORT', '7780')),
  webDir: env('PAGENT_WEB_DIR'),
};

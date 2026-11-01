import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error 纯 JS 模块，没有类型声明
import { _test, decide, isPrivate } from '../proxy.mjs';

test('私有地址判断', () => {
  for (const ip of ['10.1.2.3', '192.168.0.1', '172.20.0.5', '127.0.0.1', '169.254.169.254', '100.100.1.1', '0.0.0.0',
    '::1', 'fd00::1', 'fe80::1', '::ffff:192.168.0.22']) assert.equal(isPrivate(ip), true, ip);
  // 198.18.0.0/15 是 fake-ip，不算私有（另由 DoH 复查）
  for (const ip of ['1.1.1.1', '104.18.0.1', '172.32.0.1', '198.18.4.6', '2606:4700::1111', '::ffff:8.8.8.8']) assert.equal(isPrivate(ip), false, ip);
});

const fakeDns = (table: Record<string, string[]>) => async (host: string) => {
  if (!table[host]) throw new Error('ENOTFOUND');
  return table[host].map((address) => ({ address }));
};

test('worker 规则 "*"：公网放行，解析到内网的域名和内网 IP 都拒绝', async () => {
  _test.setRules({ 'pagent-bot-a': ['*'], 'pagent-plg-x': ['api.github.com:443', 'nas.lan:5000'] },
    new Map([['172.18.0.5', 'pagent-bot-a'], ['172.18.0.6', 'pagent-plg-x']]));
  const lookup = fakeDns({
    'example.com': ['93.184.216.34'], 'evil.rebind': ['192.168.0.1'], 'mixed.test': ['8.8.8.8', '10.0.0.1'],
    'api.github.com': ['140.82.112.6'], 'nas.lan': ['192.168.0.197'],
  });
  assert.equal(await decide('172.18.0.5', 'example.com', 443, lookup), '93.184.216.34');
  assert.equal(await decide('172.18.0.5', 'evil.rebind', 443, lookup), null);
  assert.equal(await decide('172.18.0.5', 'mixed.test', 443, lookup), null);
  assert.equal(await decide('172.18.0.5', '192.168.0.1', 80, lookup), null);
  assert.equal(await decide('172.18.0.5', '169.254.169.254', 80, lookup), null);
  assert.equal(await decide('172.18.0.5', 'nope.invalid', 443, lookup), null);
  // 插件：只能去声明过的目标；逐字声明的内网目标可以去
  assert.equal(await decide('172.18.0.6', 'api.github.com', 443, lookup), '140.82.112.6');
  assert.equal(await decide('172.18.0.6', 'example.com', 443, lookup), null);
  assert.equal(await decide('172.18.0.6', 'nas.lan', 5000, lookup), '192.168.0.197');
  // 不认识的来源一律拒绝
  assert.equal(await decide('172.18.0.99', 'example.com', 443, lookup), null);
});

test('fake-ip 网络：假地址放行，但 DoH 查到真实地址是内网的拒绝', async () => {
  _test.setRules({ 'pagent-bot-a': ['*'] }, new Map([['172.18.0.5', 'pagent-bot-a']]));
  const lookup = fakeDns({ 'api.anthropic.com': ['198.18.4.6'], '192.168.0.1.nip.io': ['198.18.9.9'], 'down.test': ['198.18.7.7'] });
  const real = async (h: string) => ({ 'api.anthropic.com': ['160.79.104.10'], '192.168.0.1.nip.io': ['192.168.0.1'] } as Record<string, string[]>)[h] ?? null;
  assert.equal(await decide('172.18.0.5', 'api.anthropic.com', 443, lookup, real), '198.18.4.6');
  assert.equal(await decide('172.18.0.5', '192.168.0.1.nip.io', 80, lookup, real), null);
  // DoH 查不到时放行（路由器那头照常代连）
  assert.equal(await decide('172.18.0.5', 'down.test', 443, lookup, real), '198.18.7.7');
});

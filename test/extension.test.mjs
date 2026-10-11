import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { access, readFile } from 'node:fs/promises';
import vm from 'node:vm';

const extensionRoot = path.resolve('extension');

test('a manually stopped extension stays stopped across reopen and wakes only after explicit start', async () => {
  const endpoint = 'http://127.0.0.1:43127';
  const stored = { endpoint, token: 'test-token', stoppedEndpoint: endpoint };
  const nodes = new Map();
  function node(selector) {
    if (!nodes.has(selector)) nodes.set(selector, {
      value: '', hidden: false, disabled: false, dataset: {}, style: {}, handlers: new Map(),
      classList: { add() {}, remove() {}, toggle() {} },
      setAttribute() {}, replaceChildren() {}, append() {}, focus() {}, querySelectorAll: () => [],
      addEventListener(name, handler) { this.handlers.set(name, handler); }
    });
    return nodes.get(selector);
  }
  let requests = 0;
  let wakes = 0;
  const onlineState = { paused: false, running: false, stopping: false, browser: {}, tasks: [], forums: [] };
  const context = vm.createContext({
    URL, URLSearchParams, AbortController, TextDecoder, console,
    location: { search: '' }, lucide: { createIcons() {} }, setTimeout: () => 0, clearTimeout() {},
    document: { querySelector: node, querySelectorAll: () => [], createElement: () => node(Symbol()) },
    chrome: { storage: { local: { get: async () => ({ ...stored }), set: async values => Object.assign(stored, values) } },
      tabs: { query: async () => [], onActivated: { addListener() {} }, onUpdated: { addListener() {} } },
      runtime: { sendMessage: async () => { wakes += 1; return { ok: true }; } } },
    fetch: async url => {
      requests += 1;
      if (url.endsWith('/api/events')) return new Response('', { status: 401 });
      if (wakes === 0) throw new TypeError('service offline');
      return Response.json(onlineState);
    }
  });
  vm.runInContext(await readFile(path.join(extensionRoot, 'sidepanel.js'), 'utf8'), context);
  await new Promise(setImmediate);
  assert.equal(nodes.get('#connection-label').textContent, '服务已停止');
  assert.equal(requests, 0);
  await vm.runInContext('connectEvents()', context);
  await assert.rejects(vm.runInContext("api('/api/state')", context), /服务已停止/);
  assert.equal(wakes, 0);
  // 另一个已打开的面板尚未刷新内存状态，也必须遵守共享的停止标记。
  vm.runInContext('serviceStopped = false', context);
  await assert.rejects(vm.runInContext("api('/api/state')", context), /服务已停止/);
  assert.equal(wakes, 0);
  await nodes.get('#service-toggle').handlers.get('click')();
  await new Promise(setImmediate);
  assert.equal(stored.stoppedEndpoint, '');
  assert.equal(wakes, 1);
  assert.ok(requests >= 2);
});

test('Chrome extension manifest uses local assets and restricted host permissions', async () => {
  const manifest = JSON.parse(await readFile(path.join(extensionRoot, 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.side_panel.default_path, 'sidepanel.html');
  assert.deepEqual(manifest.permissions, ['activeTab', 'tabs', 'nativeMessaging', 'storage', 'sidePanel']);
  assert.ok(manifest.key);
  assert.equal(manifest.host_permissions.includes('<all_urls>'), false);
  assert.deepEqual(manifest.host_permissions, ['http://127.0.0.1/*', 'http://localhost/*']);
  assert.match(manifest.content_security_policy.extension_pages, /script-src 'self'/);
  await access(path.join(extensionRoot, 'vendor', 'lucide.min.js'));

  const html = await readFile(path.join(extensionRoot, 'sidepanel.html'), 'utf8');
  assert.doesNotMatch(html, /<script[^>]+src=["']https?:/i);
  assert.doesNotMatch(html, /<script(?:\s[^>]*)?>\s*[^<]/i);
  assert.match(html, /<dialog id="confirm-dialog"/);
  assert.match(html, /id="headless-toggle"/);

  const script = await readFile(path.join(extensionRoot, 'sidepanel.js'), 'utf8');
  assert.match(script, /trash-2/);
  assert.match(script, /circle-x/);
  assert.match(script, /method: 'DELETE'/);
  assert.match(script, /\/cancel/);
  assert.match(script, /\/api\/settings\/browser/);
  assert.match(script, /supportedForum/);
  assert.match(script, /forum\.hosts/);
  assert.match(script, /ensure-local-service/);
  assert.match(script, /fetchWithServiceWake\('\/api\/events'/);

  const serviceWorker = await readFile(path.join(extensionRoot, 'service-worker.js'), 'utf8');
  assert.match(serviceWorker, /com\.resourcehub\.launcher/);
  assert.match(serviceWorker, /sendNativeMessage/);
});

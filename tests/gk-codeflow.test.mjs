import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createCodeflowServer } from '../cli/codeflow.mjs';
import { detectGkRoot } from '../cli/gk-manifest.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const uiRoot = join(__dirname, '..');
const gkRoot = detectGkRoot(join(__dirname, '..', '..', '..'));

function listen(server) {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', resolve);
    server.once('error', reject);
  });
}

function rawRequest(port, path, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function startGkServer(t, options) {
  const settings = { uiRoot, watchRoot: gkRoot, gkRoot, ...options };
  const { server, close } = createCodeflowServer(settings);
  t.after(() => close());
  await listen(server);
  const { port } = server.address();
  return { port, base: 'http://127.0.0.1:' + port };
}

test('GK manifest route serves the live architecture map and dependency inventory', async (t) => {
  assert.ok(gkRoot, 'expected to run inside a GK checkout');
  const { base } = await startGkServer(t);

  const res = await fetch(base + '/__codeflow/gk-manifest');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');

  const manifest = await res.json();
  assert.equal(manifest.ok, true);
  assert.ok(manifest.eventArchitecture.planes.length >= 5, 'planes: ' + manifest.eventArchitecture.planes.length);
  assert.ok(manifest.eventArchitecture.nodes.length >= 12, 'nodes: ' + manifest.eventArchitecture.nodes.length);
  assert.ok(manifest.eventArchitecture.mermaidSource.includes('graph'), 'mermaid source is present');
  assert.ok(manifest.targets.length >= 10, 'targets: ' + manifest.targets.length);
  assert.ok(manifest.dependencies.pinnedRepos.length >= 8, 'pinned repos: ' + manifest.dependencies.pinnedRepos.length);
  for (const target of manifest.targets) {
    assert.ok(target.id && target.title && target.category, 'target ' + target.id + ' is described');
  }
});

test('GK bundle route returns single-request walkthrough bundles', async (t) => {
  const { base } = await startGkServer(t);

  for (const targetId of ['gk-system', 'dep-codeflow']) {
    const res = await fetch(base + '/__codeflow/gk-bundle?target=' + encodeURIComponent(targetId));
    assert.equal(res.status, 200, 'bundle ' + targetId);
    assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive');
    const bundle = await res.json();
    assert.equal(bundle.ok, true);
    assert.equal(bundle.target, targetId);
    assert.ok(bundle.files.length > 0, 'bundle ' + targetId + ' carries files');
    assert.equal(bundle.fileCount, bundle.files.length);
    for (const file of bundle.files) {
      assert.ok(file.path && !file.path.startsWith('/'), 'relative path: ' + file.path);
      assert.ok(typeof file.content === 'string');
      assert.ok(file.rev !== undefined && file.rev !== null, 'rev present: ' + file.path);
    }
  }
});

test('GK bundle route refuses a path-traversal target', async (t) => {
  const { base } = await startGkServer(t);

  const res = await fetch(base + '/__codeflow/gk-bundle?target=..%2F..%2Fetc%2Fpasswd');
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.error, 'Unknown target');

  const unknown = await fetch(base + '/__codeflow/gk-bundle?target=not-a-target');
  assert.equal(unknown.status, 404);
  assert.doesNotMatch(await unknown.text(), /passwd|root:/);
});

test('GK routes 404 when no GK root is present', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'codeflow-nogk-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'app.js'), 'export const ok = 1;\n');
  const { base } = await startGkServer(t, { watchRoot: root, gkRoot: null });

  const manifest = await fetch(base + '/__codeflow/gk-manifest');
  assert.equal(manifest.status, 404);
  assert.deepEqual(await manifest.json(), { ok: false, error: 'GK root not detected' });

  const bundle = await fetch(base + '/__codeflow/gk-bundle?target=gk-system');
  assert.equal(bundle.status, 404);

  const status = await (await fetch(base + '/__codeflow/status')).json();
  assert.equal(status.ok, true);
  assert.equal(status.gkMode, false);
  assert.equal(status.gkRoot, null);
  assert.equal(status.defaultTarget, 'gk-system');
});

test('status reports GK mode and the default walkthrough target', async (t) => {
  const { base } = await startGkServer(t, { watchRoot: gkRoot });

  const status = await (await fetch(base + '/__codeflow/status')).json();
  assert.equal(status.ok, true);
  assert.equal(status.gkMode, true);
  assert.equal(status.gkRoot, gkRoot);
  assert.equal(status.defaultTarget, 'gk-system');
  assert.equal(typeof status.watch, 'boolean');
});

test('GK manifest route rejects a rebound Host but accepts the tailnet site', async (t) => {
  const { port } = await startGkServer(t);

  const rebound = await rawRequest(port, '/__codeflow/gk-manifest', {
    Host: 'evil.example.com',
    Origin: 'http://evil.example.com'
  });
  assert.equal(rebound.status, 403);
  assert.equal(rebound.body, 'Forbidden');

  const reboundOrigin = await rawRequest(port, '/__codeflow/gk-manifest', {
    Host: '127.0.0.1:' + port,
    Origin: 'https://evil.example.com'
  });
  assert.equal(reboundOrigin.status, 403);

  const viaSite = await rawRequest(port, '/__codeflow/gk-manifest', {
    Host: 'codeflow.berkle.space',
    Origin: 'https://codeflow.berkle.space'
  });
  assert.equal(viaSite.status, 200);
  assert.equal(JSON.parse(viaSite.body).ok, true);

  const viaTailnetIp = await rawRequest(port, '/__codeflow/gk-manifest', { Host: '100.124.235.45:4179' });
  assert.equal(viaTailnetIp.status, 200);
});

test('GK manifest and bundle routes support ETag and 304 Not Modified', async (t) => {
  const { base } = await startGkServer(t);
  const first = await fetch(base + '/__codeflow/gk-manifest');
  assert.equal(first.status, 200);
  const etag = first.headers.get('etag');
  assert.ok(etag && etag.startsWith('W/"'), 'expected weak ETag');
  const second = await fetch(base + '/__codeflow/gk-manifest', {
    headers: { 'If-None-Match': etag }
  });
  assert.equal(second.status, 304);

  const b1 = await fetch(base + '/__codeflow/gk-bundle?target=dep-codeflow');
  assert.equal(b1.status, 200);
  const bEtag = b1.headers.get('etag');
  assert.ok(bEtag && bEtag.startsWith('W/"'));
  const b2 = await fetch(base + '/__codeflow/gk-bundle?target=dep-codeflow', {
    headers: { 'If-None-Match': bEtag }
  });
  assert.equal(b2.status, 304);
});

test('vendored highlight.min.js + byLine() and Tailnet GitHub API proxy work and reject disallowed paths', async (t) => {
  const html = await readFile(join(uiRoot, 'index.html'), 'utf8');
  assert.match(html, /<script src="\.\/vendor\/highlight\/highlight\.min\.js"><\/script>/);
  assert.match(html, /hljsObj\.highlight\(String\(code\),\{language:hljsLang,ignoreIllegals:true\}\)\.value/);
  assert.match(html, /function getFileTypeMeta\(filenameOrPath\)/);
  assert.match(html, /function renderFileTypeIcon\(filenameOrPath,size,className\)/);
  assert.match(html, /case 'lang-ts':/);
  assert.match(html, /case 'lang-py':/);
  assert.match(html, /case 'lang-rs':/);
  assert.match(html, /case 'lang-go':/);
  assert.match(html, /function byLine\(markup\)/);
  assert.doesNotMatch(html, /\.canvas-area:has\(\.gk-quickbar\)\s*\.viz-selector/);

  const { base } = await startGkServer(t);
  const statusRes = await fetch(base + '/__codeflow/status');
  const statusBody = await statusRes.json();
  assert.equal(typeof statusBody.githubAuth?.available, 'boolean');

  const badMethod = await fetch(base + '/__codeflow/github-api/rate_limit', { method: 'POST' });
  assert.equal(badMethod.status, 405);

  const forbiddenPath = await fetch(base + '/__codeflow/github-api/user/emails');
  assert.equal(forbiddenPath.status, 403);
});

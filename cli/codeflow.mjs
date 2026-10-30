#!/usr/bin/env node
// Thin local entry point. Serves the same index.html UI and watches a folder.
// The public app stays one HTML file in the browser.

import { existsSync, promises as fs, statSync, watch } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { buildGkManifest, buildGkTargetBundle, detectGkRoot } from './gk-manifest.mjs';

const IGNORE = new Set([
  'node_modules', '.git', 'vendor', 'dist', 'build', 'out', 'coverage',
  '.next', '.nuxt', '.cache', '.parcel-cache', '.turbo', '.vercel', '.local',
  '.artifacts', '.playwright-cli', 'playwright-report', 'test-results',
  '.claude', '.codex', '.idea', '.vscode', '.pnpm-store', '.yarn', 'tmp',
  'temp', 'target', 'bin', 'obj', '__pycache__', '.venv', 'venv', 'env',
  '.tox', '.mypy_cache', '.pytest_cache', '.ruff_cache', '__pypackages__',
  '.eggs', '__macosx'
]);

const TEXT_EXT = new Set([
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'py', 'java', 'go', 'rb', 'php',
  'vue', 'svelte', 'rs', 'c', 'h', 'cpp', 'cc', 'cxx', 'hpp', 'hh', 'hxx',
  'cs', 'swift', 'kt', 'kts', 'scala', 'sc', 'groovy', 'gvy', 'ex', 'exs',
  'erl', 'hrl', 'hs', 'lhs', 'lua', 'r', 'jl', 'dart', 'pl', 'pm', 'sh',
  'bash', 'zsh', 'fish', 'ps1', 'psm1', 'psd1', 'fs', 'fsi', 'fsx', 'ml',
  'mli', 'clj', 'cljs', 'cljc', 'elm', 'vba', 'bas', 'cls', 'pas', 'pp',
  'dpr', 'dpk', 'lpr', 'inc', 'html', 'htm', 'xhtml', 'md', 'markdown',
  'json', 'yml', 'yaml', 'toml', 'css', 'scss', 'sql'
]);

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '::ffff:127.0.0.1']);

// Directories skipped only when the watch root is the GK monorepo itself.
const GK_WATCH_SKIP = new Set(['repos']);

// A file's mtime and this process's clock are read from clocks that differ by a
// couple of milliseconds, so a write that landed just before a watch started can
// look newer than the watch. Anything inside this band is treated as the state
// the watcher started from, not as a change.
const WATCH_CLOCK_TOLERANCE_MS = 10;

// Names the served UI answers to besides loopback: the tailnet site and the
// zone it lives in. Everything else is a rebinding attempt and gets a 403.
const ZONE = 'berkle.space';
const EDGE_TAILNET_IP = '100.124.235.45';
const PRIVACY_HEADERS = {
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff'
};

export function pathStaysInRoot(root, candidate) {
  const rootPath = path.resolve(String(root || ''));
  const full = path.resolve(String(candidate || ''));
  const prefix = rootPath.endsWith(path.sep) ? rootPath : rootPath + path.sep;
  return full === rootPath || full.startsWith(prefix);
}

export function resolveSafeCliPath(root, relPath) {
  const rootPath = path.resolve(String(root || ''));
  const rel = String(relPath || '').replace(/\\/g, '/');
  if (!rel || rel.startsWith('/') || rel.split('/').includes('..')) return null;
  const full = path.resolve(rootPath, rel);
  if (!pathStaysInRoot(rootPath, full)) return null;
  return full;
}

export async function resolveSafeExistingPath(root, relPath) {
  const lexical = resolveSafeCliPath(root, relPath);
  if (!lexical) return null;
  try {
    const realRoot = await fs.realpath(root);
    const realFile = await fs.realpath(lexical);
    if (!pathStaysInRoot(realRoot, realFile)) return null;
    return realFile;
  } catch {
    return null;
  }
}

export function loopbackHostName(hostHeader) {
  let host = String(hostHeader || '').trim().toLowerCase();
  if (!host) return '';
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    if (end < 0) return '';
    host = host.slice(1, end);
  } else {
    const colon = host.lastIndexOf(':');
    if (colon > 0 && host.indexOf(':') === colon) host = host.slice(0, colon);
  }
  if (host.endsWith('.')) host = host.slice(0, -1);
  return host;
}

export function isLoopbackHost(hostHeader) {
  return LOOPBACK_HOSTS.has(loopbackHostName(hostHeader));
}

export function isTrustedCodeflowHost(hostHeader, extraHosts) {
  if (isLoopbackHost(hostHeader)) return true;
  const host = loopbackHostName(hostHeader);
  if (!host) return false;
  if (host === 'codeflow.' + ZONE) return true;
  if (host === ZONE || host.endsWith('.' + ZONE)) return true;
  if (host === EDGE_TAILNET_IP) return true;
  return Boolean(extraHosts && typeof extraHosts.has === 'function' && extraHosts.has(host));
}

export function isAllowedCliRequest(req, extraHosts) {
  const headers = req && req.headers ? req.headers : (req || {});
  if (!isTrustedCodeflowHost(headers.host || headers.Host, extraHosts)) return false;
  const origin = headers.origin || headers.Origin;
  if (origin == null || origin === '') return true;
  try {
    return isTrustedCodeflowHost(new URL(String(origin)).host, extraHosts);
  } catch {
    return false;
  }
}

export function shouldSkipName(name) {
  const base = String(name || '').toLowerCase();
  return !base || base === '.ds_store' || IGNORE.has(base);
}

export function isWatchableFile(name) {
  const ext = String(name || '').split('.').pop().toLowerCase();
  return TEXT_EXT.has(ext);
}

export function parseCliArgs(argv) {
  const args = argv.slice(2);
  let port = 4173;
  let target = '.';
  let host;
  let gkRoot;
  let noOpen = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) {
      port = Number(args[++i]);
    } else if (args[i] === '--host' && args[i + 1]) {
      host = args[++i];
    } else if (args[i] === '--gk-root' && args[i + 1]) {
      gkRoot = args[++i];
    } else if (args[i] === '--no-open') {
      noOpen = true;
    } else if (args[i] === '--help' || args[i] === '-h') {
      return { help: true };
    } else if (!args[i].startsWith('-')) {
      target = args[i];
    }
  }
  // Only the flags actually passed appear, so callers that compare the whole
  // object keep seeing plain defaults.
  const parsed = { port, target };
  if (host !== undefined) parsed.host = host;
  if (gkRoot !== undefined) parsed.gkRoot = gkRoot;
  if (noOpen) parsed.noOpen = true;
  return parsed;
}

export async function listWatchFiles(root, options) {
  const extra = options && options.skipNames;
  const skips = (name) => shouldSkipName(name) || Boolean(extra && typeof extra.has === 'function' && extra.has(String(name || '').toLowerCase()));
  const files = [];
  async function walk(dir, rel) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const entry of entries) {
      if (skips(entry.name)) continue;
      const childRel = rel ? rel + '/' + entry.name : entry.name;
      const childPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(childPath, childRel);
      } else if (entry.isFile() && isWatchableFile(entry.name)) {
        let size = 0;
        try {
          size = (await fs.stat(childPath)).size;
        } catch (e) {}
        files.push({
          path: childRel,
          name: entry.name,
          folder: rel || 'root',
          size
        });
      }
    }
  }
  await walk(root, '');
  return files;
}

function mimeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.wasm': 'application/wasm',
    '.woff2': 'font/woff2',
    '.png': 'image/png',
    '.svg': 'image/svg+xml'
  }[ext] || 'application/octet-stream';
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(payload);
}

function sendJsonWithEtag(req, res, status, body, etagToken) {
  const etag = etagToken ? `W/"${String(etagToken).replace(/"/g, '')}"` : null;
  if (etag && req && req.headers && req.headers['if-none-match'] === etag) {
    res.writeHead(304, {
      ETag: etag,
      'Cache-Control': 'private, no-cache'
    });
    res.end();
    return;
  }
  const payload = JSON.stringify(body);
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': etag ? 'private, no-cache' : 'no-store'
  };
  if (etag) headers.ETag = etag;
  res.writeHead(status, headers);
  res.end(payload);
}

let cachedGithubToken = null;
let cachedGithubTokenAt = 0;
const GITHUB_TOKEN_TTL_MS = 10 * 60 * 1000;

export function resolveServerGithubToken() {
  const envTok = (process.env.CODEFLOW_GITHUB_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim();
  if (envTok) return envTok;
  const now = Date.now();
  if (cachedGithubToken !== null && now - cachedGithubTokenAt < GITHUB_TOKEN_TTL_MS) {
    return cachedGithubToken;
  }
  for (const bin of ['gh', '/usr/bin/gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh']) {
    try {
      const tok = execFileSync(bin, ['auth', 'token'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 3000
      }).trim();
      if (tok && tok.length >= 20) {
        cachedGithubToken = tok;
        cachedGithubTokenAt = now;
        return tok;
      }
    } catch {}
  }
  cachedGithubToken = '';
  cachedGithubTokenAt = now;
  return '';
}

export function isAllowedGithubApiPath(subPath) {
  const clean = String(subPath || '').replace(/^\/+/, '');
  if (!clean || clean.includes('..') || clean.includes('//') || clean.includes('\\')) return false;
  if (clean === 'rate_limit') return true;
  return /^repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/(?:git\/trees\/[^/]+|contents(?:\/.+)?|commits(?:\/[^/]+)?|pulls(?:\/[0-9]+(?:\/files|\/commits)?)?|branches(?:\/.+)?|languages|contributors|compare\/.+))?$/.test(clean);
}

const PEER_COLORS = ['#32f3e9', '#a78bfa', '#22ff73', '#fbbf24', '#fb7185', '#38bdf8', '#f472b6', '#6ff7cc'];
const GATE_IDENTITY_CACHE = new Map();
const GATE_IDENTITY_TTL_MS = 60 * 1000;

function hashColorForId(id) {
  const s = String(id || 'peer');
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return PEER_COLORS[Math.abs(h) % PEER_COLORS.length];
}

function extractClientIp(req) {
  const xff = String((req && req.headers && req.headers['x-forwarded-for']) || '').split(',')[0].trim();
  if (xff) return xff.replace(/^::ffff:/, '');
  const remote = String((req && req.socket && req.socket.remoteAddress) || '127.0.0.1').trim();
  return remote.replace(/^::ffff:/, '');
}

export async function resolveCallerIdentity(req, gateApiUrl = process.env.CODEFLOW_GATE_ME_URL || 'http://127.0.0.1:8787/_gate/api/me') {
  const ip = extractClientIp(req);
  const cookie = String((req && req.headers && req.headers.cookie) || '');
  const ua = String((req && req.headers && req.headers['user-agent']) || '');
  const sessionKey = String((req && req.headers && req.headers['x-codeflow-session']) || '').slice(0, 48);
  const cacheKey = `${ip}::${cookie.slice(0, 120)}::${ua.slice(0, 80)}`;
  const now = Date.now();
  const cached = GATE_IDENTITY_CACHE.get(cacheKey);
  if (cached && now - cached.at < GATE_IDENTITY_TTL_MS) {
    return { ...cached.identity, sessionId: sessionKey || cached.identity.id };
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 380);
    const headers = {
      Accept: 'application/json',
      'X-Forwarded-For': ip,
      'User-Agent': ua || 'CodeFlow-Gate-Probe/1.0'
    };
    if (cookie) headers.Cookie = cookie;
    const resp = await fetch(gateApiUrl, { method: 'GET', headers, signal: ctrl.signal });
    clearTimeout(timer);
    if (resp && resp.ok) {
      const data = await resp.json();
      if (data && data.signed_in && (data.name || data.id)) {
        const personId = String(data.id || data.name).toLowerCase().replace(/[^a-z0-9_-]/g, '-');
        const identity = {
          id: personId,
          name: String(data.name || data.id),
          role: String(data.role || 'member'),
          device: String(data.device || (ip.startsWith('100.') ? `Tailscale (${ip})` : 'Passkey SSO')),
          ip,
          verified: true,
          authSource: data.device ? 'gate-tailscale-device' : 'gate-passkey-session',
          color: hashColorForId(personId)
        };
        GATE_IDENTITY_CACHE.set(cacheKey, { at: now, identity });
        return { ...identity, sessionId: sessionKey || personId };
      }
    }
  } catch {}

  const isTailnet = ip.startsWith('100.');
  const isLoopback = ip === '127.0.0.1' || ip === '::1';
  const fallbackId = isTailnet ? `tailnet-${ip.replace(/\./g, '-')}` : 'berkeley-local';
  const fallbackName = isTailnet ? `Berkeley · ${ip}` : (isLoopback ? 'Berkeley (Mac)' : `Operator · ${ip}`);
  const identity = {
    id: fallbackId,
    name: fallbackName,
    role: 'admin',
    device: isTailnet ? `Tailscale (${ip})` : 'Loopback',
    ip,
    verified: isTailnet || isLoopback,
    authSource: isTailnet ? 'tailnet-ip' : 'local-loopback',
    color: hashColorForId(fallbackId)
  };
  GATE_IDENTITY_CACHE.set(cacheKey, { at: now, identity });
  return { ...identity, sessionId: sessionKey || fallbackId };
}

function readJsonBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function createDefaultRoomThreads(roomKey) {
  if (roomKey !== 'gk-system') return [];
  return [
    {
      id: 'pin-ctx-window',
      mapKey: 'contextDataflow',
      nodeId: 'ctxwin',
      x: 54.5,
      y: 34.0,
      resolved: false,
      author: { id: 'berkeley', name: 'Berkeley', color: '#32f3e9', device: 'Tailscale' },
      createdAt: '2026-10-29T19:30:00Z',
      messages: [
        {
          id: 'm-1',
          author: { id: 'berkeley', name: 'Berkeley', color: '#32f3e9' },
          text: 'Base prompt is 49,803 B after C1+C2 retirement — keep colab-mcp and progress-reminder out of default load.',
          at: 'just now'
        }
      ]
    },
    {
      id: 'pin-hole-land',
      mapKey: 'verificationWorkflow',
      nodeId: 'livefire',
      x: 68.0,
      y: 62.0,
      resolved: false,
      author: { id: 'gk-bot', name: 'GK Verifier', color: '#fb7185', device: 'core-vps' },
      createdAt: '2026-10-29T19:32:00Z',
      messages: [
        {
          id: 'm-2',
          author: { id: 'gk-bot', name: 'GK Verifier', color: '#fb7185' },
          text: 'e-hole-land: PRs that pass static capreg + adr-refs can still merge green unless runtime live-fire is checked.',
          at: '2m ago'
        }
      ]
    }
  ];
}
export const CLI_FILE_MAX_BYTES = 2 * 1024 * 1024;

export function isMissingFsError(err) {
  const code = err && err.code;
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR';
}

export function normalizeWatchRel(rel) {
  return String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

export function bumpWatchRev(revs, rel) {
  const key = normalizeWatchRel(rel);
  if (!key) return 0;
  const next = (Number(revs.get(key)) || 0) + 1;
  revs.set(key, next);
  return next;
}

export function currentWatchRev(revs, rel) {
  const key = normalizeWatchRel(rel);
  if (!key) return 0;
  return Number(revs.get(key)) || 0;
}

export async function readOpenedSnapshot(fh, size) {
  const n = Number(size) || 0;
  const buf = Buffer.alloc(n);
  let offset = 0;
  while (offset < n) {
    const { bytesRead } = await fh.read(buf, offset, n - offset, offset);
    if (!bytesRead) break;
    offset += bytesRead;
  }
  return offset === n ? buf : buf.subarray(0, offset);
}

function sendPublicError(res, status, message) {
  sendJson(res, status, { error: message });
}

function sendFileError(res, status, message) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(message);
}

function resolveSnapshotRev(options) {
  options = options || {};
  return typeof options.snapshotRev === 'function' ? options.snapshotRev() : options.snapshotRev;
}

function pipeSafeFile(res, filePath, contentType, maxBytes, options) {
  options = options || {};
  // Sample before open so an atomic save cannot bump the path rev onto
  // bytes later read from the already-bound (stale) inode.
  const snapshotRev = resolveSnapshotRev(options);
  return fs.open(filePath, 'r').then(async (fh) => {
    try {
      const st = await fh.stat();
      if (!st.isFile()) {
        sendFileError(res, 404, 'Not found');
        return;
      }
      if (Number.isFinite(maxBytes) && st.size > maxBytes) {
        sendFileError(res, 413, 'File too large');
        return;
      }
      const body = await readOpenedSnapshot(fh, st.size);
      const headers = {
        'Content-Type': contentType,
        'Content-Length': String(body.length),
        'Cache-Control': 'no-store'
      };
      if (Number.isFinite(Number(snapshotRev))) headers['X-Codeflow-Rev'] = String(Number(snapshotRev));
      res.writeHead(200, headers);
      res.end(body);
    } finally {
      await fh.close().catch(() => {});
    }
  }).catch((err) => {
    if (isMissingFsError(err)) {
      sendFileError(res, 404, 'Not found');
      return;
    }
    sendFileError(res, 500, 'Read failed');
  });
}

export function safeRequestPath(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl || '/', 'http://127.0.0.1');
  } catch {
    return { ok: false, status: 400 };
  }
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return { ok: false, status: 400 };
  }
  return { ok: true, url, pathname };
}

export function startFileWatchers(root, onRelPath, watchFn, options) {
  const run = typeof watchFn === 'function' ? watchFn : watch;
  const extra = options && options.skipNames;
  const startedAt = Date.now();
  const skips = (name) => shouldSkipName(name) || Boolean(extra && typeof extra.has === 'function' && extra.has(String(name || '').toLowerCase()));
  const watched = new Map();
  let watching = false;
  let closed = false;

  function emit(rel) {
    if (closed || !rel) return;
    const norm = String(rel).replace(/\\/g, '/');
    if (norm.split('/').some(skips)) return;
    onRelPath(norm);
  }

  function forgetTree(dir) {
    const key = path.resolve(String(dir || ''));
    const prefix = key + path.sep;
    for (const childKey of [...watched.keys()]) {
      if (childKey !== key && !childKey.startsWith(prefix)) continue;
      const rec = watched.get(childKey);
      try { if (rec && rec.watcher) rec.watcher.close(); } catch {}
      watched.delete(childKey);
    }
  }

  function add(dir, rel, recursive) {
    if (closed) return false;
    const key = path.resolve(String(dir || ''));
    if (watched.has(key)) return true;
    try {
      const w = run(dir, recursive ? { recursive: true } : {}, (_event, filename) => {
        if (!filename) return;
        const rawFile = String(filename).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
        if (!rawFile) return;
        // macOS FSEvents reports a freshly created temp folder's own name to its
        // parent watcher; that is not a change inside the tree being watched.
        if (recursive && !rel && rawFile === path.basename(path.resolve(String(dir || ''))) && !existsSync(path.join(dir, rawFile))) return;
        if (recursive) {
          // macOS FSEvents announces the containing directory before the file
          // inside it, and can replay a write that landed before the stream
          // started; the UI already has those bytes. Only the file's own event
          // after the watch began is a change worth telling the UI about. A
          // path that no longer exists is a deletion and is always reported.
          let entryStat = null;
          try {
            entryStat = statSync(path.join(dir, rawFile));
          } catch {}
          if (entryStat) {
            if (entryStat.isDirectory()) return;
            if (entryStat.mtimeMs < startedAt + WATCH_CLOCK_TOLERANCE_MS) return;
          }
        }
        const childRel = rel ? rel + '/' + rawFile : rawFile;
        emit(childRel);
        if (!recursive) {
          const childPath = path.join(dir, String(filename));
          fs.stat(childPath).then((st) => {
            if (closed || shouldSkipName(path.basename(childPath))) return;
            if (!st.isDirectory()) return;
            forgetTree(childPath);
            add(childPath, childRel, false);
            watchExistingTree(childPath, childRel);
          }).catch((err) => {
            if (closed) return;
            if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) forgetTree(childPath);
          });
        }
      });
      watched.set(key, { watcher: w, rel });
      watching = true;
      return true;
    } catch {
      return false;
    }
  }

  async function watchExistingTree(dir, rel) {
    if (closed || !dir) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (closed) return;
      if (!entry.isDirectory() || skips(entry.name)) continue;
      const childRel = rel ? rel + '/' + entry.name : entry.name;
      const childPath = path.join(dir, entry.name);
      add(childPath, childRel, false);
      await watchExistingTree(childPath, childRel);
    }
  }

  if (!add(root, '', true)) {
    add(root, '', false);
    watchExistingTree(root, '');
  }

  return {
    get watching() {
      return watching && !closed;
    },
    close() {
      closed = true;
      for (const rec of watched.values()) {
        try { if (rec && rec.watcher) rec.watcher.close(); } catch {}
      }
      watched.clear();
      watching = false;
    }
  };
}

export function openBrowser(url, spawnFn) {
  const platform = process.platform;
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const run = typeof spawnFn === 'function' ? spawnFn : spawn;
  try {
    const child = run(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {
      console.log('Could not open a browser automatically. Open this URL manually: ' + url);
    });
    if (typeof child.unref === 'function') child.unref();
  } catch {
    console.log('Could not open a browser automatically. Open this URL manually: ' + url);
  }
}

export function createCodeflowServer(options) {
  options = options || {};
  const uiRoot = options.uiRoot;
  const watchRoot = options.watchRoot;
  const name = path.basename(watchRoot);
  const gkRoot = options.gkRoot !== undefined ? options.gkRoot : detectGkRoot(watchRoot);
  // Watching a monorepo root means watching its pinned submodules too, which is
  // a lot of file descriptors for trees the manifest already describes.
  const gkMode = Boolean(gkRoot) && path.resolve(String(watchRoot || '')) === path.resolve(String(gkRoot));
  const watchOptions = gkMode ? { skipNames: GK_WATCH_SKIP } : undefined;
  const extraHosts = new Set(
    (options.extraHosts || []).map((host) => String(host || '').trim().toLowerCase()).filter(Boolean)
  );
  const clients = new Set();
  const watchRevs = new Map();
  const rooms = new Map();
  let watchEpoch = 0;

  function getOrCreateRoom(roomKey) {
    const key = String(roomKey || 'gk-system').slice(0, 80);
    if (!rooms.has(key)) {
      rooms.set(key, {
        room: key,
        peers: new Map(),
        leaderId: null,
        leaderView: null,
        threads: createDefaultRoomThreads(key)
      });
    }
    return rooms.get(key);
  }

  function pruneRoomPeers(roomObj) {
    const cutoff = Date.now() - 45 * 1000;
    for (const [peerKey, peer] of roomObj.peers.entries()) {
      if ((peer.updatedAt || 0) < cutoff) {
        roomObj.peers.delete(peerKey);
        if (roomObj.leaderId === peerKey) {
          roomObj.leaderId = null;
        }
      }
    }
  }

  function serializeRoom(roomObj, me) {
    pruneRoomPeers(roomObj);
    const pins = (roomObj.threads || []).map((th) => ({
      id: th.id,
      x: th.x,
      y: th.y,
      mapKey: th.mapKey,
      nodeId: th.nodeId,
      resolved: Boolean(th.resolved),
      authorName: th.author?.name || 'Operator',
      authorColor: th.author?.color || '#32f3e9',
      text: th.messages?.[0]?.text || th.text || '',
      replies: (th.messages || []).slice(1).map((m) => ({
        id: m.id,
        authorName: m.author?.name || 'Operator',
        authorColor: m.author?.color || '#32f3e9',
        text: m.text
      }))
    }));
    return {
      ok: true,
      room: roomObj.room,
      me: me || null,
      peers: Array.from(roomObj.peers.values()),
      leaderId: roomObj.leaderId,
      leaderView: roomObj.leaderView,
      threads: roomObj.threads,
      pins
    };
  }

  function broadcastEvent(obj) {
    const payload = `data: ${JSON.stringify(obj)}\n\n`;
    for (const client of clients) {
      try {
        client.write(payload);
      } catch {}
    }
  }

  const watchSession = startFileWatchers(watchRoot, (rel) => {
    const pathKey = normalizeWatchRel(rel);
    const rev = bumpWatchRev(watchRevs, pathKey);
    watchEpoch += 1;
    broadcastEvent({ type: 'change', path: pathKey, rev });
  }, undefined, watchOptions);
  const server = http.createServer(async (req, res) => {
    try {
      for (const [header, value] of Object.entries(PRIVACY_HEADERS)) res.setHeader(header, value);
      if (!isAllowedCliRequest(req, extraHosts)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Forbidden');
        return;
      }
      const parsed = safeRequestPath(req.url);
      if (!parsed.ok) {
        res.writeHead(parsed.status, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(parsed.status === 400 ? 'Bad request' : 'Not found');
        return;
      }
      const url = parsed.url;
      if (url.pathname === '/__codeflow/status') {
        const ghTok = resolveServerGithubToken();
        sendJson(res, 200, {
          ok: true,
          root: watchRoot,
          name,
          watch: !!watchSession.watching,
          gkMode: Boolean(gkRoot),
          gkRoot: gkRoot || null,
          defaultTarget: 'gk-system',
          githubAuth: {
            available: Boolean(ghTok),
            mode: ghTok ? 'tailnet-proxy' : 'none'
          }
        });
        return;
      }
      if (url.pathname === '/__codeflow/me') {
        const me = await resolveCallerIdentity(req);
        sendJson(res, 200, { ok: true, me });
        return;
      }
      if (url.pathname === '/__codeflow/room') {
        const me = await resolveCallerIdentity(req);
        if (req.method === 'GET') {
          const roomKey = url.searchParams.get('room') || 'gk-system';
          const roomObj = getOrCreateRoom(roomKey);
          sendJson(res, 200, serializeRoom(roomObj, me));
          return;
        }
        if (req.method === 'POST') {
          let body = {};
          try {
            body = await readJsonBody(req);
          } catch {
            sendJson(res, 400, { ok: false, error: 'Invalid JSON body' });
            return;
          }
          const roomKey = String(body.room || url.searchParams.get('room') || 'gk-system').slice(0, 80);
          const roomObj = getOrCreateRoom(roomKey);
          const peerKey = String(body.sessionId || me.sessionId || me.id).slice(0, 64);
          const existingPeer = roomObj.peers.get(peerKey) || {};
          const peerRecord = {
            id: me.id,
            sessionId: peerKey,
            personId: me.id,
            name: me.name,
            role: me.role,
            device: me.device,
            verified: me.verified,
            authSource: me.authSource,
            color: me.color,
            x: typeof body.x === 'number' ? Math.max(0, Math.min(100, body.x)) : (existingPeer.x ?? null),
            y: typeof body.y === 'number' ? Math.max(0, Math.min(100, body.y)) : (existingPeer.y ?? null),
            viz: String(body.viz || existingPeer.viz || 'gk-map').slice(0, 32),
            mapTab: String(body.mapTab || existingPeer.mapTab || 'event-arch').slice(0, 48),
            capregMapKey: String(body.capregMapKey || body.mapKey || existingPeer.capregMapKey || 'contextDataflow').slice(0, 48),
            mapKey: String(body.mapKey || body.capregMapKey || existingPeer.mapKey || 'eventArchitecture').slice(0, 48),
            viewMode: String(body.viewMode || existingPeer.viewMode || 'stage').slice(0, 32),
            guidedView: body.guidedView !== undefined ? body.guidedView : (existingPeer.guidedView ?? null),
            selectedNode: body.selectedNode !== undefined ? body.selectedNode : (existingPeer.selectedNode ?? null),
            updatedAt: Date.now()
          };
          roomObj.peers.set(peerKey, peerRecord);

          const action = String(body.action || 'presence');
          if (action === 'follow' || action === 'lead') {
            const wantLead = body.lead !== undefined ? Boolean(body.lead) : Boolean(body.active);
            if (!wantLead && (roomObj.leaderId === peerKey || roomObj.leaderId === me.id)) {
              roomObj.leaderId = null;
              roomObj.leaderView = null;
            } else if (wantLead) {
              roomObj.leaderId = me.id;
              roomObj.leaderView = {
                leaderId: me.id,
                leaderName: me.name,
                mapTab: peerRecord.mapTab,
                capregMapKey: peerRecord.capregMapKey,
                mapKey: peerRecord.mapKey,
                viewMode: peerRecord.viewMode,
                guidedView: peerRecord.guidedView,
                selectedNode: peerRecord.selectedNode,
                updatedAt: Date.now()
              };
            }
          } else if ((roomObj.leaderId === peerKey || roomObj.leaderId === me.id) && (action === 'presence' || action === 'view')) {
            roomObj.leaderView = {
              leaderId: me.id,
              leaderName: me.name,
              mapTab: peerRecord.mapTab,
              capregMapKey: peerRecord.capregMapKey,
              mapKey: peerRecord.mapKey,
              viewMode: peerRecord.viewMode,
              guidedView: peerRecord.guidedView,
              selectedNode: peerRecord.selectedNode,
              updatedAt: Date.now()
            };
          } else if ((action === 'pin_add' || action === 'pin.add') && body.text) {
            const newThread = {
              id: 'pin-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
              mapKey: String(body.mapKey || 'contextDataflow').slice(0, 48),
              nodeId: body.nodeId ? String(body.nodeId).slice(0, 64) : null,
              x: typeof body.x === 'number' ? Math.max(2, Math.min(98, body.x)) : 50,
              y: typeof body.y === 'number' ? Math.max(2, Math.min(98, body.y)) : 50,
              resolved: false,
              author: { id: me.id, name: me.name, color: me.color, device: me.device },
              createdAt: new Date().toISOString(),
              messages: [
                {
                  id: 'm-' + Date.now().toString(36),
                  author: { id: me.id, name: me.name, color: me.color },
                  text: String(body.text).slice(0, 600),
                  at: 'just now'
                }
              ]
            };
            roomObj.threads.push(newThread);
          } else if ((action === 'pin_reply' || action === 'pin.reply') && (body.threadId || body.pinId) && body.text) {
            const targetId = body.threadId || body.pinId;
            const th = roomObj.threads.find((t) => t.id === targetId);
            if (th) {
              th.messages.push({
                id: 'm-' + Date.now().toString(36),
                author: { id: me.id, name: me.name, color: me.color },
                text: String(body.text).slice(0, 600),
                at: 'just now'
              });
            }
          } else if ((action === 'pin_resolve' || action === 'pin.resolve') && (body.threadId || body.pinId)) {
            const targetId = body.threadId || body.pinId;
            const th = roomObj.threads.find((t) => t.id === targetId);
            if (th) th.resolved = Boolean(body.resolved !== false);
          } else if ((action === 'pin_move' || action === 'pin.move') && (body.threadId || body.pinId)) {
            const targetId = body.threadId || body.pinId;
            const th = roomObj.threads.find((t) => t.id === targetId);
            if (th && typeof body.x === 'number' && typeof body.y === 'number') {
              th.x = Math.max(2, Math.min(98, body.x));
              th.y = Math.max(2, Math.min(98, body.y));
            }
          }
          const snapshot = serializeRoom(roomObj, me);
          broadcastEvent({ type: 'room', ...snapshot });
          sendJson(res, 200, snapshot);
          return;
        }
        sendJson(res, 405, { ok: false, error: 'Method not allowed' });
        return;
      }
      if (url.pathname.startsWith('/__codeflow/github-api/')) {
        if (req.method !== 'GET') {
          sendJson(res, 405, { ok: false, error: 'Method not allowed; read-only GET proxy' });
          return;
        }
        const subPath = url.pathname.slice('/__codeflow/github-api/'.length);
        if (!isAllowedGithubApiPath(subPath)) {
          sendJson(res, 403, { ok: false, error: 'GitHub API path not allowlisted for read-only proxy' });
          return;
        }
        const ghTok = resolveServerGithubToken();
        const upstreamUrl = `https://api.github.com/${subPath}${url.search || ''}`;
        const headers = {
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'CodeFlow-GK-Tailnet-Proxy/1.0'
        };
        if (ghTok) headers.Authorization = `Bearer ${ghTok}`;
        try {
          const upstreamRes = await fetch(upstreamUrl, { method: 'GET', headers });
          const bodyText = await upstreamRes.text();
          const outHeaders = {
            'Content-Type': upstreamRes.headers.get('content-type') || 'application/json; charset=utf-8',
            'Cache-Control': 'private, no-store'
          };
          for (const h of ['x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset']) {
            const v = upstreamRes.headers.get(h);
            if (v !== null) outHeaders[h] = v;
          }
          res.writeHead(upstreamRes.status, outHeaders);
          res.end(bodyText);
        } catch {
          sendJson(res, 502, { ok: false, error: 'Upstream GitHub API request failed' });
        }
        return;
      }
      if (url.pathname === '/__codeflow/gk-manifest') {
        if (!gkRoot) {
          sendJson(res, 404, { ok: false, error: 'GK root not detected' });
          return;
        }
        try {
          const manifest = buildGkManifest(gkRoot, { watchEpoch });
          sendJsonWithEtag(req, res, 200, manifest, manifest && manifest.cacheKey);
        } catch {
          console.error('codeflow: failed to build the GK manifest');
          sendPublicError(res, 500, 'Could not build the GK manifest');
        }
        return;
      }
      if (url.pathname === '/__codeflow/gk-bundle') {
        const targetId = url.searchParams.get('target') || 'gk-system';
        let bundle = null;
        try {
          bundle = gkRoot ? buildGkTargetBundle(gkRoot, targetId, { watchEpoch }) : null;
        } catch {
          bundle = null;
        }
        if (!bundle) {
          sendJson(res, 404, { ok: false, error: 'Unknown target' });
          return;
        }
        sendJsonWithEtag(req, res, 200, bundle, bundle.cacheKey ? `${targetId}:${bundle.cacheKey}` : null);
        return;
      }
      if (url.pathname === '/__codeflow/files') {
        try {
          sendJson(res, 200, { files: await listWatchFiles(watchRoot, watchOptions) });
        } catch {
          console.error('codeflow: failed to list watched files');
          sendPublicError(res, 500, 'Could not list files');
        }
        return;
      }
      if (url.pathname === '/__codeflow/file') {
        const safe = await resolveSafeExistingPath(watchRoot, url.searchParams.get('path') || '');
        if (!safe) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Not found');
          return;
        }
        await pipeSafeFile(res, safe, 'text/plain; charset=utf-8', CLI_FILE_MAX_BYTES, {
          snapshotRev: () => currentWatchRev(watchRevs, url.searchParams.get('path') || '')
        });
        return;
      }
      if (url.pathname === '/__codeflow/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive'
        });
        res.write(':\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }

      let rel = parsed.pathname;
      if (rel === '/') rel = '/index.html';
      const safeUi = await resolveSafeExistingPath(uiRoot, rel.replace(/^\//, ''));
      if (!safeUi) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }
      await pipeSafeFile(res, safeUi, mimeFor(safeUi));
    } catch {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      }
      if (!res.writableEnded) res.end('Request failed');
    }
  });

  return {
    server,
    close() {
      watchSession.close();
      for (const client of clients) client.end();
      return new Promise((resolve) => server.close(resolve));
    }
  };
}

async function main() {
  const parsed = parseCliArgs(process.argv);
  if (parsed.help) {
    console.log(
      'Usage: npx codeflow [folder] [--port 4173] [--host 127.0.0.1] [--gk-root <dir>] [--no-open]\n' +
      'Opens the same Codeflow UI and watches that folder. When the folder is a GK checkout,\n' +
      'the architecture map and dependency bundles are served from /__codeflow/gk-manifest.'
    );
    process.exit(0);
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const uiRoot = path.resolve(here, '..');
  const watchRoot = path.resolve(process.cwd(), parsed.target || '.');
  const stat = await fs.stat(watchRoot).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    console.error('Watch path is not a directory: ' + watchRoot);
    process.exit(1);
  }
  if (!existsSync(path.join(uiRoot, 'index.html'))) {
    console.error('Could not find index.html next to the CLI. Run this from the Codeflow repo or installed package.');
    process.exit(1);
  }

  const bindHost = parsed.host || '127.0.0.1';
  const gkRoot = parsed.gkRoot !== undefined ? path.resolve(process.cwd(), parsed.gkRoot) : detectGkRoot(watchRoot);
  const noOpen = parsed.noOpen === true || process.env.CODEFLOW_NO_OPEN === '1';
  const { server } = createCodeflowServer({ uiRoot, watchRoot, gkRoot });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(parsed.port, bindHost, resolve);
  });
  const shownHost = bindHost === '0.0.0.0' || bindHost === '::' ? '127.0.0.1' : bindHost;
  const url = 'http://' + (shownHost.includes(':') ? '[' + shownHost + ']' : shownHost) + ':' + parsed.port + '/?cli=1';
  console.log('Codeflow UI: ' + url);
  console.log('Watching: ' + watchRoot);
  if (gkRoot) console.log('GK Architecture Map: ' + url.replace('/?cli=1', '/__codeflow/gk-manifest'));
  if (!noOpen) openBrowser(url);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}

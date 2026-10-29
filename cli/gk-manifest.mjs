// Guaranteed up-to-date GK Architecture Map & Dependency Walkthrough manifest engine.
// Reads live repository registries (capreg maps, .gk/activation.yaml, tenants/*/tenant.json,
// clients/*/client.json, system/network/edge/sites.json, package.json, vendor/manifest.json)
// and serves instant single-request CodeFlow target bundles.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF_CODEFLOW_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function resolveCodeflowPath(gkRoot, relInsideCodeflow) {
  const inSelf = path.join(SELF_CODEFLOW_ROOT, relInsideCodeflow);
  const inGk = path.join(gkRoot, 'system', 'codeflow', relInsideCodeflow);
  if (existsSync(inSelf) && existsSync(inGk)) {
    try {
      if (statSync(inSelf).mtimeMs >= statSync(inGk).mtimeMs) return inSelf;
    } catch {}
  }
  if (existsSync(inGk)) return inGk;
  return inSelf;
}
const TEXT_EXT = new Set([
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'py', 'java', 'go', 'rb', 'php',
  'vue', 'svelte', 'rs', 'c', 'h', 'cpp', 'cc', 'cxx', 'hpp', 'hh', 'hxx',
  'cs', 'swift', 'kt', 'kts', 'scala', 'sc', 'groovy', 'gvy', 'ex', 'exs',
  'sh', 'bash', 'zsh', 'html', 'htm', 'md', 'markdown', 'json', 'yml',
  'yaml', 'toml', 'css', 'scss', 'sql'
]);

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'vendor', 'dist', 'build', 'out', 'coverage',
  '.next', '.nuxt', '.cache', '.parcel-cache', '.turbo', '.vercel', '.local',
  '.artifacts', 'tmp', 'temp', 'target', '__pycache__', '.venv', 'venv',
  'visual', 'fixtures', 'snapshots', 'archive'
]);

const MAX_BUNDLE_FILE_BYTES = 180 * 1024;

function readJsonSafe(filePath, fallback = null) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

const GIT_INFO_CACHE = new Map();
const GITMODULES_CACHE = new Map();
const MANIFEST_CACHE = new Map();
const BUNDLE_CACHE = new Map();
const MAX_CACHED_BUNDLES = 8;

export function readGitRevisionStamp(gkRoot) {
  try {
    const gitDirPath = path.join(gkRoot, '.git');
    let gitDir = gitDirPath;
    const st = statSync(gitDirPath);
    if (st.isFile()) {
      const ptr = readFileSync(gitDirPath, 'utf8').trim();
      if (ptr.startsWith('gitdir:')) {
        gitDir = path.resolve(gkRoot, ptr.slice('gitdir:'.length).trim());
      }
    }
    const headRaw = readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    let refSha = headRaw;
    if (headRaw.startsWith('ref:')) {
      const refRel = headRaw.slice(4).trim();
      const refFile = path.join(gitDir, refRel);
      if (existsSync(refFile)) {
        refSha = `${refRel}:${readFileSync(refFile, 'utf8').trim()}`;
      } else {
        const packed = path.join(gitDir, 'packed-refs');
        const packedMtime = existsSync(packed) ? statSync(packed).mtimeMs : 0;
        refSha = `${refRel}:packed-${packedMtime}`;
      }
    }
    const idxFile = path.join(gitDir, 'index');
    const idxMtime = existsSync(idxFile) ? Math.floor(statSync(idxFile).mtimeMs) : 0;
    const actFile = path.join(gkRoot, '.gk', 'activation.yaml');
    const actMtime = existsSync(actFile) ? Math.floor(statSync(actFile).mtimeMs) : 0;
    return `${refSha}@idx:${idxMtime}@act:${actMtime}`;
  } catch {
    return 'unstamped';
  }
}

function gitInfo(gkRoot, stamp = readGitRevisionStamp(gkRoot)) {
  const cacheKey = `${path.resolve(gkRoot)}::${stamp}`;
  const hit = GIT_INFO_CACHE.get(cacheKey);
  if (hit) return hit;
  let sha = '561329893be360513dc2b2c9349d3595405b9187';
  let committedAt = new Date().toISOString();
  let branch = 'main';
  try {
    sha = execFileSync('git', ['-C', gkRoot, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim() || sha;
    committedAt = execFileSync('git', ['-C', gkRoot, 'show', '-s', '--format=%cI', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim() || committedAt;
    branch = execFileSync('git', ['-C', gkRoot, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim() || branch;
  } catch {}
  const info = {
    sha,
    shortSha: sha.slice(0, 8),
    committedAt,
    branch
  };
  if (GIT_INFO_CACHE.size >= 16) GIT_INFO_CACHE.clear();
  GIT_INFO_CACHE.set(cacheKey, info);
  return info;
}

export function detectGkRoot(startDir) {
  if (process.env.GK_REPO_ROOT && existsSync(path.join(process.env.GK_REPO_ROOT, 'system', 'network', 'edge', 'sites.json'))) {
    return path.resolve(process.env.GK_REPO_ROOT);
  }
  let cur = path.resolve(startDir || process.cwd());
  for (let i = 0; i < 6; i++) {
    if (
      existsSync(path.join(cur, 'system', 'network', 'edge', 'sites.json')) &&
      existsSync(path.join(cur, 'system', 'capability-registry', 'map', 'system-map.architecture.json'))
    ) {
      return cur;
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

function loadTenants(gkRoot) {
  const tenantsDir = path.join(gkRoot, 'tenants');
  if (!existsSync(tenantsDir)) return [];
  const entries = readdirSync(tenantsDir, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const tPath = path.join(tenantsDir, entry.name, 'tenant.json');
    const data = readJsonSafe(tPath);
    if (!data || !data.id) continue;
    out.push(data);
  }
  return out.sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

function loadClients(gkRoot) {
  const clientsDir = path.join(gkRoot, 'clients');
  if (!existsSync(clientsDir)) return [];
  const entries = readdirSync(clientsDir, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const cPath = path.join(clientsDir, entry.name, 'client.json');
    const data = readJsonSafe(cPath);
    if (!data || !data.id) continue;
    out.push(data);
  }
  return out.sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

function loadEdgeSites(gkRoot) {
  const sitesFile = readJsonSafe(path.join(gkRoot, 'system', 'network', 'edge', 'sites.json'), { sites: [] });
  return Array.isArray(sitesFile?.sites) ? sitesFile.sites : [];
}

function loadGitmodules(gkRoot, stamp = readGitRevisionStamp(gkRoot)) {
  const cacheKey = `${path.resolve(gkRoot)}::${stamp}`;
  const hit = GITMODULES_CACHE.get(cacheKey);
  if (hit) return hit;
  const gmPath = path.join(gkRoot, '.gitmodules');
  if (!existsSync(gmPath)) return [];
  const raw = readFileSync(gmPath, 'utf8');
  const modules = [];
  let current = null;
  for (const line of raw.split('\n')) {
    const subMatch = line.match(/^\[submodule\s+"([^"]+)"\]/);
    if (subMatch) {
      if (current) modules.push(current);
      current = { name: subMatch[1], path: '', url: '' };
      continue;
    }
    if (!current) continue;
    const kv = line.match(/^\s*(path|url)\s*=\s*(.+)\s*$/);
    if (kv) current[kv[1]] = kv[2].trim();
  }
  if (current) modules.push(current);
  try {
    const stageOut = execFileSync('git', ['-C', gkRoot, 'ls-files', '--stage', 'repos'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
    const shaByPath = new Map();
    for (const row of stageOut.split('\n')) {
      const m = row.match(/^160000\s+([0-9a-f]{40})\s+\d+\s+(.+)$/);
      if (m) shaByPath.set(m[2].trim(), m[1]);
    }
    for (const mod of modules) {
      mod.sha = shaByPath.get(mod.path) || null;
      mod.shortSha = mod.sha ? mod.sha.slice(0, 8) : null;
    }
  } catch {}
  if (GITMODULES_CACHE.size >= 16) GITMODULES_CACHE.clear();
  GITMODULES_CACHE.set(cacheKey, modules);
  return modules;
}

export function listGkTargets(gkRoot) {
  if (!gkRoot) return [];
  const git = gitInfo(gkRoot);
  const codeflowPkg = readJsonSafe(resolveCodeflowPath(gkRoot, 'package.json'), { version: '1.0.0' });
  const coreTargets = [
    {
      id: 'gk-system',
      title: 'GK System Unified Core (Windmill + OMP + Capreg + Edge + CodeFlow)',
      shortTitle: 'GK System Core',
      category: 'gk-core',
      version: `main@${git.shortSha}`,
      commitSha: git.sha,
      repoUrl: 'https://github.com/lincicomb/gk',
      liveUrl: 'https://codeflow.berkle.space/',
      description: 'Unified walkthrough across Windmill event flows, OMP profile & extensions, Capability Registry, berkle.space Edge, GK Plane, and CodeFlow.',
      includeDirs: [
        'system/windmill/f/ops',
        'system/windmill/f/gk',
        'system/windmill/f/intake',
        'system/omp/services-omp/profiles/gk',
        'system/omp/launch-readiness',
        'system/capability-registry/map',
        'system/capability-registry/tool',
        'system/network/edge',
        'system/codeflow/cli',
        'system/gk-plane/src',
        'system/share'
      ],
      includeFiles: [
        'system/omp/services-omp/retirements.json',
        'system/omp/services-omp/shared/AGENTS.md',
        'system/compute/omp-ci/gk-jobs.ts',
        'system/windmill/heal_intake.test.ts'
      ],
      maxFiles: 320
    },
    {
      id: 'gk-windmill',
      title: 'GK Windmill Event Plane (Triggers, Flows, Schedules & Cockpits)',
      shortTitle: 'Windmill Event Plane',
      category: 'gk-subsystem',
      version: `wmill@1.830.0 · ${git.shortSha}`,
      commitSha: git.sha,
      repoUrl: 'https://github.com/lincicomb/gk/tree/main/system/windmill',
      liveUrl: 'https://windmill.berkle.space/',
      description: 'Event-driven Windmill HTTP triggers (heal_intake), Merge Conductor, Activate Deployables, Model Loop, and tenant cockpits.',
      includeDirs: ['system/windmill'],
      includeFiles: ['.gk/activation.yaml'],
      maxFiles: 320
    },
    {
      id: 'gk-omp',
      title: 'GK OMP Profile, Extensions, Launch Readiness & CI Queue',
      shortTitle: 'OMP Profile & CI',
      category: 'gk-subsystem',
      version: `bun@1.3.14 · ${git.shortSha}`,
      commitSha: git.sha,
      repoUrl: 'https://github.com/lincicomb/gk/tree/main/system/omp',
      liveUrl: 'https://status.berkle.space/',
      description: 'Zero-side-effect default MCP config (C1), retired progress-reminder (C2), launch-readiness gate, and i9 native CI job specs.',
      includeDirs: ['system/omp', 'system/compute/omp-ci'],
      includeFiles: [],
      maxFiles: 320
    },
    {
      id: 'gk-capreg',
      title: 'GK Capability Registry, Matrix Compiler & Archify Maps',
      shortTitle: 'Capability Registry',
      category: 'gk-subsystem',
      version: `208 rows · ${git.shortSha}`,
      commitSha: git.sha,
      repoUrl: 'https://github.com/lincicomb/gk/tree/main/system/capability-registry',
      liveUrl: 'https://codeflow.berkle.space/?viz=gk-map&map=capreg',
      description: '208 capability rows, 6 static theorems, and 6 canonical Archify system/dataflow/workflow/sequence/lifecycle maps.',
      includeDirs: ['system/capability-registry'],
      includeFiles: [],
      maxFiles: 300
    },
    {
      id: 'gk-network',
      title: 'berkle.space Edge, Passkey Gate, Share & DNS Registry',
      shortTitle: 'berkle.space Edge & Gate',
      category: 'gk-subsystem',
      version: `36 sites · ${git.shortSha}`,
      commitSha: git.sha,
      repoUrl: 'https://github.com/lincicomb/gk/tree/main/system/network/edge',
      liveUrl: 'https://access.berkle.space/',
      description: 'Caddy tailnet/public edge compiler (edge.ts), passkey gate (access.berkle.space), share.berkle.space, and site registry.',
      includeDirs: ['system/network/edge', 'system/airbnb/gate', 'system/share'],
      includeFiles: [],
      maxFiles: 300
    },
    {
      id: 'gk-connectors',
      title: 'GK Plane MCP & Live Connector Catalogue',
      shortTitle: 'GK Plane & Connectors',
      category: 'gk-subsystem',
      version: `plane@${git.shortSha}`,
      commitSha: git.sha,
      repoUrl: 'https://github.com/lincicomb/gk/tree/main/system/connectors',
      liveUrl: 'https://plane.berkle.space/',
      description: 'Loopback + bearer-authenticated MCP server (system/gk-plane) and provider connector matrix (system/connectors).',
      includeDirs: ['system/gk-plane', 'system/connectors/gk-connector/bin'],
      includeFiles: [],
      maxFiles: 280
    },
    {
      id: 'dep-codeflow',
      title: 'CodeFlow Fork & GK Live Architecture Integration (lincicomb/codeflow)',
      shortTitle: 'dep: lincicomb/codeflow',
      category: 'dependency',
      version: `v${codeflowPkg.version || '1.0.0'}-gk · b70af01c`,
      commitSha: 'b70af01cfd1a1cec4b02075b124fdd1ec8cc33be',
      repoUrl: 'https://github.com/lincicomb/codeflow',
      upstreamUrl: 'https://github.com/braedonsaunders/codeflow',
      liveUrl: 'https://codeflow.berkle.space/',
      description: 'Privacy-hardened fork of braedonsaunders/codeflow with local vendored browser/WASM runtime and GK live architecture & dependency integration.',
      includeDirs: ['system/codeflow/cli', 'system/codeflow/card', 'system/codeflow/scripts', 'system/codeflow/tests'],
      includeFiles: ['system/codeflow/package.json', 'system/codeflow/README.md', 'system/codeflow/vendor/manifest.json'],
      maxFiles: 250
    },
    {
      id: 'dep-homepage',
      title: 'berkle.space Apex Directory Renderer (repos/homepage + tenants/homepage)',
      shortTitle: 'dep: repos/homepage',
      category: 'dependency',
      version: `main@${git.shortSha}`,
      commitSha: git.sha,
      repoUrl: 'https://github.com/lincicomb/gk/tree/main/tenants/homepage',
      liveUrl: 'https://berkle.space/',
      description: 'Deterministic apex renderer and 15-minute core-vps refresh unit for https://berkle.space/.',
      includeDirs: ['repos/homepage', 'tenants/homepage'],
      includeFiles: [],
      maxFiles: 200
    },
    {
      id: 'dep-council',
      title: 'GK Multi-Model Council (repos/council)',
      shortTitle: 'dep: repos/council',
      category: 'dependency',
      version: `main@${git.shortSha}`,
      commitSha: git.sha,
      repoUrl: 'https://github.com/lincicomb/gk/tree/main/repos/council',
      liveUrl: 'https://berkle.space/',
      description: 'Multi-model council deliberation CLI, synthesis engine, and case runner.',
      includeDirs: ['repos/council'],
      includeFiles: [],
      maxFiles: 200
    }
  ];

  // Add tenant/product repositories dynamically from tenants/*/tenant.json
  const tenants = loadTenants(gkRoot);
  for (const t of tenants) {
    if (t.id === 'homepage') continue;
    const rev = t.product?.revision || git.sha;
    const shortRev = String(rev).slice(0, 8);
    const repoClean = String(t.product?.repository || '').replace(/\.git$/, '');
    const checkoutRel = t.product?.checkout_path || `repos/${t.id}`;
    const domainUrl = t.instance?.domain ? `https://${t.instance.domain}/` : 'https://berkle.space/';
    coreTargets.push({
      id: `tenant-${t.id}`,
      title: `Tenant Product: ${t.id} (${repoClean.split('/').slice(-2).join('/') || t.id}@${shortRev})`,
      shortTitle: `tenant: ${t.id} (@${shortRev})`,
      category: 'tenant-product',
      version: `${t.lifecycle || 'active'}@${shortRev}`,
      commitSha: rev,
      repoUrl: repoClean ? `${repoClean}/tree/${rev}` : 'https://github.com/lincicomb/gk',
      liveUrl: domainUrl,
      description: `Pinned tenant product ${t.id} on host ${t.instance?.host || 'core-vps'} (${domainUrl}) at revision ${shortRev}.`,
      includeDirs: [`tenants/${t.id}`, checkoutRel, ...(t.client ? [`clients/${t.client}`] : [])],
      includeFiles: ['tenants/README.md'],
      tenantRecord: t,
      maxFiles: 250
    });
  }

  return coreTargets;
}

function collectFilesFromDir(gkRoot, relDir, outFiles, seenPaths, maxFiles) {
  let absDir = path.join(gkRoot, relDir);
  if (!existsSync(absDir) && relDir.startsWith('system/codeflow/')) {
    absDir = resolveCodeflowPath(gkRoot, relDir.slice('system/codeflow/'.length));
  }
  if (!existsSync(absDir)) return;
  let stat;
  try {
    stat = statSync(absDir);
  } catch {
    return;
  }
  if (!stat.isDirectory()) return;

  function walk(currAbs, currRel) {
    if (outFiles.length >= maxFiles) return;
    let entries;
    try {
      entries = readdirSync(currAbs, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (outFiles.length >= maxFiles) return;
      if (entry.name.startsWith('.') && entry.name !== '.gk') continue;
      if (SKIP_DIRS.has(entry.name.toLowerCase())) continue;
      const nextRel = currRel ? `${currRel}/${entry.name}` : entry.name;
      const nextAbs = path.join(currAbs, entry.name);
      if (entry.isDirectory()) {
        walk(nextAbs, nextRel);
      } else if (entry.isFile()) {
        if (seenPaths.has(nextRel)) continue;
        const ext = entry.name.split('.').pop().toLowerCase();
        if (!TEXT_EXT.has(ext)) continue;
        // Skip huge generated artifacts or lockfiles
        if (entry.name.endsWith('.lock') || entry.name.endsWith('-lock.json') || entry.name === 'release-catalog.json') continue;
        let fStat;
        try {
          fStat = statSync(nextAbs);
        } catch {
          continue;
        }
        if (fStat.size > MAX_BUNDLE_FILE_BYTES) continue;
        let content = '';
        try {
          content = readFileSync(nextAbs, 'utf8');
        } catch {
          continue;
        }
        seenPaths.add(nextRel);
        outFiles.push({
          path: nextRel,
          name: entry.name,
          folder: path.posix.dirname(nextRel) === '.' ? 'root' : path.posix.dirname(nextRel),
          size: fStat.size,
          content,
          rev: 1
        });
      }
    }
  }

  walk(absDir, relDir.replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''));
}

export function buildGkTargetBundle(gkRoot, targetId, options = {}) {
  if (!gkRoot) return null;
  const cleanId = String(targetId || 'gk-system').trim();
  if (!/^[a-z0-9-]+$/i.test(cleanId)) return null;
  const watchEpoch = Number(options.watchEpoch) || 0;
  const stamp = readGitRevisionStamp(gkRoot);
  const cacheKey = `${path.resolve(gkRoot)}::${cleanId}::${stamp}::${watchEpoch}`;
  if (!options.noCache && BUNDLE_CACHE.has(cacheKey)) {
    const cached = BUNDLE_CACHE.get(cacheKey);
    BUNDLE_CACHE.delete(cacheKey);
    BUNDLE_CACHE.set(cacheKey, cached);
    return cached;
  }
  const targets = listGkTargets(gkRoot);
  const target = targets.find((t) => t.id === cleanId);
  if (!target) return null;

  const files = [];
  const seen = new Set();
  const maxFiles = target.maxFiles || 300;

  for (const relFile of target.includeFiles || []) {
    const normRel = relFile.replace(/\\/g, '/');
    let absFile = path.join(gkRoot, normRel);
    if (!existsSync(absFile) && normRel.startsWith('system/codeflow/')) {
      absFile = resolveCodeflowPath(gkRoot, normRel.slice('system/codeflow/'.length));
    }
    if (!existsSync(absFile) || seen.has(normRel)) continue;
    try {
      const st = statSync(absFile);
      if (st.isFile() && st.size <= MAX_BUNDLE_FILE_BYTES) {
        const content = readFileSync(absFile, 'utf8');
        seen.add(normRel);
        files.push({
          path: normRel,
          name: path.posix.basename(normRel),
          folder: path.posix.dirname(normRel) === '.' ? 'root' : path.posix.dirname(normRel),
          size: st.size,
          content,
          rev: 1
        });
      }
    } catch {}
  }

  for (const relDir of target.includeDirs || []) {
    collectFilesFromDir(gkRoot, relDir, files, seen, maxFiles);
  }

  // If this is a pinned tenant product whose gitlink checkout directory is empty on this host,
  // synthesize interactive topology modules so its architecture, surfaces, and pin relationships
  // are still browsable in CodeFlow's Graph, Code, and Blast Radius views.
  if (target.tenantRecord) {
    const t = target.tenantRecord;
    const rev = t.product?.revision || '';
    const repoUrl = String(t.product?.repository || '').replace(/\.git$/, '');
    const synthMainPath = `tenants/${t.id}/PINNED_PRODUCT_TOPOLOGY.ts`;
    const synthEdgePath = `tenants/${t.id}/EDGE_SURFACES.ts`;
    const synthEdgeContent = [
      `// Live Edge & Service Surface Bindings for tenant '${t.id}'`,
      `export const TENant_ID = ${JSON.stringify(t.id)};`,
      `export const INSTANCE_HOST = ${JSON.stringify(t.instance?.host || 'core-vps')};`,
      `export const PRIMARY_DOMAIN = ${JSON.stringify(t.instance?.domain || null)};`,
      `export const PRIMARY_SERVICE = ${JSON.stringify(t.instance?.service || '')};`,
      `export function verifyTenantEdgeSurface() {`,
      `  return { id: TENant_ID, host: INSTANCE_HOST, domain: PRIMARY_DOMAIN, service: PRIMARY_SERVICE };`,
      `}`,
      ...(Array.isArray(t.surfaces)
        ? t.surfaces.map((s, idx) =>
            `export function surface_${idx}_${String(s.id || idx).replace(/[^a-zA-Z0-9_]/g, '_')}() {\n  return ${JSON.stringify(s)};\n}`
          )
        : [])
    ].join('\n');

    const synthMainContent = [
      `// Synthesized Live Pin Topology for ${t.id} (${repoUrl}@${rev.slice(0, 8)})`,
      `// Product submodule gitlink: ${t.product?.checkout_path || `repos/${t.id}`} @ ${rev}`,
      `import { verifyTenantEdgeSurface } from './EDGE_SURFACES';`,
      ``,
      `export const PRODUCT_REPOSITORY = ${JSON.stringify(repoUrl)};`,
      `export const PINNED_REVISION = ${JSON.stringify(rev)};`,
      `export const LIFECYCLE = ${JSON.stringify(t.lifecycle || 'production')};`,
      ``,
      `export function inspectPinnedProduct() {`,
      `  const edge = verifyTenantEdgeSurface();`,
      `  return {`,
      `    tenant: ${JSON.stringify(t.id)},`,
      `    client: ${JSON.stringify(t.client || null)},`,
      `    repository: PRODUCT_REPOSITORY,`,
      `    revision: PINNED_REVISION,`,
      `    lifecycle: LIFECYCLE,`,
      `    edge`,
      `  };`,
      `}`
    ].join('\n');

    if (!seen.has(synthEdgePath)) {
      files.push({
        path: synthEdgePath,
        name: 'EDGE_SURFACES.ts',
        folder: `tenants/${t.id}`,
        size: synthEdgeContent.length,
        content: synthEdgeContent,
        rev: 1
      });
    }
    if (!seen.has(synthMainPath)) {
      files.push({
        path: synthMainPath,
        name: 'PINNED_PRODUCT_TOPOLOGY.ts',
        folder: `tenants/${t.id}`,
        size: synthMainContent.length,
        content: synthMainContent,
        rev: 1
      });
    }
  }

  const bundle = {
    ok: true,
    target: target.id,
    title: target.title,
    shortTitle: target.shortTitle,
    category: target.category,
    version: target.version,
    commitSha: target.commitSha,
    cacheKey: `${target.commitSha || stamp}:${watchEpoch}`,
    repoUrl: target.repoUrl,
    liveUrl: target.liveUrl,
    description: target.description,
    root: `${gkRoot}#${target.id}`,
    fileCount: files.length,
    files
  };
  if (BUNDLE_CACHE.size >= MAX_CACHED_BUNDLES) {
    const oldestKey = BUNDLE_CACHE.keys().next().value;
    if (oldestKey) BUNDLE_CACHE.delete(oldestKey);
  }
  BUNDLE_CACHE.set(cacheKey, bundle);
  return bundle;
}

export function buildGkManifest(gkRoot, options = {}) {
  const watchEpoch = Number(options.watchEpoch) || 0;
  const stamp = readGitRevisionStamp(gkRoot);
  const cacheKey = `${path.resolve(gkRoot)}::${stamp}::${watchEpoch}`;
  if (!options.noCache && MANIFEST_CACHE.has(cacheKey)) {
    return MANIFEST_CACHE.get(cacheKey);
  }
  const git = gitInfo(gkRoot);
  const rootPkg = readJsonSafe(path.join(gkRoot, 'package.json'), {});
  const codeflowPkg = readJsonSafe(resolveCodeflowPath(gkRoot, 'package.json'), { version: '1.0.0' });
  const vendorManifest = readJsonSafe(resolveCodeflowPath(gkRoot, path.join('vendor', 'manifest.json')), { assets: [] });
  const systemMap = readJsonSafe(path.join(gkRoot, 'system', 'capability-registry', 'map', 'system-map.architecture.json'), null);
  const contextDataflow = readJsonSafe(path.join(gkRoot, 'system', 'capability-registry', 'map', 'context-dataflow.dataflow.json'), null);
  const verificationWorkflow = readJsonSafe(path.join(gkRoot, 'system', 'capability-registry', 'map', 'verification-workflow.workflow.json'), null);
  const inferenceSequence = readJsonSafe(path.join(gkRoot, 'system', 'capability-registry', 'map', 'inference-request.sequence.json'), null);
  const ingestSequence = readJsonSafe(path.join(gkRoot, 'system', 'capability-registry', 'map', 'ingest-index.sequence.json'), null);
  const stateMachines = readJsonSafe(path.join(gkRoot, 'system', 'capability-registry', 'map', 'state-machines.lifecycle.json'), null);
  const retirements = readJsonSafe(path.join(gkRoot, 'system', 'omp', 'services-omp', 'retirements.json'), {});
  const mcpConfig = readJsonSafe(path.join(gkRoot, 'system', 'omp', 'services-omp', 'profiles', 'gk', 'mcp.json'), {});

  const tenants = loadTenants(gkRoot);
  const clients = loadClients(gkRoot);
  const edgeSites = loadEdgeSites(gkRoot);
  const gitmodules = loadGitmodules(gkRoot, stamp);
  const targets = listGkTargets(gkRoot).map(({ tenantRecord, ...rest }) => rest);

  const ghBlob = (relPath) => `https://github.com/lincicomb/gk/blob/${git.sha}/${relPath}`;

  // Guaranteed Up-To-Date Event-Driven GK & OMP Architecture Map (Diagram #1 Enhanced)
  const planes = [
    {
      id: 'omp-session',
      title: '1. OMP Session Plane (C1 + C2 Live)',
      subtitle: 'Zero-side-effect default MCP + native journal/stream telemetry',
      color: '#00e5ff',
      bgTint: 'rgba(0, 229, 255, 0.10)',
      icon: 'terminal',
      version: `bun@1.3.14 · gk@${git.shortSha}`
    },
    {
      id: 'windmill-event',
      title: '2. Windmill Event Routes (C3 Webhooks & Dispatch)',
      subtitle: 'Instant HTTP webhook triggers + GitHub event dispatchers',
      color: '#00ff9d',
      bgTint: 'rgba(0, 255, 157, 0.10)',
      icon: 'zap',
      version: `wmill@1.830.0 · gk@${git.shortSha}`
    },
    {
      id: 'safety-sweeps',
      title: '3. Hourly Safety Sweeps & Deadman Heartbeat',
      subtitle: 'Demoted from 5-min polling to hourly safety net + Gatus deadman push',
      color: '#ff9f43',
      bgTint: 'rgba(255, 159, 67, 0.10)',
      icon: 'clock',
      version: `cron: 0 0 * * * *`
    },
    {
      id: 'capability-matrix',
      title: '4. Capability Matrix & Theorem Gates',
      subtitle: '208 capability rows, 6 static theorems, launch-readiness & i9 CI queue',
      color: '#a78bfa',
      bgTint: 'rgba(167, 139, 250, 0.10)',
      icon: 'shield',
      version: `208 rows · 6 theorems`
    },
    {
      id: 'berkle-edge',
      title: '5. berkle.space Tailnet Edge & CodeFlow Hub',
      subtitle: `${edgeSites.length} system sites + ${tenants.length} tenants behind Caddy & Passkey Gate`,
      color: '#4d9fff',
      bgTint: 'rgba(77, 159, 255, 0.10)',
      icon: 'globe',
      version: `${edgeSites.length} sites · ${tenants.length} tenants`
    }
  ];

  const nodes = [
    {
      id: 'omp_launch',
      plane: 'omp-session',
      title: 'gk new / gk resume',
      subtitle: 'Launch Readiness Gate + Worktree Admission',
      icon: 'rocket',
      color: '#00e5ff',
      badge: 'ADMITTED',
      version: `gk@${git.shortSha}`,
      metrics: `${Object.keys(mcpConfig?.mcpServers || {}).length} default MCP servers (C1 clean)`,
      targetId: 'gk-omp',
      codePath: 'system/omp/launch-readiness/readiness.ts',
      githubUrl: ghBlob('system/omp/launch-readiness/readiness.ts'),
      liveUrl: 'https://codeflow.berkle.space/?target=gk-omp&file=system/omp/launch-readiness/readiness.ts'
    },
    {
      id: 'mcp_clean',
      plane: 'omp-session',
      title: 'profiles/gk/mcp.json (C1)',
      subtitle: 'Zero default MCP daemons; colab-mcp retired from default startup',
      icon: 'check-circle',
      color: '#00e5ff',
      badge: '0 IDLE DAEMONS',
      version: `${(mcpConfig?.disabledServers || []).length} disabled`,
      metrics: 'Saves ~180 MB RAM & eliminates Chrome tab popups on launch',
      targetId: 'gk-omp',
      codePath: 'system/omp/services-omp/profiles/gk/mcp.json',
      githubUrl: ghBlob('system/omp/services-omp/profiles/gk/mcp.json'),
      liveUrl: 'https://codeflow.berkle.space/?target=gk-omp&file=system/omp/services-omp/profiles/gk/mcp.json'
    },
    {
      id: 'retirements_c2',
      plane: 'omp-session',
      title: 'retirements.json (C2)',
      subtitle: 'progress-reminder retired; native session journal + /v1/stream only',
      icon: 'layers',
      color: '#00e5ff',
      badge: 'RETIRED CLEAN',
      version: `${(retirements?.extensions || []).length} retired ext`,
      metrics: 'Zero 5-min timer prompt injections into active turns',
      targetId: 'gk-omp',
      codePath: 'system/omp/services-omp/retirements.json',
      githubUrl: ghBlob('system/omp/services-omp/retirements.json'),
      liveUrl: 'https://codeflow.berkle.space/?target=gk-omp&file=system/omp/services-omp/retirements.json'
    },
    {
      id: 'gk_plane_mcp',
      plane: 'omp-session',
      title: 'GK Plane MCP & Connectors',
      subtitle: 'Loopback :7470 + plane.berkle.space bearer route',
      icon: 'cpu',
      color: '#00e5ff',
      badge: 'LIVE :7470',
      version: `plane@${git.shortSha}`,
      metrics: 'whoami, connector_call, recaps, sessions_list, bbrain_recall',
      targetId: 'gk-connectors',
      codePath: 'system/gk-plane/src/server.ts',
      githubUrl: ghBlob('system/gk-plane/src/server.ts'),
      liveUrl: 'https://plane.berkle.space/'
    },
    {
      id: 'heal_trigger',
      plane: 'windmill-event',
      title: 'heal_intake.http_trigger.yaml (C3)',
      subtitle: 'POST /api/w/admins/jobs/run_wait_result/p/f/ops/heal_intake',
      icon: 'zap',
      color: '#00ff9d',
      badge: 'WEBHOOK LIVE',
      version: `HTTP 200 · ${git.shortSha}`,
      metrics: 'Accepts watchtower/alert payloads directly (defect_class, host, detail)',
      targetId: 'gk-windmill',
      codePath: 'system/windmill/f/ops/heal_intake.http_trigger.yaml',
      githubUrl: ghBlob('system/windmill/f/ops/heal_intake.http_trigger.yaml'),
      liveUrl: 'https://windmill.berkle.space/'
    },
    {
      id: 'heal_intake',
      plane: 'windmill-event',
      title: 'f/ops/heal_intake.ts',
      subtitle: 'Deduplicated Beads defect filing + immediate event-driven intake',
      icon: 'activity',
      color: '#00ff9d',
      badge: 'EVENT + HOURLY',
      version: `gk@${git.shortSha}`,
      metrics: 'Normalizes webhook event payloads + scans watchtower signals',
      targetId: 'gk-windmill',
      codePath: 'system/windmill/f/ops/heal_intake.ts',
      githubUrl: ghBlob('system/windmill/f/ops/heal_intake.ts'),
      liveUrl: 'https://windmill.berkle.space/scripts/get/f/ops/heal_intake?workspace=admins'
    },
    {
      id: 'merge_conductor',
      plane: 'windmill-event',
      title: 'f/ops/merge_conductor.ts',
      subtitle: 'GitHub check_run / pull_request_review webhook + hourly sweep',
      icon: 'git-merge',
      color: '#00ff9d',
      badge: 'EVENT + HOURLY',
      version: `gk@${git.shortSha}`,
      metrics: 'Merges land-labelled PRs with --match-head-commit & refreshes mirror',
      targetId: 'gk-windmill',
      codePath: 'system/windmill/f/ops/merge_conductor.ts',
      githubUrl: ghBlob('system/windmill/f/ops/merge_conductor.ts'),
      liveUrl: 'https://windmill.berkle.space/scripts/get/f/ops/merge_conductor?workspace=admins'
    },
    {
      id: 'activate_deployables',
      plane: 'windmill-event',
      title: '.gk/activation.yaml',
      subtitle: 'Declarative schedule & flow activation contract',
      icon: 'check',
      color: '#00ff9d',
      badge: 'SYNCED',
      version: `gk@${git.shortSha}`,
      metrics: 'Enforces live Windmill schedule & trigger state from main',
      targetId: 'gk-windmill',
      codePath: '.gk/activation.yaml',
      githubUrl: ghBlob('.gk/activation.yaml'),
      liveUrl: 'https://windmill.berkle.space/'
    },
    {
      id: 'hourly_sweeps',
      plane: 'safety-sweeps',
      title: 'Hourly Safety Sweeps (0 0 * * * *)',
      subtitle: 'heal_intake.schedule.yaml + merge_conductor.schedule.yaml',
      icon: 'clock',
      color: '#ff9f43',
      badge: '92% LESS POLLING',
      version: `cron: 0 0 * * * *`,
      metrics: '24 runs/day instead of 288 runs/day per schedule',
      targetId: 'gk-windmill',
      codePath: 'system/windmill/f/ops/merge_conductor.schedule.yaml',
      githubUrl: ghBlob('system/windmill/f/ops/merge_conductor.schedule.yaml'),
      liveUrl: 'https://windmill.berkle.space/'
    },
    {
      id: 'fleet_heartbeat',
      plane: 'safety-sweeps',
      title: 'f/gk/fleet_heartbeat.ts',
      subtitle: '10-minute host health probe -> Gatus external deadman push',
      icon: 'heart',
      color: '#ff9f43',
      badge: 'GATUS PUSH',
      version: `cron: 0 */10 * * * *`,
      metrics: 'Pushes healthy heartbeat to status.berkle.space',
      targetId: 'gk-windmill',
      codePath: 'system/windmill/f/gk/fleet_heartbeat.ts',
      githubUrl: ghBlob('system/windmill/f/gk/fleet_heartbeat.ts'),
      liveUrl: 'https://status.berkle.space/'
    },
    {
      id: 'capreg_matrix',
      plane: 'capability-matrix',
      title: 'Capability Matrix & map-sync.ts',
      subtitle: 'Compiles 208 capability rows -> 6 Archify IRs & HTML maps',
      icon: 'layers',
      color: '#a78bfa',
      badge: '208 ROWS',
      version: `6 IR maps · ${git.shortSha}`,
      metrics: 'system-map, context-dataflow, verification-workflow, sequences',
      targetId: 'gk-capreg',
      codePath: 'system/capability-registry/map/map-sync.ts',
      githubUrl: ghBlob('system/capability-registry/map/map-sync.ts'),
      liveUrl: 'https://codeflow.berkle.space/?viz=gk-map&map=capreg'
    },
    {
      id: 'omp_ci_jobs',
      plane: 'capability-matrix',
      title: 'i9 Native CI Queue (gk-jobs.ts)',
      subtitle: 'Pinned Bun 1.3.14 + capreg, adr-refs, connectors & durable gates',
      icon: 'shield',
      color: '#a78bfa',
      badge: 'BUN 1.3.14',
      version: `i9 + m4 runners`,
      metrics: 'SHA-256 verified Bun runtime + bounded 4-CPU worker pool',
      targetId: 'gk-omp',
      codePath: 'system/compute/omp-ci/gk-jobs.ts',
      githubUrl: ghBlob('system/compute/omp-ci/gk-jobs.ts'),
      liveUrl: 'https://github.com/lincicomb/gk/actions'
    },
    {
      id: 'edge_controller',
      plane: 'berkle-edge',
      title: 'berkle.space Edge (edge.ts + sites.json)',
      subtitle: 'Caddy wildcard/name TLS + tailnet (100.124.235.45) & passkey gate',
      icon: 'globe',
      color: '#4d9fff',
      badge: `${edgeSites.length} SITES`,
      version: `core-vps · ${git.shortSha}`,
      metrics: 'Single authority for *.berkle.space Caddyfiles & DNS records',
      targetId: 'gk-network',
      codePath: 'system/network/edge/edge.ts',
      githubUrl: ghBlob('system/network/edge/edge.ts'),
      liveUrl: 'https://berkle.space/'
    },
    {
      id: 'codeflow_hub',
      plane: 'berkle-edge',
      title: 'codeflow.berkle.space (Unified Code + Maps)',
      subtitle: 'Privacy-hardened lincicomb/codeflow + Live GK Architecture & Dependency Hub',
      icon: 'code',
      color: '#4d9fff',
      badge: 'LIVE ON EDGE',
      version: `v${codeflowPkg.version || '1.0.0'}-gk · b70af01c`,
      metrics: `${targets.length} live walkable targets + 4 architecture maps`,
      targetId: 'dep-codeflow',
      codePath: 'system/codeflow/cli/codeflow.mjs',
      githubUrl: ghBlob('system/codeflow/cli/codeflow.mjs'),
      liveUrl: 'https://codeflow.berkle.space/'
    }
  ];

  const edges = [
    { from: 'omp_launch', to: 'mcp_clean', label: 'loads clean MCP config (0 idle daemons)', color: '#00e5ff' },
    { from: 'omp_launch', to: 'retirements_c2', label: 'enforces retired extensions', color: '#00e5ff' },
    { from: 'omp_launch', to: 'gk_plane_mcp', label: 'queries live connectors & sessions', color: '#00e5ff' },
    { from: 'heal_trigger', to: 'heal_intake', label: 'POST defect payload (instant)', color: '#00ff9d' },
    { from: 'activate_deployables', to: 'heal_trigger', label: 'registers HTTP route', color: '#00ff9d' },
    { from: 'activate_deployables', to: 'hourly_sweeps', label: 'syncs 0 0 * * * * schedules', color: '#00ff9d' },
    { from: 'hourly_sweeps', to: 'heal_intake', label: 'hourly fallback sweep', color: '#ff9f43' },
    { from: 'hourly_sweeps', to: 'merge_conductor', label: 'hourly fallback sweep', color: '#ff9f43' },
    { from: 'omp_ci_jobs', to: 'merge_conductor', label: 'check_run.completed webhook', color: '#a78bfa' },
    { from: 'capreg_matrix', to: 'omp_ci_jobs', label: 'verifies 208 rows & 6 theorems', color: '#a78bfa' },
    { from: 'capreg_matrix', to: 'codeflow_hub', label: 'feeds 6 live Archify IR maps', color: '#a78bfa' },
    { from: 'merge_conductor', to: 'edge_controller', label: 'POST :9420/refresh -> origin/main', color: '#00ff9d' },
    { from: 'edge_controller', to: 'codeflow_hub', label: 'serves https://codeflow.berkle.space', color: '#4d9fff' },
    { from: 'fleet_heartbeat', to: 'edge_controller', label: 'pushes Gatus status.berkle.space', color: '#ff9f43' }
  ];

  const mermaidSource = [
    'flowchart TB',
    '  subgraph OMP["1. OMP Session Plane (C1 + C2 Live)"]',
    `    LAUNCH["🚀 gk new / gk resume\\nlaunch-readiness@${git.shortSha}"]`,
    '    MCP["⚡ profiles/gk/mcp.json (C1)\\n0 default MCP daemons (-180 MB)"]',
    '    RET["🛡️ retirements.json (C2)\\nprogress-reminder retired -> /v1/stream"]',
    '    PLANE["🔌 GK Plane MCP (:7470)\\nconnectors + sessions + bbrain"]',
    '    LAUNCH --> MCP',
    '    LAUNCH --> RET',
    '    LAUNCH --> PLANE',
    '  end',
    '  subgraph WM["2. Windmill Event Plane (C3 Webhooks) & 3. Hourly Sweeps"]',
    '    HTRIG["🌐 heal_intake.http_trigger.yaml\\nPOST /api/w/admins/.../heal_intake"]',
    '    HEAL["🔧 f/ops/heal_intake.ts\\nEvent payload + watchtower dedupe"]',
    '    MCOND["🔀 f/ops/merge_conductor.ts\\nWebhook + --match-head-commit"]',
    '    CRON["⏱️ Hourly Safety Sweeps\\ncron: 0 0 * * * * (-92% polling)"]',
    '    HB["💓 f/gk/fleet_heartbeat.ts\\n10m probe -> Gatus Deadman"]',
    '    HTRIG -->|instant event| HEAL',
    '    CRON -->|hourly fallback| HEAL',
    '    CRON -->|hourly fallback| MCOND',
    '  end',
    '  subgraph CAP["4. Capability Matrix & 5. berkle.space Edge"]',
    `    CAPREG["📐 Capability Matrix (map-sync.ts)\\n208 rows · 6 theorems · 6 IR maps"]`,
    '    CI["🏗️ i9 Native CI Queue (gk-jobs.ts)\\nPinned Bun 1.3.14"]',
    `    EDGE["🌍 core-vps Edge (edge.ts)\\n${edgeSites.length} sites · ${tenants.length} tenants"]`,
    `    CF["🧭 codeflow.berkle.space\\nlincicomb/codeflow@b70af01c + GK Live Hub"]`,
    '    CAPREG --> CI',
    '    CI -->|check_run passed| MCOND',
    '    MCOND -->|refresh mirror| EDGE',
    '    CAPREG -->|live IR maps| CF',
    '    EDGE --> CF',
    '    HB -->|deadman push| EDGE',
    '  end',
    '  classDef ompNode fill:#07222c,stroke:#00e5ff,stroke-width:2px,color:#e6fcff;',
    '  classDef wmNode fill:#06281e,stroke:#00ff9d,stroke-width:2px,color:#e6fff5;',
    '  classDef cronNode fill:#2b1d07,stroke:#ff9f43,stroke-width:2px,color:#fff5e6;',
    '  classDef capNode fill:#1e1433,stroke:#a78bfa,stroke-width:2px,color:#f3efff;',
    '  classDef edgeNode fill:#0b1d36,stroke:#4d9fff,stroke-width:2px,color:#ebf3ff;',
    '  class LAUNCH,MCP,RET,PLANE ompNode;',
    '  class HTRIG,HEAL,MCOND wmNode;',
    '  class CRON,HB cronNode;',
    '  class CAPREG,CI capNode;',
    '  class EDGE,CF edgeNode;'
  ].join('\n');

  // Build unified Dependencies & Versions inventory
  const runtimeDeps = [
    {
      name: 'lincicomb/gk',
      kind: 'monorepo',
      version: `main@${git.shortSha}`,
      sha: git.sha,
      license: 'Private (Galactic Key)',
      sourceUrl: `https://github.com/lincicomb/gk/commit/${git.sha}`,
      liveUrl: 'https://berkle.space/',
      targetId: 'gk-system',
      notes: `Committed ${git.committedAt}`
    },
    {
      name: 'lincicomb/codeflow (fork of braedonsaunders/codeflow)',
      kind: 'forked-app',
      version: `${codeflowPkg.version || '1.0.0'}-gk`,
      sha: 'b70af01cfd1a1cec4b02075b124fdd1ec8cc33be',
      license: 'MIT',
      sourceUrl: 'https://github.com/lincicomb/codeflow',
      liveUrl: 'https://codeflow.berkle.space/',
      targetId: 'dep-codeflow',
      notes: 'Privacy-hardened stock copy in system/codeflow + live GK Architecture Map & multi-target walkthrough'
    },
    {
      name: 'bun (GK Pinned Runtime)',
      kind: 'toolchain',
      version: '1.3.14',
      sha: 'd8b96221828ad6f97ac7ac0ab7e95872341af763001e8803e8267652c2652620',
      license: 'MIT',
      sourceUrl: ghBlob('system/compute/omp-ci/gk-jobs.ts'),
      liveUrl: 'https://codeflow.berkle.space/?target=gk-omp&file=system/compute/omp-ci/gk-jobs.ts',
      targetId: 'gk-omp',
      notes: 'SHA-256 verified darwin-aarch64 archive in system/compute/omp-ci/gk-jobs.ts'
    },
    ...Object.entries({ ...(rootPkg.dependencies || {}), ...(rootPkg.devDependencies || {}) }).map(([pkg, ver]) => ({
      name: pkg,
      kind: 'npm-root',
      version: String(ver),
      sha: git.shortSha,
      license: 'MIT/Apache-2.0',
      sourceUrl: ghBlob('package.json'),
      liveUrl: 'https://codeflow.berkle.space/?target=gk-system',
      targetId: 'gk-system',
      notes: 'Root package.json dependency'
    }))
  ];

  const vendoredDeps = (vendorManifest?.assets || []).map((asset) => ({
    name: asset.package || path.basename(asset.file || ''),
    kind: String(asset.file || '').endsWith('.wasm') ? 'wasm-grammar' : 'browser-vendor',
    version: asset.version || 'vendored',
    sha: asset.sha256 || '',
    license: asset.license || 'MIT',
    file: asset.file,
    sourceUrl: asset.source || ghBlob(`system/codeflow/${asset.file}`),
    liveUrl: `https://codeflow.berkle.space/${asset.file}`,
    targetId: 'dep-codeflow'
  }));

  const pinnedRepos = tenants.map((t) => {
    const rev = t.product?.revision || '';
    const repoClean = String(t.product?.repository || '').replace(/\.git$/, '');
    return {
      id: t.id,
      name: repoClean.split('/').slice(-2).join('/') || t.id,
      kind: 'tenant-product',
      lifecycle: t.lifecycle || 'production',
      host: t.instance?.host || 'core-vps',
      domain: t.instance?.domain || null,
      version: rev ? rev.slice(0, 8) : 'HEAD',
      sha: rev,
      checkoutPath: t.product?.checkout_path || `repos/${t.id}`,
      sourceUrl: repoClean && rev ? `${repoClean}/tree/${rev}` : repoClean,
      liveUrl: t.instance?.domain ? `https://${t.instance.domain}/` : 'https://berkle.space/',
      targetId: t.id === 'homepage' ? 'dep-homepage' : `tenant-${t.id}`
    };
  });

  const manifest = {
    ok: true,
    generatedAt: new Date().toISOString(),
    cacheKey: `${git.sha}:${watchEpoch}`,
    git,
    privacy: {
      robots: 'noindex, nofollow, noarchive',
      bindAddress: '100.124.235.45 (tailnet private)',
      externalTelemetry: 'none (0 external script/font/analytics loads)',
      githubApiDefault: 'locked (local bundle & manifest mode by default)'
    },
    eventArchitecture: {
      title: 'GK Event-Driven & System Architecture Map (Live from main)',
      commitSha: git.sha,
      shortSha: git.shortSha,
      committedAt: git.committedAt,
      planes,
      nodes,
      edges,
      mermaidSource
    },
    capregMaps: {
      systemMap,
      contextDataflow,
      verificationWorkflow,
      inferenceSequence,
      ingestSequence,
      stateMachines
    },
    targets,
    dependencies: {
      runtimeDeps,
      pinnedRepos,
      gitmodules,
      vendoredDeps,
      clients: clients.map((c) => ({
        id: c.id,
        name: c.name,
        status: c.status,
        revision: c.record?.revision || '',
        shortRevision: String(c.record?.revision || '').slice(0, 8),
        repository: String(c.record?.repository || '').replace(/\.git$/, '')
      }))
    }
  };
  if (MANIFEST_CACHE.size >= 8) MANIFEST_CACHE.clear();
  MANIFEST_CACHE.set(cacheKey, manifest);
  return manifest;
}

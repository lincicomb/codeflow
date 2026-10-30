import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const htmlPath = join(__dirname, '..', 'index.html');

test('UI Coherence Gate 1 (Images #1, #2, #3, #4): single unified source switcher & compact DataGrid-style toolbar without split-brain selectors', async () => {
  const html = await readFile(htmlPath, 'utf8');
  assert.doesNotMatch(
    html,
    /createElement\('select',\{className:'gk-target-select'/,
    'STOP: Do not render a separate native <select class="gk-target-select"> alongside .repo-input (split-brain repo selector in Image #1). Use the unified Source Switcher popover (.source-switcher) that shows ONLY the active repository/target.'
  );
  assert.match(
    html,
    /className:'source-switcher/,
    'STOP: Topbar must use the unified single-source Command/Combobox switcher (.source-switcher) combining GK targets, recent repos, and GitHub owner/repo search.'
  );
});

test('UI Coherence Gate 2 (Images #4, #8, #9, #10): custom dark checkmark popovers instead of native OS <select> menus', async () => {
  const html = await readFile(htmlPath, 'utf8');
  assert.doesNotMatch(
    html,
    /createElement\('select',\{className:'viz-select'/,
    'STOP: Do not use native <select class="viz-select"> (Images #9, #10). Use the custom dark popover menu (.cf-popover-menu / .cf-popover-item) with SVG icons and a checkmark.'
  );
  assert.doesNotMatch(
    html,
    /createElement\('select',\{className:'auth-select'/,
    'STOP: Do not use native <select class="auth-select"> (Image #8). Use the custom dark popover menu with SVG icons and a checkmark.'
  );
});

test('UI Coherence Gate 3 (Images #1, #2, #7, #21): words lead on every control — never hide button labels behind !data&&', async () => {
  const html = await readFile(htmlPath, 'utf8');
  const bannedConditionalLabels = [
    "!data&&'Excludes'",
    "!data&&'Analyze'",
    "!data&&'Open Folder'",
    "!data&&'Open ZIP'",
    "!data&&'PR'",
    "!data&&'Export'",
    "!data&&'Share'",
    "!data&&(theme==="
  ];
  for (const snippet of bannedConditionalLabels) {
    assert.equal(
      html.includes(snippet),
      false,
      `STOP: Found "${snippet}" which strips visible text labels once data loads (mystery icon-only buttons in Images #1, #7, #21). Words must lead on every control at all times.`
    );
  }
});

test('UI Coherence Gate 4 (Images #16, #21): .graph-config sliders never overflow right border', async () => {
  const html = await readFile(htmlPath, 'utf8');
  assert.match(
    html,
    /\.config-slider\{[^}]*min-width:\s*0/,
    'STOP: .config-slider must declare min-width:0 so range inputs never push .config-value numbers (200, 70, 1) outside the .graph-config popover border (Image #16).'
  );
});

test('UI Coherence Gate 5 (Images #6, #17, #18, #21): zero horizontal scrollbar tracks in sidebar cards and zero Download .patch / Click for details spam', async () => {
  const html = await readFile(htmlPath, 'utf8');
  for (const bannedText of ['Download all .patch', 'Download file .patch', 'Download .patch', 'Click for details (']) {
    assert.equal(
      html.includes(bannedText),
      false,
      `STOP: Found banned slop string "${bannedText}" (Images #6, #17, #18, #21). Use compact expandable KokonutUI/DataGrid rows with copy/preview actions instead of patch-download spam.`
    );
  }
  assert.doesNotMatch(
    html,
    /\.security-code\{[^}]*overflow-x:\s*auto;\s*white-space:\s*pre\b/,
    'STOP: .security-code must wrap cleanly (white-space:pre-wrap; overflow-wrap:anywhere) so sidebar cards never render horizontal scrollbar tracks (Images #17, #18, #21).'
  );
});

test('UI Coherence Gate 6 (Images #5, #11, #12, #13, #15, #19, #20): official icons in Overview legend, compact symbol bar, and collision-free node labels', async () => {
  const html = await readFile(htmlPath, 'utf8');
  assert.equal(
    html.includes("renderFileTypeIcon('file'+l.ext"),
    false,
    "STOP: renderOverviewPane passed 'file'+l.ext without a dot, causing all language legend items to show generic file icons (Image #11). Pass 'file.'+String(l.ext).replace(/^\\./,'') instead."
  );
  assert.equal(
    html.includes('Open files from leftover nodes or the Files tree. Open cards stay put.'),
    false,
    'STOP: Do not render the verbose 4-line .code-canvas-hint instructional paragraph over the canvas (Image #13).'
  );
});

test('UI Coherence Gate 7 (Unified CodeFlow Workspace, KokonutUI Repo Provenance Switcher, Deployment Card, Infinite Canvas Code Cards & Interactive Architecture Map): zero duplicate bolted-on screens', async () => {
  const html = await readFile(htmlPath, 'utf8');
  assert.doesNotMatch(
    html,
    /function renderGkArchitectureMapView\(|function renderGkDependenciesView\(|var GK_QUICK_VIEWS=/,
    'STOP: Never bolt on separate custom screens (gk-map / gk-deps / GK_QUICK_VIEWS) that duplicate CodeFlow views. Integrate GK targets and architecture directly into CodeFlow native views.'
  );
  assert.match(html, /function renderProvenanceDeploymentCard\(/, 'STOP: KokonutUI Provenance Deployment Card must render in Overview and Source Switcher.');
  assert.match(html, /className:'koko-repo-row/, 'STOP: Source Switcher must render KokonutUI repository rows with provenance badge, repoSlug, checkoutPath, and branch@sha.');
  assert.match(html, /className:'koko-deploy-card'/, 'STOP: KokonutUI deployment card must be present.');
  assert.match(html, /className:'code-card-ext-pill'/, 'STOP: Code Cards must render KokonutUI header with file extension badge, folder path, line/fn count, and close button.');
  assert.match(html, /className:'code-card-close-btn'/, 'STOP: Code Cards must provide a close button on the infinite canvas.');
  assert.match(html, /function enhanceArchitectureSvg\(/, 'STOP: Native Architecture Map must enhance Mermaid SVG nodes with click-to-inspect handlers and GK Event Plane toggle.');
  assert.match(html, /className:'arch-mode-bar'/, 'STOP: Native Architecture Map must provide the Codebase vs GK Event & Plane Map mode bar.');
});

test('UI Coherence Gate 8 (27-inch Camera Fit, Trackpad Pinch/Pan, Light/Dark Contrast, Backlit Buttons & File-Type Graph Key): zero regression across all views', async () => {
  const html = await readFile(htmlPath, 'utf8');
  assert.match(html, /--hud-bg:/, 'STOP: HUD CSS tokens (--hud-bg, --hud-border, --btn-backlit) must be defined for both Dark and Light themes.');
  assert.match(html, /function filterByFileType\(/, 'STOP: Interactive File Type graph key filtering (filterByFileType) must be present.');
  assert.match(html, /'Graph Key · File Types'/, 'STOP: Graph Key legend must include File Types with extension pills and counts.');
  assert.match(html, /className:'nc-ring'|\('class','nc-ring'\)/, 'STOP: Dependency graph nodes must render dual-ring visual encoding (.nc-ring + .nc + .node-ext-badge).');
  assert.match(html, /addEventListener\('gesturechange',onGestureChange/, 'STOP: Safari/macOS trackpad pinch gesture support must be wired alongside ctrlKey/metaKey wheel zoom.');
  assert.match(html, /var warmTicks=isLargeGraph\?24:48;/, 'STOP: Dependency graph must pre-warm simulation ticks and auto-fit camera into the safe viewport area.');
});

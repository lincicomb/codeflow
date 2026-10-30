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

test('UI Coherence Gate 7 (Image #1 & 1A/2A/3A/4A): full-bleed .gk-view stage, 2D Archify Stage + AnimatedBeams, RunTrace waterfall, 6-col Bento WidgetGrid, 4-edge ToolDock, ReviewPins, and Gate-verified CollabToolbar', async () => {
  const html = await readFile(htmlPath, 'utf8');
  assert.match(
    html,
    /\.main:has\(\.gk-view\)\s*>\s*\.sidebar:not\(\.mobile-visible\),\s*\.main:has\(\.gk-view\)\s*>\s*\.right-panel:not\(\.mobile-visible\)\{display:none!important\}/,
    'STOP: .main:has(.gk-view) must auto-collapse empty left/right sidebars on desktop so .gk-inner gets full-bleed width without right-edge clipping (Image #1).'
  );
  assert.match(html, /function gkRenderInteractiveIrStage\(map,mapKey\)/);
  assert.match(html, /function gkRenderSequenceWaterfall\(map,mapKey\)/);
  assert.match(html, /function gkRenderToolDock\(\)/);
  assert.match(html, /function gkRenderCollabBar\(\)/);
  assert.match(html, /className:'gk-bento-grid'/);
  assert.match(html, /className:'gk-tabstrip-row'/);
  assert.match(html, /className:'gk-guided-bar'/);
  assert.match(html, /className:'gk-filter-bar'/);
});

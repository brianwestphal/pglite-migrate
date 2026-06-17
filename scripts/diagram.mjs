#!/usr/bin/env node
/**
 * Render the README's architecture diagram to a self-contained SVG.
 *
 *   npm run diagram        # (re)generate assets/diagram.svg
 *
 * The diagram is authored as plain HTML/CSS and captured with `domotion-svg`,
 * so it stays crisp at any width and embeds with no external assets. Editing the
 * picture means editing the HTML below and re-running this script. Capturing
 * drives headless Chromium via Playwright (domotion installs it on first use).
 */
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOMOTION = join(ROOT, 'node_modules', '.bin', 'domotion');
const OUT = join(ROOT, 'assets', 'diagram.svg');

const WIDTH = 900;
const HEIGHT = 320;

const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box}
  html,body{margin:0}
  .diagram{width:${WIDTH}px;height:${HEIGHT}px;padding:30px 34px;
    background:radial-gradient(140% 140% at 0% 0%,#161d2b 0%,#0d1117 60%);
    border:1px solid #21262d;border-radius:16px;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    display:grid;grid-template-columns:1fr auto 1fr;grid-template-rows:auto auto;
    column-gap:22px;row-gap:26px;align-items:center}
  .card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:18px 20px;
    box-shadow:0 8px 24px rgba(1,4,9,.5)}
  .card .badge{display:inline-block;font:700 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;
    letter-spacing:.08em;padding:5px 9px;border-radius:999px}
  .pg17 .badge{color:#0d1117;background:#d29922}
  .pg18 .badge{color:#0d1117;background:#3fb950}
  .card h3{color:#e6edf3;font-size:19px;margin:13px 0 4px;font-weight:700}
  .card .dir{color:#8b949e;font:13px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}
  /* Three stacked rows with explicit gaps — no absolute positioning or negative
     margins, so a label can never collide with the arrow line (PGLM-36). */
  .flow{display:flex;flex-direction:column;align-items:center;width:240px;text-align:center;gap:15px}
  .flow .top{color:#7ee787;font:600 12px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace}
  .flow .bot{color:#8b949e;font:13px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace}
  .arrowrow{display:flex;align-items:center;width:100%}
  .arrowrow .seg{flex:1 1 auto;height:2px;background:#3fb950}
  .arrowrow .pill{flex:0 0 auto;margin:0 8px;background:#0d1117;border:1px solid #2ea043;
    border-radius:999px;color:#3fb950;font:600 12px/1 ui-monospace,SFMono-Regular,Menlo,monospace;
    padding:6px 12px;white-space:nowrap}
  .arrowrow .head{flex:0 0 auto;width:0;height:0;margin-left:-1px;
    border:6px solid transparent;border-left-color:#3fb950;border-right:0}
  .refuse{grid-column:1 / -1;display:flex;align-items:center;gap:11px;justify-content:center;
    color:#f85149;font:13px/1 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap}
  .refuse .x{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;
    border:1.5px solid #f85149;border-radius:50%;font-weight:700;font-size:12px;flex:0 0 auto}
</style></head><body>
  <div class="diagram">
    <div class="card pg17"><span class="badge">PG 17</span><h3>old PGlite</h3><div class="dir">source data dir</div></div>
    <div class="flow">
      <div class="top">introspect &rarr; topo-sort</div>
      <div class="arrowrow"><span class="seg"></span><span class="pill">COPY (text)</span><span class="seg"></span><span class="head"></span></div>
      <div class="bot">realign sequences &middot; validate</div>
    </div>
    <div class="card pg18"><span class="badge">PG 18</span><h3>new PGlite</h3><div class="dir">target data dir</div></div>
    <div class="refuse"><span class="x">&times;</span>a PG18 engine physically can&rsquo;t open a PG17 data directory &mdash; the failure pglite-migrate bridges</div>
  </div>
</body></html>`;

async function main() {
  const work = await mkdtemp(join(tmpdir(), 'dm-diagram-'));
  try {
    const html = join(work, 'diagram.html');
    await writeFile(html, HTML);
    const r = spawnSync(
      DOMOTION,
      ['capture', html, '--selector', '.diagram', '--width', String(WIDTH + 8), '--height', String(HEIGHT + 8), '--optimize', '-o', OUT],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
    );
    if (r.status !== 0) throw new Error(`domotion capture failed (exit ${r.status})`);
    process.stdout.write(`Wrote ${OUT}\n`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

/**
 * HTML scaffolding for the animated README demos.
 *
 * Each demo is two frames composed by `domotion animate`: a title card that
 * introduces the concept, then a macOS-style terminal window that types the
 * command and reveals the *real* captured CLI output. Both frames share one
 * canvas size so the crossfade between them is seamless.
 *
 * Nothing here renders pixels — it only emits the HTML/CSS that domotion
 * captures in Chromium. Keep the colors aligned with GitHub's dark theme so the
 * SVGs read well against the README.
 */

/** Shared canvas width for every demo SVG (px). */
export const WIDTH = 760;

/** Terminal vertical metrics (px) — used to size the canvas to the content. */
const BAR_H = 38;
const BODY_PAD_TOP = 18;
const BODY_PAD_BOTTOM = 20;
const CMD_LINE_H = 26;
const CMD_GAP = 12;
const LINE_H = 23;

/** Height that fits a terminal with `lineCount` output lines. */
export function terminalHeight(lineCount) {
  return BAR_H + BODY_PAD_TOP + CMD_LINE_H + CMD_GAP + lineCount * LINE_H + BODY_PAD_BOTTOM;
}

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Wrap one captured output line in a colored `<div>`. The text is verbatim from
 * the CLI; only presentation classes are added.
 */
function lineToHtml(line) {
  const table = line.match(/^(\s*)(public\.\w+)(:\s*\d+\s*rows)\s*$/);
  if (table) {
    return `<div class="line indent"><span class="tbl">${esc(table[2])}</span>${esc(table[3])}</div>`;
  }
  let cls = '';
  if (/^Migrating /.test(line) || /^Backed up /.test(line)) cls = 'muted';
  else if (/^DRY RUN/.test(line)) cls = 'warn';
  else if (/^(Done|Plan):/.test(line)) cls = 'ok';
  else if (/^Validation\b.*:\s*OK\.\s*$/.test(line)) cls = 'ok';
  else if (/^Validation\b/.test(line)) cls = 'err';
  return `<div class="line ${cls}">${esc(line)}</div>`;
}

const SHELL = `
  *{box-sizing:border-box}
  html,body{margin:0;background:#010409}
  .stage{width:${WIDTH}px;display:flex;flex-direction:column}
`;

/** The introductory title card. */
export function titleCardHtml({ eyebrow, headline, subtitle, height }) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  ${SHELL}
  .stage{height:${height}px;justify-content:center;align-items:center;
    background:radial-gradient(130% 130% at 0% 0%,#1b2433 0%,#0d1117 58%);
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;text-align:center}
  .eyebrow{color:#7ee787;font:600 12px/1 ui-monospace,SFMono-Regular,Menlo,monospace;
    letter-spacing:.24em;text-transform:uppercase}
  h1{color:#e6edf3;font-size:30px;line-height:1.15;margin:14px 0 0;font-weight:700}
  p{color:#8b949e;font-size:15px;line-height:1.5;margin:11px 0 0;max-width:540px}
  </style></head><body><div class="stage">
    <div class="eyebrow">${esc(eyebrow)}</div>
    <h1>${headline}</h1>
    <p>${esc(subtitle)}</p>
  </div></body></html>`;
}

/**
 * The terminal window. The command line is intentionally empty in the DOM — the
 * `typing` overlay draws it character by character — and `.out` starts visible
 * so domotion captures it, then the per-frame opacity animation hides it until
 * the command has finished "running".
 */
export function terminalHtml({ title, outputLines, height }) {
  const out = outputLines.map(lineToHtml).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  ${SHELL}
  .stage{height:${height}px;background:#0d1117}
  .bar{height:${BAR_H}px;display:flex;align-items:center;gap:8px;padding:0 14px;
    background:#161b22;border-bottom:1px solid #21262d;flex:0 0 auto}
  .dot{width:12px;height:12px;border-radius:50%}
  .r{background:#ff5f56}.y{background:#febc2e}.g{background:#28c840}
  .name{color:#8b949e;font:12px/1 ui-monospace,SFMono-Regular,Menlo,monospace;margin-left:8px}
  .body{padding:${BODY_PAD_TOP}px 20px ${BODY_PAD_BOTTOM}px;
    font:15px/1 ui-monospace,SFMono-Regular,Menlo,monospace;color:#e6edf3}
  .cmdline{height:${CMD_LINE_H}px;display:flex;align-items:center}
  .prompt{color:#7ee787;margin-right:9px;font-weight:600}
  .cmd{display:inline-block;min-width:1px}
  .out{margin-top:${CMD_GAP}px;opacity:1}
  .line{height:${LINE_H}px;line-height:${LINE_H}px;white-space:pre}
  .indent{padding-left:18px}
  .muted{color:#8b949e}.warn{color:#febc2e}.ok{color:#3fb950}.err{color:#f85149}
  .tbl{color:#79c0ff}
  </style></head><body><div class="stage">
    <div class="bar"><span class="dot r"></span><span class="dot y"></span><span class="dot g"></span><span class="name">${esc(title)}</span></div>
    <div class="body">
      <div class="cmdline"><span class="prompt">$</span><span class="cmd"></span></div>
      <div class="out">${out}</div>
    </div>
  </div></body></html>`;
}

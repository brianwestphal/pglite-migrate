#!/usr/bin/env node
/**
 * Deterministic git analysis for a technical changelog (see the
 * `technical-changelog` skill). Grounds the report in the *actual* diff, not
 * commit prose: it finds the base tag, buckets the line delta by area
 * (product vs docs vs scaffolding vs generated assets), classifies files
 * added/modified/removed, and surfaces the concrete public-surface deltas
 * (API exports, package entry points, CLI flags, dependencies).
 *
 *   node scripts/changelog-analysis.mjs [--base <tag>] [--next <version>]
 *   npm run changelog-analysis -- --next 1.1.0
 *
 * --base   Override the auto-detected base tag (default: the most recent
 *          production release tag reachable from HEAD, pre-releases excluded).
 * --next   The next planned release number (HEAD is unreleased, so this can't
 *          be read from package.json). Only used to suggest the output path.
 * --head   Override the head ref (default: HEAD).
 *
 * Prints a human-readable report to stdout. Writes nothing — the skill reads
 * this, then reads the real per-file diffs, then authors the document.
 */
import { execFileSync } from 'node:child_process';

function git(args) {
  // stderr is piped, not inherited: probes like `git show <base>:<new-file>` are
  // *expected* to fail, and their "fatal:" noise must not pollute the report.
  return execFileSync('git', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}
function gitOk(args) {
  try {
    return git(args).trim();
  } catch {
    return null;
  }
}

/** Strip comments so TSDoc (`{@link foo}`) can't be mistaken for source code. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--base') out.base = argv[++i];
    else if (argv[i] === '--next') out.next = argv[++i];
    else if (argv[i] === '--head') out.head = argv[++i];
  }
  return out;
}

/** Semver-ish compare for tags like `v1.2.3` (pre-releases sort lower). */
function cmpTag(a, b) {
  const norm = (t) => t.replace(/^v/, '');
  const [av, ap = '~'] = norm(a).split('-');
  const [bv, bp = '~'] = norm(b).split('-');
  const ap2 = av.split('.').map(Number);
  const bp2 = bv.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((ap2[i] || 0) !== (bp2[i] || 0)) return (ap2[i] || 0) - (bp2[i] || 0);
  }
  // no pre-release ('~') outranks a pre-release ('-beta') at the same version
  return ap < bp ? -1 : ap > bp ? 1 : 0;
}

/**
 * The most recent *production* release tag that is an ancestor of HEAD.
 * Production = a `vX.Y.Z` tag with no pre-release suffix (`-beta`, `-rc`, …).
 */
function latestProductionTag(head) {
  const tags = git(['tag', '--list', 'v*'])
    .split('\n')
    .map((t) => t.trim())
    .filter(Boolean)
    .filter((t) => /^v\d+\.\d+\.\d+$/.test(t)) // strict production semver, no suffix
    .filter((t) => gitOk(['merge-base', '--is-ancestor', t, head]) !== null);
  tags.sort(cmpTag);
  return tags.length > 0 ? tags[tags.length - 1] : null;
}

/**
 * Classify a changed path into a reporting area + whether it's product code.
 *
 * The split exists so the report never presents the raw line total as
 * engineering effort: docs, agent/skill scaffolding and generated SVG assets
 * routinely dwarf the actual code delta in this repo.
 */
function classify(path) {
  if (/^src\/engines(\.ts|\/)/.test(path)) return { area: 'src/engines (subsystem)', product: true };
  if (/^src\//.test(path)) return { area: 'src (other)', product: true };
  if (/^tests\/e2e\//.test(path)) return { area: 'tests (e2e)', product: true };
  if (/^tests\//.test(path)) return { area: 'tests (unit)', product: true };
  if (/^scripts\//.test(path)) return { area: 'scripts', product: true };
  if (/^assets\//.test(path)) return { area: 'assets (generated)', product: false };
  if (/^docs\//.test(path)) return { area: 'docs', product: false };
  if (/^\.(claude|agents|gemini|hotsheet|glassbox)\//.test(path)) {
    return { area: 'agent/skill scaffolding', product: false };
  }
  if (/^\.github\//.test(path)) return { area: 'CI', product: false };
  return { area: 'other (README/config)', product: false };
}

/**
 * Exported names of a barrel file at a ref, as a Set.
 *
 * Comparing the *sets* at base and head is more honest than scraping `+`/`-`
 * diff lines: a re-sorted or re-wrapped export block produces diff churn but no
 * actual public-surface change, and the set comparison ignores it.
 */
function exportedNames(ref, file) {
  const raw = gitOk(['show', `${ref}:${file}`]);
  if (raw === null) return null;
  const src = stripComments(raw);
  const names = new Set();
  // `export { a, type B, c as d } from '...'` / `export type { ... }`
  for (const m of src.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const raw of m[1].split(',')) {
      const part = raw.trim().replace(/^type\s+/, '');
      if (part === '') continue;
      // `x as y` exports `y`
      const alias = /\s+as\s+/.test(part) ? part.split(/\s+as\s+/)[1] : part;
      names.add(alias.trim());
    }
  }
  // Direct declarations: `export function f`, `export class C`, `export const K`, …
  for (const m of src.matchAll(
    /export\s+(?:declare\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|enum|type)\s+([A-Za-z_$][\w$]*)/g,
  )) {
    names.add(m[1]);
  }
  return names;
}

/** Subpath keys of package.json `exports` at a ref. */
function exportSubpaths(ref) {
  try {
    const pj = JSON.parse(git(['show', `${ref}:package.json`]));
    return new Set(Object.keys(pj.exports ?? {}));
  } catch {
    return new Set();
  }
}

/** All `--flag` tokens appearing in a file at a ref. */
function cliFlags(ref, file) {
  const src = gitOk(['show', `${ref}:${file}`]);
  if (src === null) return null;
  // Comments are kept here on purpose: the USAGE string documents every flag,
  // and a flag mentioned only in help text is still part of the CLI surface.
  return new Set([...src.matchAll(/--[a-z][a-z0-9-]+/g)].map((m) => m[0]));
}

function diffSets(before, after) {
  const added = [...after].filter((x) => !before.has(x)).sort();
  const removed = [...before].filter((x) => !after.has(x)).sort();
  return { added, removed };
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}
function padL(s, n) {
  s = String(s);
  return s.length >= n ? s : ' '.repeat(n - s.length) + s;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const head = args.head ?? 'HEAD';
  const base = args.base ?? latestProductionTag(head);

  if (base === null) {
    console.error(
      'No production release tag (vX.Y.Z) found as an ancestor of HEAD.\n' +
        'Pass one explicitly with --base <tag>.',
    );
    process.exit(1);
  }

  const range = `${base}..${head}`;
  const baseInfo = git(['log', '-1', '--format=%h %ci %s', base]).trim();
  const headInfo = git(['log', '-1', '--format=%h %ci %s', head]).trim();
  const commitCount = git(['rev-list', '--count', range]).trim();

  // All production tags, to warn if a newer one exists that isn't the base.
  const allProd = git(['tag', '--list', 'v*'])
    .split('\n')
    .map((t) => t.trim())
    .filter((t) => /^v\d+\.\d+\.\d+$/.test(t))
    .sort(cmpTag);
  const newestProd = allProd[allProd.length - 1];

  // numstat by area (--no-renames so a rename reads as delete+add and classifies cleanly)
  const numstat = git(['diff', '--numstat', '--no-renames', range])
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [add, del, ...rest] = l.split('\t');
      return { add: Number(add) || 0, del: Number(del) || 0, path: rest.join('\t') };
    });

  const areas = new Map();
  let prodAdd = 0;
  let prodDel = 0;
  let totAdd = 0;
  let totDel = 0;
  for (const { add, del, path } of numstat) {
    const { area, product } = classify(path);
    const a = areas.get(area) ?? { files: 0, add: 0, del: 0, product };
    a.files++;
    a.add += add;
    a.del += del;
    areas.set(area, a);
    totAdd += add;
    totDel += del;
    if (product) {
      prodAdd += add;
      prodDel += del;
    }
  }

  // A/M/D classification
  const status = git(['diff', '--name-status', '--no-renames', range])
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [st, ...rest] = l.split('\t');
      return { st: st[0], path: rest.join('\t') };
    });
  const added = status.filter((s) => s.st === 'A').map((s) => s.path);
  const removed = status.filter((s) => s.st === 'D').map((s) => s.path);

  // New product source files (candidate "genuinely new subsystems").
  const newProduct = added.filter((p) => classify(p).product && /\.(ts|mjs|js)$/.test(p));
  // New numbered requirements docs — this repo numbers them for linear reading.
  const newDocs = added.filter((p) => /^docs\/\d+-.*\.md$/.test(p));

  // Public API export deltas, per entry point.
  const entryPoints = ['src/index.ts', 'src/engines.ts'];
  const apiDeltas = [];
  for (const file of entryPoints) {
    const before = exportedNames(base, file);
    const after = exportedNames(head, file);
    if (before === null && after === null) continue;
    if (before === null) {
      apiDeltas.push({ file, brandNew: true, added: [...(after ?? [])].sort(), removed: [] });
      continue;
    }
    if (after === null) {
      apiDeltas.push({ file, gone: true, added: [], removed: [...before].sort() });
      continue;
    }
    const d = diffSets(before, after);
    if (d.added.length > 0 || d.removed.length > 0) apiDeltas.push({ file, ...d });
  }

  // Package entry points (`exports` subpaths) — adding one is a public change.
  const subpaths = diffSets(exportSubpaths(base), exportSubpaths(head));

  // CLI flags, compared as sets at base vs head.
  const flagsBefore = cliFlags(base, 'src/cli.ts');
  const flagsAfter = cliFlags(head, 'src/cli.ts');
  const flagDelta =
    flagsBefore !== null && flagsAfter !== null ? diffSets(flagsBefore, flagsAfter) : null;

  // Dependency changes (runtime + dev + peer; peer matters here — PGlite is a peer dep).
  let depDelta = null;
  if (gitOk(['cat-file', '-e', `${head}:package.json`]) !== null) {
    const readDeps = (ref) => {
      try {
        const pj = JSON.parse(git(['show', `${ref}:package.json`]));
        return {
          ...(pj.dependencies ?? {}),
          ...(pj.devDependencies ?? {}),
          ...(pj.peerDependencies ?? {}),
        };
      } catch {
        return {};
      }
    };
    const b = readDeps(base);
    const h = readDeps(head);
    const changed = [];
    for (const k of [...new Set([...Object.keys(b), ...Object.keys(h)])].sort()) {
      if (b[k] !== h[k]) changed.push(`${k}: ${b[k] ?? '(none)'} → ${h[k] ?? '(removed)'}`);
    }
    depDelta = changed;
  }

  // ---- print ----
  const L = [];
  L.push('# Technical Changelog Analysis');
  L.push('');
  L.push(`Base tag (auto):   ${base}   [${baseInfo}]`);
  L.push(`Head:              ${head}   [${headInfo}]`);
  L.push(`Range:             ${range}   (${commitCount} commits)`);
  L.push(`Next version:      ${args.next ?? '(NOT PROVIDED — the skill must ask the user)'}`);
  if (args.next) {
    L.push(
      `Suggested output:  docs/technical-changelog/${base}-v${String(args.next).replace(/^v/, '')}.md`,
    );
  }
  if (newestProd && newestProd !== base) {
    L.push('');
    L.push(
      `⚠️  A newer production tag exists (${newestProd}) but is not the base — confirm ${base} is intended.`,
    );
  }
  L.push('');
  L.push('## Line delta by area  (raw total is misleading — split product vs not)');
  L.push('');
  L.push(`  ${pad('area', 30)} ${padL('files', 6)} ${padL('+add', 8)} ${padL('-del', 8)}  product`);
  const sorted = [...areas.entries()].sort((a, b) => b[1].add - a[1].add);
  for (const [area, a] of sorted) {
    L.push(
      `  ${pad(area, 30)} ${padL(a.files, 6)} ${padL('+' + a.add, 8)} ${padL('-' + a.del, 8)}  ${a.product ? '✅' : '—'}`,
    );
  }
  L.push('');
  L.push(`  TOTAL (raw):        +${totAdd} / -${totDel}   across ${numstat.length} files`);
  L.push(`  PRODUCT CODE ONLY:  +${prodAdd} / -${prodDel}   (src + tests + scripts)`);
  L.push('  → In the report, lead with product-only; label docs/scaffolding separately.');
  L.push('');
  L.push(
    `## Files: ${added.length} added, ${removed.length} removed, ${status.length - added.length - removed.length} modified`,
  );
  L.push('');
  L.push('New product source files (candidate NEW subsystems — verify absent at base):');
  if (newProduct.length === 0) L.push('  (none)');
  for (const p of newProduct) L.push(`  A  ${p}`);
  if (newDocs.length > 0) {
    L.push('');
    L.push('New numbered requirements docs:');
    for (const p of newDocs) L.push(`  A  ${p}`);
  }
  if (removed.length > 0) {
    L.push('');
    L.push('Removed files:');
    for (const p of removed) L.push(`  D  ${p}`);
  }
  L.push('');
  L.push('## Public API export delta (by entry point, set-compared at base vs head)');
  if (apiDeltas.length === 0) {
    L.push('  (no change to exported names)');
  }
  for (const d of apiDeltas) {
    L.push('');
    L.push(`  ${d.file}${d.brandNew ? '   ** NEW ENTRY POINT **' : ''}${d.gone ? '   ** REMOVED **' : ''}`);
    L.push(`    added:   ${d.added.length > 0 ? d.added.join(', ') : '(none)'}`);
    L.push(`    removed: ${d.removed.length > 0 ? d.removed.join(', ') : '(none)'}`);
  }
  L.push('');
  L.push('## Package entry points (package.json "exports" subpaths)');
  L.push(`  added:   ${subpaths.added.length > 0 ? subpaths.added.join(', ') : '(none)'}`);
  L.push(`  removed: ${subpaths.removed.length > 0 ? subpaths.removed.join(', ') : '(none)'}`);
  L.push('');
  L.push('## CLI flag delta (src/cli.ts)');
  if (flagDelta) {
    L.push(`  added:   ${flagDelta.added.length > 0 ? flagDelta.added.join(', ') : '(none)'}`);
    L.push(`  removed: ${flagDelta.removed.length > 0 ? flagDelta.removed.join(', ') : '(none)'}`);
  } else {
    L.push('  (src/cli.ts not found at one end of the range)');
  }
  L.push('');
  L.push('## Dependency changes (dependencies + devDependencies + peerDependencies)');
  if (depDelta && depDelta.length > 0) for (const d of depDelta) L.push(`  ${d}`);
  else L.push('  (none)');
  L.push('');
  L.push('## Next steps for the author (do NOT stop here)');
  L.push(`  1. For each area above, READ THE REAL DIFF: \`git diff ${range} -- <path>\`.`);
  L.push('  2. Verify each "new" claim against the base tree, e.g.');
  L.push(`       \`git cat-file -e ${base}:<file>\`  (absent → genuinely new)`);
  L.push(`       \`git show ${base}:<file> | grep -c <symbol>\`  (0 → added in range)`);
  L.push(`  3. Note what already shipped at ${base} (baseline, NOT a change).`);
  L.push(`  4. Write docs/technical-changelog/${base}-v<next>.md, grounded in the diff.`);
  console.log(L.join('\n'));
}

main();

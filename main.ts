// Token Radar's entrypoint (Node 22, standard library only).
//
// It reads the sealed snapshot from /input/snapshot.json (or --input <file|dir>), runs
// every pre-token protocol through the radar-3 model in lib/model.ts, writes the ranked
// board to /output/board.json and the dashboard's data to /output/data.js, decodes the
// base64 screenshots in screenshots/ into whole PNGs under /output/screenshots, and
// copies this repository's dashboard/ into /output. Finally it writes
// /output/dossier.json, the summary the judge reads, using the vendored make.fun lib.
//
// The dashboard is a static page with no framework and no network: dashboard/index.html,
// dashboard/app.css and dashboard/app.js read /output/data.js, which this program
// writes from the same board, so the page and the board can never disagree.
//
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

/** The scorer's own caps: the text cap sizes the bytes, the rest refuse. */
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** Reads --name <value> from the arguments, or falls back. */
function arg(name: string, fallback: string): string {
  const foundAt = process.argv.indexOf(`--${name}`);
  if (foundAt >= 0 && foundAt + 1 < process.argv.length) return process.argv[foundAt + 1]!;
  const equalsForm = process.argv.find((a) => a.startsWith(`--${name}=`));
  return equalsForm === undefined ? fallback : equalsForm.slice(name.length + 3);
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`token radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input\n`);
  process.exit(2);
}
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const { board, radar } = buildRadar(snapshot);
const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`token radar: the model wrote a board the gate refuses: ${issue}\n`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(out, 'data.js'), dataScript(radar));

/** Copies one directory's regular files into `to`, skipping dotfiles. */
function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const names: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    names.push(name);
  }
  return names;
}

const dashboardFiles = copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));

// The screenshots travel in the repository as base64 text (screenshots/*.png.b64), since the
// repository is pushed as a UTF-8 snapshot and cannot hold binary files; this program decodes
// each one into a whole PNG under /output/screenshots, which the gate and dossier then read.
const shotsDir = join(here, 'screenshots');
const shotFiles = existsSync(shotsDir) ? readdirSync(shotsDir).filter((n) => n.endsWith('.png.b64') && !n.startsWith('.')) : [];
mkdirSync(join(out, 'screenshots'), { recursive: true });
const shots: string[] = [];
for (const name of shotFiles) {
  const fileName = name.slice(0, -4);
  if (!IMAGE_NAME.test(fileName)) {
    process.stderr.write(`token radar: screenshots/${fileName}: a name is letters, digits and . _ -, 1 to 128 characters\n`);
    process.exit(1);
  }
  const png = Buffer.from(readFileSync(join(shotsDir, name), 'utf8').replace(/\s+/g, ''), 'base64');
  if (png.length < 8 || png[0] !== 0x89 || png[1] !== 0x50 || png[2] !== 0x4e || png[3] !== 0x47) {
    process.stderr.write(`token radar: screenshots/${name}: not a whole PNG once decoded\n`);
    process.exit(1);
  }
  writeFileSync(join(out, 'screenshots', fileName), png);
  shots.push(fileName);
}
if (shots.length < 3) {
  process.stderr.write(`token radar: screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in 3 or 4, the board, a detail view, a filtered view and the live view\n`);
  process.exit(1);
}

// The dossier goes last: the scorer rebuilds it from this /output and compares bytes.
writeFileSync(join(out, 'dossier.json'), buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: { max_files: 400, max_bytes: 4_194_304 } }));

process.stdout.write(
  `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows scored (${radar.early_size} early, ${radar.live_size} live set aside)\n` +
    `token radar: wrote ${join(out, 'board.json')}, ${join(out, 'data.js')}, ${join(out, 'dashboard')} (${dashboardFiles.length} files), ${join(out, 'screenshots')} (${shots.length} images) and ${join(out, 'dossier.json')}\n`,
);

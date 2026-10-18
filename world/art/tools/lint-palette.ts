// Enforces "no raw colour outside the token file" for the Busyholm art kit.
// The ONLY file allowed to contain colour literals is src/tokens.ts.
//
// Usage:
//   node tools/lint-palette.ts              scan the kit, exit 1 on any violation
//   node tools/lint-palette.ts --self-test  check the matchers on sample lines, exit 1 on failure
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const toolsDir = dirname(fileURLToPath(import.meta.url));
const artRoot = join(toolsDir, '..');
const SELF = join(toolsDir, 'lint-palette.ts');
const TOKENS = join(artRoot, 'src', 'tokens.ts');
const SKIP_DIRS = new Set(['node_modules', 'build', 'goldens']);

// CSS named colours. Banned as whole quoted string literals, and as CSS property values in .css/.html.
const NAMES = [
  'white', 'black', 'red', 'green', 'blue', 'yellow', 'orange', 'purple', 'gray', 'grey',
  'pink', 'brown', 'cyan', 'magenta', 'navy', 'teal', 'maroon', 'olive', 'lime', 'silver',
  'gold', 'beige', 'ivory', 'tan',
];
const NAME_ALT = NAMES.join('|');

interface Matcher {
  kind: string;
  re: RegExp; // must carry the g flag (matchAll is used)
  cssOnly: boolean;
}

const MATCHERS: Matcher[] = [
  // a. hex colour: '#' + 3, 4, 6 or 8 hex digits, then a word boundary. Applies in strings and comments.
  { kind: 'hex', re: /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b/g, cssOnly: false },
  // b. functional colour immediately followed (optional spaces) by a digit, minus or dot.
  //    Template output like rgb(${r} ...) is not flagged because '$' follows the bracket.
  { kind: 'functional', re: /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(\s*[\d.-]/gi, cssOnly: false },
  // c. 6-digit 0x colour literal. 8-digit hash constants (0x6D2B79F5) do not match.
  { kind: 'hex-int', re: /\b0x[0-9a-fA-F]{6}\b/g, cssOnly: false },
  // d. quoted CSS named colour, whole string content only.
  { kind: 'named', re: new RegExp(`(['"\`])(?:${NAME_ALT})\\1`, 'gi'), cssOnly: false },
  // d (css/html only). named colour used as a property value, e.g. "color: black;".
  { kind: 'named-css', re: new RegExp(`:\\s*(?:${NAME_ALT})\\b`, 'gi'), cssOnly: true },
];

interface Hit {
  col: number; // 1-based
  kind: string;
  text: string;
}

function findViolations(line: string, cssLike: boolean): Hit[] {
  const hits: Hit[] = [];
  for (const m of MATCHERS) {
    if (m.cssOnly && !cssLike) continue;
    for (const match of line.matchAll(m.re)) {
      hits.push({ col: (match.index ?? 0) + 1, kind: m.kind, text: match[0] });
    }
  }
  return hits.sort((a, b) => a.col - b.col);
}

function selfTest(): number {
  // Every colour-like sample is assembled by concatenation so this file holds no literal colours.
  const q = (s: string) => "'" + s + "'";
  const cases: Array<{ label: string; line: string; cssLike?: boolean; flag: boolean }> = [
    { label: 'raw 6-digit hex string', line: 'const c = ' + q('#' + 'FFB000') + ';', flag: true },
    { label: 'rgba() with numbers', line: 'const c = ' + 'rgb' + 'a(0, 0, 0, .5);', flag: true },
    { label: '0x 6-digit int colour', line: 'const n = ' + '0x' + 'FFB000;', flag: true },
    { label: 'quoted named colour', line: 'const c = ' + q('white') + ';', flag: true },
    { label: 'css named property value', line: 'p { ' + 'color' + ': black; }', cssLike: true, flag: true },
    { label: 'rgb() template output', line: 'const c = ' + 'rgb' + '(${r} ${g} ${b});', flag: false },
    { label: '0x 8-digit hash constant', line: 'const h = ' + '0x' + '6D2B79F5;', flag: false },
    { label: "'transparent' string", line: 'const c = ' + q('transparent') + ';', flag: false },
    { label: 'token reference', line: 'fill(PAL.ink);', flag: false },
    { label: 'issue ref without hash', line: '// see note 12', flag: false },
  ];

  let failures = 0;
  for (const c of cases) {
    const hits = findViolations(c.line, c.cssLike === true);
    if ((hits.length > 0) !== c.flag) {
      failures++;
      console.log(`self-test FAIL: ${c.label}: expected ${c.flag ? 'flag' : 'pass'}, got ${hits.length} hit(s)`);
    }
  }
  if (failures > 0) {
    console.log(`lint:palette self-test FAIL: ${failures} of ${cases.length} case(s)`);
    return 1;
  }
  console.log(`lint:palette self-test OK (${cases.length} cases)`);
  return 0;
}

function walk(dir: string, keep: (file: string) => boolean, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full, keep, out);
    } else if (entry.isFile() && keep(full)) {
      out.push(full);
    }
  }
}

function listFiles(): string[] {
  const files: string[] = [];
  walk(join(artRoot, 'src'), (f) => extname(f) === '.ts', files);
  walk(join(artRoot, 'tools'), (f) => extname(f) === '.ts' || extname(f) === '.mjs', files);
  for (const entry of readdirSync(artRoot, { withFileTypes: true })) {
    if (entry.isFile() && (extname(entry.name) === '.html' || extname(entry.name) === '.css')) {
      files.push(join(artRoot, entry.name));
    }
  }
  return files.filter((f) => f !== SELF && f !== TOKENS).sort();
}

function main(): number {
  const files = listFiles();
  let violations = 0;
  const badFiles = new Set<string>();
  for (const file of files) {
    const rel = relative(artRoot, file).split(sep).join('/');
    const cssLike = extname(file) === '.html' || extname(file) === '.css';
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      for (const hit of findViolations(lines[i], cssLike)) {
        violations++;
        badFiles.add(rel);
        console.log(`${rel}:${i + 1}:${hit.col}  ${hit.kind}  ${hit.text}`);
      }
    }
  }
  if (violations > 0) {
    console.log(`lint:palette FAIL: ${violations} violation(s) in ${badFiles.size} file(s) (${files.length} files scanned)`);
    return 1;
  }
  console.log(`lint:palette OK (${files.length} files scanned)`);
  return 0;
}

process.exitCode = process.argv.includes('--self-test') ? selfTest() : main();

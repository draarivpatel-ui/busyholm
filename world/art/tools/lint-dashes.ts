// Flags em dashes (U+2014) and en dashes (U+2013). The project bans both in docs.
//
// Usage:
//   node tools/lint-dashes.ts [files...]
// With no args: every *.md directly in the art root, plus gallery.html if it exists.
// With args: exactly those files (relative paths resolve from the current directory).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const artRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const EM_DASH = '—';
const EN_DASH = '–';

function defaultTargets(): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(artRoot, { withFileTypes: true })) {
    if (entry.isFile() && extname(entry.name) === '.md') out.push(join(artRoot, entry.name));
  }
  const gallery = join(artRoot, 'gallery.html');
  if (existsSync(gallery)) out.push(gallery);
  return out.sort();
}

function main(): number {
  const args = process.argv.slice(2);
  const files = args.length > 0 ? args.map((a) => resolve(process.cwd(), a)) : defaultTargets();
  let problems = 0;
  for (const file of files) {
    if (!existsSync(file)) {
      problems++;
      console.log(`lint:dashes: no such file: ${file}`);
      continue;
    }
    const rel = relative(artRoot, file).split(sep).join('/');
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (let c = 0; c < line.length; c++) {
        const ch = line[c];
        if (ch === EM_DASH || ch === EN_DASH) {
          problems++;
          const code = ch.charCodeAt(0).toString(16).toUpperCase();
          console.log(`${rel}:${i + 1}:${c + 1}  U+${code}`);
        }
      }
    }
  }
  if (problems > 0) {
    console.log(`lint:dashes FAIL: ${problems} problem(s) (${files.length} files checked)`);
    return 1;
  }
  console.log(`lint:dashes OK (${files.length} files checked)`);
  return 0;
}

process.exitCode = main();

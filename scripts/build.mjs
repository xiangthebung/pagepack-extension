/**
 * Build pipeline for the PagePack extension.
 *
 *   node scripts/build.mjs              assemble a loadable extension in dist/
 *   node scripts/build.mjs --watch      reassemble whenever a source file changes
 *   node scripts/build.mjs --zip        build, then write artifacts/pagepack-<version>.zip
 *   node scripts/build.mjs --clean-only remove dist/ and artifacts/
 *
 * PagePack ships plain ES modules with no dependencies, so there is nothing to
 * transpile or bundle: this "build" is a copy. It exists anyway, for two reasons.
 *
 * 1. Consistency. Every extension in this workspace is now loaded the same way —
 *    `npm run build`, then point `chrome://extensions` at `dist/`. It used to be
 *    "root for this one, dist/ for that one, and run a build first for the third",
 *    which is a thing you have to remember instead of a thing you know.
 *
 * 2. The store artifact stops drifting. The old zip was assembled by hand and
 *    thirteen of its twenty-two entries had fallen behind the working tree,
 *    including popup.js and background.js. `npm run zip` now packages the exact
 *    dist/ that was just assembled, so the artifact cannot disagree with source.
 *
 * The copy is an explicit allowlist rather than a glob, so tests, docs, store
 * assets and this script are never shipped. To stop that list from silently
 * falling behind, `verifyReferences()` reads the manifest, the HTML and the JS
 * back out of dist/ and fails the build if anything they point at is missing.
 */
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createZip, verifyZip } from './zip.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist');
const artifacts = path.join(root, 'artifacts');

const args = process.argv.slice(2);
const watchMode = args.includes('--watch');
const cleanOnly = args.includes('--clean-only');
const zip = args.includes('--zip');

/** Everything that belongs in a shipped extension, and nothing else. */
const RUNTIME_FILES = [
  'manifest.json',

  // Service worker and the on-demand content script.
  'background.js',
  'content.js',

  // Popup.
  'popup.html',
  'popup.css',
  'popup.js',

  // Offline reader.
  'viewer.html',
  'viewer.css',
  'viewer.js',
  'viewer-bootstrap.js',

  // Sandboxed renderer for saved pages.
  'sandbox.html',
  'sandbox.js',

  // Shared modules.
  'storage.js',
  'monetization.js',
  'pricing.js',
  'journey-queue.js',
  'pack-page.js',
  'retry.js',

  // Icons.
  'icons/icon.svg',
  'icons/icon-16.png',
  'icons/icon-32.png',
  'icons/icon-48.png',
  'icons/icon-128.png',
];

async function copyRuntime() {
  for (const file of RUNTIME_FILES) {
    const source = path.join(root, file);
    const target = path.join(out, file);
    let data;
    try {
      data = await readFile(source);
    } catch {
      throw new Error(`build: ${file} is listed in RUNTIME_FILES but does not exist`);
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data);
  }
}

/** Every file under `dir`, as forward-slash paths relative to it. */
async function collect(dir, prefix = '') {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await collect(path.join(dir, entry.name), name)));
    else files.push({ name, data: await readFile(path.join(dir, entry.name)) });
  }
  return files;
}

/**
 * Cross-check the assembled extension against itself.
 *
 * The allowlist above is hand-written, which means it can fall behind a new
 * module. Rather than trust it, this reads the output back and resolves every
 * local reference it can find: manifest paths, `<script src>` and
 * `<link href>` in the HTML, and static or dynamic `import`s between the JS
 * modules. Anything unresolved fails the build, which is where you want to find
 * out — not from a blank popup after loading it in Chrome.
 */
async function verifyReferences(files) {
  const present = new Set(files.map((file) => file.name));
  const text = new Map(
    files
      .filter((file) => /\.(json|html|js|css)$/.test(file.name))
      .map((file) => [file.name, file.data.toString('utf8')]),
  );
  const problems = [];

  const require = (from, target) => {
    // Resolve relative to the referring file, then normalise to archive form.
    const resolved = path
      .posix
      .normalize(path.posix.join(path.posix.dirname(from), target))
      .replace(/^\.\//, '');
    if (!present.has(resolved)) problems.push(`${from} -> ${target}`);
  };

  const manifest = JSON.parse(text.get('manifest.json'));
  const manifestPaths = new Set();
  const walk = (value) => {
    if (typeof value === 'string') {
      if (/\.(js|html|css|png|svg)$/.test(value) && !/^https?:/.test(value)) manifestPaths.add(value);
    } else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(manifest);
  for (const target of manifestPaths) require('manifest.json', target);

  for (const [name, source] of text) {
    if (name.endsWith('.html')) {
      for (const match of source.matchAll(/(?:src|href)="(?!https?:|data:|#)([^"]+)"/g)) {
        require(name, match[1]);
      }
    }
    if (name.endsWith('.js')) {
      // Static `from "./x.js"` and dynamic `import("./x.js")`.
      for (const match of source.matchAll(/(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g)) {
        require(name, match[1]);
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `build: dist/ references files that are not in it:\n  ${problems.join('\n  ')}\n` +
        'Add them to RUNTIME_FILES in scripts/build.mjs.',
    );
  }
}

async function writeZip(version) {
  await mkdir(artifacts, { recursive: true });
  const archivePath = path.join(artifacts, `pagepack-${version}.zip`);
  const files = await collect(out);
  const bytes = createZip(files);
  await writeFile(archivePath, bytes);

  // Read it straight back: every entry is inflated and CRC-checked, so a
  // malformed archive fails here rather than at the Web Store upload.
  const entries = verifyZip(bytes);
  if (entries.length !== files.length) {
    throw new Error(`zip verification found ${entries.length} of ${files.length} entries`);
  }
  if (!entries.some((entry) => entry.name === 'manifest.json')) {
    throw new Error('zip is missing manifest.json at the archive root');
  }

  console.log(
    `wrote ${path.relative(root, archivePath)} ` +
      `(${entries.length} files, ${(bytes.length / 1024).toFixed(1)} kB, verified)`,
  );
}

async function build() {
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  await copyRuntime();

  const files = await collect(out);
  await verifyReferences(files);

  const manifest = JSON.parse(await readFile(path.join(out, 'manifest.json'), 'utf8'));
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  if (manifest.version !== pkg.version) {
    throw new Error(
      `build: manifest.json is ${manifest.version} but package.json is ${pkg.version}. ` +
        'Keep them in step so the store artifact is named after what it contains.',
    );
  }

  const bytes = files.reduce((total, file) => total + file.data.length, 0);
  console.log(
    `build complete -> dist/  (${files.length} files, ${(bytes / 1024).toFixed(1)} kB, v${manifest.version})`,
  );
  return manifest.version;
}

async function main() {
  if (cleanOnly) {
    await rm(out, { recursive: true, force: true });
    await rm(artifacts, { recursive: true, force: true });
    console.log('cleaned dist/ and artifacts/');
    return;
  }

  const version = await build();
  if (zip) await writeZip(version);

  if (watchMode) {
    let queued = null;
    const rebuild = () => {
      clearTimeout(queued);
      // Editors save in bursts; one rebuild per burst is enough.
      queued = setTimeout(() => {
        build().catch((error) => console.error(error.message));
      }, 120);
    };
    for (const target of ['.', 'icons']) {
      watch(path.join(root, target), { persistent: true }, (_event, filename) => {
        if (filename && RUNTIME_FILES.some((file) => file.endsWith(filename))) rebuild();
      });
    }
    console.log('watching for changes... load dist/ in Chrome and press reload after each rebuild');
    return;
  }

  console.log('Load it via chrome://extensions -> Developer mode -> Load unpacked -> select dist/');
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});

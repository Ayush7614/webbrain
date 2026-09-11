#!/usr/bin/env node
/**
 * Build unpacked development directories for loading the extension from source.
 *
 *   node scripts/build-unpacked.mjs [--browser chrome|firefox|all] [--out-dir build] [--dry-run] [--clean]
 *
 * Or via npm: npm run build:chrome | build:firefox | build:all
 *
 * Why this exists (TODOs.md #5): the release path (`npm run build:zip`) builds
 * store-submission zips from the HEAD commit, which is correct for releases but
 * awkward for day-to-day development. Developers iterating on a dirty working
 * tree need a deterministic unpacked directory they can point
 * chrome://extensions ("Load unpacked") or about:debugging ("Load Temporary
 * Add-on") at, without guessing whether to load `src/chrome/` directly or a
 * stale copy. This script copies the working-tree `src/<browser>/` directories
 * into `<out-dir>/chrome` and `<out-dir>/firefox`, validates that both
 * manifests parse and their versions match `package.json`, and prints the exact
 * load paths.
 *
 * Source-of-truth is the WORKING TREE (unlike build-zip.mjs, which archives
 * HEAD). That is intentional: dev builds must include uncommitted edits under
 * test. Never publish these directories to stores; use `npm run build:zip`.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

export const DEV_BUILD_BROWSERS = ['chrome', 'firefox'];

export const DEV_BUILD_SOURCE_DIRS = {
  chrome: 'src/chrome',
  firefox: 'src/firefox',
};

/**
 * Resolve which browsers to build and where they land.
 * Pure helper so tests and CLIs share one source of truth.
 */
export function resolveBuildPlan({ browser = 'all', outDir = 'build' } = {}) {
  const wanted =
    browser === 'all' ? [...DEV_BUILD_BROWSERS] : [String(browser).toLowerCase()];
  for (const name of wanted) {
    if (!DEV_BUILD_BROWSERS.includes(name)) {
      throw new Error(`unknown browser "${name}" (expected chrome, firefox, or all)`);
    }
  }
  return wanted.map((name) => ({
    browser: name,
    sourceDir: DEV_BUILD_SOURCE_DIRS[name],
    outDir: path.join(outDir, name === 'chrome' ? 'chrome' : 'firefox'),
  }));
}

/** Read + parse JSON, throwing a path-annotated error. */
export function readJsonFile(absPath) {
  try {
    return JSON.parse(readFileSync(absPath, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read JSON at ${absPath}: ${error.message}`);
  }
}

/**
 * Validate the dev-build inputs before copying.
 * Returns { version, manifests } or throws with a human-readable reason.
 */
export function assertDevBuildInputs(rootDir = root) {
  const pkg = readJsonFile(path.join(rootDir, 'package.json'));
  const manifests = {};
  for (const name of DEV_BUILD_BROWSERS) {
    const manifestPath = path.join(rootDir, DEV_BUILD_SOURCE_DIRS[name], 'manifest.json');
    if (!existsSync(manifestPath)) {
      throw new Error(`missing manifest: ${manifestPath}`);
    }
    manifests[name] = readJsonFile(manifestPath);
  }
  const versions = new Set([
    String(pkg.version),
    String(manifests.chrome.version),
    String(manifests.firefox.version),
  ]);
  if (versions.size !== 1) {
    throw new Error(
      `version mismatch: package.json=${pkg.version} chrome=${manifests.chrome.version} firefox=${manifests.firefox.version}`,
    );
  }
  return { version: String(pkg.version), manifests };
}

function parseArgs(argv) {
  const args = { browser: 'all', outDir: 'build', dryRun: false, clean: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--browser') args.browser = argv[(i += 1)] ?? 'all';
    else if (token.startsWith('--browser=')) args.browser = token.slice('--browser='.length);
    else if (token === '--out-dir') args.outDir = argv[(i += 1)] ?? 'build';
    else if (token.startsWith('--out-dir=')) args.outDir = token.slice('--out-dir='.length);
    else if (token === '--dry-run') args.dryRun = true;
    else if (token === '--clean') args.clean = true;
    else if (token === '--help' || token === '-h') {
      console.log(
        'Usage: node scripts/build-unpacked.mjs [--browser chrome|firefox|all] [--out-dir build] [--dry-run] [--clean]',
      );
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${token}`);
    }
  }
  return args;
}

function runCli() {
  const args = parseArgs(process.argv.slice(2));
  const { version } = assertDevBuildInputs(root);
  const plan = resolveBuildPlan({ browser: args.browser, outDir: args.outDir });

  if (args.clean && !args.dryRun) {
    for (const step of plan) {
      rmSync(path.resolve(root, step.outDir), { recursive: true, force: true });
    }
  }

  for (const step of plan) {
    const from = path.resolve(root, step.sourceDir);
    const to = path.resolve(root, step.outDir);
    if (!existsSync(from)) throw new Error(`missing source directory: ${from}`);
    if (args.dryRun) {
      console.log(`[dry-run] ${step.browser}: ${step.sourceDir}/ -> ${step.outDir}/ (v${version})`);
      continue;
    }
    mkdirSync(path.dirname(to), { recursive: true });
    rmSync(to, { recursive: true, force: true });
    cpSync(from, to, { recursive: true });
    console.log(`built ${step.browser} v${version}: ${step.sourceDir}/ -> ${step.outDir}/`);
  }

  if (!args.dryRun) {
    console.log('Load paths:');
    for (const step of plan) {
      if (step.browser === 'chrome') {
        console.log(`  Chrome: chrome://extensions/ -> Load unpacked -> ${step.outDir}/`);
      } else {
        console.log(
          `  Firefox: about:debugging#/runtime/this-firefox -> Load Temporary Add-on -> ${step.outDir}/manifest.json`,
        );
      }
    }
  }
}

const invokedAsCli =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsCli) {
  try {
    runCli();
  } catch (error) {
    console.error(`build-unpacked: ${error.message}`);
    process.exit(1);
  }
}

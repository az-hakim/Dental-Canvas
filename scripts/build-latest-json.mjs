#!/usr/bin/env node
/**
 * Build `latest.json` — the feed the in-app updater reads — from the packages
 * that are actually attached to a release.
 *
 * tauri-action writes its own `latest.json` from **each** platform job, and the
 * Windows, Linux and macOS jobs run concurrently against the same draft
 * release. Whichever job uploads last wins, so the published feed can list only
 * that platform. A Windows install then finds no `windows-x86_64` entry, the
 * plugin reports "no update available", and the machine silently stays on its
 * old version forever — indistinguishable from "there is no update".
 *
 * So the release job builds the feed once, after every package has been
 * downloaded, from the files that are really there, and uploads it with
 * `--clobber` before the release is published. Signatures come from the `.sig`
 * files tauri-action wrote, so a package without one cannot enter the feed.
 *
 *   node scripts/build-latest-json.mjs \
 *     --dir verify --version 1.5.0 --tag v1.5.0 \
 *     --repo az-hakim/Dental-Canvas --require windows-x86_64 \
 *     --notes-file verify/release-notes.md \
 *     --out verify/latest.json
 *
 * The feed's `notes` is the text the in-app updater shows as "what's new"
 * (`update.body` in src/client/lib/updater.ts). It used to be written empty,
 * so every install that updated through the app saw a blank banner. Notes are
 * therefore required: the release job passes this version's changelog (see
 * scripts/release-notes.mjs), and a feed with nothing to say fails here instead
 * of shipping.
 *
 * Exits 1 when a required platform has no signed package, so a release that
 * Windows cannot update from never gets published.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const out = { dir: ".", out: null, version: null, tag: null, repo: null, require: [], notes: null, notesFile: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} needs a value`);
      return value;
    };
    switch (arg) {
      case "--dir": out.dir = next(); break;
      case "--out": out.out = next(); break;
      case "--version": out.version = next(); break;
      case "--tag": out.tag = next(); break;
      case "--repo": out.repo = next(); break;
      case "--require": out.require.push(next()); break;
      case "--notes": out.notes = next(); break;
      case "--notes-file": out.notesFile = next(); break;
      default: throw new Error(`unknown argument ${arg}`);
    }
  }
  return out;
}

/**
 * Platform key → the artifact the updater must install.
 *
 * Tauri v2 keys: `windows-x86_64` (NSIS setup.exe), `linux-x86_64` (AppImage),
 * `darwin-aarch64` / `darwin-x86_64` (`.app.tar.gz`). macOS builds currently
 * ship a DMG only, which is not self-updatable, so that entry appears only when
 * a `.app.tar.gz` was actually produced.
 */
const PLATFORMS = [
  { key: "windows-x86_64", match: (name) => /-setup\.exe$/i.test(name) },
  { key: "linux-x86_64", match: (name) => /\.AppImage$/i.test(name) },
  { key: "darwin-aarch64", match: (name) => /aarch64.*\.app\.tar\.gz$/i.test(name) },
  { key: "darwin-x86_64", match: (name) => /(x64|x86_64).*\.app\.tar\.gz$/i.test(name) },
];

/**
 * The release notes for the feed, from `--notes-file` (a file the release job
 * writes) or `--notes` (a literal). Never empty: the updater renders this
 * verbatim, and an empty string is a silent blank panel in the app.
 */
function readNotes(args) {
  let notes = args.notes ?? "";
  if (args.notesFile) {
    if (!existsSync(args.notesFile)) throw new Error(`--notes-file ${args.notesFile} does not exist`);
    notes = readFileSync(args.notesFile, "utf8");
  }
  const trimmed = notes.trim();
  if (!trimmed) {
    throw new Error(
      "no release notes: pass --notes-file (or --notes) so the feed's `notes` field — the in-app what's-new text — is not blank",
    );
  }
  return trimmed;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.version || !args.tag || !args.repo) {
    throw new Error("--version, --tag and --repo are required");
  }
  const notes = readNotes(args);

  const dir = path.resolve(args.dir);
  const files = readdirSync(dir).filter((name) => !name.startsWith("."));

  const platforms = {};
  const missing = [];
  for (const { key, match } of PLATFORMS) {
    const artifact = files.find(match);
    if (!artifact) {
      if (args.require.includes(key)) missing.push(key);
      continue;
    }
    const sigPath = path.join(dir, `${artifact}.sig`);
    if (!existsSync(sigPath)) {
      if (args.require.includes(key)) missing.push(`${key} (no ${artifact}.sig)`);
      continue;
    }
    platforms[key] = {
      signature: readFileSync(sigPath, "utf8").trim(),
      url: `https://github.com/${args.repo}/releases/download/${args.tag}/${encodeURIComponent(artifact)}`,
    };
  }

  if (missing.length > 0) {
    throw new Error(
      `no signed package for ${missing.join(", ")} in ${dir} — the updater feed would leave those installs unable to update`,
    );
  }
  if (Object.keys(platforms).length === 0) {
    throw new Error(`no signed packages found in ${dir}`);
  }

  const feed = {
    version: args.version.replace(/^v/i, ""),
    notes,
    pub_date: new Date().toISOString(),
    platforms,
  };

  const out = path.resolve(args.out ?? path.join(dir, "latest.json"));
  writeFileSync(out, `${JSON.stringify(feed, null, 2)}\n`);

  console.log(`wrote ${out}`);
  console.log(`  version ${feed.version}`);
  console.log(`  notes   ${notes.length} chars`);
  for (const [key, entry] of Object.entries(platforms)) {
    console.log(`  ${key.padEnd(16)} ${entry.url.split("/").pop()} (signed)`);
  }
}

try {
  main();
} catch (err) {
  console.error(`::error::${err.message}`);
  process.exit(1);
}

#!/usr/bin/env node
/**
 * Fail when the three files that carry the release version disagree.
 *
 * The version a running desktop app reports — the one the in-app updater
 * compares with the release feed — comes from the **Rust crate**
 * (`src-tauri/Cargo.toml`, resolved into `src-tauri/Cargo.lock`), while the
 * tag and the installer's display version come from `package.json`. Bumping
 * only package.json ships an installer whose binary still calls itself the old
 * version, so every launch sees "a newer release exists", downloads it, installs
 * it, and offers it again — the "it updates and nothing changes" report on
 * Windows.
 *
 * The tag jobs only compared package.json with Cargo.toml; Cargo.lock's own
 * `dental-canvas` entry (which `cargo build` rewrites from Cargo.toml) was
 * unchecked, and nothing checked any of it on a normal push. This script covers
 * all three, tolerates the CRLF checkout Windows runners produce, and is pure
 * text reading: no install, no Rust, no network.
 *
 *   node scripts/check-release-versions.mjs                 # compare the files
 *   node scripts/check-release-versions.mjs --expect-tag v1.5.0
 *
 * Exits 1 on any mismatch, on a missing entry, or on a tag that does not name
 * the version.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts) => readFileSync(path.join(root, ...parts), "utf8");
const lines = (text) => text.split(/\r?\n/);

function packageVersion() {
  return String(JSON.parse(read("package.json")).version ?? "").trim();
}

/** `version` inside the `[package]` table of Cargo.toml (not a dependency's). */
function cargoTomlVersion() {
  let inPackage = false;
  for (const raw of lines(read("src-tauri", "Cargo.toml"))) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inPackage = line === "[package]";
      continue;
    }
    if (!inPackage) continue;
    const m = /^version\s*=\s*"([^"]+)"/.exec(line);
    if (m) return m[1].trim();
  }
  return null;
}

/** The root crate's own entry in Cargo.lock (`[[package]] name = "dental-canvas"`). */
function cargoLockVersion() {
  const blocks = read("src-tauri", "Cargo.lock").split(/\[\[package\]\]/).slice(1);
  for (const block of blocks) {
    const name = /^\s*name\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    if (name !== "dental-canvas") continue;
    return /^\s*version\s*=\s*"([^"]+)"/m.exec(block)?.[1]?.trim() ?? null;
  }
  return null;
}

function main() {
  const tagArg = process.argv.indexOf("--expect-tag");
  const expectedTag = tagArg > -1 ? process.argv[tagArg + 1] : null;

  const rows = [
    { file: "package.json", version: packageVersion() },
    { file: "src-tauri/Cargo.toml", version: cargoTomlVersion() },
    { file: "src-tauri/Cargo.lock", version: cargoLockVersion() },
  ];

  const width = Math.max(...rows.map((r) => r.file.length));
  for (const r of rows) {
    console.log(`${r.file.padEnd(width)}  ${r.version ?? "(missing)"}`);
  }

  const problems = [];
  for (const r of rows) {
    if (!r.version) problems.push(`${r.file} has no version`);
  }
  const versions = new Set(rows.map((r) => r.version).filter(Boolean));
  if (versions.size > 1) {
    problems.push(
      `the three files disagree (${[...versions].sort().join(", ")}) — bump all of them together`,
    );
  }

  const version = rows[0].version;
  if (expectedTag && version && expectedTag !== `v${version}`) {
    problems.push(`tag ${expectedTag} does not match the version (expected v${version})`);
  }

  if (problems.length > 0) {
    console.error("\nRelease versions are not consistent:");
    for (const p of problems) console.error(`  - ${p}`);
    console.error(
      "\nThe updater compares the running binary's crate version with the release\n" +
        "feed. A stale Cargo.toml/Cargo.lock makes a freshly installed build report\n" +
        "the old version, so every check re-offers the same update and Windows\n" +
        "installs it again and again. Bump package.json, src-tauri/Cargo.toml and\n" +
        "the dental-canvas entry in src-tauri/Cargo.lock in the same commit.",
    );
    process.exit(1);
  }

  console.log(`\nAll three files say ${version}${expectedTag ? `, tag ${expectedTag}` : ""}.`);
}

main();

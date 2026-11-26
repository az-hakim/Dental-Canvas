#!/usr/bin/env node
/**
 * The release notes for one version, taken from CHANGELOG.md.
 *
 * The updater feed carries a single `notes` string; the in-app dialog prints it
 * as "what's new" and the GitHub release page shows the same text. Writing it
 * by hand in each platform job meant three different blurbs about installers
 * (whichever job finished last won) and, in the feed, nothing at all. The
 * changelog is the place a clinic's changes are already described, so the
 * release job lifts this version's section out of it and uses that.
 *
 *   node scripts/release-notes.mjs --version 1.5.0 --changelog CHANGELOG.md \
 *     --out verify/release-notes.md
 *
 * Prints the notes to stdout and, with `--out`, writes them to a file. Exits 1
 * when the version has no section or the section is empty, so the workflow can
 * fall back to the release body (and then refuse to publish if that is empty
 * too).
 */

import { readFileSync, writeFileSync } from "node:fs";

function parseArgs(argv) {
  const out = { version: null, changelog: "CHANGELOG.md", out: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} needs a value`);
      return value;
    };
    switch (arg) {
      case "--version": out.version = next(); break;
      case "--changelog": out.changelog = next(); break;
      case "--out": out.out = next(); break;
      default: throw new Error(`unknown argument ${arg}`);
    }
  }
  return out;
}

/** `## v1.5.0`, `## 1.5.0` and `## [1.5.0] - 2026-11-26` all name the version. */
function headingVersion(line) {
  const match = /^##\s+\[?v?([0-9][0-9A-Za-z.\-+]*)\]?(?:\s|$)/.exec(line.trim());
  return match ? match[1] : null;
}

/** The lines under this version's heading, up to the next `## ` heading. */
export function sectionFor(changelog, version) {
  const wanted = String(version).replace(/^v/i, "").trim();
  const lines = changelog.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headingVersion(lines[i]) === wanted) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return "";
  const body = [];
  for (let i = start; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) break;
    body.push(lines[i]);
  }
  return body.join("\n").trim();
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.version) throw new Error("--version is required");

  const notes = sectionFor(readFileSync(args.changelog, "utf8"), args.version);
  if (!notes) {
    throw new Error(
      `CHANGELOG.md has no section for ${args.version} — add one before tagging, or the release ships with blank notes`,
    );
  }

  if (args.out) {
    writeFileSync(args.out, `${notes}\n`);
    console.log(`wrote ${args.out} (${notes.length} chars)`);
  } else {
    console.log(notes);
  }
}

// Importable for tests; only run as a CLI.
if (process.argv[1] && process.argv[1].endsWith("release-notes.mjs")) {
  try {
    main();
  } catch (err) {
    console.error(`::error::${err.message}`);
    process.exit(1);
  }
}

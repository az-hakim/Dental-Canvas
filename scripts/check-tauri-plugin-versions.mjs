#!/usr/bin/env node
/**
 * Fail when a Tauri plugin's Rust crate and its JavaScript wrapper disagree on
 * major.minor.
 *
 * The Tauri CLI refuses to build a desktop package in that state, but nothing
 * checked it before a tag: v1.4.24's first release run died in all five package
 * jobs after 64 seconds, before compiling a line, because `Cargo.lock` had
 * resolved the plugin crates ahead of the JS minors in `package.json`:
 *
 *   tauri-plugin-opener  (v2.7.2) : @tauri-apps/plugin-opener  (v2.5.5)
 *
 * The versions are read from the lockfiles rather than from `node_modules` or
 * from cargo, so the check needs no install, no Rust toolchain and no network —
 * it is a pure text comparison of what the two sides would actually build.
 *
 * The CLI is checked here too, for a different reason: it embeds the NSIS
 * installer template every Windows release is built with. Before 2.12.0 the
 * template killed the running app and slept 500 ms before overwriting files;
 * when the old exe was still mapped the copy failed and `/R` relaunched the
 * previous version — an in-app update that downloads and never applies, on
 * every machine. 2.12.0 (tauri-bundler 2.10.0) switched to the Windows Restart
 * Manager, which shuts the app down and waits for it before copying. So a CLI
 * below the floor must fail before a tag, not after a release ships.
 *
 * Exits 1 on any mismatch, on a plugin package that no crate backs, on a
 * package the JS lockfile never resolved, and on a CLI below the floor.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PKG_SCOPE = "@tauri-apps/plugin-";
const CRATE_PREFIX = "tauri-plugin-";
/** First CLI whose bundler ships the Restart Manager NSIS installer. */
const TAURI_CLI_MIN = "2.12.0";

const read = (...parts) => readFileSync(path.join(root, ...parts), "utf8");

/** major.minor of "2.7.2" → "2.7"; anything unparsable → null. */
function minorOf(version) {
  const m = /^(\d+)\.(\d+)/.exec(version.trim().replace(/^[~^]/, ""));
  return m ? `${m[1]}.${m[2]}` : null;
}

/** [major, minor, patch] of a version/spec, or null. */
function partsOf(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? "").trim().replace(/^[~^]/, ""));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Negative/zero/positive like a comparator. */
function compareVersions(a, b) {
  const pa = partsOf(a);
  const pb = partsOf(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

/** The CLI version pnpm actually resolved — the one CI installs and builds with. */
function resolvedTauriCli() {
  for (const m of read("pnpm-lock.yaml").matchAll(/'@tauri-apps\/cli@([^':()]+)'/g)) {
    return m[1].trim();
  }
  const spec = JSON.parse(read("package.json")).devDependencies?.["@tauri-apps/cli"];
  return spec ? spec.trim().replace(/^[~^]/, "") : null;
}

/** Plugin packages declared in package.json: name → spec. */
function declaredPluginPackages() {
  const pkg = JSON.parse(read("package.json"));
  const out = new Map();
  for (const field of ["dependencies", "devDependencies"]) {
    for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
      if (name.startsWith(PKG_SCOPE)) out.set(name, spec);
    }
  }
  return out;
}

/**
 * Versions pnpm actually resolved: `'@tauri-apps/plugin-opener@2.7.2':` appears
 * in both the `packages:` and `snapshots:` maps, so duplicates are expected and
 * harmless — only genuinely divergent resolutions are a problem.
 */
function resolvedPluginPackages() {
  const lock = read("pnpm-lock.yaml");
  const out = new Map();
  const re = /'(@tauri-apps\/plugin-[a-z0-9-]+)@([^':()]+)/g;
  for (const m of lock.matchAll(re)) {
    const [, name, version] = m;
    if (!out.has(name)) out.set(name, new Set());
    out.get(name).add(version.trim());
  }
  return out;
}

/** Resolved crate versions from Cargo.lock: name → Set of versions. */
function resolvedCrateVersions() {
  const out = new Map();
  let name = null;
  for (const raw of read("src-tauri/Cargo.lock").split("\n")) {
    const line = raw.trim();
    if (line.startsWith("name = ")) {
      name = JSON.parse(line.slice("name = ".length));
    } else if (line.startsWith("version = ") && name) {
      const version = JSON.parse(line.slice("version = ".length));
      if (!out.has(name)) out.set(name, new Set());
      out.get(name).add(version);
      name = null;
    } else if (line === "" || line.startsWith("[")) {
      // `[[package]]` headings and blank lines end the current record.
      name = null;
    }
  }
  return out;
}

function oneVersion(set, what) {
  if (!set) return null;
  if (set.size === 1) return [...set][0];
  throw new Error(`${what} resolves to ${set.size} versions: ${[...set].sort().join(", ")}`);
}

function main() {
  const declared = declaredPluginPackages();
  const jsResolved = resolvedPluginPackages();
  const crates = resolvedCrateVersions();
  const cliVersion = resolvedTauriCli();
  const cliComparison = compareVersions(cliVersion, TAURI_CLI_MIN);

  const rows = [];
  const failures = [];

  for (const [name, spec] of [...declared].sort(([a], [b]) => a.localeCompare(b))) {
    const crate = CRATE_PREFIX + name.slice(PKG_SCOPE.length);
    const crateVersion = oneVersion(crates.get(crate), crate);
    const jsVersion = oneVersion(jsResolved.get(name), name) ?? spec;

    const jsMinor = minorOf(jsVersion);
    const crateMinor = crateVersion ? minorOf(crateVersion) : null;

    let status;
    if (!crateVersion) {
      status = "no Rust crate in Cargo.lock";
    } else if (!jsMinor || !crateMinor) {
      status = "unparsable version";
    } else if (jsMinor !== crateMinor) {
      status = `major.minor ${crateMinor} vs ${jsMinor}`;
    } else {
      status = "ok";
    }
    if (status !== "ok") failures.push({ name, crate, crateVersion, jsVersion, status });

    rows.push({
      crate,
      crateVersion: crateVersion ?? "—",
      package: name,
      jsVersion: jsVersion + (jsResolved.has(name) ? "" : " (declared)"),
      status,
    });
  }

  // Crates with no JS side (tauri-plugin-single-instance) have nothing to pair
  // with and are listed for context only.
  const unpaired = [...crates.keys()]
    .filter((c) => c.startsWith(CRATE_PREFIX))
    .filter((c) => !declared.has(PKG_SCOPE + c.slice(CRATE_PREFIX.length)))
    .sort();

  const w = (key) => Math.max(...rows.map((r) => r[key].length), key.length);
  const widths = {
    crate: w("crate"),
    crateVersion: w("crateVersion"),
    package: w("package"),
    jsVersion: w("jsVersion"),
  };
  const pad = (v, n) => v.padEnd(n);

  console.log(
    `${pad("rust crate", widths.crate)}  ${pad("version", widths.crateVersion)}  ` +
      `${pad("js package", widths.package)}  ${pad("version", widths.jsVersion)}  status`,
  );
  for (const r of rows) {
    console.log(
      `${pad(r.crate, widths.crate)}  ${pad(r.crateVersion, widths.crateVersion)}  ` +
        `${pad(r.package, widths.package)}  ${pad(r.jsVersion, widths.jsVersion)}  ${r.status}`,
    );
  }
  for (const crate of unpaired) {
    const versions = [...crates.get(crate)].join(", ");
    console.log(`(desktop-only crate, no JS wrapper) ${crate} ${versions}`);
  }

  console.log(
    cliComparison !== null && cliComparison >= 0
      ? `tauri cli ${cliVersion} ships the Restart Manager NSIS installer (>= ${TAURI_CLI_MIN}).`
      : `tauri cli ${cliVersion ?? "unknown"} is below ${TAURI_CLI_MIN} — its NSIS installer cannot reliably replace a running app.`,
  );

  if (cliComparison === null || cliComparison < 0) {
    console.error(
      `\n@tauri-apps/cli must be at least ${TAURI_CLI_MIN} (resolved: ${cliVersion ?? "unknown"}).\n` +
        "Older CLIs bundle tauri-bundler < 2.10.0, whose NSIS installer kills the\n" +
        "app and sleeps only 500 ms before copying files. When the old exe is still\n" +
        "mapped the copy fails and `/R` relaunches the previous version: the in-app\n" +
        "update downloads and never applies. 2.12.0 replaced that with the Windows\n" +
        "Restart Manager, which waits for the app to close first.\n\n" +
        "To fix: bump @tauri-apps/cli in package.json to >= " + TAURI_CLI_MIN + " and refresh\n" +
        "pnpm-lock.yaml with the same pnpm version CI uses (pnpm install).",
    );
    process.exit(1);
  }

  if (failures.length > 0) {
    console.error(
      `\n${failures.length} Tauri plugin pair${failures.length === 1 ? "" : "s"} disagree on major.minor.\n` +
        "The Tauri CLI rejects a desktop build in this state — the release workflow\n" +
        "would fail in every package job before compiling anything.\n",
    );
    for (const f of failures) {
      console.error(`  ${f.crate} (v${f.crateVersion ?? "missing"}) : ${f.name} (v${f.jsVersion}) — ${f.status}`);
    }
    console.error(
      "\nTo fix: move the JS package to the crate's major.minor in package.json and\n" +
        "refresh pnpm-lock.yaml (pnpm install). Prefer an exact minor (`~2.7.0`, not\n" +
        "`^2.7.0`) so the next install cannot drift into a newer minor on its own; if\n" +
        "the crate should move instead, change src-tauri/Cargo.toml and regenerate\n" +
        "Cargo.lock.",
    );
    process.exit(1);
  }

  console.log(`\n${rows.length} plugin pair${rows.length === 1 ? "" : "s"} agree on major.minor.`);
}

main();

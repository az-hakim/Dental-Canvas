import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sectionFor } from "../scripts/release-notes.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The updater feed's `notes` field is the in-app what's-new text
 * (`update.body`). It used to be generated as an empty string, so every install
 * that updated through the app showed a blank banner; these run the two release
 * scripts the way the release job does.
 */

function temporaryDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "dental-canvas-release-"));
}

/** A signed package of each kind, as the release job downloads them. */
function writePackages(dir: string): void {
  for (const name of ["Dental Canvas_1.5.0_x64-setup.exe", "Dental Canvas_1.5.0_amd64.AppImage"]) {
    writeFileSync(path.join(dir, name), "package");
    writeFileSync(path.join(dir, `${name}.sig`), `signature-for-${name}\n`);
  }
}

function buildFeed(dir: string, extra: string[]) {
  return spawnSync(
    process.execPath,
    [
      "scripts/build-latest-json.mjs",
      "--dir",
      dir,
      "--version",
      "1.5.0",
      "--tag",
      "v1.5.0",
      "--repo",
      "az-hakim/Dental-Canvas",
      "--out",
      path.join(dir, "latest.json"),
      ...extra,
    ],
    { cwd: root, encoding: "utf8" },
  );
}

describe("the updater feed", () => {
  it("carries the release notes it is given", () => {
    const dir = temporaryDir();
    writePackages(dir);
    const notesPath = path.join(dir, "release-notes.md");
    // What scripts/release-notes.mjs writes: the section body, no heading.
    writeFileSync(notesPath, "- **Merge** two records for one person.\n\n");

    const run = buildFeed(dir, ["--notes-file", notesPath]);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);

    const feed = JSON.parse(readFileSync(path.join(dir, "latest.json"), "utf8"));
    expect(feed.version).toBe("1.5.0");
    expect(feed.notes).toBe("- **Merge** two records for one person.");
    expect(Object.keys(feed.platforms).sort()).toEqual(["linux-x86_64", "windows-x86_64"]);
  });

  it("accepts the notes inline too", () => {
    const dir = temporaryDir();
    writePackages(dir);
    const run = buildFeed(dir, ["--notes", "  Notes from the tag  "]);
    expect(run.status).toBe(0);
    const feed = JSON.parse(readFileSync(path.join(dir, "latest.json"), "utf8"));
    expect(feed.notes).toBe("Notes from the tag");
  });

  it("refuses to build a feed with no notes", () => {
    const dir = temporaryDir();
    writePackages(dir);
    const run = buildFeed(dir, []);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("no release notes");
  });

  it("refuses a notes file that is empty or whitespace", () => {
    const dir = temporaryDir();
    writePackages(dir);
    const notesPath = path.join(dir, "release-notes.md");
    writeFileSync(notesPath, "\n   \n");
    const run = buildFeed(dir, ["--notes-file", notesPath]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("no release notes");
  });

  it("refuses a notes file that does not exist", () => {
    const dir = temporaryDir();
    writePackages(dir);
    const run = buildFeed(dir, ["--notes-file", path.join(dir, "missing.md")]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("does not exist");
  });

  // tauri-action writes the same feed from every platform job, keyed by bundle
  // (`windows-x86_64-nsis`, `linux-x86_64-appimage`) rather than by the artifact
  // the updater installs. Replacing that file outright would drop those entries;
  // merging keeps them, without carrying another release's entries forward.
  it("merges onto the feed tauri-action wrote, keeping this tag's other entries", () => {
    const dir = temporaryDir();
    writePackages(dir);
    const base = "https://github.com/az-hakim/Dental-Canvas/releases/download/v1.5.0";
    writeFileSync(
      path.join(dir, "latest.json"),
      JSON.stringify({
        version: "1.5.0",
        notes: "what the last platform job happened to write",
        pub_date: "2026-11-01T00:00:00Z",
        platforms: {
          "windows-x86_64-nsis": { signature: "sig-nsis", url: `${base}/Dental%20Canvas_1.5.0_x64-setup.exe` },
          "linux-x86_64-appimage": { signature: "sig-appimage", url: `${base}/Dental%20Canvas_1.5.0_amd64.AppImage` },
          "darwin-aarch64": { signature: "sig-darwin", url: `${base}/Dental%20Canvas_1.5.0_aarch64.app.tar.gz` },
          // Last release's binary: never carried into this one's feed.
          "windows-x86_64-msi": {
            signature: "old-sig",
            url: "https://github.com/az-hakim/Dental-Canvas/releases/download/v1.4.9/Dental%20Canvas_1.4.9_x64_en-US.msi",
          },
        },
      }),
    );
    const notesPath = path.join(dir, "release-notes.md");
    writeFileSync(notesPath, "- **Allergy checks** on every prescription.\n");

    const run = buildFeed(dir, ["--notes-file", notesPath]);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);

    const feed = JSON.parse(readFileSync(path.join(dir, "latest.json"), "utf8"));
    expect(Object.keys(feed.platforms).sort()).toEqual([
      "darwin-aarch64",
      "linux-x86_64",
      "linux-x86_64-appimage",
      "windows-x86_64",
      "windows-x86_64-nsis",
    ]);
    // The entries this release's own packages prove win over the action's.
    expect(feed.platforms["windows-x86_64"].url.endsWith("-setup.exe")).toBe(true);
    expect(feed.platforms["windows-x86_64"].signature).toBe(
      "signature-for-Dental Canvas_1.5.0_x64-setup.exe",
    );
    expect(feed.notes).toBe("- **Allergy checks** on every prescription.");
    expect(feed.version).toBe("1.5.0");
  });
});

describe("release notes from the changelog", () => {
  const CHANGELOG = [
    "# Changelog",
    "",
    "## v1.5.0",
    "",
    "- **Merge** two records for one person.",
    "- **Print the day sheet** — Agenda → Day sheet.",
    "",
    "## v1.4.29",
    "",
    "- Something older.",
  ].join("\n");

  it("takes exactly this version's section", () => {
    expect(sectionFor(CHANGELOG, "1.5.0")).toBe(
      "- **Merge** two records for one person.\n- **Print the day sheet** — Agenda → Day sheet.",
    );
  });

  it("accepts a v-prefixed version and a bracketed heading", () => {
    expect(sectionFor(CHANGELOG, "v1.5.0")).toContain("Merge");
    expect(sectionFor("## [1.2.3] - 2026-01-01\n\n- Fixed.\n", "1.2.3")).toBe("- Fixed.");
  });

  it("is empty for a version the changelog does not have", () => {
    expect(sectionFor(CHANGELOG, "9.9.9")).toBe("");
  });

  it("writes the section, and fails when there is none", () => {
    const dir = temporaryDir();
    const changelog = path.join(dir, "CHANGELOG.md");
    writeFileSync(changelog, CHANGELOG);
    const out = path.join(dir, "release-notes.md");

    const ok = spawnSync(
      process.execPath,
      ["scripts/release-notes.mjs", "--version", "1.5.0", "--changelog", changelog, "--out", out],
      { cwd: root, encoding: "utf8" },
    );
    expect(ok.status).toBe(0);
    expect(readFileSync(out, "utf8").trim()).toContain("Print the day sheet");

    const missing = spawnSync(
      process.execPath,
      ["scripts/release-notes.mjs", "--version", "9.9.9", "--changelog", changelog, "--out", out],
      { cwd: root, encoding: "utf8" },
    );
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("no section for 9.9.9");
  });
});

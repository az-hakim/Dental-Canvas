# Dental Canvas — Release Process

How to ship a new Windows installer version.

## Version bump (3 files)

1. `package.json` — `"version"`
2. `src-tauri/Cargo.toml` — `version = "x.y.z"`
3. `src-tauri/Cargo.lock` — the `dental-canvas` package's `version` line (~line 550)

`src-tauri/tauri.conf.json` inherits from package.json automatically.

## Pre-flight checks

```bash
npx tsc --noEmit   # typecheck
npx vitest run     # tests
npm run build      # builds app + sw.js, then checks the stylesheet class set
npm run repro      # two builds must be byte-identical (docs/reproducible-builds.md)
npm run lint:tauri-plugins   # Tauri plugin crates match the JS wrappers
```

`npm run build` ends with the stylesheet class guard: the built CSS must match the
class snapshot (`scripts/stylesheet-classes.txt`). If you changed styling on
purpose, refresh it in the same commit and check the diff names only classes your
change introduced:

```bash
npm run styles:write && git diff scripts/stylesheet-classes.txt
```

A class arriving without anyone writing it means the Tailwind scan reached files
it should not (see `docs/inspecting-a-release.md`); do not paper over it by
rewriting the snapshot.

You do not have to keep that snapshot current by hand between releases. The tag's
`verify-and-publish` job regenerates it from the reference `dist/`, refuses to
publish the release if the result differs from the tag's file (the tag would be
shipping CSS the repo does not claim — fix and re-tag), and attaches the
regenerated copy to the release as `stylesheet-classes.txt`. So the published
snapshot always describes the CSS inside the packages, whatever the repo file
looked like when the tag was cut.

The `repro` check prints a `rootHash`; after the release is published you can
compare it against the release's `repro-manifest.json` to prove your local
build is the same software CI shipped. To look inside a published package,
follow [inspecting-a-release.md](inspecting-a-release.md) — unpack it in a temp
directory, never in the checkout.

`lint:tauri-plugins` (CI job **tauri plugin versions pair up**) compares each
`tauri-plugin-*` crate in `src-tauri/Cargo.lock` with its
`@tauri-apps/plugin-*` package in `pnpm-lock.yaml` and fails when the two
disagree on major.minor. The Tauri CLI refuses to build a desktop package in
that state, and the failure only shows up at tag time — v1.4.24's first release
run died in all five package jobs before compiling anything, because the
lockfile had resolved `tauri-plugin-opener` 2.7.2 next to
`@tauri-apps/plugin-opener` 2.5.5. Fix it by moving the JS package to the
crate's major.minor and reinstalling; pin the minor with `~` rather than `^`,
otherwise the next install is free to resolve a newer minor on its own and
reintroduce the mismatch.

The same script enforces a floor on `@tauri-apps/cli` itself (2.12.0). The CLI
embeds the NSIS installer template every Windows release is built with; older
ones killed the running app and slept 500 ms before overwriting files, so a
still-mapped `dental-canvas.exe` made the copy fail and `/R` relaunch the old
version — the in-app update that downloaded and never applied. 2.12.0 switched
to the Windows Restart Manager, which shuts the app down and waits for it. The
Windows package job runs the check before it compiles anything, so a tag cannot
ship the broken installer again.

## Ship

```bash
git add <specific files>          # never git add -A
git commit -m "..."
git tag vX.Y.Z
git push origin main && git push origin vX.Y.Z
```

The `v*` tag triggers **Build Windows installer** (`.github/workflows/build-windows.yml`). CI enforces that the tag matches `package.json` and `Cargo.toml` versions.

Note: if you add Rust dependencies (`src-tauri/Cargo.toml`), don't commit Cargo.lock changes generated locally unless you can run cargo — the CI runner resolves the lock as needed (tauri-action builds without `--locked`).

## v1.4.20 (in progress)

1. Bump version in `package.json`, `src-tauri/Cargo.toml`, and the `dental-canvas`
   entry in `src-tauri/Cargo.lock` → `1.4.20`.
2. Commit, tag `v1.4.20`, push, and let CI build the six packages (Windows NSIS
   installer, Linux deb/rpm/AppImage, macOS DMG, Android APK).
3. Poll the build run via `gh api repos/azshifat007/Dental-Canvas/actions/runs/<id>/jobs`
   until all six jobs report `success`.
4. Write release notes:

   - **What's new page** — new `Admin → What's new` history page; lists recent
     versions + changelogs fetched from the public GitHub releases API, cached
     in `localStorage` (24 h TTL) and shown offline ("Offline copy" chip); also
     linked from the post-update banner and Settings → About.
   - **Scroll-audit fixes** — setup-wizard card and sidebar nav scroll containers
     no longer rely on a flexible ancestor chain, so the medicine list / wizard /
     sidebar scroll no longer clips on Windows 11.
   - **Scroll-layout guard** — `scripts/check-scroll-layout.mjs` now runs in
     `npm run build` and on pre-commit: it rejects overflow-hidden wrappers that
     are not `relative`/flex/grid and contain an unbounded scroll area, and
     overflow-hidden children of `fixed` overlays without a height bound.
   - Carry forward the v1.4.19 bulletproof scroll + post-update banner work.

   Commit the notes with `gh release edit v1.4.20 --title "Dental Canvas v1.4.20"
   --notes "$(cat RELEASE-NOTES.md)"` after the tag is pushed.

5. Verify-and-publish: the embedded-frontend hash check, the `latest.json`
   feed cross-check, the shipped stylesheet class snapshot, and publishing of
   `repro-manifest.json` + `SHA256SUMS` + `stylesheet-classes.txt` run
   automatically in CI. The download step of the
   verify job must use `--pattern` to fetch every package artifact (a plain
   `gh release download` silently drops some assets, which would make the
   verify gate report `file not found` on a valid build).

## Local Windows-installer smoke test (Linux, via Wine)

A Wine prefix can install, update and uninstall the NSIS package without a
Windows machine, but only after one shim. The bundled script's
`Section WebView2` reads the EdgeUpdate runtime version and, finding none,
runs `NSISdl::download` + `ExecWait` on Microsoft's bootstrapper — under Wine
that step never returns and the installer hangs indefinitely. Registering a
runtime version makes the section skip itself:

```sh
export WINEPREFIX=$PWD/.tmp-wine WINEARCH=win64 WINEDEBUG=-all \
  WINEDLLOVERRIDES="mscoree,mshtml="      # also stops the mono/gecko prompt
wineboot -i
wine reg add 'HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}' \
  /v pv /t REG_SZ /d 130.0.2849.0 /f
wine ./Dental.Canvas_<version>_x64-setup.exe /S     # then /S /UPDATE
wine "$WINEPREFIX/drive_c/users/$USER/AppData/Local/Dental Canvas/uninstall.exe" /S
```

Wine cannot settle the question this document's CLI floor exists for: the app
itself needs WebView2 and won't start in the prefix, and Wine does not hold the
same image-section lock Windows does, so replacing a running install can't be
reproduced there. Use `.github/workflows/verify-windows-installer.yml` for that.
Delete the prefix directory afterwards — it is ~1.7 GB.

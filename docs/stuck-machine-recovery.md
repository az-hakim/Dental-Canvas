# Stuck-machine audit & recovery runbook

*Audit date: 2026-10-04, after v1.4.19. Evidence-gathering commands are inline so
the audit can be re-run after future releases.*

## TL;DR — which machines can no longer update themselves

| Population | Versions | Why stuck | Data at risk? |
|---|---|---|---|
| **Windows desktop** | v1.4.0 – v1.4.2 | No in-app updater existed yet (added in v1.4.3, commit `64533d9`) | No — reinstalling over the top preserves data |
| **Windows desktop** | v1.4.3 – v1.4.4 | Updater worked, but the service-worker shell cache never changed name, so after an in-app update the **UI stayed on the old version** while the binary moved on (`fa2e641`, fixed in v1.4.5). The updater sees a current binary and never offers anything again — the machine looks permanently stuck at the old version | No |
| **Android** | v1.4.6 – v1.4.14 | Each release's APK was signed with a **one-off ephemeral CI keystore** (fallback removed in `1980162`, v1.4.15). Certificates differ release-to-release (verified below), so Android refuses to install any newer APK over an existing one (`INSTALL_FAILED_UPDATE_INCOMPATIBLE`). Only way forward is uninstall → reinstall, which **wipes the app's private data** | **Yes — unless backed up first** |
| Android | ≤ v1.4.5 | n/a — those releases shipped unsigned APKs that Android rejects outright ("invalid"), so no installs of them can exist | — |
| **Desktop ≥ v1.4.3, Android ≥ v1.4.15** | current | Healthy: updater feed (`releases/latest/download/latest.json`) verified live → v1.4.19 with valid signatures; updater pubkey and endpoint unchanged since v1.4.3; Android signing key stable since v1.4.15 | — |

The rest of this document shows the evidence and the recovery runbooks.

## Automatic installation (why machines stop drifting)

The desktop app no longer waits to be asked. Settings → About → **App updates**
has an *Install updates automatically* switch, stored as the `update_mode`
setting and **on by default**:

- the hourly check downloads a new version in the background the moment it is
  found, and
- it installs itself at the first quiet moment — ten minutes with nobody
  touching the app, or thirty seconds with the window in the background. An open
  dialog or form is never interrupted, and pending database writes are flushed
  before the installer runs, so the restart costs nothing.

`update_mode = "ask"` restores click-to-install: the banner and the Settings
card behave exactly as before. The two fallbacks for machines that cannot
self-install — the one-time installer download and the cached-shell repair —
are never used automatically: opening a browser or clearing caches is always the
user's call.

## Evidence

### 1. When the updater shipped, and that its trust config never changed

```sh
git log --oneline --all -- src/client/lib/updater.ts        # first: 64533d9 (in v1.4.3)
git tag --contains 64533d9 | sort -V | head -3              # → v1.4.3
# pubkey + endpoint identical at 64533d9 and HEAD:
git show 64533d9:src-tauri/tauri.conf.json | grep -A3 '"endpoints"'
diff <(git show 64533d9:src-tauri/tauri.conf.json | grep pubkey) <(grep pubkey src-tauri/tauri.conf.json)
```

### 2. The updater feed is healthy right now

```sh
curl -sL https://github.com/az-hakim/Dental-Canvas/releases/latest/download/latest.json
# → {"version":"1.4.19", "platforms":{...signed entries...}}
```

### 3. Android: the ephemeral-key era is real (certificates differ per release)

`scripts/extract-apk-cert.mjs` (committed with this doc) pulls the signer
certificate SHA-256 out of the APK Signing Block (v2/v3 scheme — `keytool
-printcert -jarfile` only reads the old v1 jar signatures and reports
"Not a signed jar file" for these APKs).

```sh
gh release download v1.4.6  --repo az-hakim/Dental-Canvas --pattern '*.apk' -O 6.apk
gh release download v1.4.14 --repo az-hakim/Dental-Canvas --pattern '*.apk' -O 14.apk
gh release download v1.4.15 --repo az-hakim/Dental-Canvas --pattern '*.apk' -O 15.apk
gh release download v1.4.19 --repo az-hakim/Dental-Canvas --pattern '*.apk' -O 19.apk
node scripts/extract-apk-cert.mjs 6.apk
node scripts/extract-apk-cert.mjs 14.apk
node scripts/extract-apk-cert.mjs 15.apk
node scripts/extract-apk-cert.mjs 19.apk
```

Measured fingerprints (2026-10-04):

| APK | Signer cert SHA-256 |
|---|---|
| v1.4.6 | `65:12:B5:F0:FD:3C:56:85:92:CE:0C:65:37:51:9C:37:D7:F0:FC:93:DD:39:A2:F5:FC:EE:74:F0:BC:18:12:7E` |
| v1.4.14 | `FD:13:59:C3:20:27:A7:BD:DB:0C:6A:AB:AB:74:58:04:8B:DD:74:DA:96:85:E5:46:5C:77:AE:75:56:2B:7F:76` |
| v1.4.15 | `53:27:4C:32:27:1E:FB:6C:C7:B3:9C:32:AD:7E:21:A0:FA:34:A7:36:01:A9:CA:35:81:22:B5:81:BF:6E:7D:4B` |
| v1.4.19 | `53:27:4C:32:27:1E:FB:6C:C7:B3:9C:32:AD:7E:21:A0:FA:34:A7:36:01:A9:CA:35:81:22:B5:81:BF:6E:7D:4B` |

v1.4.6 ≠ v1.4.14 → in-place updates were already broken **within** the
ephemeral era. v1.4.15 = v1.4.19 → the stable-keystore era
(`~/dental-canvas-signing/dental-canvas-release.jks`, wired as required CI
secrets by `1980162`) is continuous, so machines on ≥ v1.4.15 can sideload any
newer APK straight over the old one.

### 4. Why desktop reinstalls are safe but Android uninstalls are not

The entire database lives in the WebView's **IndexedDB** on every platform
(`src/server/offline/sqlite-adapter.ts` exports the whole DB image to IndexedDB
after each mutation batch).

- **Windows desktop**: IndexedDB belongs to the WebView2 *user data folder*
  (under `%LOCALAPPDATA%`), not the install directory. Running a newer
  `setup.exe` over an existing install replaces the binary but leaves the
  profile — and the data — untouched.
- **Android**: IndexedDB is inside the app's private sandbox. **Uninstalling
  the app deletes the database.** There is no way to change APK signatures
  without uninstalling. Hence: backup first, always.

## Recovery runbooks

### A. Windows desktop, stuck at ≤ v1.4.2 (no updater)

1. Download the current installer from the releases page:
   `https://github.com/az-hakim/Dental-Canvas/releases/latest` →
   `Dental.Canvas_<ver>_x64-setup.exe`.
2. Optional but recommended: Settings → Backup → export a backup file (or rely
   on the folder auto-backup if configured).
3. Run the installer. NSIS upgrades in place; the WebView2 profile ( IndexedDB
   database, settings) is preserved.
4. First launch of the new version shows the "updated" banner and the What's
   new page. Subsequent updates are automatic (hourly feed poll).

Note: installers are not code-signed, so SmartScreen shows "Windows protected
your PC" — More info → Run anyway.

### B. Windows desktop, "stuck" at v1.4.3/v1.4.4 (stale-UI bug)

Symptom: the app always shows an old version in Settings → About even though
the updater says everything is fine (the *binary* may already be much newer —
the UI is served from a frozen service-worker cache).

Recovery is the same as **A** (run the latest installer): the new build's
version-stamped shell cache (v1.4.5+) replaces the frozen one on first launch.
If the UI is *still* stale after reinstalling, clear the WebView cache:
delete `%LOCALAPPDATA%\<app-identifier>\EBWebView\Default\Service Worker\`
(or, simpler, Settings → Backup → export, then reinstall) — data in IndexedDB
is not affected by removing the service-worker cache itself.

### C. Android, on v1.4.6 – v1.4.14 (ephemeral signatures) — DATA AT RISK

In-place update is impossible. The uninstall wipes the database, so the backup
must come **before** anything else.

1. **Back up first.** In the old app: Settings → Backup → export the backup
   file (format v3 includes patient images) and copy it off the device (share
   sheet → Drive/email/cable). Verify the export exists and opens (file size
   sanity check) before step 2.
2. Note the installed version (Android Settings → Apps → Dental Canvas) for
   the audit trail.
3. **Uninstall** the app.
4. Install the current APK:
   `https://github.com/az-hakim/Dental-Canvas/releases/latest` →
   `app-universal-release.apk` (enable "install unknown apps" for the browser
   / file manager when prompted).
5. Launch, then Settings → Backup → restore the file from step 1.
6. Verify: patient count matches pre-uninstall, latest appointment visible.
   From here on the app is on the stable signing key and future APKs install
   over it without uninstalling.

If the device is lost/broken before a backup was taken, the data is not
recoverable from the APK ecosystem — restore the most recent exported backup
file, or a desktop folder auto-backup, instead.

### D. Android, on ≥ v1.4.15

Not stuck. Download the current `app-universal-release.apk` and install it
over the existing app — signatures match (same stable key), data is preserved.
No uninstall needed.

## Prevention checklist for future releases

- Desktop trust config (`pubkey`, `endpoints`) must never change; if it ever
  must, every machine below the change is stuck and needs runbook A.
- Never let CI fall back to an ephemeral Android keystore (`1980162` made the
  stable secrets required — keep it that way).
- After each release, re-run the fingerprint check above for the new APK and
  compare with the previous release's fingerprint; add the value to the table
  in this doc. Any mismatch between consecutive releases = another stuck
  generation.
- Keep `latest.json` on the latest release (the `verify-and-publish` CI gate
  already fails the run when it's missing/stale — the desktop fleet depends
  on it).

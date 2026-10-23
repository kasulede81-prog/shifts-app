# DKASU Native Shift App — Repair Audit

Date: 2026-10-22  
Project: `C:\Users\Utente\Downloads\lovable mix\DKASU_Native_Shift_App`  
Original backup: `C:\Users\Utente\Downloads\lovable mix\DKASU_Native_Shift_App_backup_2026-10-22`  
Git baseline: local commit `799a5d8` (repository initialized before source edits)

## Result

The repair and worker profile handoff are implemented, the web build succeeds, 53 automated tests pass, a real-Chrome end-to-end smoke test passes, and a valid debug APK was produced.

A physical Android device (`CPH2059`) was connected and the previously installed APK failed with the reported `Execute: ... Queries can be performed using SQLiteDatabase query or rawQuery methods only` error. The device disconnected during the diagnostic relaunch before the rebuilt APK could be installed. No app data was cleared. Native SQLite startup, Force Stop/reboot persistence, Android share export, and Android file-picker restore therefore still need device confirmation. There is no emulator/AVD.

## Root cause of the startup failure

The original startup path was:

`www/index.html` → `www/boot.js` → dynamically appended `www/app.js`

`app.js` began with the retired single-profile dashboard initialization. At module load, before any profile dashboard was rendered, it tried to access template-only elements:

- `#primaryTimezone` was evaluated before the template existed. Its immediate access was wrapped in a `try`, which hid part of the failure.
- `#shiftDate` was then dereferenced at the old line 68 while binding a change handler, throwing `TypeError: Cannot read properties of null`.
- Execution stopped before the newer multi-profile code around old line 208, so the profile picker never rendered.

The old module also contained a second set of timezone handlers, a second timer, a second backup/restore implementation, obsolete screenshot-specific shift dates, a missing install button, and a missing service-worker file.

**Repair:** removed the legacy single-profile layer and moved all dashboard initialization behind a single `initApp()` call that runs only after PIN verification. The existing multi-profile UI/features and visual design were retained and rebuilt on unified modules. This avoids duplicate handlers, timers, and backup code.

## Fixes by audit area

### 1. Startup and build

- Removed the obsolete dashboard block and its null element access, duplicate interval, duplicate timezone persistence, and old backup handlers.
- Kept a single live-dashboard timer. It is cleared before rerendering or leaving the dashboard.
- PIN unlock now verifies first, initializes the app, then opens the profile picker.
- Fixed the baseline `npm run build` failure: Vite/esbuild rejected top-level `await` in `boot.js`. Startup now calls an async function without top-level await.
- Added TypeScript 5.9.3 because Capacitor CLI requires it to parse `capacitor.config.ts`.
- Set `server.androidScheme` to `https` so Web Crypto runs in a secure context.
- Built with compileSdk 35 / targetSdk 35 / minSdk 23. Because SDK Platform 35 was initially absent, an intermediate build used compileSdk 36 and produced an AGP “tested up to 35” warning. The project was returned to compileSdk 35, Gradle installed Platform 35, and the final build has no unsupported-compileSdk warning and is aligned with the selected Capacitor 7 stack.

### 2. SQLite persistence

- Replaced the synchronous `localStorage` shim that persisted asynchronously and swallowed write errors.
- Added `SqliteKeyValueStorage` in `www/native-storage.js`:
  - opens `dkasu_shift` with `no-encryption`;
  - creates `app_kv` and `app_meta`;
  - stores schema version `1` in `app_meta`;
  - enables WAL, `synchronous=FULL`, and a busy timeout;
  - serializes writes through a queue;
  - awaits every write and reads the value back to verify it before reporting success;
  - propagates database failures to the UI.
- Fixed the physical-device SQLite startup failure. The installed APK failed with:
  `Could not open the on-device SQLite database: Execute: unknown error (code 0): Queries can be performed using SQLiteDatabase query or rawQuery methods only`.
  - Exact trigger: `PRAGMA synchronous = FULL` was sent through `SQLiteDBConnection.execute()`. On Android that maps to `SQLiteDatabase.execSQL()`, which rejects PRAGMA/query statements. The plugin prefixes the failure with `Execute:`.
  - `CREATE TABLE` is valid through `execute()` because it is DDL. The first PRAGMA after table creation was the failing call; `busy_timeout` was never reached. `PRAGMA journal_mode = WAL` had already succeeded through `query()`.
  - All three initialization PRAGMAs now use `db.query()` (native raw-query path). DDL uses `execute()`; parameterized INSERT/DELETE uses `run()`.
  - A regression test emulates Android's exact error by throwing when any PRAGMA/SELECT is sent through `execute()`; it fails against the broken implementation and passes against the corrected routing.
  - Initialization errors now identify the failing step (`set synchronous`, `create app_meta table`, etc.).
- Added `ProfileStore` in `www/store.js`. State changes are persisted as one atomic `app_kv` value before in-memory state is committed. Failed writes leave both stored and in-memory data unchanged.
- Migrates legacy multi-profile state from `dkasuMultiProfileDashboard.v1` into `dkasuShiftDashboard.state.v2`; the old row is left intact.
- Starts with Andrew only when no prior state exists. An intentionally empty profile list is not reseeded.
- Schema/state migration strategy is documented in the README.
- SQLite errors at startup are shown on the PIN gate; the app does not continue with an unreliable in-memory-only database.
- Confirmation success messages appear only after the awaited SQLite write succeeds.

### 3. PIN protection

- Replaced unsalted SHA-256 with PBKDF2-HMAC-SHA-256:
  - 310,000 iterations;
  - random 16-byte salt;
  - 32-byte derived hash;
  - constant-time comparison.
- The PIN is never stored; only the salted hash record is stored.
- First launch requires PIN creation and matching confirmation. Subsequent launches require the PIN.
- Submissions are disabled while hashing/verification is in progress.
- Five consecutive failures lock attempts for 30 seconds; lockouts escalate to 60 seconds, 120 seconds, then 300 seconds. The guard is persisted in Preferences.
- Lockout timers are rechecked after app resume/visibility changes.
- Malformed PIN records fail closed and are not overwritten. Missing records show setup; a valid legacy SHA-256 record is verified once and upgraded to PBKDF2 after successful unlock.
- The app module is not initialized until PIN verification succeeds; reloading restores the PIN gate. No in-app route bypasses it.
- When the app becomes hidden/backgrounded after unlock, the PIN gate is restored immediately, the app UI is hidden, and the in-memory view is reset to the profile picker. A correct PIN is required to see the picker again. This closes the launcher/recents resume bypass while preserving data already on disk.
- The UI, README, and audit report explicitly state that the PIN is not database encryption. The SQLite connection is unencrypted.

### 4. Profile operations

- Create, edit, switch, and delete flows are implemented against the awaited store.
- Edit preserves the existing profile ID, creation timestamp, and confirmation records.
- Delete is profile-scoped and requires confirmation. Automated tests verify that deleting one profile does not remove another profile or its confirmations.
- Validation covers:
  - required name and address;
  - email syntax on new edits (legacy optional values are preserved rather than discarded);
  - real calendar dates, including leap-year/day checks;
  - contract end not before start;
  - supported IANA time zones only;
  - schedule time format;
  - duplicate schedule dates;
  - identical start/end times;
  - overnight shifts, supported as ending on the next schedule-zone date.
- Internal profile IDs are unique. Backup duplicate IDs are rejected.
- The Andrew seed retains all six original dates and 06:00–16:00 shifts.
- Confirmation records are nested under the owning profile and include the matching shift date.
- Profiles are listed alphabetically; after PIN unlock, the picker is always shown before a dashboard.
- Storage failure prevents a false success message and leaves prior data intact.

### 5. Backup, restore and worker profile handoff

- Full export includes all profiles, schedules, zones, contract fields, and local confirmations, but no PIN hash.
- Full export format: `DKASUShiftDashboardBackup` version 2; restore supports prior multi-profile version 1.
- Validation checks format, version, export timestamp, profile count, profile IDs, duplicate IDs, required text fields, contract dates, IANA zones, schedule dates/times, confirmation dates/timestamps/zones, and field types.
- Full restore validation is completed before the confirmation prompt and before any storage write. Restore requires user confirmation, then performs one atomic store write. The UI explicitly warns that it replaces every profile and all local confirmation history. Failure leaves existing profiles unchanged.
- Android export uses Filesystem to write a JSON file to app cache, reads it back, reparses/validates it, and then opens the Share sheet. The share sheet is only opened after the file is verified. Browser development uses a standard Blob download.
- `createBackup` enforces the same profile, total-shift, and character limits as restore, and every store mutation validates backupability before committing. This prevents the previous limit mismatch where the app could save data it could not export.
- **Worker handoff added:** `Export selected worker profile` builds a one-profile `DKASUShiftWorkerProfile` v1 package with the worker's setup fields, Ogram Profile ID, Swipe ID, time zones and schedule. Confirmation history is omitted entirely, not merely emptied. PIN material is absent and unsupported extra fields are rejected on import.
- **Additive import:** `Import worker profile package` validates the complete package, pre-checks duplicate internal worker IDs and duplicate non-empty Ogram Profile IDs, asks for confirmation, and then adds the profile in one atomic store write. Existing profiles and their confirmation history are preserved; the imported profile starts with no confirmations.
- Duplicate checks are repeated inside the serialized store mutation so a race cannot overwrite a profile. Errors state that nothing was imported.
- On success, the UI returns to the profile picker so the worker selects the supplied profile. The user does not have to invent IDs or manually configure the profile.
- Worker packages are plaintext and unsigned; only trusted admin packages should be imported.
- The remaining Swipe ID behavior is explicit: the Swipe ID is profile metadata supplied by the admin; the confirmation slider stores a local self-confirmation only and does not contact Ogram.

### 6. Offline operation and time math

- All web assets are packaged in the APK; there are no external fonts, scripts, APIs, or service-worker dependencies.
- The Chrome smoke test recorded zero non-local network requests.
- Removed the obsolete service-worker registration and missing install button.
- IANA conversion uses `Intl.DateTimeFormat` parts and tested offsets for Dubai, Uganda, and Italy before/after Italy's DST change.
- Shift bounds support next-day ends for overnight shifts.
- Dates without a saved schedule show “No saved shift”; no shift is invented.
- Local self-confirmations are clearly labeled as non-Ogram / non-attendance.

### 7. Android hardening

- `android:allowBackup="false"`, `android:fullBackupContent="false"`, and explicit data-extraction exclusion rules were added to avoid Android cloud/device-transfer copying of the unencrypted database and Preferences.
- The app uses the existing Capacitor FileProvider paths for cache sharing.
- No server dependency was introduced.

## Test and build results

| Check | Status | Evidence |
|---|---|---|
| JavaScript syntax | **PASS** | `npm run check:syntax` on app, boot, domain, time, pin, store, native-storage |
| Dependency install | **PASS** | Both `npm install` and a clean `npm ci` completed; final `npm audit` reports 0 vulnerabilities |
| Node automated tests | **PASS** | 53/53 tests passed |
| Real-browser smoke test | **PASS** | Chrome: PIN creation, unlock, picker, dashboard, Italy DST display, reload and resume lock, full backup download/restore, worker-package export, duplicate rejection, invalid-package rejection, additive worker import, invalid full-restore/no-change, and five-attempt lockout; no page/console errors |
| SQLite API-routing regression | **PASS** | Fake native `execute()` reproduces Android's exact PRAGMA/SELECT rejection; corrected PRAGMA calls use `query()` |
| Physical-device SQLite startup | **NOT RUN** | prior APK failure was reported on the device; device disconnected before rebuilt APK installation |
| Vite production build | **PASS** | `npm run build` |
| Capacitor sync | **PASS** | 4 plugins found/copied: SQLite, Filesystem, Preferences, Share |
| Gradle debug APK | **PASS** | `BUILD SUCCESSFUL`, 198 tasks |
| APK signature | **PASS** | APK Signature Scheme v1 and v2; Android debug certificate |
| APK archive integrity | **PASS** | 472 ZIP entries read and CRC-checked; HTML's hashed JS reference is packaged |
| APK manifest/assets | **PASS** | package `com.dkasu.shiftapp`, minSdk 23, target/compile 35, web assets + SQLCipher libs present, backup disabled |
| Chrome external-request check | **PASS** | zero external requests |
| **Android install/launch** | **NOT RUN** | no connected device or emulator |
| **Native SQLite open/write/reload** | **NOT RUN** | requires Android runtime |
| **Force-stop / reboot persistence** | **NOT RUN** | requires Android runtime |
| **Android Share export** | **NOT RUN** | requires Android runtime/share targets |
| **Android file-picker restore/import** | **NOT RUN** | requires Android runtime |
| **Android worker-package share** | **NOT RUN** | requires Android runtime/share targets |
| 5-attempt UI lockout | **PASS (browser)** | real Chrome UI enters persistent 30-second lock; escalation/expiry also unit-tested |
| Resume/background re-lock | **PASS (browser)** | visibility change shows PIN gate, hides app UI, resets to picker; PIN required to return |
| **Android WebView lockout/resume** | **NOT RUN** | requires Android runtime |

The Node tests cover time/DST calculations, profile validation, CRUD/isolation, confirmation preservation, full backup validation/round-trip and backup-limit enforcement, worker-package omissions, malformed/confirmation-history/PIN-field rejection, additive worker import, duplicate worker-profile rejection, failed-import atomicity, PIN hashing/lockout, SQLite schema initialization/API routing, SQLite-adapter queueing/read-back verification (with a fake native DB), simulated write failures, corrupt-store handling, and legacy migration. The DOM smoke test specifically opens and edits a profile, adds/removes a profile, and confirms Andrew's data remains.

Browser result details are in `artifacts/browser-smoke-result.json`; screenshots are `artifacts/ui-pin-setup.png`, `artifacts/ui-pin-locked.png`, `artifacts/ui-profile-picker.png`, `artifacts/ui-dashboard.png`, and `artifacts/ui-worker-handoff.png`.

## Artifacts

- Debug APK: `artifacts\DKASU-Shift-Dashboard-debug.apk`
- Size: 25,036,264 bytes
- SHA-256: `13EA92B9B0B2DCBF7BB6C5B3DAB15B7B7C0ECB41724C8BD1B811249EA2C0F822`
- Checksum file: `artifacts\DKASU-Shift-Dashboard-debug.apk.sha256`
- Gradle source output: `android\app\build\outputs\apk\debug\app-debug.apk`
- Browser result: `artifacts\browser-smoke-result.json`
- Browser backup sample: `artifacts\browser-smoke-backup.json`
- Browser worker package sample: `artifacts\browser-smoke-worker-profile.json`
- Handoff manual steps: `PROFILE_HANDOFF.md`

## Remaining risks / limitations

1. **Native runtime is unverified.** The APK compiles and includes the correct plugins/assets, but no device/emulator was available to prove SQLite connection, persistence across Force Stop/reboot, native sharing, or native file-picker restore work on Android. Run the manual Android checks in the README before relying on the APK.
2. **The PIN is not encryption.** SQLite is opened with `no-encryption`. The PBKDF2 PIN record and lockout counter live in unencrypted Preferences. A rooted device, debugger, or forensic access can read profiles and confirmation data.
3. **No PIN recovery.** Clearing app data resets the PIN and erases local profiles. The PIN is required on cold launch, reload, and resume after backgrounding; off-device backups are still essential.
4. **Backups are plaintext.** Full backups include worker details and confirmation history. Worker packages include worker details and Swipe IDs but exclude confirmation history and PIN material. Store and share both privately.
5. **Worker packages are unsigned, and roles are not authenticated.** Their JSON structure is validated, but there is no cryptographic proof of authorship; only import packages from a trusted owner/admin. “Owner/admin” and “worker” are UI workflow labels, not separate accounts; anyone with the app PIN can manage profiles locally.
6. **Local PIN entropy is limited** (4–12 digits), even with 310,000 PBKDF2 iterations. It is an app-screen lock, not enterprise authentication.
7. The store uses one JSON value in the key/value SQLite table rather than normalized SQL tables. This is allowed by the brief and keeps writes atomic, but every change rewrites the whole profile state. That is acceptable for the current small profile scale.
8. The legacy standalone single-profile backup format from the retired hard-coded dashboard (`AndrewWamaniShiftDashboardBackup`) is not imported. The multi-profile backup format from the newer implementation is supported (v1 and new v2).
9. The debug APK is not release-signed. Building a Play/store release needs a release keystore and release QA.
10. The Android manifest retains the Capacitor template's `INTERNET` permission and permissions contributed by the SQLite plugin (biometric/fingerprint). The shipped app code makes no network requests, and the browser test observed none; these permissions are not used by app logic.
11. Non-blocking build warnings remain in generated/third-party code: deprecated `flatDir`, an SDK XML version mismatch warning from the local SDK installation, an inconsistent `platform-tools-2` SDK path, and Kotlin warnings in `@capacitor/filesystem`. They did not affect the APK.

## Manual Android verification still recommended

1. Install the APK, create a PIN, force-stop the app, reopen, and verify the PIN gate and profile picker. This is the final proof of the corrected SQLite startup path.
2. Open a profile, press Home/Recents, and reopen the app. Confirm the PIN gate appears, no dashboard is visible in the recents preview, and unlocking returns to the profile picker.
3. Create a second profile, add schedules, confirm a local shift, force-stop, and verify both profiles and the confirmation survive.
4. Reboot the device and repeat.
5. Delete one profile and verify the other profile's schedules/confirmations remain.
6. Export a full backup on Android, choose a Files on-device destination, and verify the JSON parses. Note that returning from the Android share sheet requires the PIN.
7. Export one worker profile package, share it, and verify the recipient phone can import it additively. Verify a duplicate import is rejected without changes.
8. Restore the full JSON through the Android document picker and verify every profile is replaced only after confirmation. Note that returning from the picker requires the PIN.
9. Put the device in airplane mode and repeat profile opening, time-zone changes, confirmations, worker package export/import, and full backup export.
10. Test Italy DST dates around 2026-10-25 and 2027-03-28.

See `PROFILE_HANDOFF.md` for the expanded worker handoff test sequence.

# DKASU Native Multi-Profile Shift Dashboard

Offline Capacitor Android app with per-profile shift schedules, time-zone conversion, local self-confirmations, JSON backup/restore, on-device SQLite persistence, and a PIN app lock.

This is a repaired version of the existing project. The original single-profile dashboard code and hard-coded screenshot schedule are no longer executed. The existing multi-profile dashboard design, worker information, profile operations, shifts, countdowns, copyable address, and local confirmations are preserved.

## Status

- Debug APK: `artifacts/DKASU-Shift-Dashboard-debug.apk`
- APK SHA-256: `13EA92B9B0B2DCBF7BB6C5B3DAB15B7B7C0ECB41724C8BD1B811249EA2C0F822`
- SHA-256 file: `artifacts/DKASU-Shift-Dashboard-debug.apk.sha256`
- Android package: `com.dkasu.shiftapp`
- Version: `1.0` (`versionCode 1`)
- SDK: minSdk 23, targetSdk 35, compileSdk 35
- Build type: debug, signed with the Android debug certificate
- 53 automated JavaScript tests pass.
- A real-Chrome smoke test passes PIN flows, full-device backup/restore, worker-package export, duplicate rejection, additive worker import, invalid package rejection, and the local-only confirmation UI with no page errors or external requests.
- Native SQLite, Android share/file-picker behavior, and force-stop/device-restart persistence were **not** runtime-tested for this rebuilt APK: no Android device is currently connected and no emulator image is installed. The APK builds and its packaged assets/plugins were inspected. See `AUDIT_REPORT.md`. The earlier physical-device SQLite startup error is fixed in source and has a native-API-routing regression test, but this APK still needs device launch verification.

## Prerequisites

- Windows 10/11 with PowerShell.
- Node.js and npm. Tested with Node `v24.15.0` and npm `11.12.1`.
- Android Studio with a JDK 21 runtime. Tested with Android Studio JBR `21.0.10`.
- Android SDK with:
  - SDK Platform 35
  - Build Tools 35.0.0 (the build can also auto-download additional build-tools)
  - SDK licenses accepted
- Optional: Chrome or Edge for the browser smoke test, or a connected Android device with USB debugging.

The delivered project includes the generated `android/` Gradle project.

## Build on Windows (PowerShell)

Open PowerShell and run the following from the project root.

```powershell
Set-Location "C:\Users\Utente\Downloads\lovable mix\DKASU_Native_Shift_App"

# 1. Install exact dependencies from package-lock.json.
npm ci

# 2. Static and automated checks.
npm run check:syntax
npm test

# Optional: real-browser smoke test. Uses an installed Chrome or Edge.
# Set CHROME_PATH first if neither browser is in its usual Program Files path.
npm run test:browser

# 3. Build web assets into dist/ and copy them into android/.
npm run android:sync
```

Configure JDK 21 and the Android SDK for Gradle. Android Studio's bundled JBR is JDK 21 and avoids issues with newer system JDKs.

```powershell
$env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"

# Gradle needs the SDK location. This file is intentionally gitignored.
$sdkPath = $env:ANDROID_HOME.Replace("\", "/")
"sdk.dir=$sdkPath" | Set-Content -Encoding ascii android\local.properties
```

Build the debug APK:

```powershell
Set-Location "C:\Users\Utente\Downloads\lovable mix\DKASU_Native_Shift_App"
npm run android:debug
```

The Gradle output is:

```text
android\app\build\outputs\apk\debug\app-debug.apk
```

Copy it to the stable artifact path:

```powershell
New-Item -ItemType Directory -Force artifacts | Out-Null
Copy-Item "android\app\build\outputs\apk\debug\app-debug.apk" `
  "artifacts\DKASU-Shift-Dashboard-debug.apk" -Force
Get-FileHash -Algorithm SHA256 "artifacts\DKASU-Shift-Dashboard-debug.apk"
```

Alternatively, open `android/` in Android Studio and use **Build > Build Bundle(s) / APK(s) > Build APK(s)**.

### Install on a connected Android device

`adb` is not on this machine's PATH, so use its full path or add `platform-tools` to PATH:

```powershell
& "$env:ANDROID_HOME\platform-tools\adb.exe" devices
& "$env:ANDROID_HOME\platform-tools\adb.exe" install -r "artifacts\DKASU-Shift-Dashboard-debug.apk"
```

The APK is debug-signed. Do not treat it as a production/release build.

## First run and app behavior

1. On first launch, create a 4–12 digit PIN and confirm it.
2. On later launches, enter the PIN. Reloading the WebView returns to the PIN screen.
3. After unlocking, the app always opens the **profile picker**. Select a profile to open its dashboard.
4. The seeded **Andrew Wamani** profile and its six saved shifts are preserved unless the user deliberately edits or deletes that profile.
5. Profile add/edit/delete, schedules, display/schedule time zones, contract dates, and local self-confirmations are isolated by profile ID.
6. The confirmation slider records a local note only. It does not contact Ogram or submit attendance.

## Persistence

- Android uses `@capacitor-community/sqlite` with a `no-encryption` connection.
- Database name: `dkasu_shift`.
- Tables:
  - `app_kv(key TEXT PRIMARY KEY, value TEXT NOT NULL)` — serialized app state.
  - `app_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)` — schema version metadata.
- SQLite API routing follows Android's rules:
  - `query()` (native `rawQuery`) for `SELECT` and all `PRAGMA` statements, including the three initialization PRAGMAs;
  - `execute()` for DDL such as `CREATE TABLE`;
  - `run()` for parameterized `INSERT`/`DELETE` writes.
  Sending PRAGMA/SELECT through `execute()` raises `Queries can be performed using SQLiteDatabase query or rawQuery methods only`.
- State key: `dkasuShiftDashboard.state.v2`.
- The complete profile collection is written as one JSON value. Every UI success is shown only after the awaited SQLite write and read-back verification succeed.
- On first run after this repair, old multi-profile data under `dkasuMultiProfileDashboard.v1` is read from the same `app_kv` table and migrated to state version 2.
- An old unsalted SHA-256 PIN record, if present, is accepted once and immediately upgraded to PBKDF2 after a successful unlock.
- Corrupt/unreadable saved state is not overwritten. The app opens read-only and allows a validated backup restore.
- Profile state format version: `2`. SQLite schema version: `1` (stored in `app_meta`).

## PIN and security limits

- New PIN records use **PBKDF2-HMAC-SHA-256**, 310,000 iterations, a random 16-byte salt, and a 256-bit derived hash.
- The PIN itself is never stored in plaintext.
- Five consecutive failures trigger a 30-second lockout; further lockouts escalate to 60 seconds, 120 seconds, and a maximum of 5 minutes. The counter is stored in Capacitor Preferences.
- PIN records and the lockout counter are stored in Android Preferences/SharedPreferences, which are **not encrypted by this app**.
- The SQLite database is **not encrypted**. The PIN is a local screen lock, not database encryption.
- The Android manifest disables Android cloud backup and device-transfer backup for app data.
- A rooted/unlocked device, debugger, or forensic access can read app-private data. Use a strong device lock.
- There is no PIN recovery. Clearing app data erases the PIN and all local profiles. Export backups.
- Clearing app data or uninstalling the app also removes local data.
- The app requires the PIN on cold launch, reload, and when it returns from the background. Returning from the background also resets the visible UI to the profile picker.
- This is not Ogram authentication and does not submit attendance.

## Backup and restore

- **Full device backup** creates one JSON file containing every profile, original schedule, time-zone setting, contract field and local confirmation record. It contains no PIN material. The UI labels this separately from the one-worker handoff package.
- On Android, full backup and worker packages are written to app cache, read back and re-validated, then offered through the Android share sheet. Nothing leaves the device unless a share destination is chosen.
- In a browser development build, normal browser downloads are used.
- **Full restore** validates the complete file first, asks for confirmation, and then replaces the entire profile collection, including local confirmation history. It is not an additive import.
- Restore is a single storage write. If parsing/validation or the storage write fails, existing saved data is not partially replaced.
- Storage uses the same 200-profile, 5,000-total-shift, and 5,000,000-character backup limits. A change that would create data that cannot be exported is rejected before it is saved.
- Backup JSON and confirmation addresses are plaintext sensitive data. Store exports privately.

## Admin setup and worker profile handoff

- The owner/admin creates and maintains worker profiles, including each worker's Swipe ID and saved shifts. Workers should select the profile the admin supplied; they do not need to invent IDs or configure a profile. “Owner/admin” and “worker” are workflow roles, not separate app accounts; anyone with the app PIN can manage locally stored profiles.
- **Export selected worker profile** creates a one-profile JSON package with that worker's details, Ogram Profile ID, Swipe ID, time-zone settings, contract fields and saved schedules. It omits local self-confirmation history and all PIN material. Share the file only with that worker.
- **Import worker profile package** validates the whole package before writing, then adds that worker to the phone. It keeps all existing profiles and their local confirmation records. The imported profile starts with no confirmation history.
- If the package's internal worker ID or Ogram Profile ID already exists on the phone, import stops with a clear message and changes nothing. The same duplicate check is enforced again at the storage write.
- On success, the app returns to the profile picker so the worker can select the supplied profile and use its schedule and Swipe ID. Workers do not need to create or manually configure a profile.
- Worker profile packages are plaintext and are not cryptographically signed. Only import packages received from a trusted owner/admin.
- **Full device backup / restore** remains for moving or recovering a complete device profile collection. Full restore replaces every profile after an explicit confirmation. Use the worker package for adding one supplied profile to a phone.
- The “Swipe to confirm finished” control records a local note for a scheduled shift only. It does not sign in to Ogram, submit attendance, or change an Ogram record.

See [`PROFILE_HANDOFF.md`](PROFILE_HANDOFF.md) for exact manual tests and current verification status.

## Offline operation

- All web assets are bundled into the APK under `assets/public/`.
- The app has no remote API and makes no external requests. The Chrome smoke test asserts zero non-local network requests.
- Time-zone conversions use the device's IANA time-zone database via `Intl`. Italy's DST changes are handled automatically.
- No shift is shown for a date unless that date exists in the selected profile's saved schedule.

## Tests

```powershell
npm run check:syntax
npm test
npm run test:browser
```

- `npm test` runs 53 Node tests covering time conversion/DST, scheduling validation, full backups, worker-package format/omissions, additive import, duplicate rejection, PIN hashing/lockout, profile CRUD/isolation, SQLite schema initialization/API routing, storage-adapter write verification/queueing, write failures, legacy migration, and a DOM dashboard smoke test.
- `npm run test:browser` builds the app, starts a local static server, launches installed Chrome/Edge with Playwright Core, and verifies the PIN → picker → dashboard → reload → resume-lock → full backup flow plus worker-package export, duplicate rejection, invalid-package rejection, and additive worker import. It does not require the network.
- Native Android UI, SQLite runtime access, Android file-picker restore/import, and Android share-sheet export are not covered by these automated tests.

See `AUDIT_REPORT.md` for the audit findings, exact test status, and remaining risks.

## Project layout

```text
www/index.html              UI, PIN gate, dashboard template
www/boot.js                 PIN flow and app startup
www/app.js                  Multi-profile dashboard UI
www/store.js                Awaited profile persistence and state migrations
www/domain.js               Profile/schedule/backup validation
www/time.js                 IANA time-zone and DST calculations
www/pin.js                  PBKDF2 PIN records and lockout logic
www/native-storage.js       SQLite adapter and browser development adapter
tests/                      Node unit tests and DOM smoke test
scripts/browser-smoke.mjs   Real-browser integration smoke test
PROFILE_HANDOFF.md          Worker handoff workflow and manual test steps
android/                    Capacitor Android project
artifacts/                  Built debug APK, screenshots, test result JSON
```

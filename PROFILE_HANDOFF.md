# Worker Profile Handoff

## Previous behavior

- The app supported only a **full-device JSON backup/restore**.
- Full restore replaced every profile on the device. There was no supported way to add one worker profile while retaining everything already on a phone.
- A worker profile already contained a Swipe ID field and saved schedules, but there was no one-worker package workflow.
- The Swipe ID was displayed as worker/profile metadata. The “Swipe to confirm finished” control did **not** authenticate against or submit the Swipe ID to Ogram. It stored a local self-confirmation record containing the shift date, timestamp, display time zone and address. It never contacted Ogram.
- PIN material was never part of full backups.

## Current behavior

### Owner/admin

1. Create or edit the worker profile.
2. Fill in the worker’s details, Ogram Profile ID, Swipe ID, time zones and confirmed shifts.
3. Open **Backup / Restore → Export selected worker profile**.
4. Choose the worker and export. A browser build downloads JSON; Android writes, verifies and offers the file through the share sheet.
5. Share the package privately with that worker.

The export warns if the selected profile has no Swipe ID or no saved shifts but still permits the export so an incomplete handoff can be tested. The admin should send a corrected package when details change.

### Worker

1. Open **Backup / Restore → Import worker profile package**.
2. Select the JSON package supplied by the owner/admin.
3. The app validates the entire package, checks for duplicates, asks for confirmation, and adds the profile without replacing anything already present.
4. The app returns to the profile picker. Select the supplied worker profile.
5. Use the supplied schedule and Swipe ID. There is no need to invent IDs or configure the profile.

### Access model

“Owner/admin” and “worker” are workflow roles, not separate authenticated accounts. Anyone who can unlock the app with its PIN can create, export or import profiles. Device custody and the local app PIN remain the access control. There is no Ogram login, server authorization or official attendance submission.

### Package rules

- Format: `DKASUShiftWorkerProfile`, version `1`.
- Contains one profile with setup fields, Ogram Profile ID, Swipe ID, display/schedule zones, contract fields and saved schedules.
- Does **not** include confirmation history or PIN material.
- Imports reject:
  - invalid JSON, format, version or export timestamp;
  - incorrect field types or malformed dates/times/zones/schedules;
  - unknown top-level/profile fields, including a `confirmations` field or PIN-like fields;
  - an internal worker ID already on the phone;
  - a non-empty Ogram Profile ID already used by another profile on the phone;
  - files that would exceed the app limits.
- Duplicate checks happen before the confirmation prompt and are repeated inside the storage transaction. Failure leaves all existing profiles and confirmation history untouched.
- Worker packages are plaintext and are not cryptographically signed. Only import a package from a trusted owner/admin.

### Full device backup

- Still exports every profile, schedule, time zone and local self-confirmation.
- Full restore still **replaces every profile and all local confirmation history** after validation and an explicit confirmation.
- Full restore is not used to add one worker. Use the worker package flow for that.
- PIN material is not included in either package.

### Confirmation wording

The confirmation panel now states that the Swipe ID was supplied by the owner/admin and that swiping records a local self-confirmation only. It does not contact Ogram, submit attendance or alter an Ogram record.

## Manual test steps

Do not uninstall the app or clear app data. Use test profiles and export a full backup first.

1. Unlock the app. Open **Backup / Restore** and export a full-device backup as a safety copy.
2. As owner/admin, create two disposable worker profiles with distinct names, Ogram Profile IDs and Swipe IDs. Add at least one saved shift to each.
3. Open a saved local confirmation on one existing profile that should be preserved.
4. In **Backup / Restore**, select worker B and export their worker profile package. Confirm a JSON file is produced (browser download or Android share destination).
5. Inspect the JSON in a text editor. Confirm:
   - `format` is `DKASUShiftWorkerProfile`;
   - the correct worker’s Swipe ID and schedules are present;
   - `confirmations`/`confirmedAt` are absent;
   - no PIN, salt or hash fields exist.
6. Import the same package into the same app while worker B still exists. Confirm a clear duplicate message appears and no profile/confirmation data changes.
7. Test additive import using either a second phone or a disposable test profile:
   - Second phone: keep its existing profiles and at least one local confirmation, import worker B, and confirm all existing data remains.
   - One phone: after exporting worker B, delete only the disposable worker B, keeping other profiles and confirmations, then import worker B.
8. Confirm the app returns to the profile picker. Both the pre-existing profile and the imported worker appear.
9. Open the pre-existing profile and confirm its schedule and local confirmation are unchanged.
10. Open worker B, confirm the supplied Swipe ID, profile details and saved shifts appear, then open a scheduled shift and perform the confirmation swipe. Verify the app says it is a local self-confirmation and that Ogram was not contacted.
11. Import a malformed JSON file and a full-device backup through **Import worker profile package**. Confirm both fail with clear messages and no profile changes.
12. Import a package containing a non-empty Ogram Profile ID that already exists on the phone. Confirm the duplicate is rejected without changes.
13. Only on a disposable test install/device, test **Full backup → Restore**. Confirm the warning says all profiles and local confirmation history will be replaced and that the replacement prompt names the profiles. Do not run this on real data without a current backup.
14. On Android, repeat export/import through the share sheet and document picker, then force-stop the app and verify profiles and confirmations remain.

## Checks actually run for this build

- `npm run check:syntax`: passed.
- `npm test`: 53/53 passed, including worker-package omissions, malformed/confirmation-history/PIN-field rejection, additive import, duplicate-ID rejection, no-write-on-failure, and confirmation preservation.
- `npm run test:browser`: passed in installed Chrome. The flow covered PIN setup/unlock/lockout, profile picker, dashboard, time-zone display, reload/resume lock, full backup download/restore, worker-package export, duplicate rejection, invalid worker package rejection, additive worker import, and zero external requests.
- `npm run build`: passed.
- `npx cap sync android`: passed with the four Capacitor plugins.
- Gradle `assembleDebug`: passed; APK generated.

## Not run

- Installation and launch of this rebuilt APK on Android.
- Android native SQLite startup verification for this build.
- Android share-sheet worker package export.
- Android document-picker worker package import.
- Android force-stop/restart persistence.
- Native touch interaction with the confirmation slider.

A physical device was connected earlier but disconnected before the rebuilt APK could be installed. No app data was cleared. The APK build, package integrity, web tests and the native-API-routing regression test do not substitute for Android runtime verification.

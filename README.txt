DKASU NATIVE MULTI-PROFILE SHIFT APP — SOURCE PROJECT

What this package is
- Capacitor Android project source, intended to build an installable APK.
- On Android, the app key/value persistence adapter stores the dashboard's existing localStorage keys in a SQLite table inside the app's private sandbox. Profiles and confirmations remain logically isolated by profile ID.
- First launch asks you to create a 4–12 digit PIN. Later launches require it. PIN hash is stored with Android Preferences, not as plaintext.
- Profile add/edit/delete/switch, schedules, time zones, contracts, self-confirmations, and JSON backup/restore are preserved from the existing multi-profile dashboard.
- Works offline after installed because the web assets are bundled in the APK.

BUILD ON WINDOWS (Android Studio required)
1. Install Node.js LTS and Android Studio. In Android Studio, install Android SDK Platform and Build Tools for a current supported Android version.
2. Extract this ZIP to a normal folder, open PowerShell in that folder.
3. Run: npm install
4. Run: npm run build
5. Run: npx cap add android
6. Run: npx cap sync android
7. Run: npx cap open android
8. In Android Studio, wait for Gradle sync. Select Build > Build Bundle(s) / APK(s) > Build APK(s).
9. The debug APK is usually at android/app/build/outputs/apk/debug/app-debug.apk. Install it on your Android device for testing.

IMPORTANT IMPLEMENTATION NOTES
- This is the source project, not a precompiled APK. Build requires Android Studio/Android SDK and downloading npm/Gradle dependencies.
- SQLite database uses a key/value table as a compatibility layer for the current dashboard code; the dashboard serializes the profile collection into that table. It is on-device SQLite, but not a normalized per-profile SQL schema.
- The PIN is a local app lock, not encryption of the database. Android app-private storage protects the database from ordinary other apps, but a rooted/unlocked device or forensic access may expose it. Use a strong device lock too.
- PIN hash uses SHA-256 without a server. Do not use this as enterprise-grade authentication. The PIN is not recoverable if forgotten; export backups regularly and keep them secure. Clearing app data removes the database and PIN.
- Local self-confirmations are notes on this device; they do not submit attendance to Ogram. This is not an official Ogram integration.
- Test add/edit/delete, switch profiles, backup/restore, relaunch, offline mode, and PIN behavior before relying on it. This environment did not build or test a physical-device APK.

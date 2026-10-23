# DKASU Shift Dashboard backend foundation

This is the shift app's own authorization and data layer. It shares the POS Supabase Auth project for Google identities, but it does not use POS membership or POS staff tables.

## Current boundary

- `shift_admins` is the only source of shift administrator authority. Seed the DKASU owner by Auth user ID after reviewing the deployed project.
- Workers sign in with Google through Supabase Auth, then redeem a single-use admin-issued activation code. The code is linked only when the Google identity email matches the worker email already set by the admin.
- `shift_workers.auth_user_id` links a worker to one Auth identity. Workers can read only their active profile and schedules.
- Profile and schedule writes are admin-only. Worker authentication never inserts into `shop_members` or `shop_pos_staff`.
- `shift_confirmations` accepts append-only `worker_self_confirmation` events. `submitted_at` is the worker/device time; `received_at` is the server receipt time. These records are self-reports, not attendance or payroll data.
- The local profile identifier can be retained in `source_local_id` during an explicit, reviewed migration.

## Migration status

`supabase/migrations/20261022000100_shift_dashboard_foundation.sql` is authored locally and has not been applied. The local workspace does not have a Supabase connection. Before deployment, compare the SQL with the live project's extension placement, grants, deployed objects, and Auth identity behavior. Add the first shift admin through a controlled database-owner operation; do not expose an unauthenticated bootstrap path.

## Admin activation code handling

The admin UI should generate a cryptographically random, one-time code, compute its SHA-256 digest with Web Crypto, and call `shift_create_activation`. It should display the raw code or QR only once. The database stores only the digest; `shift_claim_activation` atomically checks and consumes it after Google sign-in. A new code revokes any prior unused code for that worker.

## Not yet implemented

- Physical-device OAuth and app-link validation, plus worker deactivation/revocation UX.
- Hosting/DNS setup for the admin build at `shifts.dkasu.com`.
- Reviewed import of existing legacy profiles and confirmation history.
- Admin bootstrap, live migration comparison, and production deployment.

## Admin dashboard

The separate `admin/` web app uses the shared Supabase Auth project and reads/writes only the `shift_*` tables. Local development uses the root `.env.local` values documented by `.env.example`; `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are public client configuration, never service-role credentials. Run it with `npm run admin:dev`; create its static output with `npm run admin:build`. Configure the hosting project to publish `dist-admin/` at the `shifts.dkasu.com` origin and add its sign-in redirect to the Supabase Auth allowlist before deployment.

The first shift admin is not self-registered. After the live migration is reviewed/applied, add the DKASU owner’s Auth UUID to `shift_admins` through an authorized database-owner workflow. A Google account that signs in without that row receives no admin data access.

## Android worker authentication and sync groundwork

`www/worker-auth.js` uses the shared Supabase Auth project, PKCE, the system browser, and Capacitor's app-link listener. The Android callback is `dkasu-shift://auth/callback`; it must be added to the Supabase Auth redirect allowlist before login can work. The Android worker gate requires Google sign-in and admin-issued activation. It loads the linked worker and schedule into an app-private SQLite cache under a separate `shift_<worker UUID>` profile, preserving pre-existing profiles and confirmations. Worker profile and schedule editing is disabled in this mode.

New worker self-confirmations are stored locally with a stable event UUID and pending status in the same profile write. Sync retries are idempotent through `client_event_id`; a lost connection leaves the event pending for a later foreground retry. Existing confirmation records have no sync UUID and are not uploaded automatically. The database stores them only as `worker_self_confirmation`, with both the submitted time and server receipt time; they are not official attendance.

The auth callback, activation, and sync paths have not been validated with the live Supabase project or on a physical Android device. Configure the public Supabase URL/key and OAuth redirect allowlist, review/apply the migration, and seed the first admin before using these flows.

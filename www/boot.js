import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { initApp } from './app.js';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { createStorage } from './native-storage.js';
import { createBackup, parseBackupText } from './domain.js';
import {
  claimSwiperActivation,
  getShiftSession,
  initializeShiftAuth,
  isShiftAdminUser,
  loadShiftSwiperData,
  shiftAuthConfigured,
  signInWithGoogle,
  signOutShiftWorker,
  setShiftDeviceId,
  syncSwiperConfirmations
} from './worker-auth.js';
import { ProfileStore } from './store.js';

const workerGate = document.getElementById('workerAuthGate');
const workerAuthTitle = document.getElementById('workerAuthTitle');
const workerAuthMessage = document.getElementById('workerAuthMessage');
const workerAuthError = document.getElementById('workerAuthError');
const workerGoogleButton = document.getElementById('workerGoogleButton');
const workerAuthSignOutButton = document.getElementById('workerAuthSignOutButton');
const workerRegistrationChoice = document.getElementById('workerRegistrationChoice');
const workerRegisterButton = document.getElementById('workerRegisterButton');
const workerRegisterIntro = document.getElementById('workerRegisterIntro');
const workerActivationForm = document.getElementById('workerActivationForm');
const workerActivationCode = document.getElementById('workerActivationCode');
const workerActivationButton = document.getElementById('workerActivationButton');
const legacyBackupButton = document.getElementById('legacyBackupButton');
const legacyBackupStatus = document.getElementById('legacyBackupStatus');
const appRoot = document.getElementById('appRoot');

let workerRegistrationMode = false;
let appStarted = false;
let applicationStore = null;
let applicationStorage = null;
let applicationApp = null;
let storageLabel = 'device storage';

async function exportPreservedLocalData() {
  if (!applicationStore) throw new Error('Local profiles have not finished loading. Try again in a moment.');
  if (applicationStore.readOnly) throw new Error('Saved profile data could not be read safely, so a backup cannot be created.');
  const profiles = applicationStore.listProfiles();
  if (!profiles.length) throw new Error('There are no readable local profiles to export.');
  const json = JSON.stringify(createBackup(profiles), null, 2);
  parseBackupText(json);
  const filename = `DKASU_Shift_Backup_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  if (Capacitor.isNativePlatform()) {
    const file = await Filesystem.writeFile({ path: filename, data: json, directory: Directory.Cache, encoding: Encoding.UTF8 });
    const check = await Filesystem.readFile({ path: filename, directory: Directory.Cache, encoding: Encoding.UTF8 });
    parseBackupText(String(check.data));
    await Share.share({ title: 'DKASU local shift data backup', dialogTitle: 'Save or share preserved local data', files: [file.uri] });
  } else {
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
}

async function getOperatorDeviceId(userId) {
  const key = `dkasu_shift_device_${userId}`;
  const saved = await Preferences.get({ key });
  if (saved.value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(saved.value)) {
    return saved.value;
  }
  const id = crypto.randomUUID();
  await Preferences.set({ key, value: id });
  const verified = await Preferences.get({ key });
  if (verified.value !== id) throw new Error('Could not save this operator’s device identity.');
  return id;
}

async function startDashboard() {
  if (!shiftAuthConfigured) {
    showWorkerGate('Sign-in is not configured in this build. Ask the DKASU admin to finish the shift app setup.');
    return;
  }
  try {
    const session = await getShiftSession();
    if (!session) {
      if (!Capacitor.isNativePlatform() && window.location.pathname.startsWith('/worker/')) {
        window.location.replace(new URL('/', window.location.origin).href);
        return;
      }
      showWorkerGate('Sign in with the Google account your DKASU admin registered.');
      return;
    }

    if (await isShiftAdminUser(session.user.id)) {
      if (Capacitor.isNativePlatform()) {
        window.location.replace(new URL('/admin/', window.location.origin).href);
        return;
      }
      if (window.location.pathname.startsWith('/worker/')) {
        window.location.replace(new URL('/', window.location.origin).href);
        return;
      }
    }

    const deviceId = await getOperatorDeviceId(session.user.id);
    setShiftDeviceId(deviceId);
    const deviceAssignmentsKey = `dkasu.shift.assignments.${session.user.id}.${deviceId}`;

    let workerContext = null;
    let workerIdsByProfileId = {};
    try {
      workerContext = await loadShiftSwiperData();
      if (!workerContext) {
        workerRegistrationMode = true;
        showWorkerGate(`Signed in as ${session.user.email || 'your Google account'}. Enter the activation code for your swiper account.`, { needsActivation: true, signedIn: true });
        return;
      }
      if (!workerContext.swiper.is_active) {
        showWorkerGate('Your swiper access is inactive. Contact the DKASU admin to restore access.', { needsAssignment: true, signedIn: true });
        return;
      }
      if (!workerContext.accounts.length) {
        workerRegistrationMode = false;
        showWorkerGate(`Swiper access is active for ${session.user.email || 'your account'}, but this device has no assigned Swipe ID groups yet. Ask the DKASU admin to assign account groups to this device, then reconnect.`, { needsAssignment: true, signedIn: true });
        return;
      }
      for (const account of workerContext.accounts) {
        const profile = await applicationStore.syncRemoteWorker(account.worker, account.schedules, account.dailyRule);
        workerIdsByProfileId[profile.id] = account.worker.id;
      }
      await applicationStorage.setItem(deviceAssignmentsKey, JSON.stringify({
        swiperId: workerContext.swiper.id,
        deviceId,
        workerIds: workerContext.accounts.map(({ worker }) => worker.id)
      }));
    } catch (error) {
      const cachedAssignmentsRaw = await applicationStorage.getItem(deviceAssignmentsKey);
      let cachedAssignments = null;
      try { cachedAssignments = cachedAssignmentsRaw ? JSON.parse(cachedAssignmentsRaw) : null; } catch { /* Ignore invalid cache; keep saved profile data untouched. */ }
      if (cachedAssignments?.deviceId !== deviceId || !cachedAssignments?.workerIds?.length) {
        showWorkerGate(`Could not load your assigned swipe accounts. Check your connection and try again. ${error?.message || error}`);
        return;
      }
      for (const id of cachedAssignments.workerIds) {
        const profileId = `shift_${id}`;
        if (applicationStore.getProfile(profileId)) workerIdsByProfileId[profileId] = id;
      }
      if (!Object.keys(workerIdsByProfileId).length) {
        showWorkerGate('No previously downloaded swipe accounts are available on this device. Connect to the internet and ask the admin to assign your accounts.');
        return;
      }
      workerAuthMessage.textContent = `Offline mode: showing ${Object.keys(workerIdsByProfileId).length} previously assigned swipe account(s). New assignments and schedule changes need an internet connection.`;
    }

    applicationStore.workerAllowedProfileIds = new Set(Object.keys(workerIdsByProfileId));
    if (!applicationStore.getActiveProfileId() || !applicationStore.workerAllowedProfileIds.has(applicationStore.getActiveProfileId())) {
      await applicationStore.selectProfile(Object.keys(workerIdsByProfileId)[0]);
    }

    applicationApp = await initApp({
      store: applicationStore,
      storageLabel,
      workerMode: true,
      workerIdsByProfileId,
      syncActorId: session.user.id,
      onResumeSync: syncSwiperConfirmations,
      onSignOut: async () => {
        try {
          await signOutShiftWorker();
          setShiftDeviceId('');
          applicationApp?.destroy?.();
          applicationApp = null;
          appStarted = false;
          if (appRoot) appRoot.style.display = 'none';
          workerRegistrationMode = false;
          if (!Capacitor.isNativePlatform()) {
            window.location.replace(new URL('/', window.location.origin).href);
            return;
          }
          showWorkerGate('You are signed out. Sign in with your DKASU Google account to continue.');
        } catch (error) {
          showWorkerGate(`Sign-out could not finish. ${error?.message || error}`);
        }
      }
    });
    if (workerGate) workerGate.style.display = 'none';
    if (appRoot) appRoot.style.display = 'block';
    appStarted = true;
  } catch (error) {
    showWorkerGate(`Could not open the worker dashboard. ${error?.message || error}`);
  }
}

function setGoogleButtonLabel(label) {
  if (!workerGoogleButton) return;
  const text = workerGoogleButton.querySelector('span');
  if (text) text.textContent = label;
  else workerGoogleButton.textContent = label;
}

function showWorkerGate(message, { needsActivation = false, needsAssignment = false, signedIn = false } = {}) {
  if (workerGate) workerGate.style.display = 'flex';
  if (appRoot) appRoot.style.display = 'none';
  if (workerAuthMessage) workerAuthMessage.textContent = message;
  if (workerAuthError) workerAuthError.textContent = '';
  if (workerGoogleButton) workerGoogleButton.disabled = !shiftAuthConfigured;
  if (workerActivationButton) workerActivationButton.disabled = !shiftAuthConfigured;
  if (workerAuthTitle) workerAuthTitle.textContent = needsActivation
    ? 'Complete swiper registration'
    : needsAssignment ? 'Waiting for swipe accounts' : 'Sign in to your shift dashboard';
  setGoogleButtonLabel(needsActivation
    ? 'Use a different Google account'
    : workerRegistrationMode ? 'Continue with Google to register' : 'Continue with Google');
  if (workerAuthSignOutButton) workerAuthSignOutButton.classList.toggle('hidden', !signedIn);
  if (workerRegistrationChoice) workerRegistrationChoice.classList.toggle('hidden', needsActivation || needsAssignment || workerRegistrationMode);
  if (workerRegisterIntro) workerRegisterIntro.classList.toggle('hidden', needsActivation || needsAssignment || !workerRegistrationMode);
  if (workerActivationForm) workerActivationForm.classList.toggle('hidden', !needsActivation);
}

async function start() {
  try {
    await initializeShiftAuth({
      onCallbackError: (error) => {
        const message = `Google sign-in could not finish. ${error?.message || error}`;
        if (appStarted) showAppError(message);
        else if (workerAuthError) workerAuthError.textContent = message;
      },
      onCallbackSuccess: () => {
        if (applicationStore && workerGate?.style.display === 'flex') void startDashboard();
      }
    });
    const storage = await createStorage();
    applicationStorage = storage;
    storageLabel = storage.label;
    applicationStore = new ProfileStore(storage);
    await applicationStore.load();
    // Remove only obsolete local app-lock preferences. This does not touch SQLite,
    // worker profiles, schedules, confirmations, Google sessions, or device identity.
    try {
      await Promise.all([
        Preferences.remove({ key: 'dkasu_pin_v2' }),
        Preferences.remove({ key: 'dkasu_pin_sha256' }),
        Preferences.remove({ key: 'dkasu_pin_guard_v2' }),
        Preferences.remove({ key: 'dkasu_biometric_unlock_v1' })
      ]);
    } catch (error) {
      console.warn('Obsolete app-lock preferences could not be cleared', error);
    }
    await startDashboard();
  } catch (error) {
    console.error(error);
    showWorkerGate(`App startup failed. The on-device database could not be opened. Close and reopen the app. If this continues, check the build and SQLite setup. ${error?.message || String(error)}`);
  }
}

function showAppError(message) {
  const element = document.getElementById('appMessage');
  if (!element) return;
  element.textContent = message;
  element.classList.remove('hidden', 'success');
  element.classList.add('error');
}

void start();

workerRegisterButton?.addEventListener('click', () => {
  workerRegistrationMode = true;
  if (workerAuthTitle) workerAuthTitle.textContent = 'Register as a swiper';
  if (workerAuthMessage) workerAuthMessage.textContent = 'Use the Google account your DKASU admin invited. You will enter the swiper activation code after signing in.';
  if (workerAuthError) workerAuthError.textContent = '';
  if (workerRegistrationChoice) workerRegistrationChoice.classList.add('hidden');
  if (workerRegisterIntro) workerRegisterIntro.classList.remove('hidden');
  if (workerGoogleButton) {
    setGoogleButtonLabel('Continue with Google to register');
    workerGoogleButton.focus();
  }
});

workerGoogleButton?.addEventListener('click', async () => {
  if (workerGoogleButton.disabled) return;
  workerGoogleButton.disabled = true;
  workerAuthError.textContent = '';
  try {
    await signInWithGoogle();
  } catch (error) {
    workerAuthError.textContent = `Google sign-in could not start. ${error?.message || error}`;
    workerGoogleButton.disabled = false;
  }
});

workerAuthSignOutButton?.addEventListener('click', async () => {
  if (workerAuthSignOutButton.disabled) return;
  workerAuthSignOutButton.disabled = true;
  workerAuthError.textContent = '';
  try {
    await signOutShiftWorker();
    setShiftDeviceId('');
    workerRegistrationMode = false;
    showWorkerGate('You are signed out. Choose “Register as a swiper” to continue with another Google account.');
  } catch (error) {
    workerAuthError.textContent = `Sign-out could not finish. ${error?.message || error}`;
  } finally {
    workerAuthSignOutButton.disabled = false;
  }
});

workerActivationForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!shiftAuthConfigured || workerActivationButton.disabled) return;
  workerActivationButton.disabled = true;
  workerAuthError.textContent = '';
  try {
    await claimSwiperActivation(workerActivationCode.value);
    workerActivationCode.value = '';
    await startDashboard();
  } catch (error) {
    workerAuthError.textContent = error?.message || String(error);
  } finally {
    workerActivationButton.disabled = false;
  }
});

legacyBackupButton?.addEventListener('click', async () => {
  legacyBackupButton.disabled = true;
  if (legacyBackupStatus) legacyBackupStatus.textContent = 'Preparing and verifying local backup…';
  try {
    await exportPreservedLocalData();
    if (legacyBackupStatus) legacyBackupStatus.textContent = 'Backup verified. Save it somewhere safe before continuing.';
  } catch (error) {
    if (legacyBackupStatus) legacyBackupStatus.textContent = `Backup was not created. ${error?.message || error}`;
  } finally {
    legacyBackupButton.disabled = false;
  }
});

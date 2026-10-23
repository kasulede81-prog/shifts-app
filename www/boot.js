import { Capacitor, registerPlugin } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { initApp } from './app.js';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { createStorage } from './native-storage.js';
import { createBackup, parseBackupText } from './domain.js';
import {
  claimSwiperActivation,
  claimSwiperPinReset,
  getShiftSession,
  initializeShiftAuth,
  isShiftAdminUser,
  loadShiftSwiperData,
  shiftAuthConfigured,
  signInWithGoogle,
  signOutShiftWorker,
  syncSwiperConfirmations
} from './worker-auth.js';
import {
  PinRecordError,
  PinValidationError,
  createPinRecord,
  emptyPinGuard,
  getLockRemainingMs,
  isValidPin,
  parsePinGuard,
  parsePinRecord,
  registerPinFailure,
  registerPinSuccess,
  serializePinRecord,
  validatePinSetup,
  verifyLegacySha256Pin,
  verifyPin
} from './pin.js';
import { ProfileStore } from './store.js';

const PIN_RECORD_KEY = 'dkasu_pin_v2';
const LEGACY_PIN_KEY = 'dkasu_pin_sha256';
const PIN_GUARD_KEY = 'dkasu_pin_guard_v2';
const BIOMETRIC_UNLOCK_KEY = 'dkasu_biometric_unlock_v1';
const LEGACY_HASH_PATTERN = /^[a-f0-9]{64}$/i;
const APP_LOCK_BACKGROUND_DELAY_MS = 5 * 60 * 1000;
const biometricUnlock = registerPlugin('BiometricUnlock');

const gate = document.getElementById('pinGate');
const workerGate = document.getElementById('workerAuthGate');
const workerAuthTitle = document.getElementById('workerAuthTitle');
const workerAuthMessage = document.getElementById('workerAuthMessage');
const workerAuthError = document.getElementById('workerAuthError');
const workerGoogleButton = document.getElementById('workerGoogleButton');
const workerSignOutButton = document.getElementById('workerSignOutButton');
const workerRegistrationChoice = document.getElementById('workerRegistrationChoice');
const workerRegisterButton = document.getElementById('workerRegisterButton');
const workerRegisterIntro = document.getElementById('workerRegisterIntro');
const workerActivationForm = document.getElementById('workerActivationForm');
const workerActivationCode = document.getElementById('workerActivationCode');
const workerActivationButton = document.getElementById('workerActivationButton');
const legacyBackupButton = document.getElementById('legacyBackupButton');
const legacyBackupStatus = document.getElementById('legacyBackupStatus');
const appRoot = document.getElementById('appRoot');
const pinForm = document.getElementById('pinForm');
const pinTitle = document.getElementById('pinTitle');
const pinHelp = document.getElementById('pinHelp');
const pinInput = document.getElementById('pinInput');
const pinConfirm = document.getElementById('pinConfirm');
const pinSubmit = document.getElementById('pinSubmit');
const biometricUnlockButton = document.getElementById('biometricUnlockButton');
const pinError = document.getElementById('pinError');
const pinRecoveryPanel = document.getElementById('pinRecoveryPanel');
const pinRecoveryCode = document.getElementById('pinRecoveryCode');
const pinRecoverySubmit = document.getElementById('pinRecoverySubmit');
const pinRecoveryGoogleButton = document.getElementById('pinRecoveryGoogleButton');
const pinRecoveryStatus = document.getElementById('pinRecoveryStatus');
const biometricUnlockToggle = document.getElementById('biometricUnlockToggle');
const biometricUnlockStatus = document.getElementById('biometricUnlockStatus');

let mode = 'starting';
let workerRegistrationMode = false;
let storedRecord = null;
let legacyHash = '';
let guard = emptyPinGuard();
let busy = true;
let lockTimer = null;
let appStarted = false;
let appLocked = false;
let appBackgroundedAt = null;
let biometricEnabled = false;
let applicationStore = null;
let applicationStorage = null;
let applicationApp = null;
let storageLabel = 'device storage';

pinSubmit.disabled = true;
pinSubmit.textContent = 'Starting…';
pinInput.setAttribute('aria-label', 'App PIN');
pinConfirm.setAttribute('aria-label', 'Confirm app PIN');

function setPinError(message) {
  if (pinError) pinError.textContent = message || '';
}

function showAppError(message) {
  const element = document.getElementById('appMessage');
  if (!element) return;
  element.textContent = message;
  element.classList.remove('hidden', 'success');
  element.classList.add('error');
}

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

function stopLockTimer() {
  if (lockTimer !== null) {
    clearInterval(lockTimer);
    lockTimer = null;
  }
}

function buttonIdleLabel() {
  return mode === 'setup' ? 'Create PIN' : 'Unlock';
}

function refreshControls() {
  if (!pinSubmit || !pinInput) return;
  if (biometricUnlockButton) {
    biometricUnlockButton.classList.toggle('hidden', mode !== 'unlock' || !biometricEnabled || !Capacitor.isNativePlatform());
    biometricUnlockButton.disabled = busy;
  }
  if (mode === 'fatal' || mode === 'corrupt') {
    pinInput.disabled = true;
    if (pinConfirm) pinConfirm.disabled = true;
    pinSubmit.disabled = true;
    pinSubmit.textContent = 'Unavailable';
    return;
  }
  const remaining = mode === 'setup' ? 0 : getLockRemainingMs(guard, Date.now());
  if (remaining > 0) {
    pinInput.disabled = true;
    if (pinConfirm) pinConfirm.disabled = true;
    pinSubmit.disabled = true;
    pinSubmit.textContent = `Locked (${Math.ceil(remaining / 1000)}s)`;
    setPinError(`Too many incorrect attempts. Try again in ${Math.ceil(remaining / 1000)} second(s).`);
    if (lockTimer === null) {
      lockTimer = setInterval(() => {
        if (mode === 'fatal' || mode === 'corrupt') {
          stopLockTimer();
          return;
        }
        if (getLockRemainingMs(guard, Date.now()) > 0) {
          refreshControls();
          return;
        }
        stopLockTimer();
        setPinError('');
        refreshControls();
        pinInput.focus();
      }, 500);
    }
    return;
  }
  stopLockTimer();
  pinInput.disabled = busy;
  if (pinConfirm) pinConfirm.disabled = busy;
  pinSubmit.disabled = busy;
  pinSubmit.textContent = busy ? 'Please wait…' : buttonIdleLabel();
}

function setBusy(value) {
  busy = value;
  refreshControls();
}

function showFatal(title, help, detail = '') {
  mode = 'fatal';
  stopLockTimer();
  busy = false;
  if (gate) gate.style.display = 'flex';
  if (appRoot) appRoot.style.display = 'none';
  if (pinTitle) pinTitle.textContent = title;
  if (pinHelp) pinHelp.textContent = help;
  setPinError(detail);
  refreshControls();
}

function configurePinScreen() {
  if (pinRecoveryPanel) pinRecoveryPanel.classList.toggle('hidden', mode === 'setup' || mode === 'fatal' || mode === 'corrupt');
  if (mode === 'setup') {
    pinTitle.textContent = 'Create your app PIN';
    pinHelp.textContent = 'Create a 4–12 digit PIN. You can optionally enable biometric unlock later in Security.';
    pinConfirm.style.display = 'block';
    pinConfirm.value = '';
    pinInput.autocomplete = 'new-password';
    pinSubmit.textContent = 'Create PIN';
    setPinError('');
    pinInput.focus();
  } else if (mode === 'unlock' || mode === 'legacy') {
    pinTitle.textContent = 'Unlock shift dashboard';
    pinHelp.textContent = mode === 'legacy'
      ? 'Enter your existing app PIN. It will be upgraded to a salted, deliberately slow hash after unlock.'
      : biometricEnabled && Capacitor.isNativePlatform()
        ? 'Use your optional biometric or phone lock, or enter your app PIN.'
        : 'Enter your app PIN to continue.';
    pinConfirm.style.display = 'none';
    pinConfirm.value = '';
    pinInput.autocomplete = 'current-password';
    setPinError('');
    pinInput.focus();
  }
  refreshControls();
}

async function persistGuard() {
  try {
    await Preferences.set({ key: PIN_GUARD_KEY, value: JSON.stringify(guard) });
  } catch (error) {
    console.error('PIN lockout state could not be persisted', error);
  }
}

async function savePinRecord(serialized) {
  await Preferences.set({ key: PIN_RECORD_KEY, value: serialized });
  const readBack = await Preferences.get({ key: PIN_RECORD_KEY });
  if (readBack.value !== serialized) {
    throw new Error('The PIN record could not be verified after saving.');
  }
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
        showWorkerGate(`Swiper access is active for ${session.user.email || 'your account'}, but the admin has not assigned any swipe accounts yet. Ask the DKASU admin to assign your accounts.`, { needsAssignment: true, signedIn: true });
        return;
      }
      for (const account of workerContext.accounts) {
        const profile = await applicationStore.syncRemoteWorker(account.worker, account.schedules, account.dailyRule);
        workerIdsByProfileId[profile.id] = account.worker.id;
      }
      await applicationStorage.setItem(`dkasu.shift.assignments.${session.user.id}`, JSON.stringify({
        swiperId: workerContext.swiper.id,
        workerIds: workerContext.accounts.map(({ worker }) => worker.id)
      }));
    } catch (error) {
      const cachedAssignmentsRaw = await applicationStorage.getItem(`dkasu.shift.assignments.${session.user.id}`);
      let cachedAssignments = null;
      try { cachedAssignments = cachedAssignmentsRaw ? JSON.parse(cachedAssignmentsRaw) : null; } catch { /* Ignore an invalid cache; do not overwrite it. */ }
      if (!cachedAssignments?.workerIds?.length) {
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
    if (gate) {
      gate.style.display = 'none';
      gate.setAttribute('aria-hidden', 'true');
    }
    if (workerGate) workerGate.style.display = 'none';
    if (appRoot) appRoot.style.display = 'block';
    appStarted = true;
    appLocked = false;
    stopLockTimer();
    pinInput.value = '';
    pinConfirm.value = '';
  } catch (error) {
    showWorkerGate(`Could not open the worker dashboard. ${error?.message || error}`);
  }
}

function showWorkerGate(message, { needsActivation = false, needsAssignment = false, signedIn = false } = {}) {
  if (gate) gate.style.display = 'none';
  if (appRoot) appRoot.style.display = 'none';
  if (workerGate) workerGate.style.display = 'flex';
  if (workerAuthMessage) workerAuthMessage.textContent = message;
  if (workerAuthError) workerAuthError.textContent = '';
  if (workerGoogleButton) workerGoogleButton.disabled = !shiftAuthConfigured;
  if (workerActivationButton) workerActivationButton.disabled = !shiftAuthConfigured;
  if (workerAuthTitle) workerAuthTitle.textContent = needsActivation
    ? 'Complete swiper registration'
    : needsAssignment ? 'Waiting for swipe accounts' : 'Sign in to your shift dashboard';
  if (workerGoogleButton) workerGoogleButton.textContent = needsActivation
    ? 'Use a different Google account'
    : workerRegistrationMode ? 'Continue with Google to register' : 'Continue with Google';
  if (workerSignOutButton) workerSignOutButton.classList.toggle('hidden', !signedIn);
  if (workerRegistrationChoice) workerRegistrationChoice.classList.toggle('hidden', needsActivation || needsAssignment || workerRegistrationMode);
  if (workerRegisterIntro) workerRegisterIntro.classList.toggle('hidden', needsActivation || needsAssignment || !workerRegistrationMode);
  if (workerActivationForm) workerActivationForm.classList.toggle('hidden', !needsActivation);
}

function showResumeLock() {
  if (!appStarted || appLocked || mode === 'fatal' || mode === 'corrupt') return;
  appLocked = true;
  mode = 'unlock';
  busy = false;
  stopLockTimer();
  pinInput.value = '';
  pinConfirm.value = '';
  if (appRoot) appRoot.style.display = 'none';
  if (gate) {
    gate.style.display = 'flex';
    gate.setAttribute('aria-hidden', 'false');
  }
  applicationApp?.showProfilePickerForLock?.();
  configurePinScreen();
  if (pinHelp) pinHelp.textContent = biometricEnabled && Capacitor.isNativePlatform()
    ? 'Use your optional biometric or phone lock, or enter your app PIN to resume.'
    : 'Enter your app PIN to resume.';
  setPinError('');
}

function completeResumeUnlock() {
  applicationApp?.showProfilePickerForLock?.();
  appLocked = false;
  pinInput.value = '';
  pinConfirm.value = '';
  if (gate) {
    gate.style.display = 'none';
    gate.setAttribute('aria-hidden', 'true');
  }
  if (appRoot) appRoot.style.display = 'block';
  stopLockTimer();
  setPinError('');
  applicationApp?.resumeAfterLock?.();
}

async function createNewPin() {
  const pin = pinInput.value.trim();
  const confirmation = pinConfirm.value.trim();
  try {
    validatePinSetup(pin, confirmation);
  } catch (error) {
    if (error instanceof PinValidationError) {
      setPinError(error.message);
      return;
    }
    throw error;
  }
  setBusy(true);
  let saved = false;
  try {
    const record = await createPinRecord(pin);
    const serialized = serializePinRecord(record);
    await savePinRecord(serialized);
    storedRecord = record;
    saved = true;
    mode = 'unlock';
    guard = registerPinSuccess();
    await persistGuard();
    pinInput.value = '';
    pinConfirm.value = '';
    configurePinScreen();
    if (appStarted) {
      appLocked = false;
      if (gate) {
        gate.style.display = 'none';
        gate.setAttribute('aria-hidden', 'true');
      }
      if (appRoot) appRoot.style.display = 'block';
      stopLockTimer();
      applicationApp?.resumeAfterLock?.();
    } else {
      await startDashboard();
    }
  } catch (error) {
    setPinError(saved
      ? `PIN saved, but the dashboard could not be opened. ${error?.message || error}`
      : `PIN could not be created. ${error?.message || error}`);
  } finally {
    setBusy(false);
    if (!appStarted) refreshControls();
  }
}

async function recoverForgottenPin() {
  if (busy || !pinRecoverySubmit) return;
  const code = String(pinRecoveryCode?.value || '').trim();
  if (!code) {
    if (pinRecoveryStatus) pinRecoveryStatus.textContent = 'Enter the one-time reset code from your DKASU admin.';
    return;
  }
  setBusy(true);
  pinRecoverySubmit.disabled = true;
  if (pinRecoveryGoogleButton) pinRecoveryGoogleButton.disabled = true;
  pinRecoverySubmit.textContent = 'Checking code…';
  if (pinRecoveryStatus) pinRecoveryStatus.textContent = '';
  try {
    await claimSwiperPinReset(code);
    await Preferences.remove({ key: PIN_RECORD_KEY });
    await Preferences.remove({ key: LEGACY_PIN_KEY });
    await Preferences.remove({ key: PIN_GUARD_KEY });
    const [recordResult, legacyResult, guardResult] = await Promise.all([
      Preferences.get({ key: PIN_RECORD_KEY }),
      Preferences.get({ key: LEGACY_PIN_KEY }),
      Preferences.get({ key: PIN_GUARD_KEY })
    ]);
    if (recordResult.value || legacyResult.value || guardResult.value) {
      throw new Error('The old PIN could not be cleared from this device. Ask your admin to issue a fresh code and try again.');
    }
    storedRecord = null;
    legacyHash = '';
    guard = emptyPinGuard();
    pinInput.value = '';
    pinConfirm.value = '';
    if (pinRecoveryCode) pinRecoveryCode.value = '';
    if (pinRecoveryPanel) {
      pinRecoveryPanel.open = false;
      pinRecoveryPanel.classList.add('hidden');
    }
    mode = 'setup';
    configurePinScreen();
    if (pinHelp) pinHelp.textContent = 'Reset approved. Create a new 4–12 digit app PIN to continue. Your saved profiles and confirmations are unchanged.';
    setPinError('');
  } catch (error) {
    if (pinRecoveryStatus) pinRecoveryStatus.textContent = error?.message || 'PIN recovery could not be completed. Check your connection and try again.';
  } finally {
    pinRecoverySubmit.disabled = false;
    if (pinRecoveryGoogleButton) pinRecoveryGoogleButton.disabled = false;
    pinRecoverySubmit.textContent = 'Verify code and reset PIN';
    setBusy(false);
  }
}

async function unlockWithPin() {
  const pin = pinInput.value.trim();
  if (!isValidPin(pin)) {
    setPinError('Use 4–12 digits.');
    return;
  }
  if (getLockRemainingMs(guard, Date.now()) > 0) {
    refreshControls();
    return;
  }

  setBusy(true);
  setPinError('');
  try {
    let valid = false;
    if (storedRecord) {
      valid = await verifyPin(pin, storedRecord);
    } else if (legacyHash) {
      valid = await verifyLegacySha256Pin(pin, legacyHash);
    }

    if (!valid) {
      guard = registerPinFailure(guard, Date.now());
      await persistGuard();
      pinInput.value = '';
      if (getLockRemainingMs(guard, Date.now()) > 0) {
        refreshControls();
      } else {
        setPinError('Incorrect PIN. Try again.');
        refreshControls();
      }
      return;
    }

    if (!storedRecord && legacyHash) {
      try {
        const upgraded = await createPinRecord(pin);
        await savePinRecord(serializePinRecord(upgraded));
        storedRecord = upgraded;
        legacyHash = '';
        try {
          await Preferences.remove({ key: LEGACY_PIN_KEY });
        } catch (error) {
          console.warn('Legacy PIN record could not be removed', error);
        }
      } catch (error) {
        setPinError(`PIN was correct, but the security upgrade could not be saved. ${error?.message || error}`);
        return;
      }
    }

    guard = registerPinSuccess();
    await persistGuard();
    if (appStarted) {
      completeResumeUnlock();
    } else {
      pinInput.value = '';
      await startDashboard();
    }
  } catch (error) {
    if (error instanceof PinRecordError) {
      setPinError(`PIN record error: ${error.message}`);
    } else {
      setPinError(`Could not verify the PIN. ${error?.message || error}`);
    }
  } finally {
    setBusy(false);
    if (!appStarted) refreshControls();
  }
}

async function unlockWithBiometric() {
  if (busy || mode !== 'unlock' || !biometricEnabled || !Capacitor.isNativePlatform()) return;
  setBusy(true);
  setPinError('');
  try {
    await biometricUnlock.authenticate();
    guard = registerPinSuccess();
    await persistGuard();
    if (appStarted) {
      completeResumeUnlock();
    } else {
      pinInput.value = '';
      await startDashboard();
    }
  } catch {
    setPinError('Unlock was canceled or unavailable. You can use your app PIN instead.');
  } finally {
    setBusy(false);
    if (!appStarted) refreshControls();
  }
}

async function refreshBiometricSettings() {
  if (!biometricUnlockToggle || !biometricUnlockStatus) return;
  const preference = await Preferences.get({ key: BIOMETRIC_UNLOCK_KEY });
  biometricEnabled = preference.value === 'true';
  biometricUnlockToggle.checked = biometricEnabled;

  if (!Capacitor.isNativePlatform()) {
    biometricUnlockToggle.disabled = true;
    biometricUnlockStatus.textContent = 'Optional biometric unlock is available in the installed Android app. The browser preview continues to use the app PIN.';
    refreshControls();
    return;
  }

  try {
    const availability = await biometricUnlock.isAvailable();
    biometricUnlockToggle.disabled = !availability.isAvailable && !biometricEnabled;
    biometricUnlockStatus.textContent = availability.isAvailable
      ? biometricEnabled
        ? 'Enabled on this phone. You can still use the app PIN as a fallback.'
        : 'Available on this phone. Turn it on if you want quicker unlock.'
      : biometricEnabled
        ? 'This phone’s secure unlock is currently unavailable. Turn the option off or use your app PIN.'
        : 'Set up phone biometrics or a secure screen lock to enable this option. The app PIN remains available.';
  } catch {
    biometricUnlockToggle.disabled = !biometricEnabled;
    biometricUnlockStatus.textContent = biometricEnabled
      ? 'Secure unlock is unavailable in this build. Turn the option off or use your app PIN.'
      : 'Secure unlock is unavailable in this build. The app PIN remains available.';
  }
  refreshControls();
}

biometricUnlockButton?.addEventListener('click', () => { void unlockWithBiometric(); });
biometricUnlockToggle?.addEventListener('change', async () => {
  if (!biometricUnlockToggle.checked) {
    try {
      await Preferences.set({ key: BIOMETRIC_UNLOCK_KEY, value: 'false' });
      biometricEnabled = false;
      biometricUnlockStatus.textContent = 'Biometric unlock is off. Your app PIN remains in use.';
    } catch (error) {
      biometricUnlockToggle.checked = biometricEnabled;
      biometricUnlockStatus.textContent = `The setting could not be saved. ${error?.message || ''}`;
    }
    refreshControls();
    return;
  }

  biometricUnlockToggle.disabled = true;
  biometricUnlockStatus.textContent = 'Confirm with your phone’s secure unlock to enable this option…';
  try {
    if (!Capacitor.isNativePlatform()) throw new Error('Use the installed Android app to enable this setting.');
    const availability = await biometricUnlock.isAvailable();
    if (!availability.isAvailable) throw new Error('Set up biometrics or a secure screen lock on this phone first.');
    await biometricUnlock.authenticate();
    await Preferences.set({ key: BIOMETRIC_UNLOCK_KEY, value: 'true' });
    biometricEnabled = true;
    biometricUnlockStatus.textContent = 'Enabled on this phone. The app PIN remains available as a fallback.';
  } catch (error) {
    biometricUnlockToggle.checked = false;
    biometricUnlockStatus.textContent = `${error?.message || 'Setup was canceled.'} Biometric unlock remains off; use your app PIN.`;
  } finally {
    await refreshBiometricSettings();
  }
});

document.addEventListener('dkasu:security-open', () => { void refreshBiometricSettings(); });

async function readPinSetup() {
  const [recordResult, legacyResult, guardResult, biometricResult] = await Promise.all([
    Preferences.get({ key: PIN_RECORD_KEY }),
    Preferences.get({ key: LEGACY_PIN_KEY }),
    Preferences.get({ key: PIN_GUARD_KEY }),
    Preferences.get({ key: BIOMETRIC_UNLOCK_KEY })
  ]);
  guard = parsePinGuard(guardResult.value);
  biometricEnabled = biometricResult.value === 'true';

  if (recordResult.value) {
    try {
      storedRecord = parsePinRecord(recordResult.value);
      mode = 'unlock';
    } catch (error) {
      if (error instanceof PinRecordError) {
        showFatal(
          'PIN data unavailable',
          'The saved PIN record is damaged. The app will not bypass the lock or overwrite it automatically.',
          `${error.message} Clear this app\'s data to start over (this erases local profiles), then restore a backup.`
        );
        return;
      }
      throw error;
    }
  } else if (legacyResult.value) {
    if (!LEGACY_HASH_PATTERN.test(legacyResult.value)) {
      showFatal(
        'PIN data unavailable',
        'The saved PIN record is damaged. The app will not bypass the lock or overwrite it automatically.',
        'Clear this app\'s data to start over (this erases local profiles), then restore a backup.'
      );
      return;
    }
    legacyHash = legacyResult.value.toLowerCase();
    mode = 'legacy';
  } else {
    mode = 'setup';
  }
  busy = false;
  configurePinScreen();
}

pinForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (busy || mode === 'fatal' || mode === 'corrupt') return;
  if (mode === 'setup') {
    void createNewPin();
  } else if (mode === 'unlock' || mode === 'legacy') {
    void unlockWithPin();
  }
});

pinRecoverySubmit?.addEventListener('click', () => { void recoverForgottenPin(); });
pinRecoveryGoogleButton?.addEventListener('click', async () => {
  if (pinRecoveryGoogleButton.disabled) return;
  pinRecoveryGoogleButton.disabled = true;
  if (pinRecoveryStatus) pinRecoveryStatus.textContent = 'Opening Google sign-in…';
  try {
    await signInWithGoogle();
  } catch (error) {
    if (pinRecoveryStatus) pinRecoveryStatus.textContent = `Google sign-in could not start. ${error?.message || error}`;
    pinRecoveryGoogleButton.disabled = false;
  }
});

for (const input of [pinInput, pinConfirm]) {
  input.addEventListener('input', () => {
    if (mode !== 'fatal' && mode !== 'corrupt' && getLockRemainingMs(guard, Date.now()) === 0) {
      if (pinError.textContent === 'Incorrect PIN. Try again.' || pinError.textContent === 'Use 4–12 digits.') {
        setPinError('');
      }
    }
  });
}

const refreshAfterResume = () => {
  if (!document.hidden && !busy && mode !== 'fatal' && mode !== 'corrupt') refreshControls();
};
const handleAppForeground = () => {
  if (document.hidden) return;
  if (appStarted && !appLocked && appBackgroundedAt !== null) {
    const awayFor = Date.now() - appBackgroundedAt;
    appBackgroundedAt = null;
    if (awayFor >= APP_LOCK_BACKGROUND_DELAY_MS) showResumeLock();
  }
  refreshAfterResume();
};
const handleVisibilityChange = () => {
  if (document.visibilityState === 'hidden') {
    if (appStarted && !appLocked && appBackgroundedAt === null) appBackgroundedAt = Date.now();
    return;
  }
  handleAppForeground();
};
document.addEventListener('visibilitychange', handleVisibilityChange);
window.addEventListener('focus', handleAppForeground);

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
    await readPinSetup();
    await startDashboard();
  } catch (error) {
    console.error(error);
    showFatal(
      'App startup failed',
      'The on-device database could not be opened. Close and reopen the app. If this continues, check the build and SQLite setup.',
      error?.message || String(error)
    );
  }
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
    workerGoogleButton.textContent = 'Continue with Google to register';
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

workerSignOutButton?.addEventListener('click', async () => {
  if (workerSignOutButton.disabled) return;
  workerSignOutButton.disabled = true;
  workerAuthError.textContent = '';
  try {
    await signOutShiftWorker();
    workerRegistrationMode = false;
    showWorkerGate('You are signed out. Choose “Register as a swiper” to continue with another Google account.');
  } catch (error) {
    workerAuthError.textContent = `Sign-out could not finish. ${error?.message || error}`;
  } finally {
    workerSignOutButton.disabled = false;
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

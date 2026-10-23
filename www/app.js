import { Capacitor } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import {
  MAX_BACKUP_CHARS,
  ValidationError,
  createBackup,
  createWorkerProfilePackage,
  parseBackupText,
  parseWorkerProfilePackageText,
  profileFromForm,
  schedulesToText
} from './domain.js';
import {
  TIME_ZONE_NAMES,
  TZ,
  formatClock,
  formatDateTime,
  formatDuration,
  getContractBounds,
  getShiftBounds
} from './time.js';

function pad(value) {
  return String(value).padStart(2, '0');
}

function prettyDateKey(dateKey) {
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  }).format(new Date(Date.UTC(year, month - 1, day, 12)));
}

function errorMessage(error) {
  return error?.message || String(error);
}

function backupFilename(now = new Date()) {
  const stamp = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}_${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  return `DKASU_Shift_Backup_${stamp}.json`;
}

function workerProfileFilename(profile, now = new Date()) {
  const stamp = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}`;
  const safeName = profile.name.normalize('NFKD').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 50) || 'Worker';
  return `DKASU_Worker_Profile_${safeName}_${stamp}.json`;
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.readOnly = true;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }
  area.remove();
  if (!copied) throw new Error('Clipboard access is blocked.');
}

function setButtonBusy(button, busy, busyLabel) {
  if (!button.dataset.idleLabel) button.dataset.idleLabel = button.textContent;
  button.disabled = busy;
  button.textContent = busy ? busyLabel : button.dataset.idleLabel;
}

export async function initApp({ store, storageLabel = 'device storage', workerMode = false, workerIdsByProfileId = {}, syncActorId = '', onSignOut = () => {}, onResumeSync = async () => {} }) {
  if (!store) throw new Error('A loaded profile store is required.');
  store.workerMode = workerMode;
  const dashboardTemplate = document.getElementById('dashboardTemplate');
  const activeProfileView = document.getElementById('activeProfileView');
  const appRoot = document.getElementById('appRoot');
  if (!dashboardTemplate || !activeProfileView || !appRoot) {
    throw new Error('The dashboard markup is incomplete.');
  }
  appRoot.style.display = 'block';
  if (workerMode) {
    document.getElementById('storagePanel')?.classList.add('hidden');
    const pickerTitle = document.querySelector('#profilePicker h2');
    const pickerHelp = document.getElementById('profilePickerHelp');
    const roleNotice = document.getElementById('profilePickerRoleNotice');
    const pickerTools = document.getElementById('profilePickerTools');
    if (pickerTitle) pickerTitle.textContent = 'Choose a swipe account';
    if (pickerHelp) pickerHelp.textContent = 'Select the account you need. The dashboard and self-confirmation will use that account.';
    if (pickerTools) pickerTools.hidden = false;
    if (roleNotice) roleNotice.classList.add('hidden');
    for (const id of ['profilesTopButton', 'addTopButton', 'addProfileButton', 'backupButton', 'editActiveButton', 'deleteActiveButton']) {
      const element = document.getElementById(id);
      if (element) element.style.display = 'none';
    }
    const switchProfileButton = document.getElementById('switchProfileButton');
    if (switchProfileButton) {
      switchProfileButton.style.display = store.listProfiles().length > 1 ? 'inline-block' : 'none';
      switchProfileButton.textContent = 'Choose another swipe account';
    }
    const signOutButton = document.getElementById('workerSignOutButton');
    if (signOutButton) signOutButton.style.display = 'inline-block';
    const securityButton = document.getElementById('securityTopButton');
    if (securityButton) securityButton.style.display = 'inline-block';
  }

  const refs = {
    appMessage: document.getElementById('appMessage'),
    profilePicker: document.getElementById('profilePicker'),
    profileList: document.getElementById('profileList'),
    profileEditor: document.getElementById('profileEditor'),
    editorTitle: document.getElementById('editorTitle'),
    editorError: document.getElementById('editorError'),
    backupPanel: document.getElementById('backupPanel'),
    backupStatus: document.getElementById('backupStatus'),
    activeProfilePanel: document.getElementById('activeProfilePanel'),
    storageStatus: document.getElementById('storageStatus'),
    addProfileButton: document.getElementById('addProfileButton'),
    addTopButton: document.getElementById('addTopButton'),
    saveProfileButton: document.getElementById('saveProfileButton'),
    cancelEditorButton: document.getElementById('cancelEditorButton'),
    deleteActiveButton: document.getElementById('deleteActiveButton'),
    backupButton: document.getElementById('backupButton'),
    backFromBackupButton: document.getElementById('backFromBackupButton'),
    exportBackupButton: document.getElementById('exportBackupButton'),
    importBackupButton: document.getElementById('importBackupButton'),
    backupFileInput: document.getElementById('backupFileInput'),
    profileExportSelect: document.getElementById('profileExportSelect'),
    exportWorkerProfileButton: document.getElementById('exportWorkerProfileButton'),
    importWorkerProfileButton: document.getElementById('importWorkerProfileButton'),
    workerProfileFileInput: document.getElementById('workerProfileFileInput')
  };
  const profileSearch = document.getElementById('profileSearch');
  const profilePickerCount = document.getElementById('profilePickerCount');

  let currentProfile = null;
  let currentHost = null;
  let resumeCurrentDashboard = null;
  let tickHandle = null;
  let editingProfileId = null;
  let openingProfile = false;
  let destroyed = false;
  let viewGeneration = 0;
  let syncVisibilityHandler = null;
  let syncOnlineHandler = null;

  function byId(id) {
    return document.getElementById(id);
  }

  function showOnly(panelId) {
    for (const panelIdToToggle of ['profilePicker', 'profileEditor', 'backupPanel', 'securityPanel', 'activeProfilePanel']) {
      byId(panelIdToToggle)?.classList.toggle('hidden', panelIdToToggle !== panelId);
    }
  }

  function showAppMessage(text, tone = 'info') {
    if (!refs.appMessage) return;
    refs.appMessage.textContent = text;
    refs.appMessage.classList.remove('hidden', 'error', 'success');
    if (tone === 'error') refs.appMessage.classList.add('error');
    if (tone === 'success') refs.appMessage.classList.add('success');
  }

  function clearAppMessage() {
    refs.appMessage?.classList.add('hidden');
    if (refs.appMessage) refs.appMessage.textContent = '';
  }

  function setStorageStatus(text) {
    if (refs.storageStatus) refs.storageStatus.textContent = text;
  }

  function setBackupStatus(text, tone = 'info') {
    if (!refs.backupStatus) return;
    refs.backupStatus.textContent = text;
    refs.backupStatus.className = 'notice';
    if (tone === 'error') refs.backupStatus.classList.add('error');
    if (tone === 'success') refs.backupStatus.classList.add('success');
  }

  function stopTicker() {
    if (tickHandle !== null) {
      clearInterval(tickHandle);
      tickHandle = null;
    }
  }

  function updateMutationControls() {
    const disabled = store.readOnly;
    if (refs.addProfileButton) refs.addProfileButton.disabled = disabled;
    if (refs.addTopButton) refs.addTopButton.disabled = disabled;
    if (refs.importWorkerProfileButton) refs.importWorkerProfileButton.disabled = disabled;
  }

  function renderProfileList() {
    if (!refs.profileList) return;
    refs.profileList.replaceChildren();
    const profiles = store.listProfiles();
    const activeId = store.getActiveProfileId();
    if (workerMode && profilePickerCount) {
      profilePickerCount.textContent = `${profiles.length} assigned account${profiles.length === 1 ? '' : 's'}`;
    }
    if (!profiles.length) {
      const empty = document.createElement('p');
      empty.textContent = store.readOnly
        ? 'Stored profiles could not be read. Use Backup / Restore to load a valid backup.'
        : 'No profiles yet. Add a profile to begin.';
      refs.profileList.appendChild(empty);
      return;
    }
    const query = workerMode ? (profileSearch?.value || '').trim().toLocaleLowerCase() : '';
    const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
    const matchingProfiles = profiles
      .filter((profile) => !query || [profile.name, profile.email, profile.job, profile.company, profile.location, profile.profileId, profile.swipeId]
        .some((value) => String(value || '').toLocaleLowerCase().includes(query)));
    const pickerNow = new Date();
    const upcomingByProfileId = new Map(matchingProfiles.map((profile) => [profile.id, nextScheduledShift(profile, pickerNow)]));
    matchingProfiles.sort((a, b) => {
      if (workerMode) {
        const aStart = upcomingByProfileId.get(a.id)?.bounds.start.getTime() ?? Number.POSITIVE_INFINITY;
        const bStart = upcomingByProfileId.get(b.id)?.bounds.start.getTime() ?? Number.POSITIVE_INFINITY;
        if (aStart !== bStart) return aStart < bStart ? -1 : 1;
      }
      return collator.compare(a.name || '', b.name || '') || collator.compare(a.swipeId || a.profileId || '', b.swipeId || b.profileId || '');
    });
    if (workerMode && profilePickerCount) {
      profilePickerCount.textContent = query
        ? `${matchingProfiles.length} of ${profiles.length} accounts`
        : `${profiles.length} assigned account${profiles.length === 1 ? '' : 's'}`;
    }
    if (!matchingProfiles.length) {
      const empty = document.createElement('div');
      empty.className = 'profile-empty-search';
      empty.textContent = query ? 'No assigned accounts match that search.' : 'No assigned swipe accounts are available.';
      refs.profileList.appendChild(empty);
      return;
    }
    for (const profile of matchingProfiles) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `profile-choice${profile.id === activeId ? ' active' : ''}`;
      button.dataset.profileId = profile.id;
      button.setAttribute('aria-pressed', String(profile.id === activeId));

      const avatar = document.createElement('div');
      avatar.className = 'avatar';
      avatar.textContent = profile.name
        .trim()
        .split(/\s+/)
        .map((part) => part[0] || '')
        .join('')
        .slice(0, 2)
        .toUpperCase();

      const meta = document.createElement('div');
      meta.className = 'profile-meta';
      const name = document.createElement('strong');
      name.textContent = profile.name;
      const details = document.createElement('span');
      details.textContent = [profile.job, profile.company, profile.email].filter(Boolean).join(' · ') || 'Account details not set';
      meta.append(name, details);
      if (workerMode) {
        const nextShift = upcomingByProfileId.get(profile.id);
        const shiftHint = document.createElement('span');
        shiftHint.className = 'profile-next-shift';
        if (nextShift) {
          const isInProgress = pickerNow >= nextShift.bounds.start && pickerNow < nextShift.bounds.end;
          shiftHint.textContent = isInProgress
            ? `In progress · ends ${formatClock(nextShift.bounds.end, profile.scheduleZone, false)} · ${prettyDateKey(nextShift.bounds.endDateKey)} (${TIME_ZONE_NAMES[profile.scheduleZone]})`
            : `Next swipe · ${formatClock(nextShift.bounds.start, profile.scheduleZone, false)} · ${prettyDateKey(nextShift.date)} (${TIME_ZONE_NAMES[profile.scheduleZone]})`;
        } else {
          shiftHint.textContent = 'No upcoming scheduled swipe';
        }
        meta.appendChild(shiftHint);
      }
      const identifiers = [profile.swipeId ? `Swipe ID ${profile.swipeId}` : '', profile.profileId ? `Profile ID ${profile.profileId}` : '']
        .filter(Boolean).join(' · ');
      if (identifiers) {
        const ids = document.createElement('span');
        ids.className = 'profile-identifiers';
        ids.textContent = identifiers;
        meta.appendChild(ids);
      }

      if (profile.id === activeId && workerMode) {
        const selected = document.createElement('span');
        selected.className = 'profile-selected-badge';
        selected.textContent = 'Selected';
        meta.appendChild(selected);
      }

      const chevron = document.createElement('span');
      chevron.setAttribute('aria-hidden', 'true');
      chevron.textContent = '›';

      button.append(avatar, meta, chevron);
      button.addEventListener('click', () => {
        void openProfile(profile.id);
      });
      refs.profileList.appendChild(button);
    }
  }

  function showProfilePicker({ message = '', tone = 'info', clearMessage = false } = {}) {
    viewGeneration += 1;
    stopTicker();
    currentProfile = null;
    if (profileSearch) profileSearch.value = '';
    if (clearMessage) clearAppMessage();
    if (message) showAppMessage(message, tone);
    renderProfileList();
    updateMutationControls();
    showOnly('profilePicker');
  }

  function fillEditor(profile) {
    const fields = {
      pName: profile?.name || '',
      pEmail: profile?.email || '',
      pProfileId: profile?.profileId || '',
      pSwipeId: profile?.swipeId || '',
      pJob: profile?.job || '',
      pCompany: profile?.company || '',
      pLocation: profile?.location || '',
      pAddress: profile?.address || '',
      pContractStart: profile?.contractStart || '',
      pContractEnd: profile?.contractEnd || '',
      pTimezone: profile?.displayZone || TZ.dubai,
      pShiftZone: profile?.scheduleZone || TZ.dubai,
      pSchedules: schedulesToText(profile?.schedules || {})
    };
    for (const [id, value] of Object.entries(fields)) {
      const input = byId(id);
      if (input) input.value = value;
    }
    if (refs.editorTitle) refs.editorTitle.textContent = profile ? 'Edit profile' : 'Add profile';
    if (refs.editorError) refs.editorError.textContent = '';
  }

  function startAddProfile() {
    if (store.readOnly) {
      showAppMessage('Profile changes are disabled because stored data could not be read. Restore a backup first.', 'error');
      return;
    }
    viewGeneration += 1;
    stopTicker();
    currentProfile = null;
    editingProfileId = null;
    clearAppMessage();
    fillEditor(null);
    showOnly('profileEditor');
    byId('pName')?.focus();
  }

  function startEditProfile() {
    if (!currentProfile) return;
    if (store.readOnly) {
      showAppMessage('Profile changes are disabled because stored data could not be read.', 'error');
      return;
    }
    const profile = store.getProfile(currentProfile.id);
    if (!profile) {
      showAppMessage('That profile no longer exists.', 'error');
      showProfilePicker();
      return;
    }
    viewGeneration += 1;
    stopTicker();
    editingProfileId = profile.id;
    clearAppMessage();
    fillEditor(profile);
    showOnly('profileEditor');
    byId('pName')?.focus();
  }

  async function saveProfileEditor() {
    if (!refs.saveProfileButton) return;
    if (refs.saveProfileButton.disabled) return;
    if (refs.editorError) refs.editorError.textContent = '';
    let fields;
    try {
      fields = profileFromForm({
        name: byId('pName')?.value,
        email: byId('pEmail')?.value,
        profileId: byId('pProfileId')?.value,
        swipeId: byId('pSwipeId')?.value,
        job: byId('pJob')?.value,
        company: byId('pCompany')?.value,
        location: byId('pLocation')?.value,
        address: byId('pAddress')?.value,
        contractStart: byId('pContractStart')?.value,
        contractEnd: byId('pContractEnd')?.value,
        displayZone: byId('pTimezone')?.value,
        scheduleZone: byId('pShiftZone')?.value,
        schedulesText: byId('pSchedules')?.value
      });
    } catch (error) {
      if (refs.editorError) refs.editorError.textContent = errorMessage(error);
      return;
    }

    setButtonBusy(refs.saveProfileButton, true, 'Saving…');
    if (refs.cancelEditorButton) refs.cancelEditorButton.disabled = true;
    try {
      const profile = editingProfileId
        ? await store.updateProfile(editingProfileId, fields)
        : await store.createProfile(fields);
      currentProfile = profile;
      editingProfileId = null;
      renderProfileList();
      showOnly('activeProfilePanel');
      renderDashboard(profile);
      showAppMessage(`${profile.name} saved on this device.`, 'success');
      setStorageStatus(`${profile.name} was saved successfully by profile.`);
    } catch (error) {
      if (refs.editorError) refs.editorError.textContent = `Not saved. ${errorMessage(error)}`;
      setStorageStatus('The profile change was not saved to device storage.');
    } finally {
      setButtonBusy(refs.saveProfileButton, false);
      if (refs.cancelEditorButton) refs.cancelEditorButton.disabled = false;
    }
  }

  async function deleteActiveProfile() {
    if (!currentProfile) return;
    if (refs.deleteActiveButton?.disabled) return;
    const profile = store.getProfile(currentProfile.id);
    if (!profile) {
      showProfilePicker({ message: 'That profile no longer exists.', tone: 'error' });
      return;
    }
    const confirmed = globalThis.confirm(
      `Delete ${profile.name}'s profile, schedules and local self-confirmations from this device?\n\nOnly this profile is deleted. Export a backup first if you may need it.`
    );
    if (!confirmed) return;
    if (refs.deleteActiveButton) setButtonBusy(refs.deleteActiveButton, true, 'Deleting…');
    try {
      await store.deleteProfile(profile.id);
      stopTicker();
      currentProfile = null;
      activeProfileView.replaceChildren();
      showProfilePicker({
        message: `${profile.name} was deleted. No other profile was changed.`,
        tone: 'success'
      });
      setStorageStatus('Profile deletion was saved to device storage.');
    } catch (error) {
      showAppMessage(`Profile was not deleted. ${errorMessage(error)}`, 'error');
    } finally {
      if (refs.deleteActiveButton) setButtonBusy(refs.deleteActiveButton, false);
    }
  }

  async function openProfile(id) {
    if (openingProfile) return;
    openingProfile = true;
    const requestGeneration = viewGeneration + 1;
    viewGeneration = requestGeneration;
    stopTicker();
    clearAppMessage();
    try {
      await store.selectProfile(id);
      if (requestGeneration !== viewGeneration) return;
      const profile = store.getProfile(id);
      if (!profile) throw new Error('The profile no longer exists.');
      currentProfile = profile;
      renderProfileList();
      showOnly('activeProfilePanel');
      renderDashboard(profile);
      setStorageStatus(`${profile.name}'s profile is open. Changes are written to device storage before success is shown.`);
    } catch (error) {
      if (requestGeneration === viewGeneration) {
        showProfilePicker({
          message: `Could not open that profile. ${errorMessage(error)}`,
          tone: 'error'
        });
      }
    } finally {
      openingProfile = false;
    }
  }

  function setText(host, selector, value) {
    const element = host.querySelector(selector);
    if (element) element.textContent = value;
  }

  function nextScheduledShift(profile, now = new Date()) {
    const dates = Object.keys(profile.schedules).sort();
    for (const date of dates) {
      try {
        if (getShiftBounds(date, profile.schedules[date], profile.scheduleZone).end > now) {
          return { date, shift: profile.schedules[date], bounds: getShiftBounds(date, profile.schedules[date], profile.scheduleZone) };
        }
      } catch {
        // Keep invalid saved dates visible in the full list for review.
      }
    }
    return null;
  }

  function renderNextSchedule(host, profile, now = new Date()) {
    const preview = host.querySelector('#nextSchedule');
    if (!preview) return;
    preview.replaceChildren();
    const next = nextScheduledShift(profile, now);
    const row = document.createElement('div');
    row.className = 'day next-day';
    const left = document.createElement('div');
    const title = document.createElement('strong');
    const zone = document.createElement('div');
    zone.className = 'next-zone';
    const right = document.createElement('span');
    if (next) {
      title.textContent = `Next shift · ${prettyDateKey(next.date)}`;
      zone.textContent = TIME_ZONE_NAMES[profile.scheduleZone];
      right.textContent = `${next.shift.start}–${next.shift.end}${next.shift.end < next.shift.start ? ' (+1 day)' : ''}`;
    } else {
      title.textContent = 'No upcoming saved shift';
      zone.textContent = 'Check with your admin for schedule updates';
      right.textContent = '—';
    }
    left.append(title, zone);
    row.append(left, right);
    preview.appendChild(row);
  }

  function renderSchedule(host, profile) {
    const list = host.querySelector('#savedSchedule');
    if (!list) return;
    list.replaceChildren();
    const dates = Object.keys(profile.schedules).sort();
    const allScheduleDetails = host.querySelector('#allScheduleDetails');
    const allScheduleSummary = host.querySelector('#allScheduleSummary');
    if (allScheduleSummary) allScheduleSummary.textContent = `View all saved shifts (${dates.length})`;
    if (allScheduleDetails) allScheduleDetails.classList.toggle('hidden', dates.length <= 1);
    renderNextSchedule(host, profile);
    if (!dates.length) {
      const empty = document.createElement('div');
      empty.className = 'day';
      const left = document.createElement('div');
      const strong = document.createElement('strong');
      strong.textContent = 'No shifts saved';
      left.appendChild(strong);
      const right = document.createElement('span');
      right.textContent = 'Edit the profile to add confirmed dates';
      empty.append(left, right);
      list.appendChild(empty);
      return;
    }
    for (const date of dates) {
      const shift = profile.schedules[date];
      const row = document.createElement('div');
      row.className = 'day';
      const left = document.createElement('div');
      const dateLabel = document.createElement('strong');
      dateLabel.textContent = prettyDateKey(date);
      const zone = document.createElement('div');
      zone.textContent = TIME_ZONE_NAMES[profile.scheduleZone];
      left.append(dateLabel, zone);
      const right = document.createElement('span');
      const overnight = shift.end < shift.start;
      right.textContent = `${shift.start} – ${shift.end}${overnight ? ' (+1 day)' : ''}`;
      row.append(left, right);
      list.appendChild(row);
    }
  }

  function renderContract(host, profile, now) {
    const daysElement = host.querySelector('#daysRemaining');
    const statusElement = host.querySelector('#contractStatus');
    const progressElement = host.querySelector('#progress');
    const datesElement = host.querySelector('#contractDates');
    if (!profile.contractStart || !profile.contractEnd) {
      if (daysElement) daysElement.textContent = '—';
      if (statusElement) statusElement.textContent = 'Add contract dates';
      if (progressElement) progressElement.textContent = '—';
      if (datesElement) datesElement.textContent = 'No contract dates are saved for this profile.';
      return;
    }
    try {
      const bounds = getContractBounds(profile.contractStart, profile.contractEnd, profile.scheduleZone);
      const before = now < bounds.start;
      const after = now >= bounds.endExclusive;
      if (daysElement) {
        if (before) {
          daysElement.textContent = `${Math.ceil((bounds.start - now) / 86400000)} days`;
        } else if (after) {
          daysElement.textContent = '0 days';
        } else {
          daysElement.textContent = `${Math.ceil((bounds.endExclusive - now) / 86400000)} days`;
        }
      }
      if (statusElement) {
        statusElement.textContent = before
          ? 'Not started'
          : after
            ? 'Contract ended'
            : `Until ${prettyDateKey(profile.contractEnd)}`;
      }
      if (progressElement) {
        const progress = after
          ? 100
          : before
            ? 0
            : ((now - bounds.start) / (bounds.endExclusive - bounds.start)) * 100;
        progressElement.textContent = `${Math.round(Math.min(100, Math.max(0, progress)))}%`;
      }
      if (datesElement) {
        datesElement.textContent = `Contract dates (${TIME_ZONE_NAMES[profile.scheduleZone]} calendar dates): ${prettyDateKey(profile.contractStart)} – ${prettyDateKey(profile.contractEnd)}`;
      }
    } catch {
      if (daysElement) daysElement.textContent = '—';
      if (statusElement) statusElement.textContent = 'Invalid contract dates';
      if (progressElement) progressElement.textContent = '—';
      if (datesElement) datesElement.textContent = 'Edit the profile to correct the contract dates.';
    }
  }

  function renderShift(host, profile, now) {
    const dateInput = host.querySelector('#shiftDate');
    const countdownElement = host.querySelector('#shiftCountdown');
    const statusElement = host.querySelector('#shiftStatus');
    const titleElement = host.querySelector('#shiftHoursTitle');
    const valueElement = host.querySelector('#shiftHoursValue');
    const sourceElement = host.querySelector('#shiftHoursSource');
    const noteElement = host.querySelector('#selectedDateNote');
    const swipeLabelElement = host.querySelector('#swipeLabel');
    if (!dateInput) return;
    const date = dateInput.value;
    const schedule = date ? profile.schedules[date] : null;

    if (!date) {
      if (countdownElement) countdownElement.textContent = '—';
      if (statusElement) statusElement.textContent = 'Select a date';
      if (titleElement) titleElement.textContent = 'Shift hours';
      if (valueElement) valueElement.textContent = '—';
      if (sourceElement) sourceElement.textContent = 'No date selected';
      if (noteElement) noteElement.textContent = 'Select a date. The app will only show a shift if that date exists in this profile.';
      return;
    }
    if (!schedule) {
      if (countdownElement) countdownElement.textContent = '—';
      if (statusElement) statusElement.textContent = 'No saved shift';
      if (titleElement) titleElement.textContent = 'Shift hours (not saved)';
      if (valueElement) valueElement.textContent = '—';
      if (sourceElement) sourceElement.textContent = 'No shift invented';
      if (noteElement) noteElement.textContent = `No shift is saved for ${date}. The app does not invent a shift; edit this profile to add a confirmed schedule.`;
      return;
    }

    try {
      const bounds = getShiftBounds(date, schedule, profile.scheduleZone);
      if (titleElement) titleElement.textContent = `Shift hours (${TIME_ZONE_NAMES[profile.displayZone]})`;
      if (valueElement) {
        valueElement.textContent = `${formatClock(bounds.start, profile.displayZone, false)}–${formatClock(bounds.end, profile.displayZone, false)}`;
      }
      if (sourceElement) {
        sourceElement.textContent = bounds.overnight
          ? `Overnight · ends next day · ${TIME_ZONE_NAMES[profile.scheduleZone]} schedule`
          : `Saved · ${TIME_ZONE_NAMES[profile.scheduleZone]} schedule`;
      }
      if (now < bounds.start) {
        if (countdownElement) countdownElement.textContent = formatDuration(bounds.start - now);
        if (statusElement) statusElement.textContent = `Not started · begins ${formatClock(bounds.start, profile.displayZone, false)} on ${prettyDateKey(date)} (${TIME_ZONE_NAMES[profile.displayZone]})`;
        if (swipeLabelElement && !profile.confirmations[date]) swipeLabelElement.textContent = 'Swipe available after shift ends';
      } else if (now < bounds.end) {
        if (countdownElement) countdownElement.textContent = formatDuration(bounds.end - now);
        if (statusElement) statusElement.textContent = `In progress · ends ${formatClock(bounds.end, profile.displayZone, false)} on ${prettyDateKey(bounds.endDateKey)} (${TIME_ZONE_NAMES[profile.displayZone]})`;
        if (swipeLabelElement && !profile.confirmations[date]) swipeLabelElement.textContent = 'Swipe available after shift ends';
      } else {
        if (countdownElement) countdownElement.textContent = 'Ended';
        if (statusElement) statusElement.textContent = 'Finished · self-confirmation available';
        if (swipeLabelElement && !profile.confirmations[date]) swipeLabelElement.textContent = 'Swipe to confirm finished';
      }
      if (noteElement) {
        const endDayNote = bounds.overnight ? ' The shift ends on the next schedule-zone date.' : '';
        noteElement.textContent = `Shift date ${date}. Source schedule: ${TIME_ZONE_NAMES[profile.scheduleZone]}. Displayed in ${TIME_ZONE_NAMES[profile.displayZone]}.${endDayNote} Local self-confirmations do not change Ogram.`;
      }
    } catch {
      if (countdownElement) countdownElement.textContent = '—';
      if (statusElement) statusElement.textContent = 'Invalid saved shift';
      if (valueElement) valueElement.textContent = '—';
      if (noteElement) noteElement.textContent = 'The saved times for this date are invalid. Edit the profile to correct them.';
    }
  }

  function renderDashboard(profile) {
    const dashboardGeneration = ++viewGeneration;
    stopTicker();
    clearAppMessage();
    const host = activeProfileView;
    currentHost = host;
    host.replaceChildren(dashboardTemplate.content.cloneNode(true));

    const menu = host.querySelector('#dashboardMenu');
    const menuToggle = document.getElementById('securityTopButton');
    const dashboardPages = [...host.querySelectorAll('[data-dashboard-page]')];
    const menuButtons = [...host.querySelectorAll('[data-dashboard-view]')];
    const securityMenuButton = host.querySelector('[data-dashboard-security]');
    const appbar = document.querySelector('.appbar');
    if (menu && appbar) appbar.append(menu);
    if (menuToggle) menuToggle.onclick = () => {
      const isOpen = menuToggle.getAttribute('aria-expanded') === 'true';
      menuToggle.setAttribute('aria-expanded', String(!isOpen));
      menu?.classList.toggle('hidden', isOpen);
    };
    const openDashboardPage = (name) => {
      showOnly('activeProfilePanel');
      for (const page of dashboardPages) page.classList.toggle('hidden', page.dataset.dashboardPage !== name);
      for (const button of menuButtons) {
        if (button.dataset.dashboardView === name) button.setAttribute('aria-current', 'page');
        else button.removeAttribute('aria-current');
      }
      menu?.classList.add('hidden');
      menuToggle?.setAttribute('aria-expanded', 'false');
      if (name !== 'home') window.scrollTo({ top: 0, behavior: 'smooth' });
    };
    for (const button of menuButtons) {
      button.addEventListener('click', () => openDashboardPage(button.dataset.dashboardView));
    }
    securityMenuButton?.addEventListener('click', () => {
      menu?.classList.add('hidden');
      menuToggle?.setAttribute('aria-expanded', 'false');
      showOnly('securityPanel');
      document.dispatchEvent(new Event('dkasu:security-open'));
    });
    for (const button of host.querySelectorAll('[data-open-dashboard-view]')) {
      button.addEventListener('click', () => openDashboardPage(button.dataset.openDashboardView));
    }

    setText(host, '#dashName', profile.name);
    setText(host, '#dashJob', profile.job || 'Job not set');
    setText(host, '#dashCompany', profile.company ? ` · ${profile.company}` : '');
    setText(host, '#dashProfileId', profile.profileId || 'Not set');
    setText(host, '#dashSwipeId', profile.swipeId || 'Not set');
    setText(host, '#accountEmail', profile.email || 'Not set');
    setText(host, '#accountName', profile.name);
    setText(host, '#accountProfileId', profile.profileId || 'Not set');
    setText(host, '#accountJob', profile.job || 'Not set');
    setText(host, '#accountCompany', profile.company || 'Not set');
    setText(host, '#accountLocation', profile.location || 'Not set');
    setText(host, '#address', profile.address || 'No work address saved.');
    setText(host, '#copyStatus', '');

    const timezoneSelect = host.querySelector('#primaryTimezone');
    if (timezoneSelect) timezoneSelect.value = profile.displayZone;
    const timezoneLabel = host.querySelector('#timezoneSelected');
    if (timezoneLabel) timezoneLabel.textContent = `Dashboard uses ${TIME_ZONE_NAMES[profile.displayZone]} time`;

    const dateInput = host.querySelector('#shiftDate');
    const scheduleDates = Object.keys(profile.schedules).sort();
    let manuallySelectedScheduleDate = false;
    if (dateInput) {
      const allMinDates = [profile.contractStart, ...scheduleDates].filter(Boolean).sort();
      const allMaxDates = [profile.contractEnd, ...scheduleDates].filter(Boolean).sort();
      dateInput.min = allMinDates[0] || '';
      dateInput.max = allMaxDates[allMaxDates.length - 1] || '';
      const upcoming = nextScheduledShift(profile, new Date());
      dateInput.value = upcoming?.date || scheduleDates[scheduleDates.length - 1] || profile.contractStart || '';
    }

    renderSchedule(host, profile);

    const copyButton = host.querySelector('#copyAddress');
    const confirmationPanel = host.querySelector('#endShiftConfirmation');
    const track = host.querySelector('#swipeTrack');
    const knob = host.querySelector('#swipeKnob');
    const swipeLabel = host.querySelector('#swipeLabel');
    const confirmStatus = host.querySelector('#endShiftStatus');
    let completed = false;
    let savingConfirmation = false;
    let dragging = false;
    let dragStartX = 0;
    let dragOffset = 0;

    const currentDate = () => host.querySelector('#shiftDate')?.value || '';
    const currentSchedule = () => {
      const date = currentDate();
      return date ? profile.schedules[date] : null;
    };
    function confirmationBlockReason() {
      const date = currentDate();
      const schedule = currentSchedule();
      if (!date || !schedule) return 'No saved shift exists for this date. Nothing was confirmed.';
      try {
        const bounds = getShiftBounds(date, schedule, profile.scheduleZone);
        const now = new Date();
        if (now < bounds.start) {
          return `This shift has not started. It begins at ${formatDateTime(bounds.start, profile.displayZone)} (${TIME_ZONE_NAMES[profile.displayZone]} time). You can self-confirm only after the shift ends.`;
        }
        if (now < bounds.end) {
          return `This shift is still in progress. It ends at ${formatDateTime(bounds.end, profile.displayZone)} (${TIME_ZONE_NAMES[profile.displayZone]} time). You can self-confirm after it ends.`;
        }
        return '';
      } catch {
        return 'The saved shift time is invalid. Ask your admin to correct the schedule.';
      }
    }
    function showConfirmationBlock(reason) {
      if (confirmStatus) confirmStatus.textContent = reason;
      showAppMessage(reason, 'error');
    }
    const maxOffset = () => Math.max(0, (track?.clientWidth || 0) - (knob?.offsetWidth || 0) - 8);

    function paint(offset) {
      if (!knob) return;
      dragOffset = Math.max(0, Math.min(maxOffset(), offset));
      knob.style.left = `${4 + dragOffset}px`;
    }

    function syncConfirmationPanel() {
      if (!confirmationPanel) return;
      confirmationPanel.classList.toggle('show', Boolean(currentSchedule()) && !store.readOnly);
    }

    function showSavedConfirmation(record) {
      if (!track || !knob || !swipeLabel || !confirmStatus || !record) return;
      completed = true;
      track.classList.add('done');
      knob.textContent = '✓';
      knob.style.left = 'calc(100% - 52px)';
      swipeLabel.textContent = 'This shift is self-confirmed';
      try {
        const syncMessage = record.syncStatus === 'synced'
          ? 'Synced to DKASU admin as your swiper self-confirmation.'
          : record.syncStatus === 'pending'
            ? 'Saved on this device. It will sync to DKASU when online.'
            : 'Saved on this device only.';
        confirmStatus.textContent = `Self-confirmed ${formatDateTime(new Date(record.confirmedAt), record.timezone || profile.displayZone)} (${TIME_ZONE_NAMES[record.timezone || profile.displayZone]} time). ${syncMessage} Ogram is unchanged.`;
      } catch {
        confirmStatus.textContent = 'A local self-confirmation is saved, but its timestamp could not be displayed. Ogram is unchanged.';
      }
    }

    function resetConfirmation() {
      completed = false;
      if (!track || !knob || !swipeLabel || !confirmStatus) return;
      track.classList.remove('done');
      knob.textContent = '›';
      knob.style.transition = 'none';
      knob.style.left = '4px';
      dragOffset = 0;
      swipeLabel.textContent = 'Swipe to confirm finished';
      confirmStatus.textContent = '';
    }

    function restoreConfirmation() {
      const date = currentDate();
      const record = date ? profile.confirmations[date] : null;
      resetConfirmation();
      if (!record) return;
      showSavedConfirmation(record);
    }

    async function saveConfirmation() {
      const date = currentDate();
      if (savingConfirmation || completed) return;
      const blockedReason = confirmationBlockReason();
      if (blockedReason) {
        resetConfirmation();
        showConfirmationBlock(blockedReason);
        return;
      }
      savingConfirmation = true;
      if (dateInput) dateInput.disabled = true;
      if (swipeLabel) swipeLabel.textContent = 'Saving…';
        if (confirmStatus) confirmStatus.textContent = 'Writing your self-confirmation for this swipe account…';
      paint(maxOffset());
      try {
        const result = await store.confirmShift(profile.id, date, { queueForSync: workerMode, syncActorId });
        if (dashboardGeneration !== viewGeneration || !host.isConnected || destroyed) return;
        profile = result.profile;
        let syncResult = null;
        const assignedWorkerId = workerIdsByProfileId[profile.id];
        if (workerMode && assignedWorkerId) {
          try {
            syncResult = await onResumeSync(profile.id, assignedWorkerId);
            profile = store.getProfile(profile.id) || profile;
          } catch {
            // The durable local event remains pending and will be retried on resume.
          }
        }
        currentProfile = profile;
        if (currentDate() === date) {
          showSavedConfirmation(profile.confirmations[date] || result.confirmation);
        } else {
          restoreConfirmation();
        }
        setStorageStatus(workerMode
          ? syncResult?.held
            ? `Self-confirmation saved for this swipe account. ${syncResult.held} older pending confirmation(s) have no saved operator identity and remain on this device for review or backup.`
            : 'Self-confirmation saved for this swipe account and queued for DKASU sync. Ogram was not contacted.'
          : 'Self-confirmation saved on this device. Ogram was not contacted.');
      } catch (error) {
        if (dashboardGeneration === viewGeneration && host.isConnected) {
          resetConfirmation();
          if (confirmStatus) {
            confirmStatus.textContent = `Self-confirmation was not saved. ${errorMessage(error)}`;
          }
          setStorageStatus('The self-confirmation was not saved to device storage.');
        }
      } finally {
        savingConfirmation = false;
        if (dateInput?.isConnected) dateInput.disabled = false;
      }
    }

    function beginDrag(event) {
      if (completed || savingConfirmation) return;
      const blockedReason = confirmationBlockReason();
      if (blockedReason) {
        showConfirmationBlock(blockedReason);
        return;
      }
      dragging = true;
      dragStartX = event.clientX;
      knob?.setPointerCapture?.(event.pointerId);
    }

    function moveDrag(event) {
      if (!dragging) return;
      paint(dragOffset + (event.clientX - dragStartX));
      dragStartX = event.clientX;
      const max = maxOffset();
      if (max > 0 && dragOffset >= max * 0.82) {
        dragging = false;
        paint(max);
        void saveConfirmation();
      }
    }

    function endDrag() {
      if (!dragging) return;
      dragging = false;
      if (!completed && !savingConfirmation) {
        if (knob) knob.style.transition = 'left .18s ease';
        paint(0);
        setTimeout(() => {
          if (knob) knob.style.transition = '';
        }, 200);
      }
    }

    knob?.addEventListener('pointerdown', beginDrag);
    knob?.addEventListener('pointermove', moveDrag);
    knob?.addEventListener('pointerup', endDrag);
    knob?.addEventListener('pointercancel', endDrag);

    timezoneSelect?.addEventListener('change', async () => {
      const requestedZone = timezoneSelect.value;
      timezoneSelect.disabled = true;
      try {
        const updated = await store.setDisplayZone(profile.id, requestedZone);
        if (dashboardGeneration !== viewGeneration) return;
        profile = updated;
        currentProfile = updated;
        if (timezoneLabel) timezoneLabel.textContent = `Dashboard uses ${TIME_ZONE_NAMES[profile.displayZone]} time`;
        tickDashboard();
        setStorageStatus('Display time zone saved on this device.');
      } catch (error) {
        if (dashboardGeneration !== viewGeneration) return;
        timezoneSelect.value = profile.displayZone;
        showAppMessage(`Time zone was not saved. ${errorMessage(error)}`, 'error');
      } finally {
        if (dashboardGeneration === viewGeneration && timezoneSelect.isConnected) timezoneSelect.disabled = false;
      }
    });

    dateInput?.addEventListener('change', () => {
      manuallySelectedScheduleDate = true;
      clearAppMessage();
      restoreConfirmation();
      syncConfirmationPanel();
      renderShift(host, profile, new Date());
    });

    if (copyButton) copyButton.disabled = !profile.address;
    copyButton?.addEventListener('click', async () => {
      const status = host.querySelector('#copyStatus');
      if (!profile.address) return;
      try {
        await copyText(profile.address);
        if (status) status.textContent = 'Address copied.';
      } catch {
        if (status) status.textContent = 'Copying was blocked. Press and hold the address to copy it manually.';
      }
    });

    function tickDashboard() {
      if (destroyed || dashboardGeneration !== viewGeneration || !host.isConnected) return;
      if (currentProfile && currentProfile.id !== profile.id) return;
      const now = new Date();
      const clocks = {
        clockUganda: TZ.uganda,
        clockDubai: TZ.dubai,
        clockItaly: TZ.italy
      };
      for (const [id, zone] of Object.entries(clocks)) {
        const element = host.querySelector(`#${id}`);
        if (element) element.textContent = formatClock(now, zone);
      }
      renderNextSchedule(host, profile, now);
      if (!manuallySelectedScheduleDate && dateInput && !dateInput.disabled) {
        const selected = dateInput.value ? profile.schedules[dateInput.value] : null;
        if (selected) {
          try {
            if (getShiftBounds(dateInput.value, selected, profile.scheduleZone).end <= now) {
              const next = nextScheduledShift(profile, now);
              if (next && next.date !== dateInput.value) {
                dateInput.value = next.date;
                restoreConfirmation();
                syncConfirmationPanel();
              }
            }
          } catch {
            // Keep invalid saved entries selected so they can be reviewed.
          }
        }
      }
      renderContract(host, profile, now);
      renderShift(host, profile, now);
    }

    resumeCurrentDashboard = () => {
      if (destroyed || dashboardGeneration !== viewGeneration || !host.isConnected) return;
      stopTicker();
      tickDashboard();
      tickHandle = setInterval(tickDashboard, 1000);
    };

    restoreConfirmation();
    syncConfirmationPanel();
    tickDashboard();
    tickHandle = setInterval(tickDashboard, 1000);
    if (appRoot) appRoot.style.display = 'block';
  }

  function showBackupPanel() {
    viewGeneration += 1;
    stopTicker();
    currentProfile = null;
    clearAppMessage();
    refreshWorkerProfileChoices();
    showOnly('backupPanel');
  }

  function refreshWorkerProfileChoices() {
    if (!refs.profileExportSelect) return;
    const selected = refs.profileExportSelect.value;
    const profiles = store.listProfiles();
    refs.profileExportSelect.replaceChildren(...profiles.map((profile) => {
      const option = document.createElement('option');
      option.value = profile.id;
      option.textContent = `${profile.name}${profile.swipeId ? ` · Swipe ID ${profile.swipeId}` : ''}`;
      return option;
    }));
    if (profiles.some((profile) => profile.id === selected)) refs.profileExportSelect.value = selected;
    if (refs.exportWorkerProfileButton) {
      refs.exportWorkerProfileButton.disabled = store.readOnly || !profiles.length;
    }
  }

  function downloadBackupInBrowser(filename, json) {
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  async function exportBackupToNativeFile(
    filename,
    json,
    validate = parseBackupText,
    { title = 'DKASU shift dashboard backup', dialogTitle = 'Save or share local backup' } = {}
  ) {
    const write = await Filesystem.writeFile({
      path: filename,
      data: json,
      directory: Directory.Cache,
      encoding: Encoding.UTF8
    });
    const readBack = await Filesystem.readFile({
      path: filename,
      directory: Directory.Cache,
      encoding: Encoding.UTF8
    });
    validate(String(readBack.data));
    await Share.share({
      title,
      dialogTitle,
      files: [write.uri]
    });
  }

  async function exportBackup() {
    if (!refs.exportBackupButton || refs.exportBackupButton.disabled) return;
    const profiles = store.listProfiles();
    if (!profiles.length) {
      setBackupStatus('There are no readable profiles to export. Restore a backup first.', 'error');
      return;
    }
    setButtonBusy(refs.exportBackupButton, true, 'Preparing…');
    if (refs.importBackupButton) refs.importBackupButton.disabled = true;
    try {
      let payload;
      try {
        payload = createBackup(profiles);
      } catch (error) {
        throw new Error(`Backup could not be created: ${errorMessage(error)}`);
      }
      const json = JSON.stringify(payload, null, 2);
      parseBackupText(json);
      const filename = backupFilename();
      if (Capacitor.isNativePlatform()) {
        await exportBackupToNativeFile(filename, json);
        setBackupStatus(
          'Backup file was written and verified. The Android share sheet opened; the file is only saved or shared to a destination you choose.',
          'success'
        );
      } else {
        downloadBackupInBrowser(filename, json);
        setBackupStatus(
          `Backup ${filename} was generated and passed to the browser download. Check your Downloads folder.`,
          'success'
        );
      }
    } catch (error) {
      setBackupStatus(`Export failed. ${errorMessage(error)}`, 'error');
    } finally {
      setButtonBusy(refs.exportBackupButton, false);
      if (refs.importBackupButton) refs.importBackupButton.disabled = false;
    }
  }

  function findExistingWorkerProfile(profile) {
    const profiles = store.listProfiles();
    const packageDuplicate = profiles.find((existing) => existing.id === profile.id);
    if (packageDuplicate) {
      return {
        existing: packageDuplicate,
        message: `This worker profile is already on this phone as "${packageDuplicate.name}". Nothing was changed.`
      };
    }
    if (profile.profileId) {
      const accountDuplicate = profiles.find(
        (existing) => existing.profileId && existing.profileId === profile.profileId
      );
      if (accountDuplicate) {
        return {
          existing: accountDuplicate,
          message: `Profile ID ${profile.profileId} is already on this phone as "${accountDuplicate.name}". Nothing was changed.`
        };
      }
    }
    return null;
  }

  async function exportWorkerProfile() {
    const profile = store.getProfile(refs.profileExportSelect?.value);
    if (!profile) { setBackupStatus('Create or import a worker profile before exporting.', 'error'); return; }
    const missing = [];
    if (!profile.swipeId) missing.push('a Swipe ID');
    if (!Object.keys(profile.schedules).length) missing.push('saved shifts');
    if (missing.length) {
      const proceed = globalThis.confirm(
        `${profile.name} has no ${missing.join(' or ')}. Export the package anyway?\n\nThe worker will need an updated package from the owner/admin to receive those details.`
      );
      if (!proceed) {
        setBackupStatus('Worker profile export cancelled. No file was created.');
        return;
      }
    }
    setButtonBusy(refs.exportWorkerProfileButton, true, 'Preparing…');
    if (refs.importWorkerProfileButton) refs.importWorkerProfileButton.disabled = true;
    try {
      const json = JSON.stringify(createWorkerProfilePackage(profile), null, 2);
      parseWorkerProfilePackageText(json);
      const filename = workerProfileFilename(profile);
      if (Capacitor.isNativePlatform()) {
        await exportBackupToNativeFile(filename, json, parseWorkerProfilePackageText, {
          title: 'DKASU worker profile package',
          dialogTitle: 'Save or share worker profile'
        });
        setBackupStatus(`Profile package for ${profile.name} was written and verified. Choose a destination in Android's share sheet.`, 'success');
      } else {
        downloadBackupInBrowser(filename, json);
        setBackupStatus(`Profile package for ${profile.name} was generated. Check your Downloads folder.`, 'success');
      }
    } catch (error) {
      setBackupStatus(`Profile export failed. ${errorMessage(error)}`, 'error');
    } finally {
      setButtonBusy(refs.exportWorkerProfileButton, false);
      if (refs.importWorkerProfileButton) refs.importWorkerProfileButton.disabled = store.readOnly;
    }
  }

  async function importWorkerProfileFile(file) {
    if (!file) return;
    setBackupStatus('Checking the worker profile package. Existing profiles will be kept…');
    try {
      if (store.readOnly) {
        throw new Error('Import is unavailable because saved profiles could not be read.');
      }
      if (file.size > MAX_BACKUP_CHARS) throw new ValidationError('Profile package is too large.');
      const parsed = parseWorkerProfilePackageText(await file.text());
      const profile = parsed.profile;
      const duplicate = findExistingWorkerProfile(profile);
      if (duplicate) {
        setBackupStatus(`${duplicate.message} Use the existing profile instead.`, 'error');
        return;
      }
      const confirmed = globalThis.confirm(
        `Add ${profile.name} to this phone?\n\nAll existing profiles and their local self-confirmations will be kept.`
      );
      if (!confirmed) {
        setBackupStatus('Import cancelled. No data was changed.');
        return;
      }
      const imported = await store.importProfile(profile);
      setStorageStatus('Worker profile was added to device storage. Existing profiles were kept.');
      setBackupStatus(`${imported.name} was added. Existing profiles and local self-confirmations were kept.`, 'success');
      showProfilePicker({
        message: `${imported.name} was added. Select that profile to open the worker dashboard. Existing profiles were kept.`,
        tone: 'success'
      });
    } catch (error) {
      setBackupStatus(`Profile import failed. No data was changed. ${errorMessage(error)}`, 'error');
    }
  }

  async function importBackupFile(file) {
    if (!file) return;
    setBackupStatus('Validating the complete backup before changing any data…');
    try {
      if (file.size > MAX_BACKUP_CHARS) throw new ValidationError('Backup file is too large.');
      const text = await file.text();
      if (text.length > MAX_BACKUP_CHARS) throw new ValidationError('Backup file is too large.');
      const parsed = parseBackupText(text);
      const names = parsed.profiles.map((profile) => profile.name).join(', ');
      const confirmed = globalThis.confirm(
        `Restore ${parsed.profiles.length} profile(s) and replace all current profiles on this device?\n\nProfiles in backup: ${names}\n\nThis cannot be undone unless you have an export of the current data.`
      );
      if (!confirmed) {
        setBackupStatus('Restore cancelled. No data was changed.');
        return;
      }
      setBackupStatus('Validation passed. Writing the restored profiles to device storage…');
      await store.restoreProfiles(parsed.profiles);
      viewGeneration += 1;
      stopTicker();
      currentProfile = null;
      activeProfileView.replaceChildren();
      updateMutationControls();
      renderProfileList();
      showOnly('profilePicker');
      showAppMessage(`Restore complete. ${parsed.profiles.length} profile(s) loaded; previous profiles were replaced.`, 'success');
      setStorageStatus('Restored profiles were saved to device storage.');
      setBackupStatus('Restore complete. The restored profiles are available in the profile picker.', 'success');
    } catch (error) {
      setBackupStatus(`Restore failed. No data was changed. ${errorMessage(error)}`, 'error');
    }
  }

  async function showProfilePickerAndClear() {
    showProfilePicker();
  }

  byId('profilesTopButton')?.addEventListener('click', showProfilePickerAndClear);
  profileSearch?.addEventListener('input', renderProfileList);
  byId('addTopButton')?.addEventListener('click', startAddProfile);
  refs.addProfileButton?.addEventListener('click', startAddProfile);
  refs.cancelEditorButton?.addEventListener('click', () => showProfilePicker());
  refs.saveProfileButton?.addEventListener('click', () => {
    void saveProfileEditor();
  });
  byId('switchProfileButton')?.addEventListener('click', showProfilePickerAndClear);
  byId('editActiveButton')?.addEventListener('click', startEditProfile);
  refs.deleteActiveButton?.addEventListener('click', () => {
    void deleteActiveProfile();
  });
  refs.backupButton?.addEventListener('click', showBackupPanel);
  refs.backFromBackupButton?.addEventListener('click', () => showProfilePicker());
  const backFromSecurityButton = byId('backFromSecurityButton');
  if (backFromSecurityButton) backFromSecurityButton.onclick = () => showOnly('activeProfilePanel');
  refs.exportBackupButton?.addEventListener('click', () => {
    void exportBackup();
  });
  refs.importBackupButton?.addEventListener('click', () => refs.backupFileInput?.click());
  refs.backupFileInput?.addEventListener('change', () => {
    const file = refs.backupFileInput?.files?.[0];
    void importBackupFile(file).finally(() => {
      if (refs.backupFileInput) refs.backupFileInput.value = '';
    });
  });
  refs.exportWorkerProfileButton?.addEventListener('click', () => { void exportWorkerProfile(); });
  refs.importWorkerProfileButton?.addEventListener('click', () => refs.workerProfileFileInput?.click());
  refs.workerProfileFileInput?.addEventListener('change', () => {
    const file = refs.workerProfileFileInput?.files?.[0];
    void importWorkerProfileFile(file).finally(() => { if (refs.workerProfileFileInput) refs.workerProfileFileInput.value = ''; });
  });

  if (store.loadWarning) {
    showAppMessage(store.loadWarning, 'error');
    setStorageStatus('Stored profile data could not be read. No stored data was overwritten.');
  } else {
    setStorageStatus(
      `${store.listProfiles().length} profile(s) loaded from ${storageLabel}. Successful changes are written and verified before confirmation.`
    );
  }
  updateMutationControls();
  if (workerMode && Object.keys(workerIdsByProfileId).length) {
    const profileIds = Object.keys(workerIdsByProfileId);
    for (const profileId of profileIds) void onResumeSync(profileId, workerIdsByProfileId[profileId]).catch(() => {});
    syncVisibilityHandler = () => {
      if (!document.hidden) {
        for (const profileId of profileIds) void onResumeSync(profileId, workerIdsByProfileId[profileId]).catch(() => {});
      }
    };
    syncOnlineHandler = () => {
      for (const profileId of profileIds) void onResumeSync(profileId, workerIdsByProfileId[profileId]).catch(() => {});
    };
    document.addEventListener('visibilitychange', syncVisibilityHandler);
    window.addEventListener('online', syncOnlineHandler);
  }
  if (workerMode && store.listProfiles().length === 1 && store.getActiveProfile()) {
    void openProfile(store.getActiveProfileId());
  } else {
    showProfilePicker();
  }

  byId('workerSignOutButton')?.addEventListener('click', () => { void onSignOut(); });

  return {
    showProfilePickerForLock() {
      stopTicker();
    },
    resumeAfterLock() {
      resumeCurrentDashboard?.();
    },
    destroy() {
      destroyed = true;
      stopTicker();
      if (syncVisibilityHandler) document.removeEventListener('visibilitychange', syncVisibilityHandler);
      if (syncOnlineHandler) window.removeEventListener('online', syncOnlineHandler);
      currentProfile = null;
      currentHost?.replaceChildren();
    }
  };
}

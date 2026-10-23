import { Capacitor } from '@capacitor/core';
import { supabase, supabaseConfigured } from './supabase.js';
import { parseWorkerProfilePackageText } from '../www/domain.js';

const $ = (selector, root = document) => root.querySelector(selector);
const loginPanel = $('#loginPanel');
const adminPanel = $('#adminPanel');
const notAdminPanel = $('#notAdminPanel');
const accountBar = $('#accountBar');
const notice = $('#notice');
const workerList = $('#workerList');
const swipeWorkerList = $('#swipeWorkerList');
const confirmationList = $('#confirmationList');
const adminMenuToggle = $('#adminMenuToggle');
const adminMenu = $('#adminMenu');
const adminPageTitles = {
  accounts: 'Accounts and schedules',
  operators: 'Operators',
  confirmations: 'Shift confirmations',
  setup: 'Add swipe accounts'
};
const companyKey = 'dkasu';
let companyId = null;
let activeUser = null;
let workers = [];
let swipers = [];
let swiperAssignments = [];
let swiperDevices = [];
let deviceSwipeGroups = [];
let schedules = [];
let scheduleRules = [];
const expandedWorkerIds = new Set();
const expandedSwiperIds = new Set();
let pendingWorkerPackage = null;

function showNotice(message, kind = '') {
  notice.textContent = message;
  notice.className = `notice${kind ? ` ${kind}` : ''}`;
}

function clearNotice() {
  notice.textContent = '';
  notice.className = 'notice hidden';
}

function applyListSearch(inputId, listId, emptyId) {
  const input = $(`#${inputId}`);
  const list = $(`#${listId}`);
  const query = input.value.trim().toLocaleLowerCase();
  const cards = [...list.querySelectorAll('[data-search]')];
  let matches = 0;
  for (const card of cards) {
    const match = !query || card.dataset.search.includes(query);
    card.classList.toggle('hidden', !match);
    if (match) matches += 1;
  }
  $(`#${emptyId}`).classList.toggle('hidden', !query || matches > 0 || cards.length === 0);
}

function showAdminPage(page) {
  if (!adminPageTitles[page]) return;
  for (const view of document.querySelectorAll('[data-admin-page]')) {
    view.classList.toggle('hidden', view.dataset.adminPage !== page);
  }
  document.querySelectorAll('[data-admin-page-link]').forEach((button) => {
    if (button.dataset.adminPageLink === page) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  $('#adminPageTitle').textContent = adminPageTitles[page];
  adminMenu.classList.add('hidden');
  adminMenuToggle.setAttribute('aria-expanded', 'false');
  adminMenuToggle.setAttribute('aria-label', 'Open admin sections');
}

function setBusy(button, busy, busyText = 'Working…') {
  if (!button) return;
  if (busy) {
    button.dataset.idleText = button.textContent;
    button.textContent = busyText;
    button.disabled = true;
  } else {
    button.textContent = button.dataset.idleText || button.textContent;
    button.disabled = false;
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}

function formatDate(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(`${value}T12:00:00`));
}

function formatTime(value) {
  return String(value || '').slice(0, 5);
}

function todayInTimeZone(timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function clearWorkerPackagePreview() {
  pendingWorkerPackage = null;
  const preview = $('#workerImportPreview');
  preview.textContent = '';
  preview.classList.add('hidden');
  $('#importPackageButton').disabled = true;
}

async function previewWorkerPackage(file) {
  clearWorkerPackagePreview();
  if (!file) return;
  const preview = $('#workerImportPreview');
  try {
    if (file.size > 5_000_000) throw new Error('The profile package is too large (maximum 5 MB).');
    const parsed = parseWorkerProfilePackageText(await file.text());
    const profile = parsed.profile;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.email)) {
      throw new Error('The swipe account needs a valid account email before it can be uploaded.');
    }
    const duplicate = workers.find((worker) =>
      worker.source_local_id === profile.id ||
      (profile.email && worker.email.trim().toLowerCase() === profile.email.trim().toLowerCase())
    );
    if (duplicate) {
      throw new Error(`An account with this profile ID or email already exists (${duplicate.name}). Existing data was not changed.`);
    }
    pendingWorkerPackage = parsed;
    const shiftCount = Object.keys(profile.schedules).length;
    preview.textContent = `Ready: ${profile.name}${profile.email ? ` · ${profile.email}` : ''} · ${shiftCount} scheduled shift${shiftCount === 1 ? '' : 's'}. Confirmation history will not be uploaded.`;
    preview.className = 'import-preview';
    $('#importPackageButton').disabled = false;
  } catch (error) {
    preview.textContent = error.message || String(error);
    preview.className = 'import-preview error';
  }
}

function resetWorkerPackageForm() {
  $('#workerImportForm').reset();
  clearWorkerPackagePreview();
}

async function importWorkerPackage(button) {
  const profile = pendingWorkerPackage?.profile;
  if (!profile) return;
  setBusy(button, true, 'Uploading…');
  let createdWorker = null;
  try {
    const { data, error } = await supabase.from('shift_workers').insert({
      company_id: companyId,
      name: profile.name,
      email: profile.email.trim().toLowerCase(),
      ogram_profile_id: profile.profileId,
      swipe_id: profile.swipeId,
      job_title: profile.job,
      company_name: profile.company,
      location: profile.location,
      address: profile.address,
      contract_start: profile.contractStart || null,
      contract_end: profile.contractEnd || null,
      display_timezone: profile.displayZone,
      schedule_timezone: profile.scheduleZone,
      source_local_id: profile.id,
      is_active: true
    }).select('id').single();
    if (error) throw error;
    createdWorker = data;

    const rows = Object.entries(profile.schedules).map(([shift_date, shift]) => ({
      worker_id: createdWorker.id,
      shift_date,
      start_time: shift.start,
      end_time: shift.end,
      schedule_timezone: profile.scheduleZone
    }));
    if (rows.length) {
      const { error: scheduleError } = await supabase.from('shift_schedules').insert(rows);
      if (scheduleError) throw scheduleError;
    }

    const name = profile.name;
    const count = rows.length;
    resetWorkerPackageForm();
    try {
      await loadDashboard();
    } catch (refreshError) {
      showNotice(`Imported ${name} and ${count} scheduled shift${count === 1 ? '' : 's'}, but the dashboard could not refresh: ${refreshError.message || refreshError}. Use Refresh to reload.`, 'error');
      return;
    }
    showNotice(`Imported swipe account ${name} and ${count} scheduled shift${count === 1 ? '' : 's'}. Assign it to an operator when ready.`, 'success');
  } catch (error) {
    if (createdWorker) {
      const name = profile.name;
      resetWorkerPackageForm();
      try { await loadDashboard(); } catch { /* Keep the partial-import message visible. */ }
      showNotice(`The profile for ${name} was added, but its schedule upload failed: ${error.message || error}. Do not re-upload the package; add the shifts manually.`, 'error');
    } else {
      showNotice(`Could not import worker profile: ${error.message || error}`, 'error');
    }
  } finally {
    setBusy(button, false);
    if (!pendingWorkerPackage) button.disabled = true;
  }
}

async function getCompanyId() {
  const { data, error } = await supabase
    .from('shift_companies')
    .select('id')
    .eq('company_key', companyKey)
    .single();
  if (error) throw error;
  return data.id;
}

async function loadDashboard() {
  const [workerResult, confirmationResult, swiperResult, assignmentResult, deviceResult, groupResult] = await Promise.all([
    supabase.from('shift_workers')
      .select('id,name,email,ogram_profile_id,swipe_id,job_title,company_name,location,address,contract_start,contract_end,display_timezone,schedule_timezone,source_local_id,is_active,auth_user_id')
      .eq('company_id', companyId)
      .order('name'),
    supabase.from('shift_confirmations')
      .select('id,worker_id,submitted_by,shift_date,submitted_at,reported_timezone,reported_address,received_at,record_kind')
      .order('received_at', { ascending: false })
      .limit(100),
    supabase.from('shift_swipers')
      .select('id,name,email,is_active,auth_user_id,device_assignment_enabled')
      .eq('company_id', companyId)
      .order('name'),
    supabase.from('shift_swiper_assignments')
      .select('swiper_id,worker_id')
      .eq('company_id', companyId),
    supabase.from('shift_swiper_devices')
      .select('id,company_id,swiper_id,device_name,platform,is_active,first_seen_at,last_seen_at')
      .eq('company_id', companyId)
      .order('last_seen_at', { ascending: false }),
    supabase.from('shift_device_swipe_groups')
      .select('device_id,swipe_id_key,assigned_at')
      .eq('company_id', companyId)
  ]);
  if (workerResult.error) throw workerResult.error;
  if (confirmationResult.error) throw confirmationResult.error;
  if (swiperResult.error) throw swiperResult.error;
  if (assignmentResult.error) throw assignmentResult.error;
  if (deviceResult.error) throw deviceResult.error;
  if (groupResult.error) throw groupResult.error;
  workers = workerResult.data || [];
  swipers = swiperResult.data || [];
  swiperAssignments = assignmentResult.data || [];
  swiperDevices = deviceResult.data || [];
  deviceSwipeGroups = groupResult.data || [];
  const workerIds = workers.map((worker) => worker.id);
  if (workerIds.length) {
    const [scheduleResult, ruleResult] = await Promise.all([
      supabase.from('shift_schedules')
        .select('id,worker_id,shift_date,start_time,end_time,schedule_timezone,schedule_kind,revision')
        .in('worker_id', workerIds)
        .order('shift_date'),
      supabase.from('shift_daily_rules')
        .select('id,worker_id,effective_from,effective_until,start_time,end_time,schedule_timezone,revision')
        .in('worker_id', workerIds)
    ]);
    if (scheduleResult.error) throw scheduleResult.error;
    if (ruleResult.error) throw ruleResult.error;
    schedules = scheduleResult.data || [];
    scheduleRules = ruleResult.data || [];
  } else {
    schedules = [];
    scheduleRules = [];
  }
  renderWorkers();
  renderSwipeWorkers();
  renderConfirmations(confirmationResult.data || []);
}

function swipeGroupKey(worker) {
  const swipeId = String(worker.swipe_id || '').trim().toLocaleLowerCase();
  return swipeId ? `swipe:${swipeId}` : `worker:${worker.id}`;
}

async function saveDeviceSwipeGroups(deviceId, button) {
  const card = swipeWorkerList.querySelector(`[data-device-card="${CSS.escape(deviceId)}"]`);
  if (!card) return;
  const keys = [...card.querySelectorAll('[data-device-swipe-group]:checked')]
    .map((input) => input.dataset.deviceSwipeGroup);
  setBusy(button, true, 'Saving…');
  try {
    const { error } = await supabase.rpc('shift_set_device_swipe_groups', {
      p_device_id: deviceId,
      p_swipe_id_keys: keys
    });
    if (error) throw error;
    await loadDashboard();
    showNotice(`Saved ${keys.length} Swipe ID group${keys.length === 1 ? '' : 's'} to this device. Selected groups now belong to it.`, 'success');
  } catch (error) {
    const conflict = error.code === '23505' || String(error.message || '').includes('shift_device_swipe_groups');
    showNotice(conflict
      ? 'One of these Swipe ID groups is already assigned to another device. Remove it from that device first, then save here.'
      : `Could not save device assignments: ${error.message || error}`, 'error');
  } finally {
    setBusy(button, false);
  }
}

function renderWorkers() {
  if (!workers.length) {
    workerList.innerHTML = '<div class="empty">No workers yet. Add a profile above to get started.</div>';
    return;
  }
  workerList.innerHTML = workers.map((worker) => {
    const workerSchedules = schedules.filter((item) => item.worker_id === worker.id);
    const rule = scheduleRules.find((item) => item.worker_id === worker.id);
    const today = todayInTimeZone(worker.schedule_timezone);
    const status = worker.is_active ? 'Swipe account' : 'Inactive';
    const profileFields = [
      ['name', 'Account name'], ['email', 'Account email'], ['ogram_profile_id', 'Ogram profile ID'],
      ['swipe_id', 'Swipe ID'], ['job_title', 'Job title'], ['company_name', 'Company name'],
      ['location', 'Work location'], ['address', 'Address'], ['contract_start', 'Contract starts'],
      ['contract_end', 'Contract ends'], ['display_timezone', 'Display time zone'], ['schedule_timezone', 'Schedule time zone']
    ];
    const searchText = [worker.name, worker.email, worker.ogram_profile_id, worker.swipe_id, worker.job_title, worker.company_name, worker.location].filter(Boolean).join(' ').toLocaleLowerCase();
    return `<details class="worker-card" data-search="${escapeHtml(searchText)}" data-worker-card="${escapeHtml(worker.id)}" data-worker-id="${escapeHtml(worker.id)}" ${expandedWorkerIds.has(worker.id) ? 'open' : ''}>
      <summary class="worker-summary"><span><strong>${escapeHtml(worker.name)}</strong><span class="worker-summary-meta">${escapeHtml(worker.email)} · ${escapeHtml(status)}</span></span><span class="worker-chevron" aria-hidden="true">⌄</span></summary>
      <div class="worker-details"><div class="worker-actions"><button class="button quiet" data-action="save-profile" data-worker-id="${escapeHtml(worker.id)}" type="button">Save profile</button>
          <button class="button ${worker.is_active ? 'danger' : 'quiet'}" data-action="toggle-active" data-worker-id="${escapeHtml(worker.id)}" type="button">${worker.is_active ? 'Deactivate' : 'Reactivate'}</button>
        </div>
      <div class="worker-fields">${profileFields.map(([key, label]) => `<label>${escapeHtml(label)}<input data-field="${key}" value="${escapeHtml(worker[key] || '')}" ${key === 'contract_start' || key === 'contract_end' ? 'type="date"' : ''}></label>`).join('')}</div>
      <div class="schedule-block"><strong>Schedule · ${escapeHtml(worker.schedule_timezone)}</strong>
        <p class="schedule-help">Enter shift times in this schedule time zone using the 24-hour clock. For example, 16:00 means 4:00 PM. Past shifts are labeled.</p>
        <form class="daily-rule-form" data-daily-rule-form="${escapeHtml(worker.id)}">
          <strong>Repeat the same shift every day</strong>
          <label>Starts (24-hour)<input name="start_time" type="time" step="60" value="${escapeHtml(rule?.start_time || '')}" required></label>
          <label>Ends (24-hour)<input name="end_time" type="time" step="60" value="${escapeHtml(rule?.end_time || '')}" required></label>
          <label>From<input name="effective_from" type="date" value="${escapeHtml(rule?.effective_from || '')}" required></label>
          <label>Until (optional)<input name="effective_until" type="date" value="${escapeHtml(rule?.effective_until || '')}"></label>
          <button class="button primary" type="submit">${rule ? 'Save daily shift' : 'Set daily shift'}</button>
          ${rule ? `<button class="button quiet" data-action="remove-daily-rule" data-worker-id="${escapeHtml(worker.id)}" type="button">Stop repeating</button>` : ''}
        </form>
        <p class="schedule-help">A saved shift or day-off exception below overrides the daily shift for that date only.</p>
        <form class="schedule-form" data-schedule-form="${escapeHtml(worker.id)}">
          <label>Shift date<input name="shift_date" type="date" required></label>
          <label>Exception type<select name="schedule_kind"><option value="shift">Different shift</option><option value="off">Day off</option></select></label>
          <label>Starts (24-hour)<input name="start_time" type="time" step="60"></label>
          <label>Ends (24-hour)<input name="end_time" type="time" step="60"></label>
          <button class="button quiet" type="submit">Save shift</button>
        </form>
        <div class="schedule-items">${workerSchedules.length ? workerSchedules.map((item) => {
          const isPast = item.shift_date < today;
          const details = item.schedule_kind === 'off' ? 'Day off' : `${escapeHtml(formatTime(item.start_time))}–${escapeHtml(formatTime(item.end_time))}`;
          return `<span class="schedule-chip${isPast ? ' past' : ''}">${escapeHtml(formatDate(item.shift_date))} · ${details}${isPast ? '<span class="schedule-status">Past</span>' : ''}<button type="button" aria-label="Remove date exception" data-action="delete-schedule" data-schedule-id="${escapeHtml(item.id)}">×</button></span>`;
        }).join('') : '<span class="muted small">No date-specific changes</span>'}</div>
      </div><div data-activation-result="${escapeHtml(worker.id)}"></div></div></details>`;
  }).join('');
  applyListSearch('workerSearch', 'workerList', 'workerSearchEmpty');
}

function renderSwipeWorkers() {
  if (!swipers.length) {
    swipeWorkerList.innerHTML = '<div class="empty">No swiper operators yet. Add an operator above, then assign swipe accounts.</div>';
    return;
  }
  swipeWorkerList.innerHTML = [...swipers].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })).map((swiper) => {
    const status = !swiper.is_active ? 'Inactive' : swiper.auth_user_id ? 'Activated' : 'Needs activation';
    const statusClass = !swiper.is_active ? 'disabled' : swiper.auth_user_id ? 'linked' : 'pending';
    const assigned = new Set(swiperAssignments.filter((row) => row.swiper_id === swiper.id).map((row) => row.worker_id));
    const operatorWorkers = workers.filter((worker) => assigned.has(worker.id));
    const groups = new Map();
    for (const worker of operatorWorkers) {
      const key = swipeGroupKey(worker);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(worker);
    }
    const devices = swiperDevices.filter((device) => device.swiper_id === swiper.id);
    const groupOwners = new Map(deviceSwipeGroups.map((row) => [row.swipe_id_key, row.device_id]));
    const searchText = [swiper.name, swiper.email].filter(Boolean).join(' ').toLocaleLowerCase();
    return `<details class="swipe-worker-card swiper-card" data-search="${escapeHtml(searchText)}" data-swiper-card="${escapeHtml(swiper.id)}" ${expandedSwiperIds.has(swiper.id) ? 'open' : ''}>
      <summary class="swiper-summary"><span class="swipe-worker-heading"><strong>${escapeHtml(swiper.name)}</strong><span>${escapeHtml(swiper.email)}</span></span><span class="swiper-summary-side"><span class="worker-access-status ${statusClass}">${status}</span><span class="worker-access-status ${swiper.device_assignment_enabled ? 'linked' : 'pending'}">Device groups ${swiper.device_assignment_enabled ? 'ON' : 'OFF'}</span><span class="worker-chevron" aria-hidden="true">⌄</span></span></summary>
      <div class="swiper-details"><p class="swiper-assignment-count">${assigned.size} swipe account${assigned.size === 1 ? '' : 's'} assigned</p>
      <details class="assignment-picker"><summary>Manage assigned accounts</summary><div class="assignment-options">${workers.map((worker) => `<label><input type="checkbox" data-assigned-worker="${escapeHtml(worker.id)}" ${assigned.has(worker.id) ? 'checked' : ''}><span>${escapeHtml(worker.name)} · ${escapeHtml(worker.swipe_id || worker.ogram_profile_id || 'No ID')}${worker.is_active ? '' : ' · Inactive'}</span></label>`).join('') || '<span class="muted small">Add swipe accounts first.</span>'}</div></details>
      <details class="assignment-picker device-picker"><summary>Assign Swipe ID groups to devices (${devices.length})</summary>
        <p class="schedule-help">Every account with the same Swipe ID is grouped and must stay on one device.</p>
        ${devices.map((device) => {
          const assignedKeys = new Set(deviceSwipeGroups.filter((row) => row.device_id === device.id).map((row) => row.swipe_id_key));
          const deviceStatus = device.is_active ? 'Ready' : 'Disabled';
          const deviceLabel = `${device.device_name} · ${String(device.id).slice(-6).toUpperCase()}`;
          return `<div class="device-assignment" data-device-card="${escapeHtml(device.id)}"><strong>${escapeHtml(deviceLabel)}</strong><span class="muted small">${escapeHtml(device.platform)} · ${deviceStatus} · Last used ${escapeHtml(new Date(device.last_seen_at).toLocaleString())}</span>
            <div class="assignment-options">${[...groups.entries()].map(([key, members]) => {
              const ownerDeviceId = groupOwners.get(key);
              const ownedElsewhere = ownerDeviceId && ownerDeviceId !== device.id;
              const ownerDevice = swiperDevices.find((candidate) => candidate.id === ownerDeviceId);
              const ownerSwiper = swipers.find((candidate) => candidate.id === ownerDevice?.swiper_id);
              const suffix = ownedElsewhere ? ` · Currently on ${ownerSwiper?.name || 'another operator'}’s device ${String(ownerDeviceId).slice(-6).toUpperCase()} — selecting moves it here` : '';
              return `<label><input type="checkbox" data-device-swipe-group="${escapeHtml(key)}" ${assignedKeys.has(key) ? 'checked' : ''} ${device.is_active ? '' : 'disabled'}><span>${escapeHtml(members[0].swipe_id || 'No Swipe ID')} · ${members.length} account${members.length === 1 ? '' : 's'}${members.length > 1 ? ` (${members.map((member) => escapeHtml(member.name)).join(', ')})` : ''}${escapeHtml(suffix)}</span></label>`;
            }).join('') || '<span class="muted small">Assign swipe accounts to this operator first.</span>'}</div>
            <button class="button quiet" data-action="save-device-groups" data-device-id="${escapeHtml(device.id)}" type="button" ${device.is_active ? '' : 'disabled'}>Save device groups</button>
          </div>`;
        }).join('') || '<p class="muted small">This operator’s devices appear here after they sign in on each device. Refresh the admin dashboard after sign-in.</p>'}
      </details>
      <div class="swiper-actions"><button class="button quiet" data-action="save-assignments" data-swiper-id="${escapeHtml(swiper.id)}" type="button">Save assignments</button>
        <button class="button ${swiper.device_assignment_enabled ? 'quiet' : 'primary'}" data-action="toggle-device-assignment" data-swiper-id="${escapeHtml(swiper.id)}" type="button" ${swiper.is_active ? '' : 'disabled'}>Turn device groups ${swiper.device_assignment_enabled ? 'off' : 'on'}</button>
        ${swiper.is_active && !swiper.auth_user_id ? `<button class="button primary" data-action="activate-swiper" data-swiper-id="${escapeHtml(swiper.id)}" type="button">Issue operator code</button>` : ''}
        ${swiper.is_active && swiper.auth_user_id ? `<button class="button quiet" data-action="reset-swiper-pin" data-swiper-id="${escapeHtml(swiper.id)}" type="button">Issue PIN reset code</button>` : ''}
        <button class="button ${swiper.is_active ? 'danger' : 'quiet'}" data-action="toggle-swiper" data-swiper-id="${escapeHtml(swiper.id)}" type="button">${swiper.is_active ? 'Deactivate' : 'Reactivate'}</button>
      </div><div data-swiper-activation="${escapeHtml(swiper.id)}"></div><div data-swiper-pin-reset="${escapeHtml(swiper.id)}"></div></div>
    </details>`;
  }).join('');
  applyListSearch('swiperSearch', 'swipeWorkerList', 'swiperSearchEmpty');
}

function renderConfirmations(rows) {
  if (!rows.length) {
    confirmationList.innerHTML = '<div class="empty">No swiper self-confirmations have synced yet.</div>';
    return;
  }
  confirmationList.innerHTML = rows.map((row) => {
    const worker = workers.find((item) => item.id === row.worker_id);
    const swiper = swipers.find((item) => item.auth_user_id === row.submitted_by);
    const details = [row.reported_timezone, row.reported_address].filter(Boolean).map(escapeHtml).join(' · ');
    const operatorName = swiper?.name || 'Legacy submitter';
    const searchText = [operatorName, worker?.name, worker?.email, row.shift_date, details, row.submitted_at, row.received_at].filter(Boolean).join(' ').toLocaleLowerCase();
    return `<div class="confirmation-row" data-search="${escapeHtml(searchText)}"><div><strong>${escapeHtml(operatorName)} · ${escapeHtml(worker?.name || 'Swipe account')} · ${escapeHtml(formatDate(row.shift_date))}</strong><span>Swiper self-confirmation${details ? ` · ${details}` : ''}</span></div><span>Submitted ${escapeHtml(new Date(row.submitted_at).toLocaleString())}<br>Received ${escapeHtml(new Date(row.received_at).toLocaleString())}</span></div>`;
  }).join('');
  applyListSearch('confirmationSearch', 'confirmationList', 'confirmationSearchEmpty');
}

function bytesToBase64Url(bytes) {
  let binary = '';
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function hashToken(token) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function issueSwiperActivation(swiperId, button) {
  setBusy(button, true, 'Creating…');
  try {
    const code = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const tokenHash = await hashToken(code);
    const { error } = await supabase.rpc('shift_create_swiper_activation', {
      p_swiper_id: swiperId,
      p_token_hash_hex: tokenHash,
      p_expires_at: expiresAt
    });
    if (error) throw error;
    const target = document.querySelector(`[data-swiper-activation="${CSS.escape(swiperId)}"]`);
    if (target) {
      target.innerHTML = `<div class="activation-code"><strong>One-time code for the swiper operator</strong><code>${escapeHtml(code)}</code><span>Expires ${escapeHtml(new Date(expiresAt).toLocaleString())}. The operator signs in with Google using the invited email.</span><div><button class="button quiet" data-action="copy-code" type="button">Copy code</button></div></div>`;
      target.querySelector('[data-action="copy-code"]')?.addEventListener('click', async (event) => {
        try { await navigator.clipboard.writeText(code); event.currentTarget.textContent = 'Copied'; }
        catch { event.currentTarget.textContent = 'Select and copy the code above'; }
      }, { once: true });
    }
    showNotice('Operator activation code created. Save or share it now; it is shown only here.', 'success');
  } catch (error) {
    showNotice(`Could not create operator code: ${error.message || error}`, 'error');
  } finally {
    setBusy(button, false);
  }
}

async function issueSwiperPinReset(swiperId, button) {
  const swiper = swipers.find((item) => item.id === swiperId);
  if (!swiper?.is_active || !swiper.auth_user_id) {
    showNotice('A PIN reset code is available only for an active, registered swiper.', 'error');
    return;
  }
  setBusy(button, true, 'Creating…');
  try {
    const code = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    const tokenHash = await hashToken(code);
    const { data, error } = await supabase.rpc('shift_create_swiper_pin_reset', {
      p_swiper_id: swiperId,
      p_token_hash_hex: tokenHash
    });
    if (error) throw error;
    const expiresAt = data?.expires_at;
    if (!expiresAt) throw new Error('Supabase did not return the reset-code expiry. Refresh and try again.');
    const target = document.querySelector(`[data-swiper-pin-reset="${CSS.escape(swiperId)}"]`);
    if (target) {
      target.innerHTML = `<div class="activation-code"><strong>One-time PIN reset code for ${escapeHtml(swiper.name)}</strong><code>${escapeHtml(code)}</code><span>Expires ${escapeHtml(new Date(expiresAt).toLocaleString())}. The swiper must sign in with their assigned Google account and enter this on the app lock screen. This code is shown only here.</span><div><button class="button quiet" data-action="copy-pin-reset-code" type="button">Copy code</button></div></div>`;
      target.querySelector('[data-action="copy-pin-reset-code"]')?.addEventListener('click', async (event) => {
        try { await navigator.clipboard.writeText(code); event.currentTarget.textContent = 'Copied'; }
        catch { event.currentTarget.textContent = 'Select and copy the code above'; }
      }, { once: true });
    }
    showNotice(`One-time PIN reset code created for ${swiper.name}. It expires in 15 minutes and is shown only here.`, 'success');
  } catch (error) {
    showNotice(`Could not create PIN reset code: ${error.message || error}`, 'error');
  } finally {
    setBusy(button, false);
  }
}

async function saveSwiperAssignments(swiperId, button) {
  const card = swipeWorkerList.querySelector(`[data-swiper-card="${CSS.escape(swiperId)}"]`);
  if (!card) return;
  const workerIds = [...card.querySelectorAll('[data-assigned-worker]:checked')].map((input) => input.dataset.assignedWorker);
  setBusy(button, true, 'Saving…');
  try {
    const { error } = await supabase.rpc('shift_set_swiper_assignments', {
      p_swiper_id: swiperId,
      p_worker_ids: workerIds
    });
    if (error) throw error;
    await loadDashboard();
    showNotice(`Saved ${workerIds.length} swipe account assignment(s).`, 'success');
  } catch (error) {
    showNotice(`Could not save assignments: ${error.message || error}`, 'error');
  } finally {
    setBusy(button, false);
  }
}

async function toggleSwiper(swiperId, button) {
  const swiper = swipers.find((item) => item.id === swiperId);
  if (!swiper) return;
  setBusy(button, true, 'Saving…');
  try {
    const { error } = await supabase.from('shift_swipers').update({ is_active: !swiper.is_active }).eq('id', swiperId);
    if (error) throw error;
    await loadDashboard();
    showNotice(swiper.is_active ? 'Operator deactivated. Access stops at the next online sync.' : 'Operator reactivated.', 'success');
  } catch (error) {
    showNotice(`Could not update operator: ${error.message || error}`, 'error');
  } finally {
    setBusy(button, false);
  }
}

async function toggleDeviceAssignment(swiperId, button) {
  const swiper = swipers.find((item) => item.id === swiperId);
  if (!swiper) return;
  const enabled = !swiper.device_assignment_enabled;
  setBusy(button, true, 'Saving…');
  try {
    const { error } = await supabase.rpc('shift_set_swiper_device_assignment', {
      p_swiper_id: swiperId,
      p_enabled: enabled
    });
    if (error) throw error;
    await loadDashboard();
    showNotice(enabled
      ? `Device Swipe ID grouping is on for ${swiper.name}. Each assigned account group is limited to its selected device.`
      : `Device Swipe ID grouping is off for ${swiper.name}. Their assigned accounts can be used on any of their devices.`, 'success');
  } catch (error) {
    const incomplete = String(error.message || '').includes('device_groups_incomplete');
    showNotice(incomplete
      ? `Assign every active Swipe ID group to one of ${swiper.name}’s registered devices, then turn device groups on.`
      : `Could not change device grouping: ${error.message || error}`, 'error');
  } finally {
    setBusy(button, false);
  }
}

async function saveWorkerProfile(workerId, button) {
  const card = button.closest('[data-worker-card]');
  const values = Object.fromEntries([...card.querySelectorAll('[data-field]')].map((input) => [input.dataset.field, input.value.trim()]));
  if (!values.name || !values.email) {
    showNotice('Swipe account name and account email are required.', 'error');
    return;
  }
  try {
    new Intl.DateTimeFormat('en', { timeZone: values.display_timezone }).format();
    new Intl.DateTimeFormat('en', { timeZone: values.schedule_timezone }).format();
  } catch {
    showNotice('Enter valid IANA time zones, such as Asia/Dubai or Europe/Rome.', 'error');
    return;
  }
  if (values.contract_start === '') values.contract_start = null;
  if (values.contract_end === '') values.contract_end = null;
  setBusy(button, true, 'Saving…');
  try {
    const { error } = await supabase.from('shift_workers').update(values).eq('id', workerId);
    if (error) throw error;
    await loadDashboard();
    showNotice('Swipe account profile saved.', 'success');
  } catch (error) {
    showNotice(`Could not save profile: ${error.message || error}`, 'error');
  } finally {
    setBusy(button, false);
  }
}

async function toggleWorker(workerId, button) {
  const worker = workers.find((item) => item.id === workerId);
  if (!worker) return;
  setBusy(button, true, 'Saving…');
  try {
    const { error } = await supabase.from('shift_workers').update({ is_active: !worker.is_active }).eq('id', workerId);
    if (error) throw error;
    await loadDashboard();
    showNotice(worker.is_active ? 'Worker deactivated. Access is blocked on the next sync.' : 'Worker reactivated.', 'success');
  } catch (error) {
    showNotice(`Could not update worker: ${error.message || error}`, 'error');
  } finally {
    setBusy(button, false);
  }
}

async function saveSchedule(workerId, form, button) {
  const values = Object.fromEntries(new FormData(form));
  const worker = workers.find((item) => item.id === workerId);
  if (!worker) return;
  const kind = values.schedule_kind || 'shift';
  if (kind === 'shift' && (!values.start_time || !values.end_time)) {
    showNotice('Enter both start and end times for a different shift.', 'error');
    return;
  }
  if (kind === 'shift' && values.start_time === values.end_time) {
    showNotice('Shift start and end times must differ.', 'error');
    return;
  }
  setBusy(button, true, 'Saving…');
  try {
    const { error } = await supabase.from('shift_schedules').upsert({
      worker_id: workerId,
      shift_date: values.shift_date,
      start_time: kind === 'shift' ? values.start_time : null,
      end_time: kind === 'shift' ? values.end_time : null,
      schedule_timezone: worker.schedule_timezone,
      schedule_kind: kind
    }, { onConflict: 'worker_id,shift_date' });
    if (error) throw error;
    form.reset();
    for (const input of form.querySelectorAll('[name="start_time"], [name="end_time"]')) {
      input.disabled = false;
      input.required = true;
    }
    form.querySelector('[type="submit"]').textContent = 'Save shift';
    await loadDashboard();
    showNotice(kind === 'off' ? 'Day-off exception saved.' : 'Date-specific shift saved.', 'success');
  } catch (error) {
    showNotice(`Could not save schedule: ${error.message || error}`, 'error');
  } finally {
    setBusy(button, false);
  }
}

async function saveDailyRule(workerId, form, button) {
  const values = Object.fromEntries(new FormData(form));
  const worker = workers.find((item) => item.id === workerId);
  if (!worker) return;
  if (values.start_time === values.end_time) {
    showNotice('Daily shift start and end times must differ.', 'error');
    return;
  }
  if (values.effective_until && values.effective_until < values.effective_from) {
    showNotice('The daily schedule end date must be on or after its start date.', 'error');
    return;
  }
  setBusy(button, true, 'Saving…');
  try {
    const ruleValues = {
      effective_from: values.effective_from,
      effective_until: values.effective_until || null,
      start_time: values.start_time,
      end_time: values.end_time,
      schedule_timezone: worker.schedule_timezone
    };
    const currentRule = scheduleRules.find((item) => item.worker_id === workerId);
    const result = currentRule
      ? await supabase.from('shift_daily_rules').update(ruleValues).eq('worker_id', workerId)
      : await supabase.from('shift_daily_rules').insert({ worker_id: workerId, ...ruleValues });
    const { error } = result;
    if (error) throw error;
    await loadDashboard();
    showNotice('Daily repeating shift saved. Date-specific changes still take precedence.', 'success');
  } catch (error) {
    showNotice(`Could not save daily shift: ${error.message || error}`, 'error');
  } finally {
    setBusy(button, false);
  }
}

async function removeDailyRule(workerId, button) {
  setBusy(button, true, 'Stopping…');
  try {
    const { error } = await supabase.from('shift_daily_rules').delete().eq('worker_id', workerId);
    if (error) throw error;
    await loadDashboard();
    showNotice('Daily repetition stopped. Saved date-specific shifts were kept.', 'success');
  } catch (error) {
    showNotice(`Could not stop daily repetition: ${error.message || error}`, 'error');
  } finally {
    setBusy(button, false);
  }
}

async function deleteSchedule(scheduleId, button) {
  setBusy(button, true, '…');
  try {
    const { error } = await supabase.from('shift_schedules').delete().eq('id', scheduleId);
    if (error) throw error;
    await loadDashboard();
    showNotice('Scheduled shift removed.', 'success');
  } catch (error) {
    showNotice(`Could not remove shift: ${error.message || error}`, 'error');
  } finally {
    setBusy(button, false);
  }
}

async function renderSession(user) {
  activeUser = user;
  if (Capacitor.isNativePlatform() && !user) {
    window.location.replace(new URL('/', window.location.origin).href);
    return;
  }
  clearNotice();
  accountBar.classList.toggle('hidden', !user);
  $('#accountEmail').textContent = user?.email || '';
  loginPanel.classList.toggle('hidden', Boolean(user));
  adminPanel.classList.add('hidden');
  notAdminPanel.classList.add('hidden');
  if (!user) return;
  try {
    const { data: admin, error } = await supabase.from('shift_admins').select('user_id').eq('user_id', user.id).maybeSingle();
    if (error) throw error;
    if (!admin) {
      if (Capacitor.isNativePlatform()) {
        window.location.replace(new URL('/', window.location.origin).href);
        return;
      }
      window.location.replace(new URL('/worker/', window.location.origin).href);
      return;
    }
    companyId = await getCompanyId();
    adminPanel.classList.remove('hidden');
    showAdminPage('accounts');
    await loadDashboard();
  } catch (error) {
    const message = error.message || String(error);
    if (/shift_daily_rules|schedule_kind/i.test(message) && /does not exist|schema cache/i.test(message)) {
      showNotice('The daily schedule upgrade is ready in the app, but Supabase needs its migration first. Run 20261023000100_shift_daily_schedule_rules.sql, then refresh this page.', 'error');
    } else {
      showNotice(`Could not load shift admin access: ${message}`, 'error');
    }
  }
}

async function start() {
  if (!supabaseConfigured) {
    $('#googleButton').disabled = true;
    $('#registerSwiperButton').disabled = true;
    $('#configHelp').classList.remove('hidden');
    showNotice('Supabase is not configured in this build. No credentials are embedded in the source.', 'error');
    return;
  }

  adminMenuToggle.addEventListener('click', () => {
    const opening = adminMenu.classList.contains('hidden');
    adminMenu.classList.toggle('hidden', !opening);
    adminMenuToggle.setAttribute('aria-expanded', String(opening));
    adminMenuToggle.setAttribute('aria-label', opening ? 'Close admin sections' : 'Open admin sections');
  });
  adminMenu.addEventListener('click', (event) => {
    const button = event.target.closest('[data-admin-page-link]');
    if (button) showAdminPage(button.dataset.adminPageLink);
  });
  document.addEventListener('click', (event) => {
    if (!event.target.closest('.admin-menu-wrap')) {
      adminMenu.classList.add('hidden');
      adminMenuToggle.setAttribute('aria-expanded', 'false');
      adminMenuToggle.setAttribute('aria-label', 'Open admin sections');
    }
  });
  for (const [inputId, listId, emptyId] of [
    ['workerSearch', 'workerList', 'workerSearchEmpty'],
    ['swiperSearch', 'swipeWorkerList', 'swiperSearchEmpty'],
    ['confirmationSearch', 'confirmationList', 'confirmationSearchEmpty']
  ]) {
    $(`#${inputId}`).addEventListener('input', () => applyListSearch(inputId, listId, emptyId));
  }

  $('#googleButton').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    setBusy(button, true, 'Opening Google…');
    try {
      const redirectTo = `${window.location.origin}/`;
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo, queryParams: { prompt: 'select_account' } }
      });
      if (error) throw error;
    } catch (error) {
      showNotice(`Google sign-in could not start: ${error.message || error}`, 'error');
      setBusy(button, false);
    }
  });

  $('#registerSwiperButton').addEventListener('click', () => {
    showNotice('Sign in with the Google email your DKASU admin added. You can enter the one-time activation code after sign-in.');
    $('#googleButton').click();
  });

  $('#signOutButton').addEventListener('click', async () => {
    const { error } = await supabase.auth.signOut();
    if (error) showNotice(`Sign out failed: ${error.message}`, 'error');
    else await renderSession(null);
  });

  const workerForm = $('#workerForm');
  const toggleWorkerFormButton = $('#toggleWorkerFormButton');
  const setWorkerFormOpen = (open) => {
    workerForm.classList.toggle('hidden', !open);
    toggleWorkerFormButton.setAttribute('aria-expanded', String(open));
    toggleWorkerFormButton.textContent = open ? 'Hide form' : 'Add worker manually';
  };

  toggleWorkerFormButton.addEventListener('click', () => {
    setWorkerFormOpen(toggleWorkerFormButton.getAttribute('aria-expanded') !== 'true');
  });

  const swiperForm = $('#swiperForm');
  const toggleSwiperFormButton = $('#toggleSwiperFormButton');
  const setSwiperFormOpen = (open) => {
    swiperForm.classList.toggle('hidden', !open);
    toggleSwiperFormButton.setAttribute('aria-expanded', String(open));
    toggleSwiperFormButton.textContent = open ? 'Hide form' : 'Add operator';
  };
  toggleSwiperFormButton.addEventListener('click', () => {
    setSwiperFormOpen(toggleSwiperFormButton.getAttribute('aria-expanded') !== 'true');
  });

  workerForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('[type="submit"]');
    const raw = Object.fromEntries(new FormData(form));
    if (raw.contract_start === '') raw.contract_start = null;
    if (raw.contract_end === '') raw.contract_end = null;
    try {
      new Intl.DateTimeFormat('en', { timeZone: raw.display_timezone }).format();
      new Intl.DateTimeFormat('en', { timeZone: raw.schedule_timezone }).format();
    } catch {
      showNotice('Enter valid IANA time zones, such as Asia/Dubai or Europe/Rome.', 'error');
      return;
    }
    setBusy(button, true, 'Adding…');
    try {
      const { error } = await supabase.from('shift_workers').insert({ ...raw, company_id: companyId });
      if (error) throw error;
      form.reset();
      form.elements.company_name.value = 'DKASU';
      form.elements.display_timezone.value = 'Asia/Dubai';
      form.elements.schedule_timezone.value = 'Asia/Dubai';
      setWorkerFormOpen(false);
      await loadDashboard();
      showNotice('Swipe account added. Assign it to one or more swiper operators above.', 'success');
    } catch (error) {
      showNotice(`Could not add worker: ${error.message || error}`, 'error');
    } finally {
      setBusy(button, false);
    }
  });

  swiperForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('[type="submit"]');
    const values = Object.fromEntries(new FormData(form));
    values.name = values.name.trim();
    values.email = values.email.trim().toLowerCase();
    if (!values.name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) {
      showNotice('Enter the operator name and their Google account email.', 'error');
      return;
    }
    setBusy(button, true, 'Adding…');
    try {
      const { error } = await supabase.from('shift_swipers').insert({ ...values, company_id: companyId });
      if (error) throw error;
      form.reset();
      setSwiperFormOpen(false);
      await loadDashboard();
      showNotice('Swiper operator added. Assign swipe accounts, then issue their activation code.', 'success');
    } catch (error) {
      showNotice(`Could not add swiper operator: ${error.message || error}`, 'error');
    } finally {
      setBusy(button, false);
    }
  });

  swipeWorkerList.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const { action, swiperId } = button.dataset;
    if (action === 'activate-swiper') await issueSwiperActivation(swiperId, button);
    if (action === 'reset-swiper-pin') await issueSwiperPinReset(swiperId, button);
    if (action === 'save-assignments') await saveSwiperAssignments(swiperId, button);
    if (action === 'save-device-groups') await saveDeviceSwipeGroups(button.dataset.deviceId, button);
    if (action === 'toggle-device-assignment') await toggleDeviceAssignment(swiperId, button);
    if (action === 'toggle-swiper') await toggleSwiper(swiperId, button);
    if (action === 'copy-code' || action === 'copy-pin-reset-code') {
      const code = button.closest('.activation-code')?.querySelector('code')?.textContent;
      if (code) {
        try { await navigator.clipboard.writeText(code); button.textContent = 'Copied'; }
        catch { button.textContent = 'Select and copy the code above'; }
      }
    }
  });

  swipeWorkerList.addEventListener('toggle', (event) => {
    const card = event.target.closest?.('details[data-swiper-card]');
    if (!card) return;
    if (card.open) expandedSwiperIds.add(card.dataset.swiperCard);
    else expandedSwiperIds.delete(card.dataset.swiperCard);
  }, true);

  $('#workerPackageInput').addEventListener('change', (event) => {
    void previewWorkerPackage(event.currentTarget.files?.[0]);
  });

  $('#workerImportForm').addEventListener('submit', (event) => {
    event.preventDefault();
    void importWorkerPackage(event.currentTarget.querySelector('[type="submit"]'));
  });

  $('#refreshButton').addEventListener('click', async () => {
    try { await loadDashboard(); showNotice('Dashboard refreshed.', 'success'); }
    catch (error) { showNotice(`Refresh failed: ${error.message || error}`, 'error'); }
  });

  workerList.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const { action, workerId, scheduleId } = button.dataset;
    if (action === 'save-profile') await saveWorkerProfile(workerId, button);
    if (action === 'toggle-active') await toggleWorker(workerId, button);
    if (action === 'delete-schedule') await deleteSchedule(scheduleId, button);
    if (action === 'remove-daily-rule') await removeDailyRule(workerId, button);
  });

  workerList.addEventListener('toggle', (event) => {
    const card = event.target.closest?.('details[data-worker-id]');
    if (!card) return;
    if (card.open) expandedWorkerIds.add(card.dataset.workerId);
    else expandedWorkerIds.delete(card.dataset.workerId);
  }, true);

  workerList.addEventListener('submit', async (event) => {
    const form = event.target.closest('[data-schedule-form]');
    if (!form) return;
    event.preventDefault();
    await saveSchedule(form.dataset.scheduleForm, form, form.querySelector('[type="submit"]'));
  });

  workerList.addEventListener('submit', async (event) => {
    const form = event.target.closest('[data-daily-rule-form]');
    if (!form) return;
    event.preventDefault();
    await saveDailyRule(form.dataset.dailyRuleForm, form, form.querySelector('[type="submit"]'));
  });

  workerList.addEventListener('change', (event) => {
    const form = event.target.closest('[data-schedule-form]');
    if (!form || event.target.name !== 'schedule_kind') return;
    const isDayOff = event.target.value === 'off';
    for (const input of form.querySelectorAll('[name="start_time"], [name="end_time"]')) {
      input.required = !isDayOff;
      input.disabled = isDayOff;
      if (isDayOff) input.value = '';
    }
    const submit = form.querySelector('[type="submit"]');
    submit.textContent = isDayOff ? 'Save day off' : 'Save shift change';
  });

  const { data, error } = await supabase.auth.getSession();
  if (error) showNotice(`Could not restore sign-in: ${error.message}`, 'error');
  await renderSession(data?.session?.user || null);
  supabase.auth.onAuthStateChange((_event, session) => {
    if (session?.user?.id !== activeUser?.id) void renderSession(session?.user || null);
  });
}

void start();

import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { Capacitor } from '@capacitor/core';
import { createClient } from '@supabase/supabase-js';

export const SHIFT_AUTH_REDIRECT = import.meta.env.VITE_SHIFT_AUTH_REDIRECT?.trim()
  || 'dkasu-shift://auth/callback';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim();
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();

let shiftDeviceId = '';
export function setShiftDeviceId(deviceId) {
  shiftDeviceId = String(deviceId || '').trim();
}

const baseFetch = globalThis.fetch.bind(globalThis);
async function shiftFetch(input, init = {}) {
  const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
  if (shiftDeviceId) headers.set('x-dkasu-device-id', shiftDeviceId);
  return baseFetch(input, { ...init, headers });
}

export const shiftSupabase = supabaseUrl && supabaseAnonKey
  ? createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        flowType: 'pkce'
      },
      global: { fetch: shiftFetch }
    })
  : null;

export const shiftAuthConfigured = Boolean(shiftSupabase);

function authError(error) {
  return error?.message || String(error);
}

async function finishOAuthCallback(url) {
  const callback = new URL(url);
  if (callback.protocol !== 'dkasu-shift:' || callback.hostname !== 'auth' || callback.pathname !== '/callback') {
    return false;
  }
  const oauthError = callback.searchParams.get('error_description') || callback.searchParams.get('error');
  if (oauthError) throw new Error(oauthError);
  const code = callback.searchParams.get('code');
  if (!code) throw new Error('Google sign-in returned without an authorization code.');
  const { error } = await shiftSupabase.auth.exchangeCodeForSession(code);
  if (error) throw new Error(authError(error));
  try {
    await Browser.close();
  } catch {
    // The browser may already have closed after handing the callback to Android.
  }
  return true;
}

async function finishWebOAuthCallback() {
  const callback = new URL(window.location.href);
  const oauthError = callback.searchParams.get('error_description') || callback.searchParams.get('error');
  const code = callback.searchParams.get('code');
  if (!oauthError && !code) return false;
  if (oauthError) throw new Error(oauthError);
  const { error } = await shiftSupabase.auth.exchangeCodeForSession(code);
  if (error) throw new Error(authError(error));
  callback.searchParams.delete('code');
  callback.searchParams.delete('error');
  callback.searchParams.delete('error_description');
  callback.searchParams.delete('error_code');
  window.history.replaceState(window.history.state, document.title, `${callback.pathname}${callback.search}${callback.hash}`);
  return true;
}

export async function initializeShiftAuth({ onCallbackError = () => {}, onCallbackSuccess = () => {} } = {}) {
  if (!shiftSupabase) return { configured: false, dispose: () => {} };
  if (!Capacitor.isNativePlatform()) {
    try {
      if (await finishWebOAuthCallback()) onCallbackSuccess();
    } catch (error) {
      onCallbackError(error);
    }
    return { configured: true, dispose: () => {} };
  }
  const listener = await App.addListener('appUrlOpen', ({ url }) => {
    void finishOAuthCallback(url).then((handled) => {
      if (handled) onCallbackSuccess();
    }).catch(onCallbackError);
  });
  try {
    const launch = await App.getLaunchUrl();
    if (launch?.url) {
      const handled = await finishOAuthCallback(launch.url);
      if (handled) onCallbackSuccess();
    }
  } catch (error) {
    onCallbackError(error);
  }
  return {
    configured: true,
    dispose: () => listener.remove()
  };
}

export async function signInWithGoogle() {
  if (!shiftSupabase) throw new Error('Shift sign-in is not configured on this build.');
  const redirectTo = Capacitor.isNativePlatform()
    ? SHIFT_AUTH_REDIRECT
    : `${window.location.origin}/`;
  const { data, error } = await shiftSupabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo,
      skipBrowserRedirect: true,
      queryParams: { prompt: 'select_account' }
    }
  });
  if (error) throw new Error(authError(error));
  if (!data?.url) throw new Error('Supabase did not return a Google sign-in URL.');
  if (Capacitor.isNativePlatform()) {
    await Browser.open({ url: data.url, presentationStyle: 'popover' });
  } else {
    window.location.assign(data.url);
  }
}

export async function getShiftSession() {
  if (!shiftSupabase) return null;
  const { data, error } = await shiftSupabase.auth.getSession();
  if (error) throw new Error(authError(error));
  return data.session || null;
}

export async function isShiftAdminUser(userId) {
  if (!shiftSupabase) throw new Error('Shift sign-in is not configured on this build.');
  if (!userId) return false;
  const { data, error } = await shiftSupabase
    .from('shift_admins')
    .select('user_id')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error(authError(error));
  return Boolean(data);
}

export async function claimSwiperActivation(code) {
  if (!shiftSupabase) throw new Error('Shift sign-in is not configured on this build.');
  const normalizedCode = String(code || '').trim();
  if (!normalizedCode) throw new Error('Enter the activation code from your DKASU admin.');
  const session = await getShiftSession();
  if (!session) throw new Error('Sign in with Google before entering an activation code.');
  const { data, error } = await shiftSupabase.rpc('shift_claim_swiper_activation', { p_token: normalizedCode });
  if (error) throw new Error(authError(error));
  if (!data?.ok || !data.swiper_id) {
    throw new Error('That activation code is invalid, expired, already used, or belongs to another email. Ask your DKASU admin for a new swiper code.');
  }
  return data.swiper_id;
}

export async function claimSwiperPinReset(code) {
  if (!shiftSupabase) throw new Error('Shift sign-in is not configured on this build.');
  const normalizedCode = String(code || '').trim();
  if (!normalizedCode) throw new Error('Enter the one-time reset code from your DKASU admin.');
  const session = await getShiftSession();
  if (!session) throw new Error('Sign in with the Google account registered to your swiper profile, then enter the reset code.');
  const { data, error } = await shiftSupabase.rpc('shift_claim_swiper_pin_reset', { p_token: normalizedCode });
  if (error) throw new Error(authError(error));
  if (!data?.ok || !data.swiper_id) {
    throw new Error('That reset code is invalid, expired, already used, or belongs to another Google account. Ask your DKASU admin for a new code.');
  }
  return data.swiper_id;
}

export async function loadShiftSwiperData() {
  if (!shiftSupabase) throw new Error('Shift sign-in is not configured on this build.');
  const session = await getShiftSession();
  if (!session) return null;
  const { data: swiper, error: swiperError } = await shiftSupabase
    .from('shift_swipers')
    .select('id,name,email,is_active,device_assignment_enabled')
    .eq('auth_user_id', session.user.id)
    .maybeSingle();
  if (swiperError) throw new Error(authError(swiperError));
  if (!swiper) return null;
  if (!shiftDeviceId) throw new Error('This installation has no registered device identity. Sign out and back in, then try again.');
  const { error: deviceError } = await shiftSupabase.rpc('shift_register_device', {
    p_device_id: shiftDeviceId,
    p_device_name: Capacitor.isNativePlatform() ? 'DKASU Shift Android' : 'DKASU Shift browser',
    p_platform: Capacitor.getPlatform()
  });
  if (deviceError) throw new Error(authError(deviceError));
  const { data: device, error: currentDeviceError } = await shiftSupabase
    .from('shift_swiper_devices')
    .select('id,device_name,is_active')
    .eq('id', shiftDeviceId)
    .maybeSingle();
  if (currentDeviceError) throw new Error(authError(currentDeviceError));
  if (!device?.is_active) throw new Error('This device has been disabled by the DKASU admin.');
  const { data: assignments, error: assignmentError } = await shiftSupabase
    .from('shift_swiper_assignments')
    .select('worker_id,shift_workers!inner(id,name,email,ogram_profile_id,swipe_id,job_title,company_name,location,address,contract_start,contract_end,display_timezone,schedule_timezone,is_active)')
    .eq('swiper_id', swiper.id);
  if (assignmentError) throw new Error(authError(assignmentError));
  const workers = (assignments || []).map((assignment) => assignment.shift_workers).filter((worker) => worker?.is_active);
  const workerIds = workers.map((worker) => worker.id);
  if (!workerIds.length) return { session, swiper, device, accounts: [] };
  const [scheduleResult, ruleResult] = await Promise.all([
    shiftSupabase.from('shift_schedules')
      .select('id,worker_id,shift_date,start_time,end_time,schedule_kind,schedule_timezone,revision,updated_at')
      .in('worker_id', workerIds)
      .order('shift_date'),
    shiftSupabase.from('shift_daily_rules')
      .select('id,worker_id,effective_from,effective_until,start_time,end_time,schedule_timezone,revision,updated_at')
      .in('worker_id', workerIds)
  ]);
  if (scheduleResult.error) throw new Error(authError(scheduleResult.error));
  if (ruleResult.error) throw new Error(authError(ruleResult.error));
  const accounts = workers.map((worker) => ({
    worker,
    schedules: (scheduleResult.data || []).filter((row) => row.worker_id === worker.id),
    dailyRule: (ruleResult.data || []).find((row) => row.worker_id === worker.id) || null
  }));
  return { session, swiper, device, accounts };
}

export async function syncSwiperConfirmations(store, profileId, workerId) {
  if (!shiftSupabase) throw new Error('Shift sync is not configured on this build.');
  const session = await getShiftSession();
  if (!session) throw new Error('Sign in again before syncing self-confirmations.');
  const allPending = store.getPendingConfirmations(profileId);
  const pending = allPending.filter((confirmation) => confirmation.syncActorId === session.user.id);
  let synced = 0;
  for (const confirmation of pending) {
    const { error } = await shiftSupabase.from('shift_confirmations').insert({
      client_event_id: confirmation.clientEventId,
      worker_id: workerId,
      shift_date: confirmation.shiftDate,
      submitted_at: confirmation.confirmedAt,
      reported_timezone: confirmation.timezone,
      reported_address: confirmation.address || null,
      record_kind: 'swiper_self_confirmation'
    });
    if (error && error.code !== '23505') break;
    await store.markConfirmationSynced(profileId, confirmation.clientEventId);
    synced += 1;
  }
  return {
    synced,
    remaining: store.getPendingConfirmations(profileId).length,
    held: allPending.filter((confirmation) => confirmation.syncActorId !== session.user.id).length
  };
}

export async function signOutShiftWorker() {
  if (!shiftSupabase) return;
  const { error } = await shiftSupabase.auth.signOut();
  if (error) throw new Error(authError(error));
}

export function onShiftAuthStateChange(callback) {
  if (!shiftSupabase) return { unsubscribe: () => {} };
  const { data } = shiftSupabase.auth.onAuthStateChange(callback);
  return data.subscription;
}

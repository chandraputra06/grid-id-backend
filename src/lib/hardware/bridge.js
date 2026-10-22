// Bridge Firebase Realtime Database -> Supabase.
//
// Struktur RTDB yang dibaca (ditulis oleh hardware):
//   /telemetry/<device_code>/<pushId>  = payload telemetri (format contoh)
//   /frames/<device_code>/<pushId>     = metadata gambar { frame_id, device_id, timestamp, frame_type,
//                                         image_path, capture_mode, upload_status }
// Struktur yang DITULIS backend (dibaca firmware):
//   /device_config/<device_code>       = { snapshot_interval_s, updated_at }
//
// Hanya perangkat yang TERDAFTAR di tabel devices (device_code) yang didengarkan.
// Posisi baca terakhir disimpan di devices.fb_cursor_* sehingga restart tidak memproses ulang semuanya,
// dan penyimpanan bersifat idempoten (firebase_key / frame_id unik).
const env = require('../../config/env');
const firebase = require('../../config/firebase');
const supabase = require('../../config/supabase');
const ingest = require('./ingest');

const state = {
  enabled: false,
  reason: null,
  started_at: null,
  rtdb_connected: null, // null = belum diketahui
  devices_attached: 0,
  last_telemetry_event_at: null,
  last_frame_event_at: null,
  last_error: null,
  counters: { telemetry: 0, frames: 0, duplicates: 0, rejected: 0 },
};

const attached = new Map(); // device_id -> { code, refs: [{ref, handlers}], chain }
const timers = [];

function recordError(where, e) {
  state.last_error = { where, message: (e && e.message) || String(e), at: new Date().toISOString() };
  console.error(`[hw-bridge] ${where}:`, state.last_error.message);
}

function serial(entry, fn) {
  entry.chain = entry.chain.then(fn).catch((e) => recordError('proses event', e));
  return entry.chain;
}

async function freshDevice(id) {
  const { data } = await supabase.from('devices').select('*').eq('id', id).maybeSingle();
  return data;
}

function attachDevice(db, device) {
  const entry = { code: device.device_code, refs: [], chain: Promise.resolve(), device };

  // --- Telemetri ---
  let tq = db.ref(`${env.HW_RTDB_TELEMETRY_ROOT}/${device.device_code}`).orderByKey();
  const tCursor = device.fb_cursor_telemetry;
  if (tCursor) tq = tq.startAt(tCursor);
  const onTelemetry = (snap) => serial(entry, async () => {
    if (tCursor && snap.key === tCursor) return; // sudah diproses sebelum restart
    state.last_telemetry_event_at = new Date().toISOString();
    const dev = (await freshDevice(device.id)) || entry.device;
    entry.device = dev;
    const res = await ingest.ingestTelemetry(dev, snap.val(), { firebaseKey: `${dev.device_code}/${snap.key}` });
    if (res.duplicate) state.counters.duplicates += 1;
    else state.counters.telemetry += 1;
    await supabase.from('devices').update({ fb_cursor_telemetry: snap.key }).eq('id', dev.id);
  });
  tq.on('child_added', onTelemetry, (e) => recordError(`listener telemetri ${device.device_code}`, e));
  entry.refs.push({ ref: tq, events: [['child_added', onTelemetry]] });

  // --- Frames ---
  let fq = db.ref(`${env.HW_RTDB_FRAMES_ROOT}/${device.device_code}`).orderByKey();
  const fCursor = device.fb_cursor_frames;
  if (fCursor) fq = fq.startAt(fCursor);
  const onFrame = (isChange) => (snap) => serial(entry, async () => {
    if (!isChange && fCursor && snap.key === fCursor) return;
    state.last_frame_event_at = new Date().toISOString();
    const dev = (await freshDevice(device.id)) || entry.device;
    entry.device = dev;
    const res = await ingest.ingestFrame(dev, snap.val());
    if (res.stored) state.counters.frames += 1;
    else state.counters.rejected += 1;
    if (!isChange) await supabase.from('devices').update({ fb_cursor_frames: snap.key }).eq('id', dev.id);
  });
  const added = onFrame(false);
  const changed = onFrame(true);
  fq.on('child_added', added, (e) => recordError(`listener frame ${device.device_code}`, e));
  fq.on('child_changed', changed, (e) => recordError(`listener frame ${device.device_code}`, e));
  entry.refs.push({ ref: fq, events: [['child_added', added], ['child_changed', changed]] });

  attached.set(device.id, entry);
}

function detachDevice(id) {
  const entry = attached.get(id);
  if (!entry) return;
  for (const r of entry.refs) for (const [ev, fn] of r.events) r.ref.off(ev, fn);
  attached.delete(id);
}

async function syncDevices(db, { reattachAll = false } = {}) {
  const { data, error } = await supabase.from('devices').select('*').limit(1000);
  if (error) return recordError('memuat daftar perangkat', error);
  const ids = new Set((data || []).map((d) => d.id));
  for (const id of [...attached.keys()]) if (!ids.has(id) || reattachAll) detachDevice(id);
  for (const d of data || []) if (d.device_code && !attached.has(d.id)) attachDevice(db, d);
  state.devices_attached = attached.size;
  return null;
}

function start() {
  const fb = firebase.init();
  if (!env.HW_BRIDGE_ENABLED) {
    state.reason = 'HW_BRIDGE_ENABLED=false';
    return state;
  }
  if (!fb.db) {
    state.reason = fb.error || 'Firebase Realtime Database belum dikonfigurasi';
    return state;
  }
  state.enabled = true;
  state.started_at = new Date().toISOString();

  fb.db.ref('.info/connected').on('value', (s) => {
    state.rtdb_connected = !!s.val();
  });

  syncDevices(fb.db).then(() => ingest.requeuePending()).catch((e) => recordError('start', e));
  // Perangkat baru terdaftar -> mulai didengarkan dalam <= 60 dtk.
  timers.push(setInterval(() => syncDevices(fb.db).catch((e) => recordError('sync', e)), 60 * 1000));
  // Pasang ulang listener tiap 30 menit agar cache query tidak terus membesar.
  timers.push(setInterval(() => syncDevices(fb.db, { reattachAll: true }).catch((e) => recordError('reattach', e)), 30 * 60 * 1000));
  // Sapuan offline / telemetri terlambat.
  timers.push(setInterval(() => ingest.sweepConnectivity().catch((e) => recordError('sweep', e)), 60 * 1000));
  console.log('[hw-bridge] aktif — mendengarkan Firebase RTDB');
  return state;
}

function stop() {
  for (const id of [...attached.keys()]) detachDevice(id);
  while (timers.length) clearInterval(timers.pop());
  state.enabled = false;
}

// Tulis konfigurasi perangkat ke RTDB (dibaca firmware). Return { ok, error }.
async function writeDeviceConfig(deviceCode, patch) {
  const fb = firebase.init();
  if (!fb.db) return { ok: false, error: fb.error || 'Firebase Realtime Database belum dikonfigurasi' };
  try {
    await fb.db.ref(`${env.HW_RTDB_CONFIG_ROOT}/${deviceCode}`).update({ ...patch, updated_at: new Date().toISOString() });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function status() {
  return { ...state, counters: { ...state.counters } };
}

module.exports = { start, stop, status, writeDeviceConfig };

// src/lib/hardware/sistemIotAdapter.js
// Adapter untuk Firebase RTDB tim hardware (project InspeksiPanelAI, node "Sistem_IoT").
// Model data: SATU perangkat, current-state (ditimpa di tempat), foto insiden via ImgBB,
// frame live base64. Ini BEDA dengan bridge.js (yang mengharapkan /telemetry/<id>/<pushId>
// + Firebase Storage), jadi dipakai adapter khusus berbasis POLLING REST.
//
// Tidak butuh firebase-admin / service account bila Rules RTDB mengizinkan baca.
// Memetakan Sistem_IoT -> format telemetri internal lalu memakai ingest.js:
//   -> penyimpanan device_telemetry, evaluasi alert, dan email Alur A otomatis.
// Foto insiden ImgBB -> aiClient.detect -> device_detections + alert AI (email).
//
// ENV:
//   GRID_HW_RTDB_URL      (wajib) https://inspeksipanelai-default-rtdb.asia-southeast1.firebasedatabase.app
//   GRID_HW_RTDB_AUTH     (opsional) token/secret bila Rules butuh auth; kosong = rules read publik
//   GRID_HW_RTDB_ROOT     (default "Sistem_IoT")
//   GRID_HW_DEVICE_CODE   (default "PANEL-01")
//   GRID_HW_DEVICE_NAME   (default "Panel Inspeksi 01")
//   GRID_HW_POLL_MS       (default 10000)

const supabase = require('../../config/supabase');
const aiClient = require('../aiClient');
const ingest = require('./ingest');
const rules = require('./rules');

const RTDB_URL = (process.env.GRID_HW_RTDB_URL || '').replace(/\/+$/, '');
const AUTH = process.env.GRID_HW_RTDB_AUTH || '';
const ROOT = process.env.GRID_HW_RTDB_ROOT || 'Sistem_IoT';
const DEVICE_CODE = process.env.GRID_HW_DEVICE_CODE || 'PANEL-01';
const DEVICE_NAME = process.env.GRID_HW_DEVICE_NAME || 'Panel Inspeksi 01';
const POLL_MS = Math.max(3000, Number(process.env.GRID_HW_POLL_MS || 10000));

const state = {
  enabled: false,
  reason: null,
  started_at: null,
  last_poll_at: null,
  last_error: null,
  last_tick: null,
  last_photo_url: null,
  counters: { telemetry: 0, duplicates: 0, frames: 0, detections: 0, errors: 0 },
};
let timer = null;

function recordError(where, e) {
  state.last_error = { where, message: (e && e.message) || String(e), at: new Date().toISOString() };
  state.counters.errors += 1;
  console.error(`[hw-adapter] ${where}:`, state.last_error.message);
}

function nodeUrl(path) {
  const u = `${RTDB_URL}/${path}.json`;
  return AUTH ? `${u}?auth=${encodeURIComponent(AUTH)}` : u;
}

async function fetchNode(path) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch(nodeUrl(path), { signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status} saat baca ${path}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

async function fetchImage(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status} saat unduh foto`);
    return Buffer.from(await r.arrayBuffer());
  } finally {
    clearTimeout(t);
  }
}

// Pastikan 1 baris device ada (buat bila belum).
async function ensureDevice() {
  const { data } = await supabase.from('devices').select('*').eq('device_code', DEVICE_CODE).maybeSingle();
  if (data) return data;
  const { data: created, error } = await supabase
    .from('devices')
    .insert({ device_code: DEVICE_CODE, name: DEVICE_NAME, type: 'multisensor', status: 'online' })
    .select('*')
    .single();
  if (error) {
    recordError('buat device', error);
    return null;
  }
  return created;
}

const n = (v) => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (v != null && v !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
};

// Petakan Sistem_IoT -> payload format internal (lihat normalize.js).
// Catatan: sensor_suara & kekuatan_sinyal adalah nilai MENTAH (bukan dB/dBm terkalibrasi),
// jadi SENGAJA tidak dipetakan ke sound_level_db/rssi_dbm agar lolos validasi rentang fisik.
function toPayload(sistem) {
  const T = (sistem && sistem.Telemetri) || {};
  const telemetry = {
    thermal: { max_temp_c: n(T.termal_suhu_max) },
    environment: { ambient_temp_c: n(T.sensor_dht22_suhu), humidity_pct: n(T.sensor_dht22_kelembapan) },
    gas: { raw_value: n(T.sensor_mq135_gas) },
    distance: { distance_cm: n(T.sensor_tfluna_jarak_cm) },
    device_status: { alarm_state: String(T.termal_status || '').toUpperCase() === 'OVERHEAT' },
    pan_tilt: { pan_deg: n(T.gimbal_aktual_pan_x), tilt_deg: n(T.gimbal_aktual_tilt_y) },
  };
  const lat = n(T.gps_latitude);
  const lng = n(T.gps_longitude);
  if (lat != null && lng != null && !(lat === 0 && lng === 0)) telemetry.gps = { lat, lng };
  const tick = n(T.z_sistem_uptime_tick);
  return { payload: { device_id: DEVICE_CODE, timestamp: Date.now(), telemetry, simulated: false }, tick };
}

// Jalankan AI pada foto insiden ImgBB (HD) lalu simpan deteksi + alert.
async function handlePhoto(sistem, device) {
  const K = (sistem && sistem.Kejadian) || {};
  const url = K.foto_terakhir_url;
  if (!url || typeof url !== 'string' || !/^https?:\/\//.test(url)) return;
  if (url === state.last_photo_url) return; // foto belum berubah
  state.last_photo_url = url;

  let buf;
  try {
    buf = await fetchImage(url);
  } catch (e) {
    return recordError('unduh foto ImgBB', e);
  }

  const result = await aiClient.detect(buf, url.split('/').pop() || 'inspeksi.jpg');
  const at = new Date().toISOString();
  const frameId = `${device.device_code}-${Date.now()}`;
  const dets = result.ok && Array.isArray(result.detections) ? result.detections : [];

  const { error: fErr } = await supabase.from('device_frames').insert({
    frame_id: frameId,
    device_id: device.id,
    device_code: device.device_code,
    frame_type: 'rgb',
    image_path: url, // URL publik ImgBB (bukan Firebase Storage)
    capture_mode: 'event',
    upload_status: 'uploaded',
    inference_status: result.ok ? 'done' : 'failed',
    inference_at: at,
    inference_error: result.ok ? null : result.error || result.status || 'ai_error',
    model_version: result.model_version || null,
    inference_ms: typeof result.inference_ms === 'number' ? result.inference_ms : null,
    source: 'firebase',
    raw: K,
  });
  if (fErr) return recordError('simpan frame', fErr);
  state.counters.frames += 1;

  if (!dets.length) return;
  const { error: dErr } = await supabase.from('device_detections').insert(
    dets.map((d) => ({
      frame_id: frameId,
      device_id: device.id,
      defect: d.defect || null,
      category: d.category || null,
      confidence: typeof d.confidence === 'number' ? d.confidence : null,
      severity: typeof d.severity === 'number' ? d.severity : null,
      bbox: d.bbox || null,
      model_version: d.model_version || result.model_version || null,
      inference_ms: typeof result.inference_ms === 'number' ? result.inference_ms : null,
    }))
  );
  if (dErr) return recordError('simpan deteksi', dErr);
  state.counters.detections += dets.length;

  // Satu alert per jenis kerusakan (confidence tertinggi) -> reuse rules + ingest.upsertAlert (email Alur A).
  try {
    const cfg = await ingest.configFor(device);
    const best = new Map();
    for (const d of dets) {
      const k = d.defect || 'unknown';
      if (!best.has(k) || Number(d.confidence) > Number(best.get(k).confidence)) best.set(k, d);
    }
    for (const d of best.values()) {
      const cand = rules.aiDetectionAlert(d, cfg);
      if (cand) await ingest.upsertAlert(device, cand, { frame_id: frameId, source: 'firebase' });
    }
  } catch (e) {
    recordError('alert AI', e);
  }
}

async function poll() {
  try {
    const sistem = await fetchNode(ROOT);
    state.last_poll_at = new Date().toISOString();
    if (!sistem || typeof sistem !== 'object') return;

    const device = await ensureDevice();
    if (!device) return; // gagal buat/temukan device -> coba lagi poll berikutnya

    // --- Telemetri (simpan hanya saat ada data baru, pakai uptime tick sebagai penanda) ---
    const { payload, tick } = toPayload(sistem);
    const dup = tick != null && tick === state.last_tick;
    if (!dup) {
      state.last_tick = tick;
      const key = tick != null ? `${device.device_code}/t${tick}` : `${device.device_code}/${Date.now()}`;
      const res = await ingest.ingestTelemetry(device, payload, { firebaseKey: key, source: 'firebase' });
      if (res && res.duplicate) state.counters.duplicates += 1;
      else if (res && res.stored) state.counters.telemetry += 1;
    }

    // --- Foto insiden -> AI ---
    await handlePhoto(sistem, device);
  } catch (e) {
    recordError('poll', e);
  }
}

function start() {
  if (!RTDB_URL) {
    state.reason = 'GRID_HW_RTDB_URL belum diset';
    console.log('[hw-adapter] tidak aktif:', state.reason);
    return state;
  }
  if (timer) return state;
  state.enabled = true;
  state.started_at = new Date().toISOString();
  poll();
  timer = setInterval(() => poll(), POLL_MS);
  console.log(`[hw-adapter] aktif — polling ${ROOT} tiap ${POLL_MS}ms (device ${DEVICE_CODE})`);
  return state;
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  state.enabled = false;
}

function status() {
  return { ...state, counters: { ...state.counters } };
}

module.exports = { start, stop, status };
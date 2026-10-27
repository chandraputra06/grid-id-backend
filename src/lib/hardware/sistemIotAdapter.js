// src/lib/hardware/sistemIotAdapter.js
// Adapter untuk Firebase RTDB tim hardware (project InspeksiPanelAI, node "Sistem_IoT").
// Model data: SATU perangkat, current-state (ditimpa di tempat). Skema terbaru punya 4 sub-node:
//   Sistem_IoT/node_panel_esp32    -> dht22, mic_inmp441, thermal_mlx90640
//   Sistem_IoT/node_ruang_esp32s3  -> lidar tfluna, mq135, suara 3pin, gps, kesimpulan AI ruangan
//   Sistem_IoT/info_sistem_dan_ip  -> uptime, rssi, ip, waktu sinkronisasi, url stream
//   Sistem_IoT/kontrol_dan_visual  -> kamera (url_foto_terbaru untuk YOLO) + servo_gimbal (pan/tilt)
// BEDA dengan bridge.js (yang mengharapkan /telemetry/<id>/<pushId> + Firebase Storage),
// jadi dipakai adapter khusus berbasis POLLING REST.
//
// Tidak butuh firebase-admin / service account bila Rules RTDB mengizinkan baca.
// Memetakan Sistem_IoT -> format telemetri internal (sama seperti sebelumnya, lihat normalize.js)
// lalu memakai ingest.js: penyimpanan device_telemetry, evaluasi alert, email Alur A otomatis.
// Foto insiden (url_foto_terbaru) -> aiClient.detect -> device_frames + device_detections + alert AI.
//
// Catatan skema:
// - GPS: koordinat DIABAIKAN sampai ada fix betulan (jumlah_satelit > 0 & status bukan "MENCARI_SINYAL").
// - Gas mq135 dipetakan sebagai nilai MENTAH (0-4095) ke gas.raw_value; ppm_estimasi disimpan di meta.
// - Suara & RSSI disimpan di meta (bukan field telemetri terkalibrasi) agar lolos validasi rentang fisik.
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
const obj = (v) => (v && typeof v === 'object' ? v : {});
const maxOf = (arr) => {
  const nums = arr.map(n).filter((x) => x != null);
  return nums.length ? Math.max(...nums) : null;
};

// Petakan Sistem_IoT (skema 4 sub-node) -> payload format internal (lihat normalize.js).
// Bentuk output telemetry SENGAJA dijaga sama dengan versi lama agar kompatibel dengan ingest/normalize.
function toPayload(sistem) {
  const panel = obj(sistem.node_panel_esp32);
  const ruang = obj(sistem.node_ruang_esp32s3);
  const info = obj(sistem.info_sistem_dan_ip);
  const kv = obj(sistem.kontrol_dan_visual);

  const dht = obj(panel.dht22);
  const mic = obj(panel.mic_inmp441);
  const th = obj(panel.thermal_mlx90640);
  const servo = obj(kv.servo_gimbal);
  const mq = obj(ruang.detail_mq135);
  const lidar = obj(ruang.detail_lidar_tfluna);
  const suara = obj(ruang.detail_suara_3pin);
  const gps = obj(ruang.gps_lokasi);
  const aiRoom = obj(ruang.kesimpulan_ai_ruangan);

  // Suhu termal tertinggi dari 3 titik panas (fallback ke suhu_center).
  const maxTemp = maxOf([th.suhu_max_1, th.suhu_max_2, th.suhu_max_3]) ?? n(th.suhu_center);
  const termalStatus = String(th.status_termal || '').toUpperCase();

  // Jarak lidar: pakai field datar, fallback ke detail.
  const distance = n(ruang.lidar_tfluna_jarak_cm) ?? n(lidar.jarak_cm);

  const telemetry = {
    thermal: { max_temp_c: maxTemp },
    environment: { ambient_temp_c: n(dht.suhu_panel), humidity_pct: n(dht.kelembapan_panel) },
    gas: { raw_value: n(ruang.mq135_gas_asap) },
    distance: { distance_cm: distance },
    device_status: { alarm_state: /OVERHEAT|PANAS|BAHAYA|KRITIS|ALARM|DANGER/.test(termalStatus) },
    pan_tilt: { pan_deg: n(servo.sudut_pan_aktual), tilt_deg: n(servo.sudut_tilt_aktual) },
  };

  // GPS hanya dipakai bila benar-benar fix (hindari koordinat dummy saat "MENCARI_SINYAL").
  const lat = n(gps.latitude);
  const lng = n(gps.longitude);
  const sats = n(gps.jumlah_satelit) || 0;
  const gpsStatus = String(gps.status_gps || '').toUpperCase();
  const gpsFixed =
    lat != null && lng != null && !(lat === 0 && lng === 0) && sats > 0 && !/MENCARI|NO_?FIX|SEARCH|TIDAK/.test(gpsStatus);
  if (gpsFixed) telemetry.gps = { lat, lng };

  // Data tambahan untuk dashboard (disimpan utuh di kolom raw device_telemetry; diabaikan normalize).
  const meta = {
    rssi_dbm: n(info.wifi_rssi_dbm),
    uptime_s: n(info.uptime_detik),
    device_time: info.waktu_sinkronisasi || null,
    cam_ip: info.ip_esp32s3_cam || null,
    stream_url: kv.kamera && kv.kamera.url_stream_mjpeg_lokal ? kv.kamera.url_stream_mjpeg_lokal : info.url_stream_mjpeg_lokal || null,
    thermal_status: th.status_termal || null,
    thermal_center_c: n(th.suhu_center),
    thermal_min_c: n(th.suhu_min),
    gas_ppm: n(mq.ppm_estimasi),
    gas_status: mq.status_udara || null,
    sound_db_panel: n(mic.desibel_estimasi),
    sound_status_panel: mic.status_suara_panel || null,
    sound_db_room: n(suara.desibel_estimasi),
    sound_status_room: suara.status_kebisingan || null,
    lidar_status: lidar.status_objek || null,
    gps_status: gps.status_gps || null,
    gps_satellites: sats,
    ai_room_score: n(aiRoom.skor_keamanan_persen),
    ai_room_status: aiRoom.status_keseluruhan || null,
    ai_room_message: aiRoom.pesan_analisis_ai || null,
    gimbal_mode: servo.mode || null,
  };

  const tick = n(info.uptime_detik); // uptime monoton -> penanda data berubah (reset saat reboot)
  return { payload: { device_id: DEVICE_CODE, timestamp: Date.now(), telemetry, meta, simulated: false }, tick };
}

// Jalankan AI pada foto terbaru (url_foto_terbaru) lalu simpan deteksi + alert.
async function handlePhoto(sistem, device) {
  const kamera = obj(obj(sistem.kontrol_dan_visual).kamera);
  const url = kamera.url_foto_terbaru;
  if (!url || typeof url !== 'string' || !/^https?:\/\//.test(url)) return;
  if (url === state.last_photo_url) return; // foto belum berubah
  state.last_photo_url = url;

  let buf;
  try {
    buf = await fetchImage(url);
  } catch (e) {
    return recordError('unduh foto', e);
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
    image_path: url, // URL publik (ImgBB), bukan Firebase Storage
    capture_mode: 'event',
    captured_at: at, // wajib (NOT NULL); pakai waktu proses karena waktu firmware non-ISO
    upload_status: 'uploaded',
    inference_status: result.ok ? 'done' : 'failed',
    inference_at: at,
    inference_error: result.ok ? null : result.error || result.status || 'ai_error',
    model_version: result.model_version || null,
    inference_ms: typeof result.inference_ms === 'number' ? result.inference_ms : null,
    source: 'firebase',
    raw: kamera, // menyimpan alasan_foto_terakhir, waktu_foto_terakhir, dll.
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
    // Seluruh node Sistem_IoT kecil (tidak ada base64), aman diambil sekali jalan.
    const sistem = await fetchNode(ROOT);
    state.last_poll_at = new Date().toISOString();
    if (!sistem || typeof sistem !== 'object') return;

    const device = await ensureDevice();
    if (!device) return; // gagal buat/temukan device -> coba lagi poll berikutnya

    // --- Telemetri (simpan hanya saat ada data baru, pakai uptime sebagai penanda) ---
    const { payload, tick } = toPayload(sistem);
    const dup = tick != null && tick === state.last_tick;
    if (!dup) {
      state.last_tick = tick;
      const key = tick != null ? `${device.device_code}/t${tick}` : `${device.device_code}/${Date.now()}`;
      const res = await ingest.ingestTelemetry(device, payload, { firebaseKey: key, source: 'firebase' });
      if (res && res.duplicate) state.counters.duplicates += 1;
      else if (res && res.stored) state.counters.telemetry += 1;
    }

    // --- Foto terbaru -> AI ---
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
  console.log(`[hw-adapter] aktif - polling ${ROOT} tiap ${POLL_MS}ms (device ${DEVICE_CODE})`);
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
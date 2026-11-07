// src/lib/hardware/sistemIotAdapter.js
// Adapter Firebase RTDB tim hardware - skema "grid_id" (firmware Node 1 ESP32-S3 + Node 3 ESP32).
//
// Struktur RTDB (root = grid_id), ditulis firmware:
//   grid_id/node1_s3cam     -> lidar_cm/amp/kd, sound3pin_db/raw/peak, sound_status, gps,
//                              servo_state{current_pan,current_tilt,active_mode,...},
//                              hazard_status{hazard_level,hazard_label,is_danger,raw_temp_c,compensated_temp_c},
//                              camera{latest_imgbb_url, last_capture_time, boot_capture, manual_capture, auto_capture}
//   grid_id/node2_thermal   -> max_temp_raw, min_temp_raw, center_temp_raw (ditulis Node 2 Thermal)
//   grid_id/node3_esp8266   -> dht_temp, dht_hum, mq135_ppm, mq135_raw, mic6pin_db, mic6pin_peak
//   grid_id/control         -> mode, preset, ... (perintah; TIDAK dipetakan ke telemetri)
//   grid_id/network         -> info IP + latest_imgbb_url (duplikat; tidak dipakai di sini)
//
// PENTING: foto ADA di node1_s3cam/camera/latest_imgbb_url (bukan latest_snapshot - node itu tidak ada).
// Adapter polling REST per-node, memetakan ke format internal (normalize.js) lalu ingest.js.
// Foto terbaru -> re-host ke Supabase -> YOLO -> device_frames/detections + alert.
//
// ENV:
//   GRID_HW_RTDB_URL      (wajib)
//   GRID_HW_RTDB_AUTH     (opsional)
//   GRID_HW_RTDB_ROOT     (default "grid_id")
//   GRID_HW_DEVICE_CODE   (default "PANEL-01")
//   GRID_HW_DEVICE_NAME   (default "Panel Inspeksi 01")
//   GRID_HW_POLL_MS       (default 10000)
//   GRID_HW_STORAGE_BUCKET(default "report-photos")

const crypto = require('crypto');
const supabase = require('../../config/supabase');
const aiClient = require('../aiClient');
const ingest = require('./ingest');
const rules = require('./rules');

const RTDB_URL = (process.env.GRID_HW_RTDB_URL || '').replace(/\/+$/, '');
const AUTH = process.env.GRID_HW_RTDB_AUTH || '';
const ROOT = process.env.GRID_HW_RTDB_ROOT || 'grid_id';
const DEVICE_CODE = process.env.GRID_HW_DEVICE_CODE || 'PANEL-01';
const DEVICE_NAME = process.env.GRID_HW_DEVICE_NAME || 'Panel Inspeksi 01';
const POLL_MS = Math.max(3000, Number(process.env.GRID_HW_POLL_MS || 10000));
const STORAGE_BUCKET = process.env.GRID_HW_STORAGE_BUCKET || 'report-photos';

const HAZARD_LABEL = { 0: 'Normal', 1: 'Kritis', 2: 'Bahaya Sedang', 3: 'Peringatan Dini' };

const state = {
  enabled: false,
  reason: null,
  started_at: null,
  last_poll_at: null,
  last_error: null,
  last_sig: null,
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
const firstNum = (...vals) => {
  for (const v of vals) {
    const x = n(v);
    if (x != null) return x;
  }
  return null;
};

// Petakan node grid_id -> payload format internal (lihat normalize.js).
function toPayload(nodes) {
  const th = obj(nodes.thermal); // node2_thermal
  const e = obj(nodes.esp); // node3_esp8266
  const s3 = obj(nodes.s3); // node1_s3cam
  const servo = obj(s3.servo_state);
  const gps = obj(s3.gps);
  const hz = obj(s3.hazard_status); // hazard + compensated ditulis firmware di sini

  // Suhu: raw dari node2_thermal (fallback raw_temp_c node1); compensated & hazard dari node1 (fallback node2).
  const maxTemp = firstNum(th.max_temp_raw, hz.raw_temp_c);
  const minTemp = n(th.min_temp_raw);
  const deltaTemp = maxTemp != null && minTemp != null ? Math.round((maxTemp - minTemp) * 10) / 10 : null;
  const compensated = firstNum(hz.compensated_temp_c, th.compensated_max_temp);
  const hazard = firstNum(hz.hazard_level, th.hazard_level);

  const telemetry = {
    thermal: {
      max_temp_c: maxTemp,
      avg_temp_c: n(th.center_temp_raw),
      delta_temp_c: deltaTemp,
      compensated_max_temp: compensated,
    },
    environment: { ambient_temp_c: n(e.dht_temp), humidity_pct: n(e.dht_hum) },
    sound: { sound_level_db: n(e.mic6pin_db), audio_anomaly: null },
    gas: { raw_value: n(e.mq135_raw), ppm: n(e.mq135_ppm) },
    distance: { distance_cm: n(s3.lidar_cm) },
    device_status: {
      alarm_state: hazard === 1, // level 1 = bahaya kritis
      hazard_level: hazard,
    },
    pan_tilt: {
      pan_deg: firstNum(servo.current_pan, servo.servo_bawah_pan),
      tilt_deg: firstNum(servo.current_tilt, servo.servo_atas_tilt),
    },
  };

  // GPS: pakai bila ada fix (satelit > 0 & koordinat valid).
  const lat = n(gps.lat);
  const lng = n(gps.lng);
  const sats = n(gps.satellites) || 0;
  if (lat != null && lng != null && !(lat === 0 && lng === 0) && sats > 0) telemetry.gps = { lat, lng };

  // Data tambahan untuk dashboard (disimpan utuh di kolom raw device_telemetry; diabaikan normalize).
  const meta = {
    lidar_amp: n(s3.lidar_amp),
    lidar_kd: n(s3.lidar_kd),
    mic6pin_peak: n(e.mic6pin_peak),
    sound3pin_db: n(s3.sound3pin_db),
    sound3pin_raw: n(s3.sound3pin_raw),
    sound3pin_peak: n(s3.sound3pin_peak),
    sound_status: s3.sound_status || null,
    gas_ppm: n(e.mq135_ppm),
    compensated_max_temp: compensated,
    hazard_level: hazard,
    hazard_label: hz.hazard_label || (hazard != null ? HAZARD_LABEL[hazard] || null : null),
    servo_mode: servo.active_mode || null,
    servo_preset: n(servo.preset),
    gps_satellites: sats,
    gps_location: gps.location_name || null,
    cam_ip: s3.ip_local || null,
    stream_url: s3.stream_url_port81 || null,
  };

  // Signature untuk dedup: hanya simpan saat nilai berubah.
  const sig = [
    maxTemp, telemetry.thermal.avg_temp_c, minTemp, compensated, hazard,
    telemetry.environment.ambient_temp_c, telemetry.environment.humidity_pct,
    telemetry.gas.raw_value, telemetry.gas.ppm, telemetry.sound.sound_level_db,
    telemetry.distance.distance_cm, meta.sound3pin_db, telemetry.pan_tilt.pan_deg, telemetry.pan_tilt.tilt_deg,
  ].join('|');

  return { payload: { device_id: DEVICE_CODE, timestamp: Date.now(), telemetry, meta, simulated: false }, sig };
}

const CONTENT_TYPE = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
function extFromUrl(u) {
  const m = /\.(jpg|jpeg|png|webp)(?:\?|$)/i.exec(u || '');
  return m ? m[1].toLowerCase() : 'jpg';
}

// Re-host byte gambar ke Supabase Storage (bucket publik) agar tampil di semua jaringan
// (ImgBB kerap diblokir ISP di Indonesia). Return URL publik Supabase, atau null bila gagal.
async function rehostImage(buf, srcUrl) {
  try {
    const ext = extFromUrl(srcUrl);
    const path = `hardware/${DEVICE_CODE}/${Date.now()}-${crypto.randomUUID()}.${ext}`;
    const { error } = await supabase.storage
      .from(STORAGE_BUCKET)
      .upload(path, buf, { contentType: CONTENT_TYPE[ext] || 'image/jpeg', upsert: false });
    if (error) throw new Error(error.message);
    const { data: pub } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(path);
    return (pub && pub.publicUrl) || null;
  } catch (e) {
    recordError('re-host gambar', e);
    return null;
  }
}

// Ambil URL foto terbaru dari node1_s3cam/camera (prioritas latest_imgbb_url, lalu auto/manual/boot).
function pickPhotoUrl(cam) {
  const c = obj(cam);
  const candidates = [
    c.latest_imgbb_url,
    obj(c.auto_capture).imgbb_url,
    obj(c.manual_capture).imgbb_url,
    obj(c.boot_capture).imgbb_url,
  ];
  for (const u of candidates) {
    if (u && typeof u === 'string' && /^https?:\/\//.test(u) && !/\/placeholder\//i.test(u)) return u;
  }
  return null;
}

// Jalankan AI pada foto terbaru lalu simpan deteksi + alert.
async function handlePhoto(cam, device) {
  const camera = obj(cam);
  const url = pickPhotoUrl(camera);
  if (!url) return;
  if (url === state.last_photo_url) return; // foto belum berubah
  state.last_photo_url = url;

  let buf;
  try {
    buf = await fetchImage(url);
  } catch (err) {
    return recordError('unduh foto', err);
  }

  const storedUrl = (await rehostImage(buf, url)) || url; // fallback ke URL asli bila upload gagal

  const result = await aiClient.detect(buf, url.split('/').pop() || 'inspeksi.jpg');
  const at = new Date().toISOString();
  const frameId = `${device.device_code}-${Date.now()}`;
  const dets = result.ok && Array.isArray(result.detections) ? result.detections : [];
  const infMs = typeof result.inference_ms === 'number' ? Math.round(result.inference_ms) : null; // kolom integer

  const { error: fErr } = await supabase.from('device_frames').insert({
    frame_id: frameId,
    device_id: device.id,
    device_code: device.device_code,
    frame_type: 'rgb',
    image_path: storedUrl, // URL publik Supabase (re-host); fallback ImgBB bila upload gagal
    capture_mode: 'event',
    captured_at: at, // wajib (NOT NULL); waktu firmware non-ISO jadi pakai waktu proses
    upload_status: 'uploaded',
    inference_status: result.ok ? 'done' : 'failed',
    inference_at: at,
    inference_error: result.ok ? null : result.error || result.status || 'ai_error',
    model_version: result.model_version || null,
    inference_ms: infMs,
    source: 'firebase',
    raw: camera, // metadata kamera: auto_capture.trigger_reason, hazard_level, capture_time, dll.
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
      inference_ms: infMs,
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
  } catch (err) {
    recordError('alert AI', err);
  }
}

async function poll() {
  try {
    // Per-node (JANGAN tarik seluruh grid_id: ada riwayat 'snapshots' yang besar).
    const [thermal, esp, s3, control] = await Promise.all([
      fetchNode(`${ROOT}/node2_thermal`),
      fetchNode(`${ROOT}/node3_esp8266`),
      fetchNode(`${ROOT}/node1_s3cam`),
      fetchNode(`${ROOT}/control`),
    ]);
    state.last_poll_at = new Date().toISOString();
    if (!thermal && !esp && !s3) return; // belum ada data (alat mati)

    const device = await ensureDevice();
    if (!device) return;

    // --- Telemetri (simpan hanya saat nilai berubah) ---
    const { payload, sig } = toPayload({ thermal, esp, s3, control });
    if (sig !== state.last_sig) {
      state.last_sig = sig;
      const key = `${device.device_code}/${crypto.createHash('sha1').update(sig).digest('hex').slice(0, 16)}`;
      const res = await ingest.ingestTelemetry(device, payload, { firebaseKey: key, source: 'firebase' });
      if (res && res.duplicate) state.counters.duplicates += 1;
      else if (res && res.stored) state.counters.telemetry += 1;
    }

    // --- Foto terbaru (node1_s3cam/camera) -> AI ---
    await handlePhoto(obj(s3).camera, device);
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
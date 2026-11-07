// src/lib/hardware/sistemIotAdapter.js
// Adapter Firebase RTDB tim hardware — skema "grid_id" v3 (firmware Node 1/2/3 v3.0.0).
//
// STRUKTUR BARU (root = grid_id), ditulis firmware v3 — rapi per-node di bawah /nodes:
//   grid_id/nodes/node1_s3cam/live    -> lidar{distance_cm,strength,...}, sound{raw,db_estimate,status},
//                                        gps{fix,lat,lng,satellites,...}, thermal_link{source,temp_c,...}
//   grid_id/nodes/node1_s3cam/servo   -> mode, preset, pan, tilt, step{num,total,phase}, tracking{...}
//   grid_id/nodes/node1_s3cam/camera  -> ok, capture_status, total_captures,
//                                        latest/boot/manual/auto {imgbb_url, type, reason, pan, tilt, temp_c, level}
//   grid_id/nodes/node1_s3cam/status  -> level(0..3), thermal_temp_c, evaluated_temp_c, is_danger, summary
//   grid_id/nodes/node1_s3cam/ai      -> system_level, risk, risk_score, diagnosis, recommendation
//   grid_id/nodes/node1_s3cam/network -> ip, rssi_dbm, stream_url, control_url
//   grid_id/nodes/node2_thermal/live  -> max_temp_c, min_temp_c, center_temp_c, mean_temp_c, delta_t_c,
//                                        level, anomaly, hotspot{x,y,area_pct}, fps
//   grid_id/nodes/node3_panel/live    -> temperature{value_c,humidity_pct,rise_c_per_min,trend,level},
//                                        gas{raw,baseline,ratio,z_score,saturated,level},
//                                        sound{db,baseline_db,delta_db,crest_factor,arc_events_5s,hum100_ratio,level}
//   grid_id/nodes/node3_panel/ai      -> anomaly_score, health_score, risk, diagnosis
//   grid_id/nodes/node1_s3cam/commands-> perintah servo (lihat deviceControl.js; TIDAK dipetakan ke telemetri)
//
// Level bahaya firmware v3 (menaik): 0 NORMAL, 1 WASPADA, 2 SIAGA, 3 BAHAYA. is_danger = level >= 2.
// Catatan: MQ-135 v3 melaporkan RATIO (bukan ppm). gas_ppm kolom -> null; rasio ada di meta.gas_ratio.
//
// Adapter polling REST per-subnode, memetakan ke format internal (normalize.js) lalu ingest.js.
// Foto terbaru -> re-host ke Supabase -> YOLO -> device_frames/detections + alert.
//
// ENV:
//   GRID_HW_RTDB_URL      (wajib)
//   GRID_HW_RTDB_AUTH     (opsional)
//   GRID_HW_RTDB_ROOT     (default "grid_id")
//   GRID_HW_NODE1_PATH    (default "nodes/node1_s3cam")
//   GRID_HW_NODE2_PATH    (default "nodes/node2_thermal")
//   GRID_HW_NODE3_PATH    (default "nodes/node3_panel")
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
const NODE1 = (process.env.GRID_HW_NODE1_PATH || 'nodes/node1_s3cam').replace(/^\/+|\/+$/g, '');
const NODE2 = (process.env.GRID_HW_NODE2_PATH || 'nodes/node2_thermal').replace(/^\/+|\/+$/g, '');
const NODE3 = (process.env.GRID_HW_NODE3_PATH || 'nodes/node3_panel').replace(/^\/+|\/+$/g, '');
const DEVICE_CODE = process.env.GRID_HW_DEVICE_CODE || 'PANEL-01';
const DEVICE_NAME = process.env.GRID_HW_DEVICE_NAME || 'Panel Inspeksi 01';
const POLL_MS = Math.max(3000, Number(process.env.GRID_HW_POLL_MS || 10000));
// Heartbeat: simpan telemetri minimal tiap interval ini meski nilai tak berubah,
// supaya "Telemetri terakhir" tetap segar & badge tidak salah jadi "Offline".
const HEARTBEAT_MS = Math.max(POLL_MS, Number(process.env.GRID_HW_HEARTBEAT_MS || 30000));
const STORAGE_BUCKET = process.env.GRID_HW_STORAGE_BUCKET || 'report-photos';

// Label level menaik sesuai firmware v3.
const HAZARD_LABEL = { 0: 'Normal', 1: 'Waspada', 2: 'Siaga', 3: 'Bahaya' };

const state = {
  enabled: false,
  reason: null,
  started_at: null,
  last_poll_at: null,
  last_error: null,
  last_sig: null,
  last_store_at: 0,
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
const bool = (v) => v === true || v === 'true' || v === 1;
const firstNum = (...vals) => {
  for (const v of vals) {
    const x = n(v);
    if (x != null) return x;
  }
  return null;
};

// Petakan node grid_id v3 -> payload format internal (lihat normalize.js).
// d = { n1live, n1servo, n1cam, n1status, n1ai, n1net, n2live, n3live, n3ai }
function toPayload(d) {
  const n2 = obj(d.n2live); // nodes/node2_thermal/live
  const n2hot = obj(n2.hotspot);
  const n3 = obj(d.n3live); // nodes/node3_panel/live
  const n3t = obj(n3.temperature);
  const n3g = obj(n3.gas);
  const n3s = obj(n3.sound);
  const n3ai = obj(d.n3ai); // nodes/node3_panel/ai

  const live1 = obj(d.n1live); // nodes/node1_s3cam/live
  const lidar = obj(live1.lidar);
  const snd1 = obj(live1.sound);
  const gps = obj(live1.gps);
  const servo = obj(d.n1servo); // nodes/node1_s3cam/servo
  const st1 = obj(d.n1status); // nodes/node1_s3cam/status (hazard terfusi)
  const ai1 = obj(d.n1ai); // nodes/node1_s3cam/ai
  const net1 = obj(d.n1net); // nodes/node1_s3cam/network

  // Suhu: raw & delta dari Node 2 (kamera termal); compensated & hazard dari Node 1 (fusi).
  const maxTemp = firstNum(n2.max_temp_c, st1.thermal_temp_c);
  const minTemp = n(n2.min_temp_c);
  const avgTemp = firstNum(n2.center_temp_c, n2.mean_temp_c);
  const deltaTemp = firstNum(
    n2.delta_t_c,
    maxTemp != null && minTemp != null ? Math.round((maxTemp - minTemp) * 10) / 10 : null
  );
  const compensated = firstNum(st1.evaluated_temp_c, obj(live1.thermal_link).temp_c);
  const hazard = firstNum(st1.level, ai1.system_level);
  const isDanger = hazard != null ? hazard >= 2 : false; // firmware: is_danger = level >= 2

  const telemetry = {
    thermal: {
      max_temp_c: maxTemp,
      avg_temp_c: avgTemp,
      delta_temp_c: deltaTemp,
      compensated_max_temp: compensated,
    },
    environment: { ambient_temp_c: n(n3t.value_c), humidity_pct: n(n3t.humidity_pct) },
    sound: {
      sound_level_db: firstNum(n3s.db, snd1.db_estimate),
      audio_anomaly: (n(n3s.arc_events_5s) || 0) > 0 || (n(n3s.level) || 0) >= 1 ? true : null,
    },
    gas: { raw_value: n(n3g.raw), ppm: null }, // v3: MQ-135 lapor ratio, bukan ppm (lihat meta.gas_ratio)
    distance: { distance_cm: n(lidar.distance_cm) },
    device_status: { alarm_state: isDanger, hazard_level: hazard },
    pan_tilt: { pan_deg: n(servo.pan), tilt_deg: n(servo.tilt) },
  };

  // GPS: pakai bila ada fix (satelit > 0 & koordinat valid).
  const lat = n(gps.lat);
  const lng = n(gps.lng);
  const sats = n(gps.satellites) || 0;
  const gpsFix = bool(gps.fix);
  if (gpsFix && lat != null && lng != null && !(lat === 0 && lng === 0)) telemetry.gps = { lat, lng };

  // Data tambahan untuk dashboard (disimpan utuh di kolom raw device_telemetry; diabaikan normalize).
  const meta = {
    // LiDAR
    lidar_cm: n(lidar.distance_cm),
    lidar_amp: n(lidar.strength), // kompat lama (kartu "Intensitas Laser")
    lidar_strength: n(lidar.strength),
    lidar_sensor_temp_c: n(lidar.sensor_temp_c),
    lidar_comp_factor: n(lidar.distance_comp_factor),
    // Suara — Node 3 (INMP441) & Node 1 (3-pin)
    sound_db: n(n3s.db),
    sound_baseline_db: n(n3s.baseline_db),
    sound_delta_db: n(n3s.delta_db),
    sound_crest_factor: n(n3s.crest_factor),
    arc_events_5s: n(n3s.arc_events_5s),
    hum100_ratio: n(n3s.hum100_ratio),
    mic6pin_peak: n(n3s.crest_factor), // kompat lama (kartu "Puncak Akustik")
    sound3pin_db: n(snd1.db_estimate),
    sound3pin_raw: n(snd1.raw),
    sound3pin_peak: n(snd1.peak_to_peak),
    sound_status: snd1.status || null,
    // Gas — MQ-135 v3 (ratio terhadap baseline)
    gas_raw: n(n3g.raw),
    gas_baseline: n(n3g.baseline),
    gas_ratio: n(n3g.ratio),
    gas_z_score: n(n3g.z_score),
    gas_saturated: bool(n3g.saturated),
    gas_level: n(n3g.level),
    gas_ppm: null, // tidak lagi dikirim firmware v3
    // Thermal (Node 2)
    thermal_min_c: minTemp,
    thermal_mean_c: n(n2.mean_temp_c),
    delta_t_c: deltaTemp,
    hotspot_x: n(n2hot.x),
    hotspot_y: n(n2hot.y),
    hotspot_area_pct: n(n2hot.area_pct),
    thermal_anomaly: bool(n2.anomaly),
    thermal_fps: n(n2.fps),
    thermal_level: n(n2.level),
    // Hazard & AI (fusi)
    compensated_max_temp: compensated,
    hazard_level: hazard,
    hazard_label: hazard != null ? HAZARD_LABEL[hazard] || null : null,
    is_danger: isDanger,
    system_level: n(ai1.system_level),
    node1_level: firstNum(ai1.node1_level, st1.level),
    node2_level: firstNum(ai1.node2_level, n2.level),
    node3_level: firstNum(ai1.node3_level, n3t.level),
    ai_risk: ai1.risk || n3ai.risk || null,
    ai_risk_score: firstNum(ai1.risk_score, n3ai.risk_score),
    ai_diagnosis: ai1.diagnosis || n3ai.diagnosis || st1.summary || null,
    ai_recommendation: ai1.recommendation || null,
    health_score: n(n3ai.health_score),
    anomaly_score: n(n3ai.anomaly_score),
    // Servo
    servo_mode: servo.mode || null,
    servo_preset: n(servo.preset),
    servo_preset_name: servo.preset_name || null,
    servo_pan: n(servo.pan),
    servo_tilt: n(servo.tilt),
    servo_step_num: n(obj(servo.step).num),
    servo_step_total: n(obj(servo.step).total),
    servo_phase: obj(servo.step).phase || null,
    servo_pca_ok: bool(servo.pca9685_ok),
    tracking_enabled: bool(obj(servo.tracking).enabled),
    tracking_active: bool(obj(servo.tracking).active),
    tracking_centered: bool(obj(servo.tracking).centered),
    // GPS
    gps_satellites: sats,
    gps_fix: gpsFix,
    gps_location: gps.location_name || null,
    gps_maps_url: gps.maps_url || null,
    // Jaringan & kamera
    cam_ip: net1.ip || null,
    stream_url: net1.stream_url || null,
    control_url: net1.control_url || null,
    rssi_dbm: n(net1.rssi_dbm),
    capture_status: obj(d.n1cam).capture_status || null,
    total_captures: n(obj(d.n1cam).total_captures),
  };

  // Signature untuk dedup: hanya simpan saat nilai berubah.
  const sig = [
    maxTemp, avgTemp, minTemp, compensated, hazard,
    telemetry.environment.ambient_temp_c, telemetry.environment.humidity_pct,
    telemetry.gas.raw_value, meta.gas_ratio, telemetry.sound.sound_level_db,
    telemetry.distance.distance_cm, meta.sound3pin_db,
    telemetry.pan_tilt.pan_deg, telemetry.pan_tilt.tilt_deg,
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

// Ambil URL foto terbaru dari node1_s3cam/camera v3 (latest -> auto -> manual -> boot, field .imgbb_url).
function pickPhotoUrl(cam) {
  const c = obj(cam);
  const candidates = [
    obj(c.latest).imgbb_url,
    obj(c.auto).imgbb_url,
    obj(c.manual).imgbb_url,
    obj(c.boot).imgbb_url,
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
    raw: camera, // metadata kamera v3: latest/auto/manual/boot {reason, pan, tilt, temp_c, level, time_local}
  });
  if (fErr) return recordError('simpan frame', fErr);
  state.counters.frames += 1;

  if (!dets.length) return;
  const { error: dErr } = await supabase.from('device_detections').insert(
    dets.map((dd) => ({
      frame_id: frameId,
      device_id: device.id,
      defect: dd.defect || null,
      category: dd.category || null,
      confidence: typeof dd.confidence === 'number' ? dd.confidence : null,
      severity: typeof dd.severity === 'number' ? dd.severity : null,
      bbox: dd.bbox || null,
      model_version: dd.model_version || result.model_version || null,
      inference_ms: infMs,
    }))
  );
  if (dErr) return recordError('simpan deteksi', dErr);
  state.counters.detections += dets.length;

  // Satu alert per jenis kerusakan (confidence tertinggi) -> reuse rules + ingest.upsertAlert (email Alur A).
  try {
    const cfg = await ingest.configFor(device);
    const best = new Map();
    for (const dd of dets) {
      const k = dd.defect || 'unknown';
      if (!best.has(k) || Number(dd.confidence) > Number(best.get(k).confidence)) best.set(k, dd);
    }
    for (const dd of best.values()) {
      const cand = rules.aiDetectionAlert(dd, cfg);
      if (cand) await ingest.upsertAlert(device, cand, { frame_id: frameId, source: 'firebase' });
    }
  } catch (err) {
    recordError('alert AI', err);
  }
}

async function poll() {
  try {
    // Per-subnode (JANGAN tarik seluruh node: ada 'history'/'events' yang besar).
    const [n1live, n1servo, n1cam, n1status, n1ai, n1net, n2live, n3live, n3ai] = await Promise.all([
      fetchNode(`${ROOT}/${NODE1}/live`),
      fetchNode(`${ROOT}/${NODE1}/servo`),
      fetchNode(`${ROOT}/${NODE1}/camera`),
      fetchNode(`${ROOT}/${NODE1}/status`),
      fetchNode(`${ROOT}/${NODE1}/ai`),
      fetchNode(`${ROOT}/${NODE1}/network`),
      fetchNode(`${ROOT}/${NODE2}/live`),
      fetchNode(`${ROOT}/${NODE3}/live`),
      fetchNode(`${ROOT}/${NODE3}/ai`),
    ]);
    state.last_poll_at = new Date().toISOString();
    if (!n1live && !n1status && !n2live && !n3live) return; // belum ada data (alat mati)

    const device = await ensureDevice();
    if (!device) return;

    // Heartbeat koneksi: alat jelas hidup (ada data), jadi tandai online tiap poll.
    // Mencegah badge salah "Offline" saat nilai sensor kebetulan stabil.
    await supabase
      .from('devices')
      .update({ status: 'online', last_seen: new Date().toISOString() })
      .eq('id', device.id);

    // --- Telemetri: simpan saat nilai berubah ATAU sudah lewat HEARTBEAT_MS sejak simpan terakhir ---
    const { payload, sig } = toPayload({ n1live, n1servo, n1cam, n1status, n1ai, n1net, n2live, n3live, n3ai });
    const now = Date.now();
    const changed = sig !== state.last_sig;
    const stale = now - state.last_store_at >= HEARTBEAT_MS;
    if (changed || stale) {
      state.last_sig = sig;
      state.last_store_at = now;
      // Kunci ingest menyertakan bucket waktu heartbeat supaya baris baru tetap tersimpan
      // walau signature sama (bukan dianggap duplikat).
      const bucket = Math.floor(now / HEARTBEAT_MS);
      const hash = crypto.createHash('sha1').update(sig).digest('hex').slice(0, 12);
      const key = `${device.device_code}/${hash}-${changed ? 'c' + now : 'h' + bucket}`;
      const res = await ingest.ingestTelemetry(device, payload, { firebaseKey: key, source: 'firebase' });
      if (res && res.duplicate) state.counters.duplicates += 1;
      else if (res && res.stored) state.counters.telemetry += 1;
    }

    // --- Foto terbaru (node1_s3cam/camera) -> AI ---
    await handlePhoto(n1cam, device);
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
  console.log(`[hw-adapter] aktif - polling ${ROOT}/${NODE1}|${NODE2}|${NODE3} tiap ${POLL_MS}ms (device ${DEVICE_CODE})`);
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
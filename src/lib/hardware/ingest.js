// Penyimpanan data hardware ke Supabase + evaluasi peringatan + antrean inferensi AI.
// Dipakai oleh bridge Firebase (produksi) dan skrip simulasi (source='simulasi').
const supabase = require('../../config/supabase');
const firebase = require('../../config/firebase');
const aiClient = require('../aiClient');
const notifier = require('../alertNotifier');
const { normalizeTelemetry, normalizeFrame } = require('./normalize');
const rules = require('./rules');

// ---------------------------------------------------------------------------
// Settings (hw_settings, cache 30 detik)
// ---------------------------------------------------------------------------
let settingsCache = { at: 0, value: null };

async function getGlobalConfig({ fresh = false } = {}) {
  if (!fresh && settingsCache.value && Date.now() - settingsCache.at < 30000) return settingsCache.value;
  const { data } = await supabase.from('hw_settings').select('config').eq('id', 1).maybeSingle();
  settingsCache = { at: Date.now(), value: (data && data.config) || {} };
  return settingsCache.value;
}

function invalidateSettings() {
  settingsCache = { at: 0, value: null };
}

async function configFor(device) {
  return rules.mergeConfig(await getGlobalConfig(), device && device.alert_config);
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------
async function upsertAlert(device, cand, extra = {}) {
  const now = new Date().toISOString();
  const { data: open } = await supabase
    .from('device_alerts')
    .select('id, occurrences')
    .eq('device_id', device.id)
    .eq('dedup_key', cand.dedup_key)
    .neq('status', 'selesai')
    .order('last_seen_at', { ascending: false })
    .limit(1);

  const fields = {
    priority: cand.priority,
    message: cand.message,
    trigger_value: cand.trigger_value ?? null,
    trigger_unit: cand.trigger_unit ?? null,
    threshold: cand.threshold ?? null,
    active: true,
    cleared_at: null,
    last_seen_at: now,
    ...(extra.frame_id ? { frame_id: extra.frame_id } : {}),
    ...(extra.telemetry_id ? { telemetry_id: extra.telemetry_id } : {}),
  };

  if (open && open[0]) {
    await supabase
      .from('device_alerts')
      .update({ ...fields, occurrences: (open[0].occurrences || 1) + 1 })
      .eq('id', open[0].id);
    return open[0].id;
  }
  const { data, error } = await supabase
    .from('device_alerts')
    .insert({
      ...fields,
      device_id: device.id,
      asset_id: device.asset_id || null,
      category: cand.category,
      dedup_key: cand.dedup_key,
      first_seen_at: now,
      source: extra.source || 'firebase',
    })
    .select('id')
    .single();
  if (error) console.error('[hw] gagal menyimpan alert:', error.message);
  // Email ke supervisor + hardware HANYA saat alert BARU dibuat (bukan update dedup).
  // Fire-and-forget: tidak memblok ingest & tidak menggagalkannya bila email gagal.
  if (data && !error) notifier.notifyHardwareAlert(device, cand).catch(() => {});
  return data ? data.id : null;
}

async function clearAlerts(device, categories) {
  if (!categories.length) return;
  await supabase
    .from('device_alerts')
    .update({ active: false, cleared_at: new Date().toISOString() })
    .eq('device_id', device.id)
    .eq('active', true)
    .neq('status', 'selesai')
    .in('category', categories);
}

// ---------------------------------------------------------------------------
// Telemetri
// ---------------------------------------------------------------------------
/**
 * @param device      baris tabel devices
 * @param payload     JSON dari hardware (format contoh di HARDWARE_INTEGRATION.md)
 * @param opt         { firebaseKey, source: 'firebase'|'simulasi', now }
 * @returns {Promise<{stored:boolean, duplicate?:boolean, row?:object}>}
 */
// Paket yang ditandai `simulated: true` (skrip hw-simulate) selalu berlabel 'simulasi'
// dan tampil dengan badge SIMULASI di dashboard — terpisah dari data produksi.
function sourceOf(payload, opt) {
  if (opt.source) return opt.source;
  return payload && payload.simulated === true ? 'simulasi' : 'firebase';
}

async function ingestTelemetry(device, payload, opt = {}) {
  const source = sourceOf(payload, opt);
  const { row } = normalizeTelemetry(payload, { expectedDeviceId: device.device_code, now: opt.now });

  const record = {
    ...row,
    device_id: device.id,
    device_code: device.device_code,
    source,
    firebase_key: opt.firebaseKey || null,
    raw: payload && typeof payload === 'object' ? payload : null,
  };

  let inserted;
  if (record.firebase_key) {
    const { data, error } = await supabase
      .from('device_telemetry')
      .upsert(record, { onConflict: 'firebase_key', ignoreDuplicates: true })
      .select('*');
    if (error) throw new Error(error.message);
    if (!data || !data.length) return { stored: false, duplicate: true };
    inserted = data[0];
  } else {
    const { data, error } = await supabase.from('device_telemetry').insert(record).select('*').single();
    if (error) throw new Error(error.message);
    inserted = data;
  }

  // Waktu "terakhir terlihat" memakai waktu perangkat bila valid (tidak lebih dari waktu server),
  // supaya data lama yang diputar ulang tidak membuat perangkat tampak online.
  const seenMs = Math.min(Date.now(), Date.parse(inserted.timestamp_valid ? inserted.captured_at : inserted.received_at));
  const prevMs = device.last_telemetry_at ? Date.parse(device.last_telemetry_at) : 0;
  if (seenMs >= prevMs) {
    const seenIso = new Date(seenMs).toISOString();
    await supabase
      .from('devices')
      .update({ last_telemetry_at: seenIso, last_seen: seenIso, latest_telemetry_id: inserted.id, status: 'online' })
      .eq('id', device.id);
    device.last_telemetry_at = seenIso;
    device.latest_telemetry_id = inserted.id;

    // Evaluasi aturan hanya untuk data terbaru & valid.
    if (inserted.valid) {
      const cfg = await configFor(device);
      const n = Math.max(cfg.consecutive_readings, cfg.audio_anomaly_consecutive);
      const { data: recent } = await supabase
        .from('device_telemetry')
        .select('*')
        .eq('device_id', device.id)
        .eq('valid', true)
        .order('captured_at', { ascending: false })
        .limit(n);
      const res = rules.evaluateTelemetry(recent || [inserted], cfg);
      for (const c of res.raise) await upsertAlert(device, c, { telemetry_id: inserted.id, source });
      await clearAlerts(device, res.clear);
      const conn = rules.evaluateConnectivity(device.last_telemetry_at, cfg);
      await clearAlerts(device, conn.clear);
    }
  }
  return { stored: true, row: inserted };
}

// ---------------------------------------------------------------------------
// Frames (metadata gambar)
// ---------------------------------------------------------------------------
async function ingestFrame(device, meta, opt = {}) {
  const source = sourceOf(meta, opt);
  const { row, storable } = normalizeFrame(meta, { expectedDeviceId: device.device_code, now: opt.now });
  if (!storable) return { stored: false, reason: 'metadata tidak lengkap', errors: row.validation_errors };

  const { data: existing } = await supabase
    .from('device_frames')
    .select('id, device_id, upload_status, inference_status')
    .eq('frame_id', row.frame_id)
    .maybeSingle();

  let frame;
  if (existing) {
    if (existing.device_id !== device.id) return { stored: false, reason: 'frame_id sudah dipakai perangkat lain' };
    const patch = {
      upload_status: row.upload_status,
      image_path: row.image_path,
      capture_mode: row.capture_mode,
      width: row.width,
      height: row.height,
      validation_errors: row.validation_errors,
      raw: meta,
    };
    const { data, error } = await supabase.from('device_frames').update(patch).eq('id', existing.id).select('*').single();
    if (error) throw new Error(error.message);
    frame = data;
  } else {
    const { data, error } = await supabase
      .from('device_frames')
      .insert({
        ...row,
        device_id: device.id,
        device_code: device.device_code,
        inference_status: row.frame_type === 'rgb' ? 'pending' : 'not_applicable',
        source,
        raw: meta,
      })
      .select('*')
      .single();
    if (error) throw new Error(error.message);
    frame = data;
    const prev = device.last_frame_at ? Date.parse(device.last_frame_at) : 0;
    if (Date.parse(frame.captured_at) >= prev) {
      await supabase.from('devices').update({ last_frame_at: frame.captured_at }).eq('id', device.id);
      device.last_frame_at = frame.captured_at;
    }
  }

  const cfg = await configFor(device);
  if (frame.upload_status === 'failed') {
    await upsertAlert(device, {
      category: 'upload_failed', dedup_key: 'upload_failed', priority: cfg.priority.upload_failed,
      trigger_value: null, trigger_unit: null, threshold: null,
      message: `Upload gambar ${frame.frame_type.toUpperCase()} gagal (frame ${frame.frame_id}).`,
    }, { frame_id: frame.frame_id, source });
  } else if (frame.upload_status === 'uploaded') {
    await clearAlerts(device, ['upload_failed']);
  }

  if (frame.frame_type === 'rgb' && frame.upload_status === 'uploaded' && frame.inference_status === 'pending') {
    enqueueInference(device, frame, cfg);
  }
  return { stored: true, frame };
}

// ---------------------------------------------------------------------------
// Inferensi AI (pipeline existing: lib/aiClient -> layanan YOLO GRID.ID)
// Antrean in-process, konkurensi 1, dibatasi per perangkat.
// ---------------------------------------------------------------------------
const queue = [];
let running = false;
const lastInferenceAt = new Map(); // device_id -> ms

function enqueueInference(device, frame, cfg) {
  queue.push({ device, frame, cfg });
  if (!running) drain();
}

async function drain() {
  running = true;
  while (queue.length) {
    const job = queue.shift();
    try {
      await runInference(job.device, job.frame, job.cfg);
    } catch (e) {
      console.error('[hw] inferensi gagal:', e.message);
    }
  }
  running = false;
}

async function setFrame(frameId, patch) {
  await supabase.from('device_frames').update(patch).eq('frame_id', frameId);
}

async function runInference(device, frame, cfg) {
  if (!cfg.inference_enabled) {
    return setFrame(frame.frame_id, { inference_status: 'skipped', inference_error: 'Inferensi dinonaktifkan di pengaturan' });
  }
  const last = lastInferenceAt.get(device.id) || 0;
  if (Date.now() - last < cfg.inference_min_interval_s * 1000) {
    return setFrame(frame.frame_id, {
      inference_status: 'skipped',
      inference_error: `Dilewati: interval inferensi minimum ${cfg.inference_min_interval_s} dtk`,
    });
  }
  const fb = firebase.init();
  if (!fb.bucket) {
    return setFrame(frame.frame_id, { inference_status: 'failed', inference_error: 'Firebase Storage belum dikonfigurasi' });
  }
  lastInferenceAt.set(device.id, Date.now());
  await setFrame(frame.frame_id, { inference_status: 'processing', inference_error: null });

  let buf;
  try {
    [buf] = await fb.bucket.file(frame.image_path).download();
  } catch (e) {
    return setFrame(frame.frame_id, { inference_status: 'failed', inference_error: `Gagal mengunduh gambar: ${e.message}` });
  }

  const result = await aiClient.detect(buf, frame.image_path.split('/').pop());
  const at = new Date().toISOString();
  if (!result.ok) {
    return setFrame(frame.frame_id, { inference_status: 'failed', inference_at: at, inference_error: result.error || result.status });
  }

  const dets = Array.isArray(result.detections) ? result.detections : [];
  if (dets.length) {
    const rows = dets.map((d) => ({
      frame_id: frame.frame_id,
      device_id: device.id,
      defect: d.defect || null,
      category: d.category || null,
      confidence: typeof d.confidence === 'number' ? d.confidence : null,
      severity: typeof d.severity === 'number' ? d.severity : null,
      bbox: d.bbox || null,
      model_version: d.model_version || result.model_version || null,
      inference_ms: typeof result.inference_ms === 'number' ? result.inference_ms : null,
    }));
    const { error } = await supabase.from('device_detections').insert(rows);
    if (error) {
      return setFrame(frame.frame_id, { inference_status: 'failed', inference_at: at, inference_error: error.message });
    }
  }
  await setFrame(frame.frame_id, {
    inference_status: 'done',
    inference_at: at,
    inference_error: null,
    model_version: result.model_version,
    inference_ms: result.inference_ms,
  });

  // Satu alert per jenis kerusakan (deteksi dengan confidence tertinggi).
  const best = new Map();
  for (const d of dets) {
    const k = d.defect || 'unknown';
    if (!best.has(k) || Number(d.confidence) > Number(best.get(k).confidence)) best.set(k, d);
  }
  for (const d of best.values()) {
    const cand = rules.aiDetectionAlert(d, cfg);
    if (cand) await upsertAlert(device, cand, { frame_id: frame.frame_id, source: frame.source });
  }
  return null;
}

// Frame RGB yang tertinggal 'pending' (mis. backend restart) — antrekan ulang (maks 1 jam terakhir).
async function requeuePending() {
  const since = new Date(Date.now() - 3600 * 1000).toISOString();
  const { data } = await supabase
    .from('device_frames')
    .select('*, device:device_id(*)')
    .in('inference_status', ['pending', 'processing'])
    .eq('upload_status', 'uploaded')
    .eq('frame_type', 'rgb')
    .gte('captured_at', since)
    .order('captured_at', { ascending: true })
    .limit(100);
  for (const f of data || []) {
    if (!f.device) continue;
    enqueueInference(f.device, f, await configFor(f.device));
  }
}

// ---------------------------------------------------------------------------
// Sapuan konektivitas: offline / telemetri terlambat
// ---------------------------------------------------------------------------
async function sweepConnectivity() {
  const { data: devices } = await supabase.from('devices').select('*').limit(1000);
  for (const d of devices || []) {
    const cfg = await configFor(d);
    const res = rules.evaluateConnectivity(d.last_telemetry_at, cfg);
    for (const c of res.raise) await upsertAlert(d, c);
    await clearAlerts(d, res.clear);
    // Selaraskan kolom status existing agar halaman Perangkat IoT lama tetap benar.
    if (d.last_telemetry_at) {
      const want = res.state === 'offline' ? 'offline' : 'online';
      if (d.status !== want) await supabase.from('devices').update({ status: want }).eq('id', d.id);
    }
  }
}

module.exports = {
  getGlobalConfig,
  invalidateSettings,
  configFor,
  ingestTelemetry,
  ingestFrame,
  requeuePending,
  sweepConnectivity,
  upsertAlert,
  clearAlerts,
};
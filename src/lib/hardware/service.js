// Lapisan baca data hardware yang dipakai BERSAMA oleh:
//   - /api/hardware  (Supervisor PLN / admin / hardware)  -> scope.assetIds = null (semua)
//   - /api/business  (GRID.ID Business Portal, role b2b)   -> scope.assetIds = aset yang diberikan ke organisasi
//
// Seluruh pembatasan akses B2B terjadi DI SINI (server), bukan di frontend:
// setiap query perangkat/telemetri/frame/alert difilter ke device_id milik aset dalam scope.
const supabase = require('../../config/supabase');
const firebase = require('../../config/firebase');
const env = require('../../config/env');
const ApiError = require('../../utils/apiError');
const rules = require('./rules');
const { parseThermalMatrix } = require('./normalize');
const ingest = require('./ingest');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = 864e5;

const TELEMETRY_COLS =
  'id, device_id, device_code, captured_at, received_at, timestamp_valid, source, max_temp_c, avg_temp_c, delta_temp_c, hotspot_x, hotspot_y, ambient_temp_c, humidity_pct, sound_level_db, dominant_freq_hz, audio_anomaly, gas_raw, distance_cm, rssi_dbm, alarm_state, pan_deg, tilt_deg, gps_lat, gps_lng, valid, validation_errors';
const FRAME_COLS =
  'id, frame_id, device_id, device_code, captured_at, received_at, frame_type, image_path, capture_mode, upload_status, inference_status, inference_at, inference_error, model_version, inference_ms, width, height, source';
const ASSET_COLS = 'id, asset_code, name, asset_type, lat, lng, unit, adm4, criticality';

const ALERT_CATEGORIES = ['offline', 'telemetry_late', 'temp_threshold', 'audio_anomaly', 'gas_threshold', 'alarm_perangkat', 'ai_detection', 'upload_failed'];
const ALERT_STATUSES = ['baru', 'ditinjau', 'selesai'];
const PRIORITIES = ['tinggi', 'sedang', 'rendah'];

// ---------------------------------------------------------------------------
// Util
// ---------------------------------------------------------------------------
function dbErr(error) {
  return new ApiError(500, 'db_error', error.message);
}

function parseDate(v, name) {
  if (v === undefined || v === null || v === '') return null;
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) throw new ApiError(400, 'bad_request', `${name} harus tanggal ISO yang valid`);
  return new Date(ms).toISOString();
}

// Rentang default 7 hari; maksimum 92 hari.
function parseRange(q, defDays = 7) {
  const to = parseDate(q.to, 'to') || new Date().toISOString();
  const from = parseDate(q.from, 'from') || new Date(Date.parse(to) - defDays * DAY).toISOString();
  if (Date.parse(from) > Date.parse(to)) throw new ApiError(400, 'bad_request', 'from harus sebelum to');
  if (Date.parse(to) - Date.parse(from) > 92 * DAY) throw new ApiError(400, 'bad_request', 'Rentang maksimum 92 hari');
  return { from, to };
}

function intParam(v, def, min, max) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(n, min), max);
}

function firstBy(rows, key) {
  const m = new Map();
  for (const r of rows || []) if (!m.has(r[key])) m.set(r[key], r);
  return m;
}

// ---------------------------------------------------------------------------
// Signed URL Firebase Storage (cache sampai mendekati kedaluwarsa)
// ---------------------------------------------------------------------------
const urlCache = new Map();

async function signedUrl(path) {
  if (!path) return null;
  const fb = firebase.init();
  if (!fb.bucket) return null;
  const hit = urlCache.get(path);
  if (hit && hit.exp - Date.now() > 60 * 1000) return hit.url;
  try {
    const exp = Date.now() + env.HW_SIGNED_URL_TTL_S * 1000;
    const [url] = await fb.bucket.file(path).getSignedUrl({ action: 'read', expires: exp });
    urlCache.set(path, { url, exp });
    if (urlCache.size > 5000) urlCache.delete(urlCache.keys().next().value);
    return url;
  } catch (e) {
    console.error('[hw] signed URL gagal:', e.message);
    return null;
  }
}

function storageState() {
  const fb = firebase.init();
  return fb.bucket ? 'ready' : 'not_configured';
}

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------
async function assetsMap(ids) {
  const uniq = [...new Set((ids || []).filter(Boolean))];
  if (!uniq.length) return new Map();
  const { data, error } = await supabase.from('assets').select(ASSET_COLS).in('id', uniq);
  if (error) throw dbErr(error);
  return new Map((data || []).map((a) => [a.id, a]));
}

/**
 * Perangkat dalam scope (+ filter opsional).
 * @returns {Promise<{devices: object[], assets: Map}>}
 */
async function devicesInScope(scope, f = {}) {
  let q = supabase.from('devices').select('*').order('device_code', { ascending: true }).limit(1000);
  if (scope.assetIds) {
    if (!scope.assetIds.length) return { devices: [], assets: new Map() };
    q = q.in('asset_id', scope.assetIds);
  }
  if (f.assetId) q = q.eq('asset_id', f.assetId);
  if (f.deviceId) q = q.eq('id', f.deviceId);
  const { data, error } = await q;
  if (error) throw dbErr(error);
  let devices = data || [];
  const assets = await assetsMap(devices.map((d) => d.asset_id));
  if (f.unit) devices = devices.filter((d) => (assets.get(d.asset_id) || {}).unit === f.unit);
  return { devices, assets };
}

async function deviceInScope(scope, id) {
  if (!UUID_RE.test(id || '')) throw new ApiError(400, 'bad_request', 'id perangkat harus UUID');
  const { devices, assets } = await devicesInScope(scope, { deviceId: id });
  // 404 juga untuk perangkat di luar scope (tidak membocorkan keberadaannya).
  if (!devices.length) throw new ApiError(404, 'not_found', 'Perangkat tidak ditemukan');
  return { device: devices[0], asset: assets.get(devices[0].asset_id) || null };
}

// Terapkan filter device_id. Return null bila scope kosong (hasil pasti kosong).
function byDevices(q, deviceIds) {
  if (deviceIds === null) return q;
  if (!deviceIds.length) return null;
  return q.in('device_id', deviceIds);
}

// Daftar device_id untuk scope + filter (null = semua, untuk staff tanpa filter).
async function scopeDeviceIds(scope, f = {}) {
  if (!scope.assetIds && !f.unit && !f.assetId && !f.deviceId) return { ids: null, devices: null, assets: null };
  const { devices, assets } = await devicesInScope(scope, f);
  return { ids: devices.map((d) => d.id), devices, assets };
}

// ---------------------------------------------------------------------------
// Serialisasi
// ---------------------------------------------------------------------------
function publicDevice(d, scope, cfg) {
  const base = {
    id: d.id,
    device_code: d.device_code,
    name: d.name || null,
    type: d.type || null,
    asset_id: d.asset_id || null,
    connection: rules.connectionState(d.last_telemetry_at, cfg),
    last_telemetry_at: d.last_telemetry_at || null,
    last_frame_at: d.last_frame_at || null,
    created_at: d.created_at || null,
    capabilities: d.capabilities || {},
    snapshot_interval_s: d.snapshot_interval_s ?? null,
    stream: null,
  };
  const streamAllowed = scope.kind === 'staff' || scope.viewStream;
  if (d.stream_url && streamAllowed) base.stream = { url: d.stream_url, type: d.stream_type || 'mjpeg' };
  base.stream_configured = !!d.stream_url;
  base.stream_allowed = streamAllowed;
  if (scope.kind === 'staff') {
    base.alert_config = d.alert_config || {};
    base.status_raw = d.status || null;
  }
  return base;
}

async function riskByAsset(assetIds) {
  const ids = [...new Set((assetIds || []).filter(Boolean))];
  if (!ids.length) return new Map();
  const { data, error } = await supabase
    .from('risk_scores')
    .select('asset_id, score, level, computed_at')
    .in('asset_id', ids)
    .order('computed_at', { ascending: false })
    .limit(ids.length * 10);
  if (error) return new Map();
  return firstBy(data, 'asset_id');
}

async function detectionsFor(frameIds) {
  if (!frameIds.length) return new Map();
  const { data, error } = await supabase
    .from('device_detections')
    .select('id, frame_id, defect, category, confidence, severity, bbox, model_version, inference_ms, verified, created_at')
    .in('frame_id', frameIds)
    .order('confidence', { ascending: false });
  if (error) throw dbErr(error);
  const m = new Map();
  for (const d of data || []) {
    if (!m.has(d.frame_id)) m.set(d.frame_id, []);
    m.get(d.frame_id).push(d);
  }
  return m;
}

async function serializeFrames(frames) {
  const dets = await detectionsFor(frames.filter((f) => f.frame_type === 'rgb').map((f) => f.frame_id));
  return Promise.all(
    frames.map(async (f) => {
      const out = { ...f, detections: dets.get(f.frame_id) || [] };
      delete out.image_path;
      out.has_file = f.upload_status === 'uploaded' && !!f.image_path;
      out.image_url = f.frame_type === 'rgb' && out.has_file ? await signedUrl(f.image_path) : null;
      out.storage = storageState();
      return out;
    })
  );
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------
async function listDevices(scope, q = {}) {
  const cfgGlobal = await ingest.getGlobalConfig();
  const { devices, assets } = await devicesInScope(scope, { unit: q.unit || null, assetId: q.asset_id || null });
  const ids = devices.map((d) => d.id);
  // Staff tanpa filter: tidak perlu daftar IN panjang (semua perangkat memang dalam scope).
  const narrowed = scope.assetIds || q.unit || q.asset_id ? ids : null;
  const inDevices = (x) => (narrowed ? x.in('device_id', narrowed) : x);

  const [latestRows, aiFrames, openAlerts, risk] = await Promise.all([
    (async () => {
      const tids = devices.map((d) => d.latest_telemetry_id).filter(Boolean);
      if (!tids.length) return new Map();
      const { data, error } = await supabase.from('device_telemetry').select(TELEMETRY_COLS).in('id', tids);
      if (error) throw dbErr(error);
      return new Map((data || []).map((t) => [t.device_id, t]));
    })(),
    (async () => {
      if (!ids.length) return new Map();
      const { data, error } = await inDevices(supabase
        .from('device_frames')
        .select('frame_id, device_id, captured_at, inference_status, model_version, source'))
        .eq('frame_type', 'rgb')
        .eq('inference_status', 'done')
        .order('captured_at', { ascending: false })
        .limit(Math.max(50, ids.length * 5));
      if (error) throw dbErr(error);
      return firstBy(data, 'device_id');
    })(),
    (async () => {
      if (!ids.length) return new Map();
      const { data, error } = await inDevices(supabase
        .from('device_alerts')
        .select('device_id, priority'))
        .neq('status', 'selesai')
        .limit(5000);
      if (error) throw dbErr(error);
      const m = new Map();
      for (const a of data || []) m.set(a.device_id, (m.get(a.device_id) || 0) + 1);
      return m;
    })(),
    riskByAsset(devices.map((d) => d.asset_id)),
  ]);
  const dets = await detectionsFor([...aiFrames.values()].map((f) => f.frame_id));

  let rows = devices.map((d) => {
    const cfg = rules.mergeConfig(cfgGlobal, d.alert_config);
    const t = latestRows.get(d.id) || null;
    const ai = aiFrames.get(d.id) || null;
    const aiDets = ai ? dets.get(ai.frame_id) || [] : [];
    const r = risk.get(d.asset_id) || null;
    return {
      ...publicDevice(d, scope, cfg),
      asset: assets.get(d.asset_id) || null,
      latest: t
        ? {
            id: t.id, captured_at: t.captured_at, valid: t.valid, source: t.source,
            max_temp_c: t.max_temp_c, sound_level_db: t.sound_level_db, gas_raw: t.gas_raw,
            humidity_pct: t.humidity_pct, rssi_dbm: t.rssi_dbm, audio_anomaly: t.audio_anomaly,
          }
        : null,
      last_ai: ai
        ? { frame_id: ai.frame_id, captured_at: ai.captured_at, detections: aiDets.length, top: aiDets[0] || null, source: ai.source }
        : null,
      open_alerts: openAlerts.get(d.id) || 0,
      priority: r ? { level: r.level, score: r.score, computed_at: r.computed_at } : null,
    };
  });

  // Filter
  if (q.status) rows = rows.filter((r) => r.connection === q.status);
  if (q.priority) rows = rows.filter((r) => (q.priority === 'belum' ? !r.priority : r.priority && r.priority.level === q.priority));
  if (q.q) {
    const s = String(q.q).toLowerCase();
    rows = rows.filter((r) =>
      [r.device_code, r.name, r.asset && r.asset.name, r.asset && r.asset.asset_code, r.asset && r.asset.unit]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(s))
    );
  }
  const from = parseDate(q.from, 'from');
  const to = parseDate(q.to, 'to');
  if (from) rows = rows.filter((r) => r.last_telemetry_at && r.last_telemetry_at >= from);
  if (to) rows = rows.filter((r) => r.last_telemetry_at && r.last_telemetry_at <= to);

  const units = [...new Set([...assets.values()].map((a) => a.unit).filter(Boolean))].sort();
  return { devices: rows, units };
}

async function getDevice(scope, id) {
  const { device, asset } = await deviceInScope(scope, id);
  const cfg = await ingest.configFor(device);

  const [latest, rgb, thermal, openAlerts, risk] = await Promise.all([
    device.latest_telemetry_id
      ? supabase.from('device_telemetry').select(TELEMETRY_COLS).eq('id', device.latest_telemetry_id).maybeSingle().then((r) => r.data)
      : null,
    supabase.from('device_frames').select(FRAME_COLS).eq('device_id', id).eq('frame_type', 'rgb')
      .order('captured_at', { ascending: false }).limit(1).then((r) => (r.data || [])[0] || null),
    supabase.from('device_frames').select(FRAME_COLS).eq('device_id', id).eq('frame_type', 'thermal')
      .order('captured_at', { ascending: false }).limit(1).then((r) => (r.data || [])[0] || null),
    supabase.from('device_alerts').select('id', { count: 'exact', head: true }).eq('device_id', id).neq('status', 'selesai').then((r) => r.count || 0),
    riskByAsset([device.asset_id]),
  ]);

  const [rgbS] = rgb ? await serializeFrames([rgb]) : [null];
  const [thS] = thermal ? await serializeFrames([thermal]) : [null];
  const r = risk.get(device.asset_id) || null;
  const out = {
    device: publicDevice(device, scope, cfg),
    asset,
    latest_telemetry: latest,
    latest_rgb: rgbS,
    latest_thermal: thS,
    open_alerts: openAlerts,
    priority: r ? { level: r.level, score: r.score, computed_at: r.computed_at } : null,
    thresholds: {
      telemetry_late_after_s: cfg.telemetry_late_after_s,
      offline_after_s: cfg.offline_after_s,
      temp_max_c: cfg.temp_max_c,
      gas_raw_max: cfg.gas_raw_max,
    },
    integration: { firebase: firebase.publicStatus().status, storage: storageState() },
    generated_at: new Date().toISOString(),
  };
  return out;
}

async function telemetryHistory(scope, id, q = {}) {
  await deviceInScope(scope, id);
  const { from, to } = parseRange(q, 1);
  const limit = intParam(q.limit, 1000, 1, 5000);
  const { data, error } = await supabase
    .from('device_telemetry')
    .select(TELEMETRY_COLS)
    .eq('device_id', id)
    .gte('captured_at', from)
    .lte('captured_at', to)
    .order('captured_at', { ascending: false })
    .limit(limit);
  if (error) throw dbErr(error);
  return { from, to, rows: (data || []).reverse(), truncated: (data || []).length === limit };
}

async function listFrames(scope, q = {}) {
  const f = { deviceId: q.device_id || null, assetId: q.asset_id || null, unit: q.unit || null };
  if (f.deviceId && !UUID_RE.test(f.deviceId)) throw new ApiError(400, 'bad_request', 'device_id harus UUID');
  const { ids } = await scopeDeviceIds(scope, f);
  const { from, to } = parseRange(q, 7);
  const limit = intParam(q.limit, 24, 1, 200);
  let query = supabase.from('device_frames').select(FRAME_COLS).gte('captured_at', from).lte('captured_at', to);
  query = byDevices(query, ids);
  if (!query) return { from, to, frames: [] };
  if (q.frame_type) query = query.eq('frame_type', q.frame_type);
  if (q.before) query = query.lt('captured_at', parseDate(q.before, 'before'));
  const { data, error } = await query.order('captured_at', { ascending: false }).limit(limit);
  if (error) throw dbErr(error);
  return { from, to, frames: await serializeFrames(data || []), has_more: (data || []).length === limit };
}

// Frame dalam scope atau 404.
async function frameInScope(scope, frameId) {
  const { data: frame, error } = await supabase.from('device_frames').select(FRAME_COLS).eq('frame_id', frameId).maybeSingle();
  if (error) throw dbErr(error);
  if (!frame) throw new ApiError(404, 'not_found', 'Frame tidak ditemukan');
  const { device, asset } = await deviceInScope(scope, frame.device_id).catch(() => {
    throw new ApiError(404, 'not_found', 'Frame tidak ditemukan');
  });
  return { frame, device, asset };
}

async function nearestTelemetry(deviceId, iso, windowS = 120) {
  const t = Date.parse(iso);
  const { data } = await supabase
    .from('device_telemetry')
    .select(TELEMETRY_COLS)
    .eq('device_id', deviceId)
    .gte('captured_at', new Date(t - windowS * 1000).toISOString())
    .lte('captured_at', new Date(t + windowS * 1000).toISOString())
    .limit(200);
  let best = null;
  for (const r of data || []) {
    const d = Math.abs(Date.parse(r.captured_at) - t);
    if (!best || d < best.d) best = { d, r };
  }
  return best ? { ...best.r, offset_s: Math.round((Date.parse(best.r.captured_at) - t) / 1000) } : null;
}

async function getFrame(scope, frameId) {
  const { frame, device, asset } = await frameInScope(scope, frameId);
  const cfg = await ingest.configFor(device);
  const [serialized] = await serializeFrames([frame]);
  const [telemetry, thermalNear, alert] = await Promise.all([
    nearestTelemetry(device.id, frame.captured_at),
    frame.frame_type === 'rgb'
      ? supabase.from('device_frames').select(FRAME_COLS).eq('device_id', device.id).eq('frame_type', 'thermal')
          .gte('captured_at', new Date(Date.parse(frame.captured_at) - 60000).toISOString())
          .lte('captured_at', new Date(Date.parse(frame.captured_at) + 60000).toISOString())
          .limit(1).then((r) => (r.data || [])[0] || null)
      : null,
    supabase.from('device_alerts').select('id, status, priority, category, message, last_seen_at')
      .eq('frame_id', frame.frame_id).order('last_seen_at', { ascending: false }).limit(1).then((r) => (r.data || [])[0] || null),
  ]);
  const risk = await riskByAsset([device.asset_id]);
  const r = risk.get(device.asset_id) || null;
  return {
    frame: serialized,
    device: publicDevice(device, scope, cfg),
    asset,
    telemetry,
    thermal_frame: thermalNear ? (await serializeFrames([thermalNear]))[0] : null,
    alert,
    priority: r ? { level: r.level, score: r.score, computed_at: r.computed_at } : null,
  };
}

const thermalCache = new Map();
async function thermalData(scope, frameId) {
  const { frame } = await frameInScope(scope, frameId);
  if (frame.frame_type !== 'thermal') throw new ApiError(400, 'bad_request', 'Frame ini bukan citra thermal');
  if (frame.upload_status !== 'uploaded' || !frame.image_path) throw new ApiError(409, 'not_uploaded', 'File thermal belum terunggah');
  if (thermalCache.has(frame.frame_id)) return thermalCache.get(frame.frame_id);
  const fb = firebase.init();
  if (!fb.bucket) throw new ApiError(503, 'storage_unavailable', 'Firebase Storage belum dikonfigurasi');
  let json;
  try {
    const [buf] = await fb.bucket.file(frame.image_path).download();
    json = JSON.parse(buf.toString('utf8'));
  } catch (e) {
    throw new ApiError(502, 'storage_error', `Gagal membaca file thermal: ${e.message}`);
  }
  const parsed = parseThermalMatrix(json);
  if (!parsed.ok) throw new ApiError(422, 'invalid_thermal', parsed.error);
  const out = { frame_id: frame.frame_id, captured_at: frame.captured_at, ...parsed };
  thermalCache.set(frame.frame_id, out);
  if (thermalCache.size > 200) thermalCache.delete(thermalCache.keys().next().value);
  return out;
}

// ---------------------------------------------------------------------------
// Inspeksi (frame RGB yang sudah diproses AI)
// ---------------------------------------------------------------------------
async function listInspections(scope, q = {}) {
  const f = { deviceId: q.device_id || null, assetId: q.asset_id || null, unit: q.unit || null };
  if (f.deviceId && !UUID_RE.test(f.deviceId)) throw new ApiError(400, 'bad_request', 'device_id harus UUID');
  const { ids } = await scopeDeviceIds(scope, f);
  const { from, to } = parseRange(q, 7);
  const limit = intParam(q.limit, 50, 1, 200);

  let query = supabase.from('device_frames').select(FRAME_COLS).eq('frame_type', 'rgb').gte('captured_at', from).lte('captured_at', to);
  query = byDevices(query, ids);
  if (!query) return { from, to, inspections: [] };
  const statuses = q.inference_status ? [q.inference_status] : ['done', 'failed'];
  query = query.in('inference_status', statuses);

  if (q.defect || q.with_detections === 'true') {
    let dq = supabase.from('device_detections').select('frame_id').gte('created_at', from);
    if (q.defect) dq = dq.eq('defect', q.defect);
    dq = byDevices(dq, ids);
    const { data: dd, error: de } = await dq.limit(2000);
    if (de) throw dbErr(de);
    const fids = [...new Set((dd || []).map((d) => d.frame_id))];
    if (!fids.length) return { from, to, inspections: [] };
    query = query.in('frame_id', fids);
  }

  const { data: frames, error } = await query.order('captured_at', { ascending: false }).limit(limit);
  if (error) throw dbErr(error);
  const list = frames || [];
  if (!list.length) return { from, to, inspections: [] };

  const devIds = [...new Set(list.map((fr) => fr.device_id))];
  const { devices, assets } = await devicesInScope(scope, {});
  const devMap = new Map(devices.filter((d) => devIds.includes(d.id)).map((d) => [d.id, d]));
  const minT = new Date(Date.parse(list[list.length - 1].captured_at) - 120000).toISOString();
  const maxT = new Date(Date.parse(list[0].captured_at) + 120000).toISOString();

  const [serialized, tele, thermals, alerts, risk] = await Promise.all([
    serializeFrames(list),
    supabase.from('device_telemetry').select('device_id, captured_at, max_temp_c, avg_temp_c, delta_temp_c')
      .in('device_id', devIds).gte('captured_at', minT).lte('captured_at', maxT).limit(5000).then((r) => r.data || []),
    supabase.from('device_frames').select('frame_id, device_id, captured_at, upload_status')
      .in('device_id', devIds).eq('frame_type', 'thermal').gte('captured_at', minT).lte('captured_at', maxT).limit(2000).then((r) => r.data || []),
    supabase.from('device_alerts').select('frame_id, status, priority').in('frame_id', list.map((fr) => fr.frame_id)).then((r) => r.data || []),
    riskByAsset([...devMap.values()].map((d) => d.asset_id)),
  ]);
  const alertByFrame = firstBy(alerts, 'frame_id');
  const near = (rows, devId, iso, maxMs) => {
    const t = Date.parse(iso);
    let best = null;
    for (const r of rows) {
      if (r.device_id !== devId) continue;
      const d = Math.abs(Date.parse(r.captured_at) - t);
      if (d <= maxMs && (!best || d < best.d)) best = { d, r };
    }
    return best ? best.r : null;
  };

  const inspections = serialized.map((fr) => {
    const d = devMap.get(fr.device_id) || {};
    const a = assets.get(d.asset_id) || null;
    const t = near(tele, fr.device_id, fr.captured_at, 120000);
    const th = near(thermals, fr.device_id, fr.captured_at, 60000);
    const al = alertByFrame.get(fr.frame_id) || null;
    const rk = risk.get(d.asset_id) || null;
    let followup;
    if (fr.inference_status !== 'done') followup = 'menunggu_ai';
    else if (!fr.detections.length) followup = 'tidak_ada_temuan';
    else if (al) followup = al.status;
    else followup = 'di_bawah_ambang'; // ada deteksi tapi confidence < ambang alert
    return {
      ...fr,
      device: { id: d.id, device_code: d.device_code, name: d.name || null },
      asset: a,
      telemetry: t ? { captured_at: t.captured_at, max_temp_c: t.max_temp_c, avg_temp_c: t.avg_temp_c, delta_temp_c: t.delta_temp_c } : null,
      thermal_frame_id: th && th.upload_status === 'uploaded' ? th.frame_id : null,
      followup_status: followup,
      priority: rk ? { level: rk.level, score: rk.score, computed_at: rk.computed_at } : null,
    };
  });
  return { from, to, inspections, has_more: list.length === limit };
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------
async function listAlerts(scope, q = {}) {
  const f = { deviceId: q.device_id || null, assetId: q.asset_id || null, unit: q.unit || null };
  if (f.deviceId && !UUID_RE.test(f.deviceId)) throw new ApiError(400, 'bad_request', 'device_id harus UUID');
  const { ids } = await scopeDeviceIds(scope, f);
  const { from, to } = parseRange(q, 30);
  const limit = intParam(q.limit, 100, 1, 500);
  let query = supabase.from('device_alerts').select('*').gte('last_seen_at', from).lte('last_seen_at', to);
  query = byDevices(query, ids);
  if (!query) return { from, to, alerts: [] };
  if (q.category) {
    if (!ALERT_CATEGORIES.includes(q.category)) throw new ApiError(400, 'bad_request', 'category tidak valid');
    query = query.eq('category', q.category);
  }
  if (q.status) {
    if (q.status === 'terbuka') query = query.neq('status', 'selesai');
    else if (ALERT_STATUSES.includes(q.status)) query = query.eq('status', q.status);
    else throw new ApiError(400, 'bad_request', 'status tidak valid');
  }
  if (q.priority) {
    if (!PRIORITIES.includes(q.priority)) throw new ApiError(400, 'bad_request', 'priority tidak valid');
    query = query.eq('priority', q.priority);
  }
  const { data, error } = await query.order('last_seen_at', { ascending: false }).limit(limit);
  if (error) throw dbErr(error);
  const list = data || [];
  const { devices, assets } = await devicesInScope(scope, {});
  const devMap = new Map(devices.map((d) => [d.id, d]));
  const alerts = list.map((a) => {
    const d = devMap.get(a.device_id) || {};
    const out = {
      ...a,
      device: { id: d.id, device_code: d.device_code, name: d.name || null },
      asset: assets.get(d.asset_id) || null,
    };
    if (scope.kind !== 'staff') {
      // B2B: sembunyikan identitas petugas internal.
      delete out.reviewed_by;
      delete out.resolved_by;
    }
    return out;
  });
  return { from, to, alerts };
}

async function updateAlert(id, body, user) {
  if (!UUID_RE.test(id || '')) throw new ApiError(400, 'bad_request', 'id harus UUID');
  const { status, note } = body || {};
  if (status !== undefined && !ALERT_STATUSES.includes(status)) throw new ApiError(400, 'bad_request', 'status harus baru/ditinjau/selesai');
  const patch = {};
  const now = new Date().toISOString();
  if (status) {
    patch.status = status;
    if (status === 'ditinjau') Object.assign(patch, { reviewed_by: user.id, reviewed_at: now });
    if (status === 'selesai') Object.assign(patch, { resolved_by: user.id, resolved_at: now });
    if (status === 'baru') Object.assign(patch, { resolved_by: null, resolved_at: null });
  }
  if (note !== undefined) patch.note = note ? String(note).slice(0, 1000) : null;
  if (!Object.keys(patch).length) throw new ApiError(400, 'bad_request', 'Tidak ada field untuk diupdate');
  const { data, error } = await supabase.from('device_alerts').update(patch).eq('id', id).select('*').maybeSingle();
  if (error) throw dbErr(error);
  if (!data) throw new ApiError(404, 'not_found', 'Peringatan tidak ditemukan');
  return data;
}

// ---------------------------------------------------------------------------
// Overview & laporan
// ---------------------------------------------------------------------------
async function countIn(table, build, ids) {
  let q = supabase.from(table).select('id', { count: 'exact', head: true });
  q = byDevices(q, ids);
  if (!q) return 0;
  q = build(q);
  const { count, error } = await q;
  if (error) throw dbErr(error);
  return count || 0;
}

function hourlySeries(rows, field, from, to) {
  const bucketMs = Date.parse(to) - Date.parse(from) > 3 * DAY ? 6 * 3600e3 : 3600e3;
  const m = new Map();
  for (const r of rows) {
    const v = r[field];
    if (v === null || v === undefined) continue;
    const b = Math.floor(Date.parse(r.captured_at) / bucketMs) * bucketMs;
    const cur = m.get(b) || { sum: 0, n: 0, max: -Infinity };
    cur.sum += Number(v);
    cur.n += 1;
    cur.max = Math.max(cur.max, Number(v));
    m.set(b, cur);
  }
  return [...m.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([b, c]) => ({ t: new Date(b).toISOString(), avg: Math.round((c.sum / c.n) * 10) / 10, max: c.max, n: c.n }));
}

async function overview(scope, q = {}) {
  const { from, to } = parseRange(q, 1);
  const list = await listDevices(scope, { unit: q.unit || null });
  const devices = list.devices;
  const ids = scope.assetIds || q.unit ? devices.map((d) => d.id) : null;

  const conn = { online: 0, late: 0, offline: 0, never: 0 };
  for (const d of devices) conn[d.connection] += 1;

  const [rgbFrames, inspections, detections, openAlertsRows, tele] = await Promise.all([
    countIn('device_frames', (x) => x.eq('frame_type', 'rgb').gte('captured_at', from).lte('captured_at', to), ids),
    countIn('device_frames', (x) => x.eq('frame_type', 'rgb').eq('inference_status', 'done').gte('captured_at', from).lte('captured_at', to), ids),
    countIn('device_detections', (x) => x.gte('created_at', from).lte('created_at', to), ids),
    (async () => {
      let x = supabase.from('device_alerts').select('device_id, priority, category').neq('status', 'selesai');
      x = byDevices(x, ids);
      if (!x) return [];
      const { data, error } = await x.limit(5000);
      if (error) throw dbErr(error);
      return data || [];
    })(),
    (async () => {
      let x = supabase.from('device_telemetry').select('captured_at, max_temp_c, sound_level_db, humidity_pct, gas_raw')
        .eq('valid', true).gte('captured_at', from).lte('captured_at', to);
      x = byDevices(x, ids);
      if (!x) return [];
      const { data, error } = await x.order('captured_at', { ascending: false }).limit(5000);
      if (error) throw dbErr(error);
      return data || [];
    })(),
  ]);

  const alertsByPriority = { tinggi: 0, sedang: 0, rendah: 0 };
  for (const a of openAlertsRows) alertsByPriority[a.priority] = (alertsByPriority[a.priority] || 0) + 1;
  const lastTelemetry = devices.map((d) => d.last_telemetry_at).filter(Boolean).sort().pop() || null;
  const recent = await listInspections(scope, { from, to, limit: 5, unit: q.unit || undefined });

  return {
    from,
    to,
    devices_total: devices.length,
    connection: conn,
    devices_with_alerts: new Set(openAlertsRows.map((a) => a.device_id)).size,
    open_alerts: openAlertsRows.length,
    alerts_by_priority: alertsByPriority,
    rgb_frames: rgbFrames,
    inspections,
    detections,
    last_telemetry_at: lastTelemetry,
    trend: {
      max_temp_c: hourlySeries(tele, 'max_temp_c', from, to),
      sound_level_db: hourlySeries(tele, 'sound_level_db', from, to),
      humidity_pct: hourlySeries(tele, 'humidity_pct', from, to),
      gas_raw: hourlySeries(tele, 'gas_raw', from, to),
      samples: tele.length,
      truncated: tele.length === 5000,
    },
    contains_simulated_data: devices.some((d) => d.latest && d.latest.source === 'simulasi'),
    recent_inspections: recent.inspections,
    attention: devices
      .filter((d) => d.open_alerts > 0 || d.connection === 'offline')
      .sort((a, b) => b.open_alerts - a.open_alerts)
      .slice(0, 8),
    integration: { firebase: firebase.publicStatus().status, storage: storageState() },
    generated_at: new Date().toISOString(),
  };
}

function dayKey(iso) {
  // Hari dalam WITA (UTC+8) agar sesuai wilayah operasional default; label tetap ISO date.
  return new Date(Date.parse(iso) + 8 * 3600e3).toISOString().slice(0, 10);
}

async function report(scope, q = {}) {
  const { from, to } = parseRange(q, 30);
  const { devices, assets } = await devicesInScope(scope, { unit: q.unit || null });
  const ids = devices.map((d) => d.id);
  const empty = !ids.length;
  const cfgGlobal = await ingest.getGlobalConfig();
  const narrowed = scope.assetIds || q.unit ? ids : null;
  const inDevices = (x) => (narrowed ? x.in('device_id', narrowed) : x);

  const [frames, dets, alerts] = empty
    ? [[], [], []]
    : await Promise.all([
        inDevices(supabase.from('device_frames').select('frame_id, device_id, captured_at, inference_status, upload_status, source'))
          .eq('frame_type', 'rgb').gte('captured_at', from).lte('captured_at', to).limit(20000)
          .then((r) => { if (r.error) throw dbErr(r.error); return r.data || []; }),
        inDevices(supabase.from('device_detections').select('frame_id, device_id, defect, confidence, severity, verified, created_at'))
          .gte('created_at', from).lte('created_at', to).limit(20000)
          .then((r) => { if (r.error) throw dbErr(r.error); return r.data || []; }),
        inDevices(supabase.from('device_alerts').select('id, device_id, category, priority, status, first_seen_at, last_seen_at, source'))
          .gte('last_seen_at', from).lte('last_seen_at', to).limit(20000)
          .then((r) => { if (r.error) throw dbErr(r.error); return r.data || []; }),
      ]);

  const done = frames.filter((f) => f.inference_status === 'done');
  const byClass = {};
  for (const d of dets) {
    const k = d.defect || 'unknown';
    byClass[k] = byClass[k] || { defect: k, count: 0, conf_sum: 0, verified: 0 };
    byClass[k].count += 1;
    byClass[k].conf_sum += Number(d.confidence) || 0;
    if (d.verified) byClass[k].verified += 1;
  }
  const alertsByCategory = {};
  const alertsByStatus = { baru: 0, ditinjau: 0, selesai: 0 };
  for (const a of alerts) {
    alertsByCategory[a.category] = (alertsByCategory[a.category] || 0) + 1;
    alertsByStatus[a.status] = (alertsByStatus[a.status] || 0) + 1;
  }
  const conn = { online: 0, late: 0, offline: 0, never: 0 };
  for (const d of devices) conn[rules.connectionState(d.last_telemetry_at, rules.mergeConfig(cfgGlobal, d.alert_config))] += 1;

  // Tren harian
  const daily = new Map();
  const bump = (iso, k) => {
    const key = dayKey(iso);
    const cur = daily.get(key) || { date: key, inspections: 0, detections: 0, alerts: 0 };
    cur[k] += 1;
    daily.set(key, cur);
  };
  // Isi setiap hari dalam periode (hari tanpa data = 0, bukan dihilangkan).
  for (let t = Date.parse(from); t <= Date.parse(to) + 1; t += DAY) {
    const key = dayKey(new Date(t).toISOString());
    if (!daily.has(key)) daily.set(key, { date: key, inspections: 0, detections: 0, alerts: 0 });
  }
  const lastKey = dayKey(to);
  if (!daily.has(lastKey)) daily.set(lastKey, { date: lastKey, inspections: 0, detections: 0, alerts: 0 });
  done.forEach((f) => bump(f.captured_at, 'inspections'));
  dets.forEach((d) => bump(d.created_at, 'detections'));
  alerts.forEach((a) => bump(a.first_seen_at, 'alerts'));

  // Per aset
  const perAsset = new Map();
  const devAsset = new Map(devices.map((d) => [d.id, d.asset_id]));
  const ensure = (assetId) => {
    if (!perAsset.has(assetId)) {
      const a = assets.get(assetId) || null;
      perAsset.set(assetId, { asset: a, devices: 0, inspections: 0, detections: 0, alerts: 0, open_alerts: 0, last_inspection_at: null, defects: {} });
    }
    return perAsset.get(assetId);
  };
  devices.forEach((d) => { ensure(d.asset_id || null).devices += 1; });
  done.forEach((f) => {
    const p = ensure(devAsset.get(f.device_id) || null);
    p.inspections += 1;
    if (!p.last_inspection_at || f.captured_at > p.last_inspection_at) p.last_inspection_at = f.captured_at;
  });
  dets.forEach((d) => {
    const p = ensure(devAsset.get(d.device_id) || null);
    p.detections += 1;
    p.defects[d.defect || 'unknown'] = (p.defects[d.defect || 'unknown'] || 0) + 1;
  });
  alerts.forEach((a) => {
    const p = ensure(devAsset.get(a.device_id) || null);
    p.alerts += 1;
    if (a.status !== 'selesai') p.open_alerts += 1;
  });

  const simulated =
    frames.some((f) => f.source === 'simulasi') || alerts.some((a) => a.source === 'simulasi');

  return {
    from,
    to,
    unit: q.unit || null,
    summary: {
      devices: devices.length,
      connection: conn,
      rgb_frames: frames.length,
      upload_failed: frames.filter((f) => f.upload_status === 'failed').length,
      inspections: done.length,
      inference_failed: frames.filter((f) => f.inference_status === 'failed').length,
      detections: dets.length,
      detections_verified: dets.filter((d) => d.verified).length,
      alerts: alerts.length,
      alerts_by_status: alertsByStatus,
      alerts_by_category: alertsByCategory,
    },
    detections_by_class: Object.values(byClass)
      .map((c) => ({ defect: c.defect, count: c.count, avg_confidence: c.count ? Math.round((c.conf_sum / c.count) * 100) / 100 : null, verified: c.verified }))
      .sort((a, b) => b.count - a.count),
    daily: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)),
    assets: [...perAsset.values()].sort((a, b) => b.open_alerts - a.open_alerts || b.detections - a.detections),
    contains_simulated_data: simulated,
    generated_at: new Date().toISOString(),
  };
}

module.exports = {
  UUID_RE,
  parseRange,
  devicesInScope,
  deviceInScope,
  listDevices,
  getDevice,
  telemetryHistory,
  listFrames,
  getFrame,
  thermalData,
  listInspections,
  listAlerts,
  updateAlert,
  overview,
  report,
  ALERT_CATEGORIES,
};

// Validasi & normalisasi payload hardware (murni, tanpa I/O — mudah dites).
//
// Prinsip:
//  - Field yang tidak dikirim => null (BUKAN 0). Dashboard menampilkan "—".
//  - Field yang dikirim tapi tidak valid => null + dicatat di validation_errors.
//  - Rentang di bawah adalah RENTANG FISIK/OPERASIONAL SENSOR (dari datasheet),
//    BUKAN ambang keselamatan listrik. Ambang peringatan diatur terpisah (hw_settings).

const FUTURE_SKEW_MS = 5 * 60 * 1000; // toleransi jam perangkat 5 menit

// [min, max] rentang fisik yang masuk akal per sensor
const RANGES = {
  max_temp_c: [-40, 300], // MLX90640: -40..300 °C
  avg_temp_c: [-40, 300],
  delta_temp_c: [-340, 340],
  ambient_temp_c: [-40, 85],
  humidity_pct: [0, 100],
  sound_level_db: [0, 194],
  dominant_freq_hz: [0, 48000],
  gas_raw: [0, 65535], // nilai ADC mentah (belum terkalibrasi ppm)
  distance_cm: [0, 10000],
  rssi_dbm: [-130, 0],
  pan_deg: [-360, 360],
  tilt_deg: [-180, 180],
};

// Resolusi MLX90640 = 32 x 24 piksel
const THERMAL_W = 32;
const THERMAL_H = 24;

const FRAME_TYPES = ['rgb', 'thermal'];
const CAPTURE_MODES = ['periodic', 'manual', 'event'];
const UPLOAD_STATUSES = ['pending', 'uploaded', 'failed'];

function isObj(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function pick(obj, path) {
  let cur = obj;
  for (const k of path) {
    if (!isObj(cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}

function parseTimestamp(value, now, errors) {
  if (value == null || value === '') {
    errors.push({ field: 'timestamp', reason: 'tidak ada' });
    return null;
  }
  let ms;
  if (typeof value === 'number') {
    // dukung epoch detik atau milidetik
    ms = value < 1e12 ? value * 1000 : value;
  } else if (typeof value === 'string') {
    ms = Date.parse(value);
  } else {
    ms = NaN;
  }
  if (!Number.isFinite(ms)) {
    errors.push({ field: 'timestamp', reason: 'format tidak valid' });
    return null;
  }
  if (ms - now > FUTURE_SKEW_MS) {
    errors.push({ field: 'timestamp', reason: 'di masa depan (jam perangkat tidak sinkron)' });
    return null;
  }
  return new Date(ms).toISOString();
}

function num(raw, field, errors) {
  if (raw === undefined || raw === null || raw === '') return null;
  const v = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    errors.push({ field, reason: 'bukan angka' });
    return null;
  }
  const r = RANGES[field];
  if (r && (v < r[0] || v > r[1])) {
    errors.push({ field, reason: `di luar rentang sensor (${r[0]}..${r[1]})`, value: v });
    return null;
  }
  return v;
}

function bool(raw, field, errors) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'boolean') return raw;
  if (raw === 0 || raw === 1) return raw === 1;
  errors.push({ field, reason: 'bukan boolean' });
  return null;
}

function int(raw, field, min, max, errors) {
  if (raw === undefined || raw === null) return null;
  if (!Number.isInteger(raw) || raw < min || raw > max) {
    errors.push({ field, reason: `harus bilangan bulat ${min}..${max}`, value: raw });
    return null;
  }
  return raw;
}

/**
 * Normalisasi satu paket telemetri.
 * @param {object} payload  bentuk: { device_id, timestamp, telemetry: { thermal, environment, sound, gas, distance, device_status, pan_tilt?, gps? } }
 * @param {object} opt      { expectedDeviceId, now }
 * @returns {{ row: object, errors: object[] }}
 */
function normalizeTelemetry(payload, opt = {}) {
  const now = opt.now || Date.now();
  const errors = [];
  const p = isObj(payload) ? payload : {};
  const t = isObj(p.telemetry) ? p.telemetry : {};

  if (!isObj(p.telemetry)) errors.push({ field: 'telemetry', reason: 'tidak ada / bukan objek' });

  if (opt.expectedDeviceId && p.device_id !== opt.expectedDeviceId) {
    errors.push({ field: 'device_id', reason: `tidak cocok dengan path (${opt.expectedDeviceId})`, value: p.device_id ?? null });
  }

  const captured = parseTimestamp(p.timestamp, now, errors);

  const row = {
    captured_at: captured || new Date(now).toISOString(),
    timestamp_valid: !!captured,

    max_temp_c: num(pick(t, ['thermal', 'max_temp_c']), 'max_temp_c', errors),
    avg_temp_c: num(pick(t, ['thermal', 'avg_temp_c']), 'avg_temp_c', errors),
    delta_temp_c: num(pick(t, ['thermal', 'delta_temp_c']), 'delta_temp_c', errors),
    hotspot_x: int(pick(t, ['thermal', 'hotspot', 'x']), 'hotspot_x', 0, THERMAL_W - 1, errors),
    hotspot_y: int(pick(t, ['thermal', 'hotspot', 'y']), 'hotspot_y', 0, THERMAL_H - 1, errors),

    ambient_temp_c: num(pick(t, ['environment', 'ambient_temp_c']), 'ambient_temp_c', errors),
    humidity_pct: num(pick(t, ['environment', 'humidity_pct']), 'humidity_pct', errors),

    sound_level_db: num(pick(t, ['sound', 'sound_level_db']), 'sound_level_db', errors),
    dominant_freq_hz: num(pick(t, ['sound', 'dominant_freq_hz']), 'dominant_freq_hz', errors),
    audio_anomaly: bool(pick(t, ['sound', 'audio_anomaly']), 'audio_anomaly', errors),

    gas_raw: num(pick(t, ['gas', 'raw_value']), 'gas_raw', errors),
    distance_cm: num(pick(t, ['distance', 'distance_cm']), 'distance_cm', errors),

    rssi_dbm: num(pick(t, ['device_status', 'rssi_dbm']), 'rssi_dbm', errors),
    alarm_state: bool(pick(t, ['device_status', 'alarm_state']), 'alarm_state', errors),

    pan_deg: num(pick(t, ['pan_tilt', 'pan_deg']), 'pan_deg', errors),
    tilt_deg: num(pick(t, ['pan_tilt', 'tilt_deg']), 'tilt_deg', errors),

    gps_lat: null,
    gps_lng: null,
  };

  // GPS hanya dipakai bila valid: ada fix, dalam rentang, dan bukan (0,0).
  const gps = t.gps;
  if (gps !== undefined && gps !== null) {
    const lat = Number(gps.lat);
    const lng = Number(gps.lng);
    const noFix = gps.fix === false;
    const inRange = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
    if (noFix) {
      errors.push({ field: 'gps', reason: 'belum fix' });
    } else if (!inRange || (lat === 0 && lng === 0)) {
      errors.push({ field: 'gps', reason: 'koordinat tidak valid' });
    } else {
      row.gps_lat = lat;
      row.gps_lng = lng;
    }
  }

  // Data dianggap tidak valid bila ada error selain GPS belum fix (kondisi normal di dalam ruangan).
  const blocking = errors.filter((e) => !(e.field === 'gps' && e.reason === 'belum fix'));
  row.valid = blocking.length === 0;
  row.validation_errors = errors;
  return { row, errors };
}

/**
 * Normalisasi metadata frame (gambar RGB / matriks thermal).
 * image_path WAJIB berada di folder perangkat itu sendiri: frames/<device_id>/...
 */
function normalizeFrame(meta, opt = {}) {
  const now = opt.now || Date.now();
  const errors = [];
  const m = isObj(meta) ? meta : {};
  const deviceId = opt.expectedDeviceId || m.device_id;

  if (opt.expectedDeviceId && m.device_id !== opt.expectedDeviceId) {
    errors.push({ field: 'device_id', reason: `tidak cocok dengan path (${opt.expectedDeviceId})` });
  }

  const frameId = typeof m.frame_id === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(m.frame_id) ? m.frame_id : null;
  if (!frameId) errors.push({ field: 'frame_id', reason: 'tidak ada / format tidak valid' });

  const frameType = FRAME_TYPES.includes(m.frame_type) ? m.frame_type : null;
  if (!frameType) errors.push({ field: 'frame_type', reason: "harus 'rgb' atau 'thermal'" });

  let imagePath = typeof m.image_path === 'string' ? m.image_path : null;
  if (imagePath && (!imagePath.startsWith(`frames/${deviceId}/`) || imagePath.includes('..'))) {
    errors.push({ field: 'image_path', reason: 'harus berada di frames/<device_id>/' });
    imagePath = null;
  }

  let uploadStatus = UPLOAD_STATUSES.includes(m.upload_status) ? m.upload_status : null;
  if (!uploadStatus) uploadStatus = imagePath ? 'uploaded' : 'pending';
  if (!imagePath && uploadStatus === 'uploaded') uploadStatus = 'failed';

  const captureMode = CAPTURE_MODES.includes(m.capture_mode) ? m.capture_mode : null;
  const captured = parseTimestamp(m.timestamp, now, errors);

  const row = {
    frame_id: frameId,
    captured_at: captured || new Date(now).toISOString(),
    frame_type: frameType,
    image_path: imagePath,
    capture_mode: captureMode,
    upload_status: uploadStatus,
    width: Number.isInteger(m.width) ? m.width : null,
    height: Number.isInteger(m.height) ? m.height : null,
    validation_errors: errors,
  };
  // Frame tanpa id/tipe tidak bisa disimpan.
  const storable = !!frameId && !!frameType;
  return { row, errors, storable };
}

/**
 * Validasi matriks thermal (MLX90640 32x24 = 768 nilai) dari file JSON di Storage.
 * Format diterima: { width, height, data: number[] } atau number[768] atau number[24][32].
 */
function parseThermalMatrix(json) {
  let width = THERMAL_W;
  let height = THERMAL_H;
  let data = null;
  if (Array.isArray(json) && Array.isArray(json[0])) {
    height = json.length;
    width = json[0].length;
    data = json.flat();
  } else if (Array.isArray(json)) {
    data = json;
  } else if (isObj(json) && Array.isArray(json.data)) {
    width = Number(json.width) || THERMAL_W;
    height = Number(json.height) || THERMAL_H;
    data = Array.isArray(json.data[0]) ? json.data.flat() : json.data;
  }
  if (!data || data.length !== width * height) return { ok: false, error: 'Ukuran matriks thermal tidak sesuai' };
  const vals = data.map(Number);
  if (vals.some((v) => !Number.isFinite(v) || v < RANGES.max_temp_c[0] || v > RANGES.max_temp_c[1])) {
    return { ok: false, error: 'Matriks thermal berisi nilai tidak valid' };
  }
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let maxIdx = 0;
  vals.forEach((v, i) => {
    if (v < min) min = v;
    if (v > max) {
      max = v;
      maxIdx = i;
    }
    sum += v;
  });
  return {
    ok: true,
    width,
    height,
    data: vals,
    min,
    max,
    avg: sum / vals.length,
    hotspot: { x: maxIdx % width, y: Math.floor(maxIdx / width) },
  };
}

module.exports = { normalizeTelemetry, normalizeFrame, parseThermalMatrix, RANGES, THERMAL_W, THERMAL_H };

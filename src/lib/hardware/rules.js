// Aturan peringatan hardware (murni, tanpa I/O).
//
// PENTING:
//  - Ambang suhu & gas DEFAULT NULL = aturan NONAKTIF. GRID.ID tidak menetapkan ambang
//    keselamatan listrik sendiri; nilainya wajib diisi supervisor/admin sesuai SOP PLN.
//  - Peringatan sensor butuh beberapa pembacaan berturut-turut (consecutive_readings)
//    agar satu pembacaan tunggal tidak dianggap kepastian kerusakan.
//  - Pesan peringatan memakai kata "indikasi", bukan vonis kerusakan.

const DEFAULT_CONFIG = Object.freeze({
  telemetry_late_after_s: 180, // tidak ada telemetri > 3 menit -> "telemetri terlambat"
  offline_after_s: 600, // > 10 menit -> "perangkat offline"
  consecutive_readings: 3,
  temp_max_c: null, // NONAKTIF sampai diisi
  gas_raw_max: null, // NONAKTIF sampai diisi (nilai ADC mentah)
  audio_anomaly_consecutive: 2,
  ai_min_confidence: 0.5,
  ai_severity_tinggi: 70, // severity dari layanan AI (0-100)
  ai_severity_sedang: 40,
  inference_enabled: true,
  inference_min_interval_s: 30, // batasi beban layanan AI per perangkat
  priority: {
    offline: 'sedang',
    telemetry_late: 'rendah',
    temp_threshold: 'tinggi',
    gas_threshold: 'tinggi',
    audio_anomaly: 'sedang',
    alarm_perangkat: 'tinggi',
    upload_failed: 'rendah',
  },
});

const PRIORITIES = ['tinggi', 'sedang', 'rendah'];

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Gabungkan default <- global (hw_settings) <- per-perangkat (devices.alert_config). Validasi tipe.
function mergeConfig(globalCfg, deviceCfg) {
  const out = { ...DEFAULT_CONFIG, priority: { ...DEFAULT_CONFIG.priority } };
  for (const src of [globalCfg, deviceCfg]) {
    if (!src || typeof src !== 'object') continue;
    for (const k of Object.keys(DEFAULT_CONFIG)) {
      if (!(k in src)) continue;
      if (k === 'priority') {
        for (const [pk, pv] of Object.entries(src.priority || {})) {
          if (pk in out.priority && PRIORITIES.includes(pv)) out.priority[pk] = pv;
        }
      } else if (k === 'inference_enabled') {
        out[k] = !!src[k];
      } else if (k === 'temp_max_c' || k === 'gas_raw_max') {
        out[k] = numOrNull(src[k]);
      } else {
        const n = numOrNull(src[k]);
        if (n !== null && n >= 0) out[k] = n;
      }
    }
  }
  out.consecutive_readings = Math.max(1, Math.round(out.consecutive_readings));
  out.audio_anomaly_consecutive = Math.max(1, Math.round(out.audio_anomaly_consecutive));
  if (out.offline_after_s < out.telemetry_late_after_s) out.offline_after_s = out.telemetry_late_after_s;
  return out;
}

// Validasi body PUT settings -> objek config bersih (hanya kunci dikenal).
function sanitizeConfigInput(body) {
  const merged = mergeConfig({}, body);
  const clean = {};
  for (const k of Object.keys(DEFAULT_CONFIG)) clean[k] = merged[k];
  return clean;
}

/**
 * Evaluasi aturan sensor terhadap telemetri terbaru.
 * @param {object[]} recent  telemetri VALID terbaru dari perangkat, urut terbaru dulu (termasuk yang baru masuk)
 * @param {object} cfg       hasil mergeConfig
 * @returns {{ raise: object[], clear: string[] }}  raise = kandidat alert; clear = kategori yang kondisinya hilang
 */
function evaluateTelemetry(recent, cfg) {
  const raise = [];
  const clear = [];
  const latest = recent[0];
  if (!latest) return { raise, clear };

  const lastN = (n, field) => recent.slice(0, n).filter((r) => r[field] !== null && r[field] !== undefined);

  // Suhu maksimum thermal melewati ambang terkonfigurasi (N pembacaan berturut-turut)
  if (cfg.temp_max_c !== null) {
    const win = lastN(cfg.consecutive_readings, 'max_temp_c');
    if (win.length === cfg.consecutive_readings && win.every((r) => Number(r.max_temp_c) > cfg.temp_max_c)) {
      raise.push({
        category: 'temp_threshold',
        dedup_key: 'temp_threshold',
        priority: cfg.priority.temp_threshold,
        trigger_value: Number(latest.max_temp_c),
        trigger_unit: '°C',
        threshold: cfg.temp_max_c,
        message: `Indikasi suhu tinggi: suhu maksimum thermal > ${cfg.temp_max_c} °C pada ${cfg.consecutive_readings} pembacaan berturut-turut. Perlu verifikasi lapangan.`,
      });
    } else if (latest.max_temp_c !== null && Number(latest.max_temp_c) <= cfg.temp_max_c) {
      clear.push('temp_threshold');
    }
  }

  // Gas/asap (nilai mentah sensor) melewati ambang terkonfigurasi
  if (cfg.gas_raw_max !== null) {
    const win = lastN(cfg.consecutive_readings, 'gas_raw');
    if (win.length === cfg.consecutive_readings && win.every((r) => Number(r.gas_raw) > cfg.gas_raw_max)) {
      raise.push({
        category: 'gas_threshold',
        dedup_key: 'gas_threshold',
        priority: cfg.priority.gas_threshold,
        trigger_value: Number(latest.gas_raw),
        trigger_unit: 'raw',
        threshold: cfg.gas_raw_max,
        message: `Indikasi gas/asap: nilai sensor > ${cfg.gas_raw_max} (raw) pada ${cfg.consecutive_readings} pembacaan berturut-turut. Nilai belum terkalibrasi ke ppm.`,
      });
    } else if (latest.gas_raw !== null && Number(latest.gas_raw) <= cfg.gas_raw_max) {
      clear.push('gas_threshold');
    }
  }

  // Anomali audio — memakai flag dari perangkat sendiri
  {
    const n = cfg.audio_anomaly_consecutive;
    const win = lastN(n, 'audio_anomaly');
    if (win.length === n && win.every((r) => r.audio_anomaly === true)) {
      raise.push({
        category: 'audio_anomaly',
        dedup_key: 'audio_anomaly',
        priority: cfg.priority.audio_anomaly,
        trigger_value: latest.sound_level_db !== null ? Number(latest.sound_level_db) : null,
        trigger_unit: 'dB',
        threshold: null,
        message: `Indikasi anomali suara terdeteksi perangkat pada ${n} pembacaan berturut-turut${latest.dominant_freq_hz != null ? ` (frekuensi dominan ${latest.dominant_freq_hz} Hz)` : ''}.`,
      });
    } else if (latest.audio_anomaly === false) {
      clear.push('audio_anomaly');
    }
  }

  // Alarm dari perangkat
  if (latest.alarm_state === true) {
    raise.push({
      category: 'alarm_perangkat',
      dedup_key: 'alarm_perangkat',
      priority: cfg.priority.alarm_perangkat,
      trigger_value: null,
      trigger_unit: null,
      threshold: null,
      message: 'Perangkat melaporkan status alarm aktif.',
    });
  } else if (latest.alarm_state === false) {
    clear.push('alarm_perangkat');
  }

  return { raise, clear };
}

/**
 * Status koneksi perangkat dari waktu telemetri terakhir.
 * @returns 'never' | 'online' | 'late' | 'offline'
 */
function connectionState(lastTelemetryAt, cfg, now = Date.now()) {
  if (!lastTelemetryAt) return 'never';
  const ms = Date.parse(lastTelemetryAt);
  if (!Number.isFinite(ms)) return 'never';
  const age = (now - ms) / 1000;
  if (age > cfg.offline_after_s) return 'offline';
  if (age > cfg.telemetry_late_after_s) return 'late';
  return 'online';
}

function evaluateConnectivity(lastTelemetryAt, cfg, now = Date.now()) {
  const state = connectionState(lastTelemetryAt, cfg, now);
  const ageS = lastTelemetryAt ? Math.round((now - Date.parse(lastTelemetryAt)) / 1000) : null;
  if (state === 'offline') {
    return {
      state,
      raise: [{
        category: 'offline', dedup_key: 'offline', priority: cfg.priority.offline,
        trigger_value: ageS, trigger_unit: 'detik', threshold: cfg.offline_after_s,
        message: `Perangkat offline: tidak ada telemetri selama ${Math.round(ageS / 60)} menit.`,
      }],
      clear: ['telemetry_late'],
    };
  }
  if (state === 'late') {
    return {
      state,
      raise: [{
        category: 'telemetry_late', dedup_key: 'telemetry_late', priority: cfg.priority.telemetry_late,
        trigger_value: ageS, trigger_unit: 'detik', threshold: cfg.telemetry_late_after_s,
        message: `Telemetri terlambat: data terakhir ${ageS} detik lalu.`,
      }],
      clear: ['offline'],
    };
  }
  if (state === 'online') return { state, raise: [], clear: ['offline', 'telemetry_late'] };
  return { state, raise: [], clear: [] };
}

// Prioritas peringatan dari deteksi AI (severity dari layanan AI, bukan dihitung ulang).
function aiDetectionAlert(det, cfg) {
  const conf = Number(det.confidence);
  if (!Number.isFinite(conf) || conf < cfg.ai_min_confidence) return null;
  const sev = Number(det.severity);
  let priority = 'rendah';
  if (Number.isFinite(sev) && sev >= cfg.ai_severity_tinggi) priority = 'tinggi';
  else if (Number.isFinite(sev) && sev >= cfg.ai_severity_sedang) priority = 'sedang';
  return {
    category: 'ai_detection',
    dedup_key: `ai_detection:${det.defect || 'unknown'}`,
    priority,
    trigger_value: Math.round(conf * 100) / 100,
    trigger_unit: 'confidence',
    threshold: cfg.ai_min_confidence,
    message: `Model AI mendeteksi indikasi "${det.defect || 'kerusakan'}" (confidence ${conf.toFixed(2)}). Belum diverifikasi manusia.`,
  };
}

module.exports = {
  DEFAULT_CONFIG,
  mergeConfig,
  sanitizeConfigInput,
  evaluateTelemetry,
  evaluateConnectivity,
  connectionState,
  aiDetectionAlert,
};

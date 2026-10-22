const test = require('node:test');
const assert = require('node:assert');
require('./helpers/load');
const { normalizeTelemetry, normalizeFrame, parseThermalMatrix } = require('../src/lib/hardware/normalize');

const NOW = Date.parse('2026-10-22T01:31:00Z');
const SAMPLE = {
  device_id: 'GARDU-001',
  timestamp: '2026-10-22T09:30:00+08:00',
  telemetry: {
    thermal: { max_temp_c: 68.4, avg_temp_c: 41.2, delta_temp_c: 37.9, hotspot: { x: 14, y: 9 } },
    environment: { ambient_temp_c: 30.5, humidity_pct: 72 },
    sound: { sound_level_db: 62.3, dominant_freq_hz: 100, audio_anomaly: false },
    gas: { raw_value: 410 },
    distance: { distance_cm: 320 },
    device_status: { rssi_dbm: -58, alarm_state: false },
  },
};

test('payload contoh dari tim hardware valid & terpetakan lengkap', () => {
  const { row, errors } = normalizeTelemetry(SAMPLE, { expectedDeviceId: 'GARDU-001', now: NOW });
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(row.valid, true);
  assert.strictEqual(row.captured_at, '2026-10-22T01:30:00.000Z');
  assert.strictEqual(row.max_temp_c, 68.4);
  assert.strictEqual(row.delta_temp_c, 37.9);
  assert.strictEqual(row.hotspot_x, 14);
  assert.strictEqual(row.hotspot_y, 9);
  assert.strictEqual(row.humidity_pct, 72);
  assert.strictEqual(row.gas_raw, 410);
  assert.strictEqual(row.rssi_dbm, -58);
  assert.strictEqual(row.audio_anomaly, false);
  assert.strictEqual(row.alarm_state, false);
});

test('field yang tidak dikirim menjadi null, bukan 0', () => {
  const { row } = normalizeTelemetry({ device_id: 'GARDU-001', timestamp: SAMPLE.timestamp, telemetry: { thermal: { max_temp_c: 50 } } }, { now: NOW });
  assert.strictEqual(row.gas_raw, null);
  assert.strictEqual(row.sound_level_db, null);
  assert.strictEqual(row.pan_deg, null);
  assert.strictEqual(row.gps_lat, null);
  assert.strictEqual(row.valid, true);
});

test('nilai di luar rentang sensor ditandai tidak valid & dikosongkan', () => {
  const p = structuredClone(SAMPLE);
  p.telemetry.environment.humidity_pct = 140;
  p.telemetry.thermal.max_temp_c = 'panas';
  const { row, errors } = normalizeTelemetry(p, { now: NOW });
  assert.strictEqual(row.humidity_pct, null);
  assert.strictEqual(row.max_temp_c, null);
  assert.strictEqual(row.valid, false);
  assert.ok(errors.find((e) => e.field === 'humidity_pct'));
});

test('timestamp di masa depan / rusak -> captured_at = waktu server, timestamp_valid=false', () => {
  const p = { ...SAMPLE, timestamp: '2027-01-01T00:00:00Z' };
  const { row } = normalizeTelemetry(p, { now: NOW });
  assert.strictEqual(row.timestamp_valid, false);
  assert.strictEqual(row.captured_at, new Date(NOW).toISOString());
  assert.strictEqual(row.valid, false);
  const r2 = normalizeTelemetry({ ...SAMPLE, timestamp: 'kemarin' }, { now: NOW }).row;
  assert.strictEqual(r2.timestamp_valid, false);
});

test('device_id tidak cocok dengan path Firebase ditolak', () => {
  const { row, errors } = normalizeTelemetry(SAMPLE, { expectedDeviceId: 'GARDU-002', now: NOW });
  assert.strictEqual(row.valid, false);
  assert.ok(errors.find((e) => e.field === 'device_id'));
});

test('GPS hanya dipakai bila valid; (0,0) & tanpa fix diabaikan', () => {
  const p = structuredClone(SAMPLE);
  p.telemetry.gps = { lat: 0, lng: 0 };
  assert.strictEqual(normalizeTelemetry(p, { now: NOW }).row.gps_lat, null);
  p.telemetry.gps = { lat: -8.65, lng: 115.21, fix: false };
  const r = normalizeTelemetry(p, { now: NOW }).row;
  assert.strictEqual(r.gps_lat, null);
  assert.strictEqual(r.valid, true, 'GPS belum fix bukan alasan data tidak valid');
  p.telemetry.gps = { lat: -8.65, lng: 115.21, fix: true };
  assert.strictEqual(normalizeTelemetry(p, { now: NOW }).row.gps_lat, -8.65);
});

test('metadata frame: path harus di folder perangkat sendiri', () => {
  const base = { frame_id: 'F-1', device_id: 'GARDU-001', timestamp: SAMPLE.timestamp, frame_type: 'rgb', capture_mode: 'periodic' };
  const ok = normalizeFrame({ ...base, image_path: 'frames/GARDU-001/F-1.jpg', upload_status: 'uploaded' }, { expectedDeviceId: 'GARDU-001', now: NOW });
  assert.strictEqual(ok.storable, true);
  assert.strictEqual(ok.row.upload_status, 'uploaded');
  const bad = normalizeFrame({ ...base, image_path: 'frames/GARDU-999/x.jpg', upload_status: 'uploaded' }, { expectedDeviceId: 'GARDU-001', now: NOW });
  assert.strictEqual(bad.row.image_path, null);
  assert.strictEqual(bad.row.upload_status, 'failed');
  const trav = normalizeFrame({ ...base, image_path: 'frames/GARDU-001/../GARDU-2/x.jpg' }, { expectedDeviceId: 'GARDU-001', now: NOW });
  assert.strictEqual(trav.row.image_path, null);
  const noType = normalizeFrame({ ...base, frame_type: 'video' }, { now: NOW });
  assert.strictEqual(noType.storable, false);
});

test('matriks thermal 32x24 diparse; ukuran salah ditolak', () => {
  const data = Array.from({ length: 768 }, (_, i) => 30 + (i === 300 ? 40 : 0));
  const m = parseThermalMatrix({ width: 32, height: 24, data });
  assert.strictEqual(m.ok, true);
  assert.strictEqual(m.max, 70);
  assert.deepStrictEqual(m.hotspot, { x: 300 % 32, y: Math.floor(300 / 32) });
  assert.strictEqual(parseThermalMatrix(data.slice(0, 100)).ok, false);
});

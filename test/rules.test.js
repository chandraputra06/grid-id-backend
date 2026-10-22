const test = require('node:test');
const assert = require('node:assert');
require('./helpers/load');
const rules = require('../src/lib/hardware/rules');

const t = (o) => ({ max_temp_c: null, gas_raw: null, audio_anomaly: null, alarm_state: null, sound_level_db: null, ...o });

test('ambang suhu & gas default NONAKTIF (tidak ada ambang keselamatan buatan)', () => {
  const cfg = rules.mergeConfig({}, null);
  assert.strictEqual(cfg.temp_max_c, null);
  assert.strictEqual(cfg.gas_raw_max, null);
  const r = rules.evaluateTelemetry([t({ max_temp_c: 250 }), t({ max_temp_c: 250 }), t({ max_temp_c: 250 })], cfg);
  assert.strictEqual(r.raise.filter((x) => x.category === 'temp_threshold').length, 0);
});

test('satu pembacaan tinggi tidak memicu alert; N berturut-turut memicu', () => {
  const cfg = rules.mergeConfig({ temp_max_c: 80, consecutive_readings: 3 }, null);
  let r = rules.evaluateTelemetry([t({ max_temp_c: 90 }), t({ max_temp_c: 60 }), t({ max_temp_c: 60 })], cfg);
  assert.strictEqual(r.raise.length, 0);
  r = rules.evaluateTelemetry([t({ max_temp_c: 90 })], cfg);
  assert.strictEqual(r.raise.length, 0, 'kurang dari N pembacaan');
  r = rules.evaluateTelemetry([t({ max_temp_c: 90 }), t({ max_temp_c: 85 }), t({ max_temp_c: 81 })], cfg);
  assert.strictEqual(r.raise[0].category, 'temp_threshold');
  assert.match(r.raise[0].message, /Indikasi/);
  r = rules.evaluateTelemetry([t({ max_temp_c: 70 })], cfg);
  assert.ok(r.clear.includes('temp_threshold'));
});

test('override per perangkat menimpa global; input tak dikenal diabaikan', () => {
  const cfg = rules.mergeConfig({ temp_max_c: 80, priority: { offline: 'tinggi' } }, { temp_max_c: 95, hack: 1, priority: { offline: 'gawat' } });
  assert.strictEqual(cfg.temp_max_c, 95);
  assert.strictEqual(cfg.priority.offline, 'tinggi');
  assert.strictEqual(cfg.hack, undefined);
  const clean = rules.sanitizeConfigInput({ offline_after_s: 60, telemetry_late_after_s: 120 });
  assert.ok(clean.offline_after_s >= clean.telemetry_late_after_s);
});

test('status koneksi: never / online / late / offline', () => {
  const cfg = rules.mergeConfig({}, null);
  const now = Date.parse('2026-10-22T02:00:00Z');
  assert.strictEqual(rules.connectionState(null, cfg, now), 'never');
  assert.strictEqual(rules.connectionState('2026-10-22T01:59:30Z', cfg, now), 'online');
  assert.strictEqual(rules.connectionState('2026-10-22T01:55:00Z', cfg, now), 'late');
  assert.strictEqual(rules.connectionState('2026-10-22T01:40:00Z', cfg, now), 'offline');
  const c = rules.evaluateConnectivity('2026-10-22T01:40:00Z', cfg, now);
  assert.strictEqual(c.raise[0].category, 'offline');
  assert.strictEqual(rules.evaluateConnectivity(null, cfg, now).raise.length, 0, 'belum pernah kirim data bukan "offline"');
});

test('alert AI: di bawah ambang confidence tidak dibuat; prioritas dari severity layanan AI', () => {
  const cfg = rules.mergeConfig({}, null);
  assert.strictEqual(rules.aiDetectionAlert({ defect: 'korosi', confidence: 0.3, severity: 90 }, cfg), null);
  assert.strictEqual(rules.aiDetectionAlert({ defect: 'korosi', confidence: 0.8, severity: 90 }, cfg).priority, 'tinggi');
  assert.strictEqual(rules.aiDetectionAlert({ defect: 'korosi', confidence: 0.8, severity: 50 }, cfg).priority, 'sedang');
  assert.strictEqual(rules.aiDetectionAlert({ defect: 'korosi', confidence: 0.8 }, cfg).priority, 'rendah');
});

test('anomali audio memakai flag perangkat & butuh N berturut-turut', () => {
  const cfg = rules.mergeConfig({}, null);
  assert.strictEqual(rules.evaluateTelemetry([t({ audio_anomaly: true }), t({ audio_anomaly: false })], cfg).raise.length, 0);
  assert.strictEqual(rules.evaluateTelemetry([t({ audio_anomaly: true }), t({ audio_anomaly: true })], cfg).raise[0].category, 'audio_anomaly');
});

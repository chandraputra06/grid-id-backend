// Integrasi: ingest -> tabel -> service, dan isolasi data antar organisasi B2B.
const test = require('node:test');
const assert = require('node:assert');
const { withFakes } = require('./helpers/load');
const { createFakeSupabase } = require('./helpers/fake-supabase');

const A1 = '11111111-1111-4111-8111-111111111111';
const A2 = '22222222-2222-4222-8222-222222222222';
const D1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const D2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function setup() {
  const sb = createFakeSupabase({
    assets: [
      { id: A1, asset_code: 'GD-001', name: 'Gardu A', unit: 'ULP Denpasar' },
      { id: A2, asset_code: 'GD-002', name: 'Gardu B', unit: 'ULP Kuta' },
    ],
    devices: [
      { id: D1, device_code: 'GARDU-001', asset_id: A1, type: 'multisensor', alert_config: {}, capabilities: {} },
      { id: D2, device_code: 'GARDU-002', asset_id: A2, type: 'multisensor', alert_config: {}, capabilities: {} },
    ],
    hw_settings: [{ id: 1, config: { temp_max_c: 60, consecutive_readings: 2 } }],
  });
  const load = withFakes(sb);
  return { sb, ingest: load('src/lib/hardware/ingest.js'), svc: load('src/lib/hardware/service.js') };
}

const payload = (code, max, ts) => ({
  device_id: code,
  timestamp: ts || new Date().toISOString(),
  telemetry: { thermal: { max_temp_c: max }, sound: { sound_level_db: 50 } },
});

test('ingest telemetri: idempoten per firebase_key, perangkat jadi online', async () => {
  const { sb, ingest, svc } = setup();
  const dev = sb.tables.devices[0];
  const r1 = await ingest.ingestTelemetry(dev, payload('GARDU-001', 40), { firebaseKey: 'GARDU-001/-Nabc' });
  const r2 = await ingest.ingestTelemetry(dev, payload('GARDU-001', 40), { firebaseKey: 'GARDU-001/-Nabc' });
  assert.strictEqual(r1.stored, true);
  assert.strictEqual(r2.duplicate, true);
  assert.strictEqual(sb.tables.device_telemetry.length, 1);
  const list = await svc.listDevices({ kind: 'staff', assetIds: null, viewStream: true }, {});
  const d = list.devices.find((x) => x.id === D1);
  assert.strictEqual(d.connection, 'online');
  assert.strictEqual(d.latest.max_temp_c, 40);
  assert.strictEqual(list.devices.find((x) => x.id === D2).connection, 'never');
});

test('alert suhu muncul setelah N pembacaan berturut-turut dan terdeduplikasi', async () => {
  const { sb, ingest } = setup();
  const dev = sb.tables.devices[0];
  const base = Date.now() - 60000;
  await ingest.ingestTelemetry(dev, payload('GARDU-001', 70, new Date(base).toISOString()), { firebaseKey: 'k1' });
  assert.strictEqual((sb.tables.device_alerts || []).length, 0);
  await ingest.ingestTelemetry(dev, payload('GARDU-001', 72, new Date(base + 10000).toISOString()), { firebaseKey: 'k2' });
  await ingest.ingestTelemetry(dev, payload('GARDU-001', 75, new Date(base + 20000).toISOString()), { firebaseKey: 'k3' });
  const alerts = sb.tables.device_alerts.filter((a) => a.category === 'temp_threshold');
  assert.strictEqual(alerts.length, 1);
  assert.strictEqual(alerts[0].occurrences, 2);
  assert.strictEqual(alerts[0].threshold, 60);
});

test('B2B hanya melihat perangkat/telemetri/alert aset organisasinya', async () => {
  const { sb, ingest, svc } = setup();
  await ingest.ingestTelemetry(sb.tables.devices[0], payload('GARDU-001', 40), { firebaseKey: 'x1' });
  await ingest.ingestTelemetry(sb.tables.devices[1], payload('GARDU-002', 41), { firebaseKey: 'x2' });
  await ingest.upsertAlert(sb.tables.devices[1], { category: 'offline', dedup_key: 'offline', priority: 'sedang', message: 'x' });

  const orgA = { kind: 'b2b', assetIds: [A1], viewStream: false };
  const devs = await svc.listDevices(orgA, {});
  assert.deepStrictEqual(devs.devices.map((d) => d.id), [D1]);

  await assert.rejects(svc.getDevice(orgA, D2), (e) => e.status === 404);
  await assert.rejects(svc.telemetryHistory(orgA, D2, {}), (e) => e.status === 404);

  const al = await svc.listAlerts(orgA, {});
  assert.strictEqual(al.alerts.length, 0, 'alert perangkat org lain tidak terlihat');

  const empty = { kind: 'b2b', assetIds: [], viewStream: true };
  assert.strictEqual((await svc.listDevices(empty, {})).devices.length, 0);
  assert.strictEqual((await svc.listAlerts(empty, {})).alerts.length, 0);
  assert.strictEqual((await svc.listInspections(empty, {})).inspections.length, 0);

  const staff = { kind: 'staff', assetIds: null, viewStream: true };
  assert.strictEqual((await svc.listAlerts(staff, {})).alerts.length, 1);
});

test('B2B tanpa izin view_stream tidak menerima URL stream', async () => {
  const { sb, svc } = setup();
  sb.tables.devices[0].stream_url = 'https://stream.example/cam1.m3u8';
  sb.tables.devices[0].stream_type = 'hls';
  const noView = await svc.getDevice({ kind: 'b2b', assetIds: [A1], viewStream: false }, D1);
  assert.strictEqual(noView.device.stream, null);
  assert.strictEqual(noView.device.stream_configured, true);
  assert.strictEqual(noView.device.alert_config, undefined, 'konfigurasi internal tidak bocor ke B2B');
  const view = await svc.getDevice({ kind: 'b2b', assetIds: [A1], viewStream: true }, D1);
  assert.strictEqual(view.device.stream.type, 'hls');
});

test('frame milik perangkat lain ditolak (frame_id bentrok) & frame di luar scope 404', async () => {
  const { sb, ingest, svc } = setup();
  const ts = new Date().toISOString();
  const r = await ingest.ingestFrame(sb.tables.devices[0], {
    frame_id: 'F-100', device_id: 'GARDU-001', timestamp: ts, frame_type: 'rgb', image_path: 'frames/GARDU-001/F-100.jpg', upload_status: 'uploaded',
  });
  assert.strictEqual(r.stored, true);
  const clash = await ingest.ingestFrame(sb.tables.devices[1], {
    frame_id: 'F-100', device_id: 'GARDU-002', timestamp: ts, frame_type: 'rgb', image_path: 'frames/GARDU-002/F-100.jpg',
  });
  assert.strictEqual(clash.stored, false);
  await assert.rejects(svc.getFrame({ kind: 'b2b', assetIds: [A2], viewStream: true }, 'F-100'), (e) => e.status === 404);
  const ok = await svc.getFrame({ kind: 'b2b', assetIds: [A1], viewStream: true }, 'F-100');
  assert.strictEqual(ok.frame.frame_id, 'F-100');
  assert.strictEqual(ok.frame.image_path, undefined, 'path storage tidak diekspos');
  assert.strictEqual(ok.frame.image_url, null, 'tanpa Firebase Storage, URL tidak dikarang');
});

test('upload gagal memicu alert upload_failed', async () => {
  const { sb, ingest } = setup();
  await ingest.ingestFrame(sb.tables.devices[0], {
    frame_id: 'F-200', device_id: 'GARDU-001', timestamp: new Date().toISOString(), frame_type: 'rgb', upload_status: 'failed',
  });
  assert.ok(sb.tables.device_alerts.find((a) => a.category === 'upload_failed'));
});

test('overview, laporan, inspeksi & frame list berjalan tanpa error (staff & b2b)', async () => {
  const { sb, ingest, svc } = setup();
  const dev = sb.tables.devices[0];
  await ingest.ingestTelemetry(dev, payload('GARDU-001', 40), { firebaseKey: 'o1' });
  const fr = await ingest.ingestFrame(dev, {
    frame_id: 'F-300', device_id: 'GARDU-001', timestamp: new Date().toISOString(), frame_type: 'rgb', image_path: 'frames/GARDU-001/F-300.jpg', upload_status: 'uploaded',
  });
  // simulasikan hasil AI selesai
  const f = sb.tables.device_frames.find((x) => x.frame_id === 'F-300');
  f.inference_status = 'done';
  sb.tables.device_detections = [{ id: 'd1', frame_id: 'F-300', device_id: D1, defect: 'korosi', confidence: 0.81, severity: 55, bbox: { x: 0.5, y: 0.5, w: 0.2, h: 0.2 }, created_at: new Date().toISOString() }];
  assert.ok(fr.stored);
  for (const scope of [{ kind: 'staff', assetIds: null, viewStream: true }, { kind: 'b2b', assetIds: [A1], viewStream: true }]) {
    const ov = await svc.overview(scope, {});
    assert.strictEqual(ov.devices_total, scope.kind === 'staff' ? 2 : 1);
    assert.strictEqual(ov.inspections, 1);
    assert.strictEqual(ov.detections, 1);
    const ins = await svc.listInspections(scope, {});
    assert.strictEqual(ins.inspections[0].detections[0].defect, 'korosi');
    assert.strictEqual(ins.inspections[0].telemetry.max_temp_c, 40);
    assert.strictEqual(ins.inspections[0].followup_status, 'di_bawah_ambang');
    const byDefect = await svc.listInspections(scope, { defect: 'isolator_pecah' });
    assert.strictEqual(byDefect.inspections.length, 0);
    const rep = await svc.report(scope, {});
    assert.strictEqual(rep.summary.inspections, 1);
    assert.strictEqual(rep.detections_by_class[0].defect, 'korosi');
    const frames = await svc.listFrames(scope, { device_id: D1 });
    assert.strictEqual(frames.frames.length, 1);
  }
  const outside = await svc.listFrames({ kind: 'b2b', assetIds: [A2], viewStream: true }, {});
  assert.strictEqual(outside.frames.length, 0);
  await assert.rejects(svc.listInspections({ kind: 'staff', assetIds: null }, { from: 'bukan-tanggal' }), (e) => e.status === 400);
});

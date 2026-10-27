// /api/hardware — Hardware Monitoring untuk Supervisor PLN (juga admin & tim hardware).
// Dipasang di index.js di belakang requireAuth + requireRole('admin', 'supervisor', 'hardware').
const router = require('express').Router();
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/apiError');
const supabase = require('../config/supabase');
const firebase = require('../config/firebase');
const { requireRole } = require('../middleware/auth');
const { staffScope } = require('../lib/hardware/access');
const svc = require('../lib/hardware/service');
const ingest = require('../lib/hardware/ingest');
const bridge = require('../lib/hardware/bridge');
const adapter = require('../lib/hardware/sistemIotAdapter');
const rules = require('../lib/hardware/rules');

const SNAPSHOT_INTERVALS = [5, 10, 30, 60];
const STREAM_TYPES = ['mjpeg', 'hls', 'iframe'];

router.use(staffScope);

// GET /api/hardware/status — status integrasi apa adanya (tidak mengklaim terhubung sebelum terbukti).
// Mencakup DUA jalur sumber data: adapter REST (Sistem_IoT, dipakai alat saat ini) dan
// bridge firebase-admin lama. Dashboard menilai kesiapan dari salah satu yang aktif.
router.get(
  '/status',
  asyncHandler(async (req, res) => {
    const fb = firebase.publicStatus();
    const br = bridge.status();
    const ad = adapter.status();
    res.json({
      ok: true,
      data: {
        firebase: fb,
        bridge: {
          enabled: br.enabled,
          reason: br.reason,
          started_at: br.started_at,
          rtdb_connected: br.rtdb_connected,
          devices_attached: br.devices_attached,
          last_telemetry_event_at: br.last_telemetry_event_at,
          last_frame_event_at: br.last_frame_event_at,
          last_error: br.last_error,
          counters: br.counters,
        },
        adapter: {
          enabled: ad.enabled,
          reason: ad.reason,
          started_at: ad.started_at,
          last_poll_at: ad.last_poll_at,
          last_error: ad.last_error,
          counters: ad.counters,
        },
        ai_service: { configured: !!(process.env.GRID_AI_URL && process.env.GRID_AI_API_KEY) },
        time: new Date().toISOString(),
      },
    });
  })
);

router.get('/overview', asyncHandler(async (req, res) => res.json({ ok: true, data: await svc.overview(req.scope, req.query) })));
router.get('/devices', asyncHandler(async (req, res) => res.json({ ok: true, data: await svc.listDevices(req.scope, req.query) })));
router.get('/devices/:id', asyncHandler(async (req, res) => res.json({ ok: true, data: await svc.getDevice(req.scope, req.params.id) })));
router.get(
  '/devices/:id/telemetry',
  asyncHandler(async (req, res) => res.json({ ok: true, data: await svc.telemetryHistory(req.scope, req.params.id, req.query) }))
);
router.get('/frames', asyncHandler(async (req, res) => res.json({ ok: true, data: await svc.listFrames(req.scope, req.query) })));
router.get('/frames/:frameId', asyncHandler(async (req, res) => res.json({ ok: true, data: await svc.getFrame(req.scope, req.params.frameId) })));
router.get(
  '/frames/:frameId/thermal',
  asyncHandler(async (req, res) => res.json({ ok: true, data: await svc.thermalData(req.scope, req.params.frameId) }))
);
router.get('/inspections', asyncHandler(async (req, res) => res.json({ ok: true, data: await svc.listInspections(req.scope, req.query) })));
router.get('/alerts', asyncHandler(async (req, res) => res.json({ ok: true, data: await svc.listAlerts(req.scope, req.query) })));
router.get('/report', asyncHandler(async (req, res) => res.json({ ok: true, data: await svc.report(req.scope, req.query) })));

// PATCH /api/hardware/alerts/:id — tindak lanjut (Supervisor/Admin).
router.patch(
  '/alerts/:id',
  requireRole('admin', 'supervisor'),
  asyncHandler(async (req, res) => res.json({ ok: true, data: await svc.updateAlert(req.params.id, req.body, req.user) }))
);

// GET/PUT /api/hardware/settings — aturan peringatan global.
router.get(
  '/settings',
  asyncHandler(async (req, res) => {
    const cfg = await ingest.getGlobalConfig({ fresh: true });
    res.json({ ok: true, data: { config: rules.mergeConfig(cfg, null), defaults: rules.DEFAULT_CONFIG } });
  })
);
const saveSettings = [
  requireRole('admin', 'supervisor'),
  asyncHandler(async (req, res) => {
    const clean = rules.sanitizeConfigInput(req.body || {});
    const { error } = await supabase
      .from('hw_settings')
      .upsert({ id: 1, config: clean, updated_by: req.user.id, updated_at: new Date().toISOString() });
    if (error) throw new ApiError(500, 'db_error', error.message);
    ingest.invalidateSettings();
    res.json({ ok: true, data: { config: clean } });
  }),
];
router.put('/settings', ...saveSettings);
router.patch('/settings', ...saveSettings);

// PATCH /api/hardware/devices/:id/config — nama, stream, capabilities, override ambang (admin/hardware).
router.patch(
  '/devices/:id/config',
  requireRole('admin', 'hardware'),
  asyncHandler(async (req, res) => {
    await svc.deviceInScope(req.scope, req.params.id);
    const b = req.body || {};
    const patch = {};
    if (b.name !== undefined) patch.name = b.name ? String(b.name).slice(0, 120) : null;
    if (b.stream_url !== undefined) {
      if (b.stream_url) {
        let u;
        try {
          u = new URL(b.stream_url);
        } catch {
          throw new ApiError(400, 'bad_request', 'stream_url harus URL yang valid');
        }
        if (!['http:', 'https:'].includes(u.protocol)) throw new ApiError(400, 'bad_request', 'stream_url harus http/https');
        patch.stream_url = u.toString();
      } else patch.stream_url = null;
    }
    if (b.stream_type !== undefined) {
      if (b.stream_type && !STREAM_TYPES.includes(b.stream_type)) throw new ApiError(400, 'bad_request', 'stream_type harus mjpeg/hls/iframe');
      patch.stream_type = b.stream_type || null;
    }
    if (b.capabilities !== undefined) {
      const c = b.capabilities || {};
      patch.capabilities = { snapshot_interval_control: !!c.snapshot_interval_control, thermal_image: !!c.thermal_image };
    }
    if (b.alert_config !== undefined) {
      // Hanya simpan kunci yang dikirim (override per perangkat), divalidasi lewat mergeConfig.
      const merged = rules.mergeConfig({}, b.alert_config || {});
      const override = {};
      for (const k of Object.keys(b.alert_config || {})) if (k in merged) override[k] = merged[k];
      patch.alert_config = override;
    }
    if (!Object.keys(patch).length) throw new ApiError(400, 'bad_request', 'Tidak ada field untuk diupdate');
    const { data, error } = await supabase.from('devices').update(patch).eq('id', req.params.id).select('id').maybeSingle();
    if (error) throw new ApiError(500, 'db_error', error.message);
    if (!data) throw new ApiError(404, 'not_found', 'Perangkat tidak ditemukan');
    res.json({ ok: true, data: await svc.getDevice(req.scope, req.params.id) });
  })
);

// PUT /api/hardware/devices/:id/snapshot-interval — tulis interval ke Firebase /device_config.
// Hanya bila perangkat menyatakan mendukung (capabilities.snapshot_interval_control) & Firebase siap.
const saveInterval = [
  requireRole('admin', 'supervisor', 'hardware'),
  asyncHandler(async (req, res) => {
    const { device } = await svc.deviceInScope(req.scope, req.params.id);
    const s = Number((req.body || {}).interval_s);
    if (!SNAPSHOT_INTERVALS.includes(s)) throw new ApiError(400, 'bad_request', `interval_s harus salah satu: ${SNAPSHOT_INTERVALS.join(', ')}`);
    if (!(device.capabilities || {}).snapshot_interval_control) {
      throw new ApiError(409, 'not_supported', 'Perangkat belum mendukung pengaturan interval dari dashboard');
    }
    const w = await bridge.writeDeviceConfig(device.device_code, { snapshot_interval_s: s });
    if (!w.ok) throw new ApiError(503, 'firebase_unavailable', w.error);
    await supabase.from('devices').update({ snapshot_interval_s: s }).eq('id', device.id);
    res.json({ ok: true, data: { snapshot_interval_s: s, note: 'Terkirim ke Firebase. Berlaku setelah firmware membaca konfigurasi.' } });
  }),
];
router.put('/devices/:id/snapshot-interval', ...saveInterval);
router.patch('/devices/:id/snapshot-interval', ...saveInterval);

module.exports = router;
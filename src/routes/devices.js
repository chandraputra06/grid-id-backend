const router = require('express').Router();
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/apiError');
const supabase = require('../config/supabase');

const TYPES = ['camera', 'thermal', 'sensor', 'multisensor'];

// POST /api/devices — daftarkan alat (admin/hardware).
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    if (!b.device_code) throw new ApiError(400, 'bad_request', 'device_code wajib');
    if (b.type && !TYPES.includes(b.type)) throw new ApiError(400, 'bad_request', 'type harus camera/thermal/sensor/multisensor');
    const row = {
      device_code: b.device_code,
      name: b.name || null,
      type: b.type || null,
      asset_id: b.asset_id || null,
      status: b.status || 'offline',
      meta: b.meta || null,
    };
    const { data, error } = await supabase.from('devices').insert(row).select('*').single();
    if (error) throw new ApiError(400, 'create_failed', error.message);
    res.status(201).json({ ok: true, data });
  })
);

// GET /api/devices
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { data, error } = await supabase.from('devices').select('*').order('created_at', { ascending: false }).limit(500);
    if (error) throw new ApiError(500, 'db_error', error.message);
    res.json({ ok: true, data: data || [] });
  })
);

// GET /api/devices/:id
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { data, error } = await supabase.from('devices').select('*').eq('id', req.params.id).maybeSingle();
    if (error) throw new ApiError(500, 'db_error', error.message);
    if (!data) throw new ApiError(404, 'not_found', 'Alat tidak ditemukan');
    res.json({ ok: true, data });
  })
);

// PATCH /api/devices/:id — update status/meta/asset.
router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    const patch = {};
    if (b.type !== undefined) {
      if (b.type && !TYPES.includes(b.type)) throw new ApiError(400, 'bad_request', 'type tidak valid');
      patch.type = b.type;
    }
    if (b.asset_id !== undefined) patch.asset_id = b.asset_id;
    if (b.status !== undefined) patch.status = b.status;
    if (b.meta !== undefined) patch.meta = b.meta;
    if (Object.keys(patch).length === 0) throw new ApiError(400, 'bad_request', 'Tidak ada field untuk diupdate');

    const { data, error } = await supabase.from('devices').update(patch).eq('id', req.params.id).select('*').maybeSingle();
    if (error) throw new ApiError(500, 'db_error', error.message);
    if (!data) throw new ApiError(404, 'not_found', 'Alat tidak ditemukan');
    res.json({ ok: true, data });
  })
);

// POST /api/devices/:id/readings — alat kirim data (ingestion). Update last_seen & status online.
// Catatan: produksi sebaiknya pakai device token terpisah, bukan JWT user.
router.post(
  '/:id/readings',
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    const { data: dev } = await supabase.from('devices').select('id').eq('id', req.params.id).maybeSingle();
    if (!dev) throw new ApiError(404, 'not_found', 'Alat tidak ditemukan');

    const row = { device_id: req.params.id, payload: b.payload || b || null, captured_at: b.captured_at || new Date().toISOString() };
    const { data, error } = await supabase.from('device_readings').insert(row).select('*').single();
    if (error) throw new ApiError(500, 'db_error', error.message);

    await supabase.from('devices').update({ status: 'online', last_seen: new Date().toISOString() }).eq('id', req.params.id);
    res.status(201).json({ ok: true, data });
  })
);

// GET /api/devices/:id/readings — 100 pembacaan terbaru.
router.get(
  '/:id/readings',
  asyncHandler(async (req, res) => {
    const { data, error } = await supabase
      .from('device_readings')
      .select('*')
      .eq('device_id', req.params.id)
      .order('captured_at', { ascending: false })
      .limit(100);
    if (error) throw new ApiError(500, 'db_error', error.message);
    res.json({ ok: true, data: data || [] });
  })
);

module.exports = router;
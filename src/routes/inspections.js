const router = require('express').Router();
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/apiError');
const supabase = require('../config/supabase');

const LEVELS = ['kritis', 'waspada', 'aman'];

// POST /api/inspections — petugas input inspeksi detail.
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    if (!b.asset_id && !(b.lat != null && b.lng != null)) {
      throw new ApiError(400, 'bad_request', 'asset_id atau koordinat (lat/lng) wajib');
    }
    if (b.diagnosis_level && !LEVELS.includes(b.diagnosis_level)) {
      throw new ApiError(400, 'bad_request', 'diagnosis_level harus kritis/waspada/aman');
    }
    if (b.diagnosis_score != null && (b.diagnosis_score < 0 || b.diagnosis_score > 100)) {
      throw new ApiError(400, 'bad_request', 'diagnosis_score harus 0-100');
    }
    // readings: pengukuran lapangan (temperatur aset, suhu lingkungan, arus, beban trafo) — jsonb.
    const readings = b.readings && typeof b.readings === 'object' && !Array.isArray(b.readings) ? b.readings : null;
    const row = {
      asset_id: b.asset_id || null,
      petugas_id: req.user.id,
      device_type: b.device_type || null,
      serial_number: b.serial_number || null,
      lat: b.lat ?? null,
      lng: b.lng ?? null,
      address: b.address || null,
      diagnosis_score: b.diagnosis_score ?? null,
      diagnosis_level: b.diagnosis_level || null,
      diagnosis_text: b.diagnosis_text || null,
      humidity: b.humidity ?? null,
      weather: b.weather || null,
      readings,
      photos: b.photos || null,
    };
    const { data, error } = await supabase.from('inspections').insert(row).select('*').single();
    if (error) throw new ApiError(500, 'db_error', error.message);
    res.status(201).json({ ok: true, data });
  })
);

// GET /api/inspections?asset_id= — petugas lihat miliknya; supervisor/admin lihat semua.
router.get(
  '/',
  asyncHandler(async (req, res) => {
    let q = supabase.from('inspections').select('*').order('created_at', { ascending: false }).limit(200);
    if (req.query.asset_id) q = q.eq('asset_id', req.query.asset_id);
    if (req.user.role === 'petugas') q = q.eq('petugas_id', req.user.id);
    const { data, error } = await q;
    if (error) throw new ApiError(500, 'db_error', error.message);
    res.json({ ok: true, data: data || [] });
  })
);

// GET /api/inspections/:id
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { data, error } = await supabase.from('inspections').select('*').eq('id', req.params.id).maybeSingle();
    if (error) throw new ApiError(500, 'db_error', error.message);
    if (!data) throw new ApiError(404, 'not_found', 'Inspeksi tidak ditemukan');
    res.json({ ok: true, data });
  })
);

module.exports = router;
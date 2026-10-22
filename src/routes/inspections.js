const router = require('express').Router();
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/apiError');
const supabase = require('../config/supabase');

const LEVELS = ['kritis', 'waspada', 'aman'];
const REVIEW = ['checked', 'rejected'];
const isSuper = (r) => r === 'admin' || r === 'supervisor';

// Lampirkan ringkasan aset + nama petugas untuk tampilan review supervisor.
async function attach(rows) {
  const assetIds = [...new Set(rows.map((r) => r.asset_id).filter(Boolean))];
  const petugasIds = [...new Set(rows.map((r) => r.petugas_id).filter(Boolean))];
  const assets = {};
  const profs = {};
  if (assetIds.length) {
    const { data } = await supabase.from('assets').select('id, asset_code, name, unit, lat, lng').in('id', assetIds);
    (data || []).forEach((a) => (assets[a.id] = a));
  }
  if (petugasIds.length) {
    const { data } = await supabase.from('profiles').select('id, full_name').in('id', petugasIds);
    (data || []).forEach((p) => (profs[p.id] = p));
  }
  return rows.map((r) => ({ ...r, asset: assets[r.asset_id] || null, petugas: profs[r.petugas_id] || null }));
}

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

// GET /api/inspections?asset_id=&review_status= — petugas lihat miliknya; supervisor/admin lihat semua.
router.get(
  '/',
  asyncHandler(async (req, res) => {
    let q = supabase.from('inspections').select('*').order('created_at', { ascending: false }).limit(200);
    if (req.query.asset_id) q = q.eq('asset_id', req.query.asset_id);
    if (req.query.review_status) q = q.eq('review_status', req.query.review_status);
    if (req.user.role === 'petugas') q = q.eq('petugas_id', req.user.id);
    const { data, error } = await q;
    if (error) throw new ApiError(500, 'db_error', error.message);
    res.json({ ok: true, data: await attach(data || []) });
  })
);

// GET /api/inspections/:id
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { data, error } = await supabase.from('inspections').select('*').eq('id', req.params.id).maybeSingle();
    if (error) throw new ApiError(500, 'db_error', error.message);
    if (!data) throw new ApiError(404, 'not_found', 'Inspeksi tidak ditemukan');
    if (req.user.role === 'petugas' && data.petugas_id !== req.user.id) throw new ApiError(403, 'forbidden', 'Bukan inspeksimu');
    const [withMeta] = await attach([data]);
    res.json({ ok: true, data: withMeta });
  })
);

// PATCH /api/inspections/:id/review — keputusan supervisor/admin.
// body: { decision: 'checked'|'rejected', note? }
router.patch(
  '/:id/review',
  asyncHandler(async (req, res) => {
    if (!isSuper(req.user.role)) throw new ApiError(403, 'forbidden', 'Hanya supervisor/admin yang bisa meninjau');
    const { decision, note } = req.body || {};
    if (!REVIEW.includes(decision)) throw new ApiError(400, 'bad_request', "decision harus 'checked' atau 'rejected'");

    const { data: insp, error: e0 } = await supabase.from('inspections').select('id').eq('id', req.params.id).maybeSingle();
    if (e0) throw new ApiError(500, 'db_error', e0.message);
    if (!insp) throw new ApiError(404, 'not_found', 'Inspeksi tidak ditemukan');

    const { data, error } = await supabase
      .from('inspections')
      .update({
        review_status: decision,
        reviewed_by: req.user.id,
        reviewed_at: new Date().toISOString(),
        review_note: note || null,
      })
      .eq('id', insp.id)
      .select('*')
      .single();
    if (error) throw new ApiError(500, 'db_error', error.message);
    res.json({ ok: true, data });
  })
);

module.exports = router;
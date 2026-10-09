const router = require('express').Router();
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/apiError');
const supabase = require('../config/supabase');

// GET /api/assets
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { data, error } = await supabase
      .from('assets')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw new ApiError(500, 'db_error', error.message);
    res.json({ ok: true, data });
  })
);

// GET /api/assets/:id  (+ kondisi MAXIMO dummy + skor terakhir)
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { data: asset, error } = await supabase.from('assets').select('*').eq('id', id).single();
    if (error) throw new ApiError(404, 'not_found', 'Aset tidak ditemukan');

    const { data: maximo } = await supabase
      .from('maximo_conditions')
      .select('*')
      .eq('asset_id', id)
      .order('fetched_at', { ascending: false })
      .limit(1);

    const { data: score } = await supabase
      .from('risk_scores')
      .select('*')
      .eq('asset_id', id)
      .order('computed_at', { ascending: false })
      .limit(1);

    res.json({
      ok: true,
      data: { asset, maximo: (maximo && maximo[0]) || null, risk_score: (score && score[0]) || null },
    });
  })
);

const { computeForAsset } = require('../lib/riskScore');

// GET /api/assets/:id/score — hitung Risk Score (severity 40 / cuaca 35 / kepadatan 25)
router.get(
  '/:id/score',
  asyncHandler(async (req, res) => {
    const { data: asset, error } = await supabase.from('assets').select('*').eq('id', req.params.id).single();
    if (error) throw new ApiError(404, 'not_found', 'Aset tidak ditemukan');
    const score = await computeForAsset(asset, { persist: true });
    res.json({ ok: true, data: score });
  })
);

module.exports = router;

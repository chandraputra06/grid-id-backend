const router = require('express').Router();
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/apiError');
const supabase = require('../config/supabase');
const { computeForAsset } = require('../lib/riskScore');

// GET /api/prioritas — semua aset terurut Risk Score (desc)
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { data: assets, error } = await supabase.from('assets').select('*');
    if (error) throw new ApiError(500, 'db_error', error.message);

    const results = [];
    for (const a of assets) {
      const s = await computeForAsset(a, { persist: false });
      const { data: mc } = await supabase
        .from('maximo_conditions').select('condition_grade,condition_score')
        .eq('asset_id', a.id).order('fetched_at', { ascending: false }).limit(1);
      results.push({
        ...s,
        asset: { asset_code: a.asset_code, name: a.name, asset_type: a.asset_type, unit: a.unit, lat: a.lat, lng: a.lng },
        maximo: (mc && mc[0]) || null,
      });
    }
    results.sort((x, y) => y.score - x.score);
    res.json({ ok: true, data: results });
  })
);

module.exports = router;
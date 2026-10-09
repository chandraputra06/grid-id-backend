const router = require('express').Router();
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/apiError');
const supabase = require('../config/supabase');

// GET /api/prioritas — daftar aset terurut Risk Score (GRID vs MAXIMO).
// PLACEHOLDER: akan terisi setelah Risk Score Engine mengisi tabel risk_scores.
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { data, error } = await supabase
      .from('risk_scores')
      .select(
        '*, assets:asset_id(asset_code,name,asset_type,unit,lat,lng), maximo:maximo_condition_id(condition_grade,condition_score)'
      )
      .order('score', { ascending: false })
      .limit(200);
    if (error) throw new ApiError(500, 'db_error', error.message);
    res.json({ ok: true, data, note: 'Placeholder: terisi setelah Risk Score Engine aktif.' });
  })
);

module.exports = router;

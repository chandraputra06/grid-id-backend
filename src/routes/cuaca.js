const router = require('express').Router();
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/apiError');
const { getForecast } = require('../lib/bmkg');

// GET /api/cuaca?adm4=51.71.01.2008&horizon=24
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const adm4 = String(req.query.adm4 || '').trim();
    if (!adm4) throw new ApiError(400, 'bad_request', 'Parameter adm4 wajib diisi');
    const horizon = Math.min(72, Math.max(3, Number(req.query.horizon) || 24));
    const data = await getForecast(adm4, horizon);
    res.json({ ok: true, data });
  })
);

module.exports = router;

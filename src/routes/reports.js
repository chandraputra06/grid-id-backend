const router = require('express').Router();
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/apiError');
const supabase = require('../config/supabase');

// POST /api/reports  — foto diupload ke Storage lebih dulu, kirim URL-nya.
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const {
      asset_id = null,
      source = 'warga',
      reporter_name = null,
      reporter_contact = null,
      photo_url,
      description = null,
      lat = null,
      lng = null,
    } = req.body || {};

    if (!photo_url) throw new ApiError(400, 'bad_request', 'photo_url wajib diisi');

    const { data, error } = await supabase
      .from('reports')
      .insert({ asset_id, source, reporter_name, reporter_contact, photo_url, description, lat, lng })
      .select()
      .single();
    if (error) throw new ApiError(500, 'db_error', error.message);

    res.status(201).json({ ok: true, data });
  })
);

// GET /api/reports  — 100 laporan terbaru
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { data, error } = await supabase
      .from('reports')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) throw new ApiError(500, 'db_error', error.message);
    res.json({ ok: true, data });
  })
);

module.exports = router;

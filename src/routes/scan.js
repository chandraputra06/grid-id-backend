const router = require('express').Router();
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/apiError');
const supabase = require('../config/supabase');
const { mockInfer } = require('../lib/inference');
const { computeForAsset } = require('../lib/riskScore');

// POST /api/scan
// Body: { report_id }  ATAU  { photo_url, asset_id?, source?, description?, lat?, lng? }
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { report_id } = req.body || {};
    let report;

    if (report_id) {
      const { data, error } = await supabase.from('reports').select('*').eq('id', report_id).single();
      if (error) throw new ApiError(404, 'not_found', 'Laporan tidak ditemukan');
      report = data;
    } else {
      const {
        photo_url, asset_id = null, source = 'warga',
        reporter_name = null, reporter_contact = null, description = null, lat = null, lng = null,
      } = req.body || {};
      if (!photo_url) throw new ApiError(400, 'bad_request', 'report_id atau photo_url wajib diisi');
      const { data, error } = await supabase
        .from('reports')
        .insert({ photo_url, asset_id, source, reporter_name, reporter_contact, description, lat, lng })
        .select().single();
      if (error) throw new ApiError(500, 'db_error', error.message);
      report = data;
    }

    // AI Screening (mock) -> detections
    const infer = mockInfer(report.photo_url);
    let detections = [];
    if (infer.length) {
      const rows = infer.map((d) => ({ report_id: report.id, ...d }));
      const { data, error } = await supabase.from('detections').insert(rows).select();
      if (error) throw new ApiError(500, 'db_error', error.message);
      detections = data;
    }

    // Recompute Risk Score kalau laporan terkait aset
    let risk_score = null;
    if (report.asset_id) {
      const { data: asset } = await supabase.from('assets').select('*').eq('id', report.asset_id).single();
      if (asset) risk_score = await computeForAsset(asset, { persist: true });
    }

    res.status(201).json({ ok: true, data: { report, detections, risk_score } });
  })
);

module.exports = router;
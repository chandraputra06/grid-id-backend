const router = require('express').Router();
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/apiError');
const supabase = require('../config/supabase');
const aiClient = require('../lib/aiClient');
const { computeForAsset } = require('../lib/riskScore');
const notifier = require('../lib/alertNotifier');

// Unduh byte foto dari URL (storage Supabase) untuk dikirim ke layanan AI (multipart).
async function fetchImageBuffer(photoUrl) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(photoUrl, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`gagal mengunduh foto (HTTP ${r.status})`);
    return Buffer.from(await r.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

function filenameFromUrl(u) {
  try {
    return decodeURIComponent(new URL(u).pathname.split('/').pop() || '') || 'upload.jpg';
  } catch {
    return 'upload.jpg';
  }
}

// POST /api/scan
// Body: { report_id }  ATAU  { photo_url, asset_id?, source?, description?, lat?, lng? }
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { report_id } = req.body || {};
    let report;

    if (report_id) {
      const { data, error } = await supabase.from('reports').select('*').eq('id', report_id).maybeSingle();
      if (error) throw new ApiError(500, 'db_error', error.message);
      if (!data) throw new ApiError(404, 'not_found', 'Laporan tidak ditemukan');
      report = data;
    } else {
      const {
        photo_url, asset_id = null, source = 'warga',
        reporter_name = null, reporter_contact = null, description = null, lat = null, lng = null,
      } = req.body || {};
      if (!photo_url) throw new ApiError(400, 'bad_request', 'report_id atau photo_url wajib diisi');
      const owner = (req.user && req.user.email) || reporter_contact;
      const ownerName = (req.user && req.user.profile && req.user.profile.full_name) || reporter_name;
      const { data, error } = await supabase
        .from('reports')
        .insert({ photo_url, asset_id, source, reporter_name: ownerName, reporter_contact: owner, description, lat, lng })
        .select().single();
      if (error) throw new ApiError(500, 'db_error', error.message);
      report = data;
    }

    // ---- AI screening via layanan nyata (yolov8s-grid7-v1.0) ----
    // Status eksplisit: 'done' | 'ai_unavailable'. JANGAN pernah menandai aman saat gagal.
    let ai_status = 'ai_unavailable';
    let detections = [];
    let severity_max = null;
    let model_version = null;
    let inference_ms = null;

    try {
      const buf = await fetchImageBuffer(report.photo_url);
      const result = await aiClient.detect(buf, filenameFromUrl(report.photo_url));

      if (result.ok) {
        ai_status = 'done';
        model_version = result.model_version;
        inference_ms = result.inference_ms;
        const dets = Array.isArray(result.detections) ? result.detections : [];
        // Severity dari layanan AI (jangan dihitung ulang). Tertinggi; 0 bila tak ada deteksi.
        severity_max = dets.reduce((m, d) => Math.max(m, Number(d.severity) || 0), 0);

        if (dets.length) {
          const rows = dets.map((d) => ({
            report_id: report.id,
            defect: d.defect || null,
            category: d.category || null,
            confidence: typeof d.confidence === 'number' ? d.confidence : null,
            severity: typeof d.severity === 'number' ? d.severity : null,
            bbox: d.bbox || null, // jsonb {x,y,w,h} — YOLO (titik tengah + lebar/tinggi, 0–1)
            model_version: d.model_version || result.model_version || null,
            inference_ms: typeof result.inference_ms === 'number' ? result.inference_ms : null,
          }));
          const { data, error } = await supabase.from('detections').insert(rows).select();
          if (error) throw new ApiError(500, 'db_error', error.message);
          detections = data;
        }
      }
      // result.ok === false -> ai_status tetap 'ai_unavailable' (atau 'ai_error' dari client); tidak aman.
    } catch (e) {
      // Kegagalan unduh/parse/insert -> JANGAN crash, JANGAN tandai aman.
      ai_status = 'ai_unavailable';
      console.error('[scan] AI screening gagal:', e && e.message);
    }

    // Catat status AI pada laporan (butuh migrasi 004).
    await supabase.from('reports').update({
      ai_status,
      ai_model_version: model_version,
      ai_severity_max: ai_status === 'done' ? severity_max : null,
      ai_inference_ms: inference_ms,
    }).eq('id', report.id);

    // Alur B — laporan dengan deteksi AI berisiko tinggi (severity >= 70) -> email peringatan area.
    // Fire-and-forget: tidak memblok respons & tidak menggagalkan scan bila email gagal.
    if (ai_status === 'done' && severity_max >= 70) {
      notifier
        .notifyCriticalArea({ ...report, lat: report.lat, lng: report.lng, ai_severity_max: severity_max }, { severity: severity_max })
        .catch(() => {});
    }

    // Recompute Risk Score hanya bila AI sukses & laporan terkait aset.
    // Komponen severity 40% = severity tertinggi (0 bila tak ada deteksi). Cuaca 35% & kepadatan 25% tetap.
    let risk_score = null;
    if (report.asset_id && ai_status === 'done') {
      const { data: asset } = await supabase.from('assets').select('*').eq('id', report.asset_id).maybeSingle();
      if (asset) risk_score = await computeForAsset(asset, { persist: true });
    }

    res.status(201).json({
      ok: true,
      data: {
        report: { ...report, ai_status, ai_model_version: model_version, ai_severity_max: ai_status === 'done' ? severity_max : null },
        ai_status,
        detections,
        risk_score,
      },
    });
  })
);

module.exports = router;
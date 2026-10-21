const router = require('express').Router();
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/apiError');
const supabase = require('../config/supabase');
const { computeForAsset } = require('../lib/riskScore');

// Scope peta & ringkasan sesuai role:
//  - petugas            -> hanya aset yang ditugaskan kepadanya
//  - admin & supervisor -> seluruh aset (pandangan nasional)

async function assignedAssetIds(userId) {
  const { data, error } = await supabase.from('assignments').select('asset_id').eq('assigned_to', userId);
  if (error) throw new ApiError(500, 'db_error', error.message);
  return [...new Set((data || []).map((a) => a.asset_id).filter(Boolean))];
}

// Hitung skor aset (tanpa simpan). Bila assetIds diberikan (array), hanya aset itu yang diambil;
// array kosong -> tidak ada aset.
async function scoreAssets(assetIds) {
  let q = supabase.from('assets').select('*');
  if (Array.isArray(assetIds)) {
    if (assetIds.length === 0) return [];
    q = q.in('id', assetIds);
  }
  const { data: assets, error } = await q;
  if (error) throw new ApiError(500, 'db_error', error.message);
  const results = [];
  for (const a of assets || []) {
    try {
      const score = await computeForAsset(a, { persist: false });
      results.push({ asset: a, score });
    } catch (e) {
      results.push({ asset: a, score: null });
    }
  }
  return results;
}

async function scopedScore(user) {
  if (user.role === 'petugas') return scoreAssets(await assignedAssetIds(user.id));
  return scoreAssets(null);
}

// Aset layak dipetakan hanya bila punya lat/lng numerik.
function hasCoord(a) {
  if (!a || a.lat == null || a.lng == null) return false;
  return !Number.isNaN(Number(a.lat)) && !Number.isNaN(Number(a.lng));
}

// GET /api/dashboard — ringkasan angka, mengikuti scope role.
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const scored = await scopedScore(req.user);
    const petugasScope = req.user.role === 'petugas';

    const by_level = { kritis: 0, waspada: 0, aman: 0 };
    for (const r of scored) {
      const lvl = r.score && r.score.level;
      if (lvl && by_level[lvl] != null) by_level[lvl] += 1;
    }

    const aset_terkritis = scored
      .filter((r) => r.score)
      .sort((a, b) => b.score.score - a.score.score)
      .slice(0, 5)
      .map((r) => ({
        asset_id: r.asset.id,
        asset_code: r.asset.asset_code,
        name: r.asset.name,
        score: r.score.score,
        level: r.score.level,
      }));

    // Laporan: untuk petugas dibatasi ke aset yang ditugaskan (konsisten dengan peta).
    const scopeAssetIds = petugasScope ? scored.map((r) => r.asset.id) : null;
    let reports = [];
    if (!petugasScope) {
      const { data, error } = await supabase.from('reports').select('id, status');
      if (error) throw new ApiError(500, 'db_error', error.message);
      reports = data || [];
    } else if (scopeAssetIds.length) {
      const { data, error } = await supabase.from('reports').select('id, status').in('asset_id', scopeAssetIds);
      if (error) throw new ApiError(500, 'db_error', error.message);
      reports = data || [];
    }
    const laporan = { total: reports.length, baru: 0, diproses: 0, terverifikasi: 0, ditolak: 0 };
    for (const r of reports) if (laporan[r.status] != null) laporan[r.status] += 1;

    // Deteksi 7 hari: global untuk admin/supervisor; untuk petugas hanya pada laporan dalam scope-nya.
    const since = new Date(Date.now() - 7 * 864e5).toISOString();
    let deteksi7 = 0;
    if (!petugasScope) {
      const { count, error } = await supabase
        .from('detections')
        .select('id', { count: 'exact', head: true })
        .gte('created_at', since);
      if (error) throw new ApiError(500, 'db_error', error.message);
      deteksi7 = count || 0;
    } else {
      const reportIds = reports.map((r) => r.id);
      if (reportIds.length) {
        const { count, error } = await supabase
          .from('detections')
          .select('id', { count: 'exact', head: true })
          .gte('created_at', since)
          .in('report_id', reportIds);
        if (error) throw new ApiError(500, 'db_error', error.message);
        deteksi7 = count || 0;
      }
    }

    res.json({
      ok: true,
      data: {
        total_aset: scored.length,
        by_level,
        aset_terkritis,
        laporan,
        deteksi_7hari: deteksi7,
        generated_at: new Date().toISOString(),
        scope: petugasScope ? 'petugas' : 'nasional',
      },
    });
  })
);

// GET /api/dashboard/geojson — aset ber-koordinat sebagai GeoJSON FeatureCollection, sesuai scope role.
// Aset tanpa lat/lng tidak diikutkan (mencegah titik koordinat null di peta).
router.get(
  '/geojson',
  asyncHandler(async (req, res) => {
    const scored = await scopedScore(req.user);
    const features = scored
      .filter((r) => hasCoord(r.asset))
      .map((r) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [Number(r.asset.lng), Number(r.asset.lat)] },
        properties: {
          id: r.asset.id,
          asset_code: r.asset.asset_code,
          name: r.asset.name,
          asset_type: r.asset.asset_type,
          unit: r.asset.unit,
          criticality: r.asset.criticality,
          adm4: r.asset.adm4,
          score: r.score ? r.score.score : null,
          level: r.score ? r.score.level : null,
        },
      }));
    res.json({ ok: true, data: { type: 'FeatureCollection', features } });
  })
);

module.exports = router;
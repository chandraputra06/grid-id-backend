const router = require('express').Router();
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/apiError');
const supabase = require('../config/supabase');

const SELECT = 'id, status, source, description, photo_url, lat, lng, created_at, asset_id';

function toFeature(r) {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [Number(r.lng), Number(r.lat)] },
    properties: {
      id: r.id,
      status: r.status,
      source: r.source,
      description: r.description,
      photo_url: r.photo_url,
      created_at: r.created_at,
    },
  };
}

// Hanya baris ber-koordinat, terbaru dulu, dibatasi 500.
function withCoord(q) {
  return q.not('lat', 'is', null).not('lng', 'is', null).order('created_at', { ascending: false }).limit(500);
}

// id laporan yang ditindaklanjuti penugasan (pola '#LPR:<id>' pada problem_desc).
function linkedReportIds(assignments) {
  const ids = new Set();
  for (const a of assignments || []) {
    const matches = (a.problem_desc || '').match(/#LPR:([^\s]+)/g);
    if (matches) matches.forEach((m) => ids.add(m.slice(5)));
  }
  return [...ids];
}

// GET /api/map/reports — laporan ber-koordinat sebagai GeoJSON (hanya staf), sesuai scope role.
// Privasi: lokasi & thumbnail laporan tidak dibuka ke publik.
//  - petugas            -> laporan pada aset yang ditugaskan + laporan yang ditindaklanjuti tugasnya
//  - admin & supervisor -> seluruh laporan ber-koordinat
router.get(
  '/reports',
  asyncHandler(async (req, res) => {
    if (req.user.role === 'petugas') {
      const { data: asg, error: eAsg } = await supabase
        .from('assignments')
        .select('asset_id, problem_desc')
        .eq('assigned_to', req.user.id);
      if (eAsg) throw new ApiError(500, 'db_error', eAsg.message);

      const assetIds = [...new Set((asg || []).map((a) => a.asset_id).filter(Boolean))];
      const reportIds = linkedReportIds(asg);

      const byId = new Map();
      if (assetIds.length) {
        const { data, error } = await withCoord(supabase.from('reports').select(SELECT).in('asset_id', assetIds));
        if (error) throw new ApiError(500, 'db_error', error.message);
        (data || []).forEach((r) => byId.set(r.id, r));
      }
      if (reportIds.length) {
        const { data, error } = await withCoord(supabase.from('reports').select(SELECT).in('id', reportIds));
        if (error) throw new ApiError(500, 'db_error', error.message);
        (data || []).forEach((r) => byId.set(r.id, r));
      }

      const features = [...byId.values()].map(toFeature);
      return res.json({ ok: true, data: { type: 'FeatureCollection', features } });
    }

    // admin & supervisor
    const { data, error } = await withCoord(supabase.from('reports').select(SELECT));
    if (error) throw new ApiError(500, 'db_error', error.message);
    const features = (data || []).map(toFeature);
    res.json({ ok: true, data: { type: 'FeatureCollection', features } });
  })
);

module.exports = router;
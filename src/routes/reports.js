const router = require('express').Router();
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/apiError');
const supabase = require('../config/supabase');
const { requireRole } = require('../middleware/auth');

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

    // kaitkan ke akun yang login (dipakai poin/misi). Nama & email diambil dari server, bukan dari klien.
    const owner = (req.user && req.user.email) || reporter_contact;
    const ownerName = (req.user && req.user.profile && req.user.profile.full_name) || reporter_name;

    const { data, error } = await supabase
      .from('reports')
      .insert({ asset_id, source, reporter_name: ownerName, reporter_contact: owner, photo_url, description, lat, lng })
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

// DELETE /api/reports/:id  — hapus permanen satu laporan.
// Hanya admin & supervisor (router ini sudah di belakang requireAuth di index.js).
// Guard: hanya laporan berstatus 'ditolak' yang boleh dihapus permanen — sesuai
// tombol "Hapus permanen" di antrean Verifikasi. Deteksi AI terkait (detections.report_id)
// ikut terhapus otomatis lewat FK ON DELETE CASCADE.
router.delete(
  '/:id',
  requireRole('admin', 'supervisor'),
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const { data: rep, error: e0 } = await supabase
      .from('reports')
      .select('id, status, photo_url')
      .eq('id', id)
      .maybeSingle();
    if (e0) throw new ApiError(500, 'db_error', e0.message);
    if (!rep) throw new ApiError(404, 'not_found', 'Laporan tidak ditemukan');

    if (rep.status !== 'ditolak') {
      throw new ApiError(
        409,
        'conflict',
        'Hanya laporan berstatus "ditolak" yang bisa dihapus permanen',
      );
    }

    const { error: eDel } = await supabase.from('reports').delete().eq('id', id);
    if (eDel) throw new ApiError(500, 'db_error', eDel.message);

    // Best-effort: bersihkan foto di Supabase Storage bila URL-nya memang objek Storage kita.
    // Tidak pernah menggagalkan DELETE kalau pembersihan file gagal (baris DB sudah terhapus).
    try {
      await removeStoragePhoto(rep.photo_url);
    } catch (_) {
      /* abaikan: file yatim bisa dibersihkan terpisah */
    }

    res.json({ ok: true, data: { id, deleted: true } });
  })
);

// Hapus objek Storage dari public/signed URL Supabase.
// Format: https://<proj>.supabase.co/storage/v1/object/{public|sign|authenticated}/<bucket>/<path...>
// Foto yang di-host eksternal (bukan Storage Supabase) dilewati.
async function removeStoragePhoto(url) {
  if (!url || typeof url !== 'string') return;
  const m = url.match(/\/storage\/v1\/object\/(?:public|sign|authenticated)\/([^/]+)\/(.+)$/);
  if (!m) return;
  const bucket = m[1];
  const path = decodeURIComponent(m[2].split('?')[0]);
  if (!bucket || !path) return;
  await supabase.storage.from(bucket).remove([path]);
}

module.exports = router;
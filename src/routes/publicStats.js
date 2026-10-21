const router = require('express').Router();
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/apiError');
const supabase = require('../config/supabase');

// GET /api/public/stats — angka agregat untuk landing page (PUBLIK, tanpa login).
// Hanya mengembalikan angka total; tidak ada data personal/lokasi laporan.
// Di-cache di memori 5 menit supaya endpoint publik ini tidak membebani DB.
const TTL_MS = 5 * 60 * 1000;
let cache = { at: 0, data: null };

async function compute() {
  const [assetsRes, reportsRes] = await Promise.all([
    supabase.from('assets').select('adm4').not('adm4', 'is', null).limit(20000),
    supabase
      .from('reports')
      .select('status, source, reporter_name, reporter_contact')
      .limit(50000),
  ]);
  if (assetsRes.error) throw new ApiError(500, 'db_error', assetsRes.error.message);
  if (reportsRes.error) throw new ApiError(500, 'db_error', reportsRes.error.message);

  // Zona terpantau = jumlah kelurahan/desa (adm4) unik yang punya aset
  const zona = new Set((assetsRes.data || []).map((a) => a.adm4).filter(Boolean));

  let diproses = 0;
  let terverifikasi = 0;
  let ditolak = 0;
  const pelapor = new Set();
  for (const r of reportsRes.data || []) {
    // diproses = sudah lewat antrean 'baru' (diproses / terverifikasi / ditolak)
    if (r.status && r.status !== 'baru') diproses += 1;
    if (r.status === 'terverifikasi') terverifikasi += 1;
    if (r.status === 'ditolak') ditolak += 1;

    // warga terlibat = pelapor unik dari sumber 'warga'
    if (r.source === 'warga') {
      const key = String(r.reporter_contact || r.reporter_name || '').trim().toLowerCase();
      if (key) pelapor.add(key);
    }
  }

  // Proxy akurasi: dari laporan yang sudah diputuskan supervisor, berapa % dikonfirmasi benar.
  const keputusan = terverifikasi + ditolak;
  const akurasi = keputusan > 0 ? Math.round((terverifikasi / keputusan) * 100) : null;

  return {
    zona_terpantau: zona.size,
    laporan_diproses: diproses,
    warga_terlibat: pelapor.size,
    akurasi_prediksi: akurasi,
    generated_at: new Date().toISOString(),
  };
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    if (!cache.data || Date.now() - cache.at > TTL_MS) {
      cache = { at: Date.now(), data: await compute() };
    }
    res.set('Cache-Control', 'public, max-age=60');
    res.json({ ok: true, data: cache.data });
  })
);

module.exports = router;
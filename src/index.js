const express = require('express');
const cors = require('cors');
const env = require('./config/env');
const { notFound, errorHandler } = require('./middleware/errorHandler');
const swaggerUi = require('swagger-ui-express');
const openapi = require('./docs/openapi');
const { requireAuth, requireRole } = require('./middleware/auth');

const app = express();

// CORS_ORIGIN boleh berisi beberapa origin dipisah koma, mis.
//   CORS_ORIGIN=https://grid-id.com,https://www.grid-id.com
// CORS_ALLOW_LOCALHOST=true -> izinkan juga http://localhost:<port> & http://127.0.0.1:<port> (untuk debugging).
const allowedOrigins = String(env.CORS_ORIGIN || '*').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
const LOCALHOST_RE = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
app.use(
  cors({
    origin(origin, cb) {
      // Request tanpa Origin (curl, Postman, server-to-server) tidak terkena CORS.
      if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) return cb(null, true);
      if (env.CORS_ALLOW_LOCALHOST && LOCALHOST_RE.test(origin)) return cb(null, true);
      return cb(null, false);
    },
  })
);
app.use(express.json({ limit: '2mb' }));

// Docs (publik)
app.get('/api/openapi.json', (req, res) => res.json(openapi));
app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(openapi, { customSiteTitle: 'GRID.ID API Docs' }));

// Publik (tanpa login)
app.use('/api/health', require('./routes/health'));
app.use('/api/cuaca', require('./routes/cuaca'));
app.use('/api/public/laporan', require('./routes/publicLaporan'));
app.use('/api/public/stats', require('./routes/publicStats'));

// Jangan cache respon yang menentukan identitas/role — cegah 304 role basi.
function noStore(req, res, next) {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  next();
}

// Perlu login (semua role)
app.use('/api/me', requireAuth, noStore, require('./routes/me'));
app.use('/api/gamifikasi', requireAuth, require('./routes/gamifikasi'));
app.use('/api/assets', requireAuth, require('./routes/assets'));
app.use('/api/reports', requireAuth, require('./routes/reports'));
app.use('/api/scan', requireAuth, require('./routes/scan'));
app.use('/api/uploads', requireAuth, require('./routes/uploads'));

// Admin + Petugas + Supervisor
app.use('/api/dashboard', requireAuth, requireRole('admin', 'petugas', 'supervisor'), require('./routes/dashboard'));
app.use('/api/prioritas', requireAuth, requireRole('admin', 'petugas', 'supervisor'), require('./routes/prioritas'));
app.use('/api/rekomendasi', requireAuth, requireRole('admin', 'petugas', 'supervisor'), require('./routes/rekomendasi'));
app.use('/api/detections', requireAuth, requireRole('admin', 'petugas', 'supervisor'), require('./routes/detections'));

// Dataset training: Admin + Hardware (tim alat/ML)
app.use('/api/dataset', requireAuth, requireRole('admin', 'hardware'), require('./routes/dataset'));

// Manajemen user: admin (semua role) + supervisor (hanya petugas; dibatasi di dalam route)
app.use('/api/users', requireAuth, requireRole('admin', 'supervisor'), require('./routes/users'));

// === Route v2 — alur inspeksi, penugasan, verifikasi ===
app.use('/api/inspections', requireAuth, requireRole('admin', 'petugas', 'supervisor'), require('./routes/inspections'));
app.use('/api/assignments', requireAuth, requireRole('admin', 'petugas', 'supervisor'), require('./routes/assignments'));
app.use('/api/review',      requireAuth, requireRole('admin', 'supervisor'),            require('./routes/review'));

// Dossier analisis AI (data pendukung verifikasi supervisor)
app.use('/api/analysis',    requireAuth, requireRole('admin', 'supervisor'),            require('./routes/analysis'));

// === Dummy MAXIMO adapter ===
app.use('/api/maximo', requireAuth, requireRole('admin', 'supervisor'), require('./routes/maximo'));

// === Peta: laporan ber-koordinat (staf) ===
app.use('/api/map', requireAuth, requireRole('admin', 'petugas', 'supervisor'), require('./routes/map'));

// === Ekosistem: reward (leaderboard) & mitra ===
app.use('/api/reward', requireAuth, requireRole('admin', 'petugas', 'supervisor'), require('./routes/reward'));
app.use('/api/mitra', requireAuth, requireRole('admin', 'petugas', 'supervisor'), require('./routes/mitra'));

// === Hardware / IoT (role hardware) ===
app.use('/api/devices', requireAuth, requireRole('admin', 'hardware'), require('./routes/devices'));

// === Hardware Monitoring (Firebase -> backend -> dashboard) ===
// Supervisor PLN + admin + tim hardware: seluruh perangkat.
// CATATAN: butuh src/config/firebase.js + paket 'firebase-admin'. Bila belum ada, komentari baris ini.
app.use('/api/hardware', requireAuth, noStore, requireRole('admin', 'supervisor', 'hardware'), require('./routes/hardware'));

// === GRID.ID Business Portal (B2B, multi-organisasi) ===
// Scope data = aset yang diberikan ke organisasi pengguna (ditegakkan di server).
// CATATAN: butuh tabel dari migrasi hardware/B2B (organizations, organization_assets,
// profiles.organization_id/org_role). Jalankan migrasi itu sebelum endpoint ini dipakai.
const { resolveBusinessScope } = require('./lib/hardware/access');
app.use('/api/business', requireAuth, noStore, requireRole('b2b'), resolveBusinessScope, require('./routes/business'));
app.use('/api/organizations', requireAuth, requireRole('admin'), require('./routes/organizations'));

// 404 + error handler (harus paling bawah)
app.use(notFound);
app.use(errorHandler);

app.listen(env.PORT, () => {
  console.log(`GRID.ID backend jalan di http://localhost:${env.PORT}`);
  // Bridge Firebase -> Supabase (tidak aktif bila Firebase belum dikonfigurasi; status di /api/hardware/status).
  // Dibungkus try/catch supaya kegagalan bridge TIDAK menjatuhkan server.
  try {
    const hw = require('./lib/hardware/bridge').start();
    if (!hw || !hw.enabled) console.log(`[hw-bridge] tidak aktif: ${hw && hw.reason ? hw.reason : 'tidak diketahui'}`);
  } catch (e) {
    console.error('[hw-bridge] gagal start:', e && e.message);
  }
  // Adapter Sistem_IoT (Firebase RTDB tim hardware) -> backend, via polling REST.
  // Aktif bila GRID_HW_RTDB_URL diisi; dibungkus try/catch agar tidak menjatuhkan server.
  try {
    require('./lib/hardware/sistemIotAdapter').start();
  } catch (e) {
    console.error('[hw-adapter] gagal start:', e && e.message);
  }
  console.log(`Coba: http://localhost:${env.PORT}/api/health`);
  console.log(`Docs: http://localhost:${env.PORT}/api/docs`);
});
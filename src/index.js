const express = require('express');
const cors = require('cors');
const env = require('./config/env');
const { notFound, errorHandler } = require('./middleware/errorHandler');
const swaggerUi = require('swagger-ui-express');
const openapi = require('./docs/openapi');
const { requireAuth, requireRole } = require('./middleware/auth');

const app = express();

app.use(cors({ origin: env.CORS_ORIGIN }));
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

// 404 + error handler (harus paling bawah)
app.use(notFound);
app.use(errorHandler);

app.listen(env.PORT, () => {
  console.log(`GRID.ID backend jalan di http://localhost:${env.PORT}`);
  console.log(`Coba: http://localhost:${env.PORT}/api/health`);
  console.log(`Docs: http://localhost:${env.PORT}/api/docs`);
});
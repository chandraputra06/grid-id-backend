// Firebase Admin (server-only). Dipakai untuk:
//  - membaca telemetri & metadata frame dari Realtime Database (bridge)
//  - membuat signed URL / mengunduh gambar dari Firebase Storage
//  - menulis konfigurasi perangkat (interval snapshot) ke RTDB
//
// Inisialisasi bersifat LAZY & TOLERAN: jika SDK belum terpasang atau env belum diisi,
// modul mengembalikan status yang jelas (bukan crash) agar dashboard bisa menampilkan
// "Firebase belum dikonfigurasi" secara jujur.
const fs = require('fs');
const env = require('./env');

let state = null; // { status, error, app, db, bucket, project_id, database_url, storage_bucket }

function parseServiceAccount() {
  const raw = env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (raw) {
    const text = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    return JSON.parse(text);
  }
  const p = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (p && fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  return null;
}

function init() {
  if (state) return state;
  const base = {
    project_id: env.FIREBASE_PROJECT_ID || null,
    database_url: env.FIREBASE_DATABASE_URL || null,
    storage_bucket: env.FIREBASE_STORAGE_BUCKET || null,
  };

  if (!env.FIREBASE_DATABASE_URL && !env.FIREBASE_STORAGE_BUCKET) {
    state = { ...base, status: 'not_configured', error: 'FIREBASE_DATABASE_URL / FIREBASE_STORAGE_BUCKET belum diset' };
    return state;
  }

  let admin;
  try {
    // eslint-disable-next-line global-require
    admin = require('firebase-admin');
  } catch (e) {
    state = { ...base, status: 'sdk_missing', error: "Paket 'firebase-admin' belum terpasang (npm install)" };
    return state;
  }

  let sa;
  try {
    sa = parseServiceAccount();
  } catch (e) {
    state = { ...base, status: 'error', error: 'Service account Firebase tidak valid (JSON rusak)' };
    return state;
  }
  if (!sa) {
    state = { ...base, status: 'not_configured', error: 'Kredensial service account Firebase belum diset' };
    return state;
  }

  try {
    const app = admin.initializeApp(
      {
        credential: admin.credential.cert(sa),
        projectId: env.FIREBASE_PROJECT_ID || sa.project_id,
        databaseURL: env.FIREBASE_DATABASE_URL || undefined,
        storageBucket: env.FIREBASE_STORAGE_BUCKET || undefined,
      },
      'grid-id-hardware'
    );
    state = {
      ...base,
      project_id: env.FIREBASE_PROJECT_ID || sa.project_id || null,
      // "initialized" = SDK siap; konektivitas sebenarnya dibuktikan oleh bridge (event pertama / ping).
      status: 'initialized',
      error: null,
      app,
      db: env.FIREBASE_DATABASE_URL ? app.database() : null,
      bucket: env.FIREBASE_STORAGE_BUCKET ? app.storage().bucket() : null,
    };
  } catch (e) {
    state = { ...base, status: 'error', error: `Gagal inisialisasi Firebase: ${e.message}` };
  }
  return state;
}

// Ringkasan aman untuk API (tanpa kredensial).
function publicStatus() {
  const s = init();
  return {
    status: s.status,
    error: s.error || null,
    project_id: s.project_id,
    realtime_database: !!s.db,
    storage: !!s.bucket,
  };
}

// Untuk test: reset singleton.
function _reset() {
  state = null;
}

module.exports = { init, publicStatus, _reset };

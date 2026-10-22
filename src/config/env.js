require('dotenv').config();

const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.warn(`[env] WARNING: variabel belum diset: ${missing.join(', ')} — salin .env.example ke .env lalu isi.`);
}

module.exports = {
  PORT: Number(process.env.PORT) || 4000,
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  BMKG_BASE_URL: process.env.BMKG_BASE_URL || 'https://api.bmkg.go.id/publik/prakiraan-cuaca',
  WEATHER_CACHE_MINUTES: Number(process.env.WEATHER_CACHE_MINUTES) || 45,
  CORS_ORIGIN: process.env.CORS_ORIGIN || '*',
  CORS_ALLOW_LOCALHOST: process.env.CORS_ALLOW_LOCALHOST === 'true',
  INFERENCE_URL: process.env.INFERENCE_URL || '',
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY || 'sb_publishable_D2TsrWhsQJIMdw9CGJ0NVA_Myu5OSdA',

  // === Hardware / Firebase (server-only; JANGAN dikirim ke frontend) ===
  // Kredensial service account: isi salah satu —
  //   FIREBASE_SERVICE_ACCOUNT_JSON  (isi JSON mentah atau base64 dari JSON)
  //   GOOGLE_APPLICATION_CREDENTIALS (path file JSON di server)
  FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID || '',
  FIREBASE_DATABASE_URL: process.env.FIREBASE_DATABASE_URL || '',
  FIREBASE_STORAGE_BUCKET: process.env.FIREBASE_STORAGE_BUCKET || '',
  FIREBASE_SERVICE_ACCOUNT_JSON: process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '',
  // Bridge Firebase -> Supabase. Default aktif bila Firebase terkonfigurasi; set 'false' untuk mematikan
  // (mis. saat backend dijalankan >1 instance: aktifkan di satu instance saja).
  HW_BRIDGE_ENABLED: process.env.HW_BRIDGE_ENABLED !== 'false',
  // Root path di Realtime Database
  HW_RTDB_TELEMETRY_ROOT: process.env.HW_RTDB_TELEMETRY_ROOT || 'telemetry',
  HW_RTDB_FRAMES_ROOT: process.env.HW_RTDB_FRAMES_ROOT || 'frames',
  HW_RTDB_CONFIG_ROOT: process.env.HW_RTDB_CONFIG_ROOT || 'device_config',
  // Masa berlaku signed URL gambar (detik)
  HW_SIGNED_URL_TTL_S: Number(process.env.HW_SIGNED_URL_TTL_S) || 900,
};

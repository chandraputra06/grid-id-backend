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
};

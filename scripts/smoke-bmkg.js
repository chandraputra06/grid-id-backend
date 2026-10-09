// Smoke test connector BMKG (tanpa DB): node scripts/smoke-bmkg.js
// Memastikan API BMKG Bali bisa diakses + struktur field sesuai parser.
require('../src/config/env');
const { fetchBmkgRaw, normalizeForecast, extractFactors } = require('../src/lib/bmkg');

const LOKASI = [
  { nama: 'Pemogan (Denpasar Selatan)', adm4: '51.71.01.2008' },
  { nama: 'Renon (Denpasar Selatan)', adm4: '51.71.01.1005' },
  { nama: 'Kuta (Badung)', adm4: '51.03.01.1002' },
];

(async () => {
  for (const l of LOKASI) {
    try {
      const raw = await fetchBmkgRaw(l.adm4);
      const slots = normalizeForecast(raw, l.adm4);
      const f = extractFactors(slots, 24);
      console.log(`\n== ${l.nama} (${l.adm4}) ==`);
      console.log(`jumlah slot: ${slots.length}`);
      console.log('contoh slot:', slots[0]);
      console.log('faktor cuaca 24 jam:', f);
    } catch (e) {
      console.error(`\n== ${l.nama} (${l.adm4}) GAGAL: ${e.message}`);
    }
  }
  console.log('\nSelesai. Cek: schema field (t/hu/ws/weather_desc), satuan ws (km/jam), timezone (valid_from), dan limit 60 req/menit/IP.');
})();

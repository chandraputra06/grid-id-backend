// scripts/seed.js — seed data dummy (idempotent). Jalankan: npm run seed
require('../src/config/env');
const supabase = require('../src/config/supabase');

const assets = [
  { asset_code: 'GD-PMG-07', name: 'Gardu Distribusi Pemogan 07', asset_type: 'gardu', lat: -8.7085, lng: 115.2000, adm4: '51.71.01.2008', unit: 'UP3 Bali Selatan', criticality: 'tinggi' },
  { asset_code: 'TR-PMG-12', name: 'Trafo Pemogan 12',            asset_type: 'trafo', lat: -8.7102, lng: 115.2035, adm4: '51.71.01.2008', unit: 'UP3 Bali Selatan', criticality: 'sedang' },
  { asset_code: 'GD-RNN-05', name: 'Gardu Distribusi Renon 05',   asset_type: 'gardu', lat: -8.6700, lng: 115.2370, adm4: '51.71.01.1005', unit: 'UP3 Bali Selatan', criticality: 'tinggi' },
  { asset_code: 'TG-RNN-18', name: 'Tiang Listrik Renon 18',      asset_type: 'tiang', lat: -8.6735, lng: 115.2402, adm4: '51.71.01.1005', unit: 'UP3 Bali Selatan', criticality: 'rendah' },
  { asset_code: 'TR-KUTA-03', name: 'Trafo Kuta 03',              asset_type: 'trafo', lat: -8.7180, lng: 115.1690, adm4: '51.03.01.1002', unit: 'UP3 Bali Selatan', criticality: 'tinggi' },
];

const maximoByCode = {
  'GD-PMG-07':  { condition_score: 68, condition_grade: 'sedang', criticality: 'tinggi', last_inspection_date: '2026-07-15', next_maintenance_date: '2026-12-01' },
  'TR-PMG-12':  { condition_score: 81, condition_grade: 'baik',   criticality: 'sedang', last_inspection_date: '2026-08-02', next_maintenance_date: '2027-02-02' },
  'GD-RNN-05':  { condition_score: 54, condition_grade: 'buruk',  criticality: 'tinggi', last_inspection_date: '2026-06-20', next_maintenance_date: '2026-11-05' },
  'TG-RNN-18':  { condition_score: 88, condition_grade: 'baik',   criticality: 'rendah', last_inspection_date: '2026-09-01', next_maintenance_date: '2027-03-01' },
  'TR-KUTA-03': { condition_score: 61, condition_grade: 'sedang', criticality: 'tinggi', last_inspection_date: '2026-07-28', next_maintenance_date: '2026-12-20' },
};

async function main() {
  // 1) upsert assets by asset_code (aman di-run ulang)
  const { data: rows, error: e1 } = await supabase
    .from('assets')
    .upsert(assets, { onConflict: 'asset_code' })
    .select('id, asset_code');
  if (e1) throw e1;
  console.log(`assets upserted: ${rows.length}`);

  // 2) maximo_conditions: insert hanya jika aset belum punya (idempotent)
  let seeded = 0;
  for (const a of rows) {
    const m = maximoByCode[a.asset_code];
    if (!m) continue;
    const { data: existing } = await supabase
      .from('maximo_conditions').select('id').eq('asset_id', a.id).limit(1);
    if (existing && existing.length) continue;
    const { error: e2 } = await supabase
      .from('maximo_conditions')
      .insert({ asset_id: a.id, is_mock: true, source: 'dummy', ...m });
    if (e2) throw e2;
    seeded++;
  }
  console.log(`maximo_conditions seeded: ${seeded} (is_mock=true)`);
  console.log('Selesai. Cek: GET /api/assets');
}

main().then(() => process.exit(0)).catch((e) => { console.error('Seed gagal:', e.message); process.exit(1); });
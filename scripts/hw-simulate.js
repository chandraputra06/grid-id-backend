// Simulasi pengiriman telemetri hardware GRID.ID — UNTUK PENGUJIAN SAJA.
// Semua paket diberi `simulated: true` sehingga tersimpan dengan source='simulasi'
// dan tampil berlabel SIMULASI di dashboard (tidak tercampur dengan data produksi).
//
// Pemakaian:
//   node scripts/hw-simulate.js --device GARDU-001 --firebase           # tulis ke Firebase RTDB (uji jalur penuh)
//   node scripts/hw-simulate.js --device GARDU-001 --direct             # langsung ke Supabase (tanpa Firebase)
//   node scripts/hw-simulate.js --device GARDU-001 --firebase --count 20 --interval 5
//   node scripts/hw-simulate.js --device GARDU-001 --firebase --file contoh.json   # kirim JSON milik sendiri
require('dotenv').config();
const fs = require('fs');
const env = require('../src/config/env');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const deviceCode = arg('device');
const mode = arg('firebase') ? 'firebase' : arg('direct') ? 'direct' : null;
const count = Number(arg('count', 1));
const intervalS = Number(arg('interval', 5));
const file = arg('file');

if (!deviceCode || !mode) {
  console.error('Pakai: --device <DEVICE_CODE> (--firebase | --direct) [--count N] [--interval detik] [--file payload.json]');
  process.exit(1);
}

const jitter = (v, d) => Math.round((v + (Math.random() * 2 - 1) * d) * 10) / 10;

function payload() {
  if (file) {
    const p = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { ...p, device_id: deviceCode, timestamp: new Date().toISOString(), simulated: true };
  }
  const max = jitter(68.4, 3);
  const ambient = jitter(30.5, 0.5);
  return {
    device_id: deviceCode,
    timestamp: new Date().toISOString(),
    simulated: true,
    telemetry: {
      thermal: { max_temp_c: max, avg_temp_c: jitter(41.2, 1.5), delta_temp_c: Math.round((max - ambient) * 10) / 10, hotspot: { x: 14, y: 9 } },
      environment: { ambient_temp_c: ambient, humidity_pct: Math.round(jitter(72, 3)) },
      sound: { sound_level_db: jitter(62.3, 2), dominant_freq_hz: 100, audio_anomaly: false },
      gas: { raw_value: Math.round(jitter(410, 15)) },
      distance: { distance_cm: 320 },
      device_status: { rssi_dbm: Math.round(jitter(-58, 4)), alarm_state: false },
    },
  };
}

async function main() {
  let send;
  if (mode === 'firebase') {
    const fb = require('../src/config/firebase').init();
    if (!fb.db) throw new Error(`Firebase RTDB tidak siap: ${fb.error}`);
    send = async (p) => {
      const ref = await fb.db.ref(`${env.HW_RTDB_TELEMETRY_ROOT}/${deviceCode}`).push(p);
      return `RTDB ${env.HW_RTDB_TELEMETRY_ROOT}/${deviceCode}/${ref.key}`;
    };
  } else {
    const supabase = require('../src/config/supabase');
    const ingest = require('../src/lib/hardware/ingest');
    const { data: device } = await supabase.from('devices').select('*').eq('device_code', deviceCode).maybeSingle();
    if (!device) throw new Error(`Perangkat ${deviceCode} belum terdaftar di tabel devices`);
    send = async (p) => {
      const r = await ingest.ingestTelemetry(device, p, { source: 'simulasi' });
      return r.stored ? `Supabase device_telemetry ${r.row.id} (valid=${r.row.valid})` : 'duplikat';
    };
  }
  for (let i = 0; i < count; i++) {
    const out = await send(payload());
    console.log(`[SIMULASI ${i + 1}/${count}] ${out}`);
    if (i < count - 1) await new Promise((r) => setTimeout(r, intervalS * 1000));
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('Simulasi gagal:', e.message);
  process.exit(1);
});

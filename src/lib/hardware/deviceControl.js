// src/lib/hardware/deviceControl.js
// Jalur perintah TURUN (web -> Firebase RTDB -> firmware Node 1 v3).
//
// Firmware v3 memoll node:  grid_id/nodes/node1_s3cam/commands
// dan HANYA bereaksi saat field `seq` BERUBAH (dibandingkan sebagai STRING).
// Dashboard lokal menulis:  PUT .../commands  { seq: String(Date.now()), action, ...extra }
// Firmware membalas di:      grid_id/nodes/node1_s3cam/commands_ack  { seq, action, result, ... }
//
// Aksi yang didukung firmware v3 (runCommand):
//   AUTO      { preset: 1..4 }      -> patroli otomatis
//   MANUAL    { pan, tilt }         -> arahkan servo (pan 0..145, tilt 65..100)
//   STEP      { step: 1..14 }       -> loncat ke langkah master sequence
//   STANDBY   {}                    -> posisi standby (pan 85, tilt 90)
//   SNAPSHOT  {}                    -> jepret manual
//   CALIBRATE {}                    -> kalibrasi mandiri 14 langkah
//   SIM_TEMP  { temp_c }            -> simulasi suhu (temp_c < 0 => matikan)
//   TRACK_ON / TRACK_OFF {}         -> tracking hotspot termal
//
// Memakai kredensial RTDB yang sama dengan adapter (REST, tanpa firebase-admin).
//
// ENV: GRID_HW_RTDB_URL, GRID_HW_RTDB_AUTH, GRID_HW_RTDB_ROOT (default "grid_id"),
//      GRID_HW_NODE1_PATH (default "nodes/node1_s3cam").

const RTDB_URL = (process.env.GRID_HW_RTDB_URL || '').replace(/\/+$/, '');
const AUTH = process.env.GRID_HW_RTDB_AUTH || '';
const ROOT = process.env.GRID_HW_RTDB_ROOT || 'grid_id';
const NODE1 = (process.env.GRID_HW_NODE1_PATH || 'nodes/node1_s3cam').replace(/^\/+|\/+$/g, '');

// Batas sudut — harus sama dengan #define firmware (alat tetap meng-constrain lagi).
const PAN_MIN = 0;
const PAN_MAX = 145;
const TILT_MIN = 65;
const TILT_MAX = 100;

const ACTIONS = new Set([
  'AUTO', 'MANUAL', 'STEP', 'STANDBY', 'SNAPSHOT', 'CALIBRATE', 'SIM_TEMP', 'TRACK_ON', 'TRACK_OFF',
]);

function clampInt(v, lo, hi) {
  const x = Number(v);
  if (!Number.isFinite(x)) return null;
  return Math.min(hi, Math.max(lo, Math.round(x)));
}

function nodeUrl(suffix) {
  const u = `${RTDB_URL}/${ROOT}/${NODE1}/${suffix}.json`;
  return AUTH ? `${u}?auth=${encodeURIComponent(AUTH)}` : u;
}

async function rtdb(method, suffix, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 7000);
  try {
    const r = await fetch(nodeUrl(suffix), {
      method,
      signal: ctrl.signal,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) throw new Error(`RTDB HTTP ${r.status}`);
    return await r.json().catch(() => null);
  } finally {
    clearTimeout(timer);
  }
}

function configured() {
  return Boolean(RTDB_URL);
}

function err(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// Tentukan action + field tambahan dari input.
// Terima dua gaya: { action, ... }  ATAU  { mode, pan, tilt, preset, snapshot }.
function resolveCommand(cmd = {}) {
  const extra = {};
  let action = cmd.action ? String(cmd.action).toUpperCase() : null;

  // Kompat dengan route lama (mode/pan/tilt/preset/snapshot).
  if (!action) {
    if (cmd.snapshot) action = 'SNAPSHOT';
    else if (cmd.mode) action = String(cmd.mode).toUpperCase();
  }
  if (!action) throw err('bad_request', "Butuh 'action' atau 'mode' (AUTO/MANUAL) atau snapshot:true");
  if (!ACTIONS.has(action)) throw err('bad_request', `action '${action}' tidak dikenal`);

  if (action === 'MANUAL') {
    const pan = clampInt(cmd.pan, PAN_MIN, PAN_MAX);
    const tilt = clampInt(cmd.tilt, TILT_MIN, TILT_MAX);
    if (pan == null || tilt == null) throw err('bad_request', 'pan & tilt wajib angka untuk mode MANUAL');
    extra.pan = pan;
    extra.tilt = tilt;
  } else if (action === 'AUTO') {
    const preset = clampInt(cmd.preset != null ? cmd.preset : 3, 1, 4);
    extra.preset = preset == null ? 3 : preset;
  } else if (action === 'STEP') {
    const step = clampInt(cmd.step, 1, 14);
    if (step == null) throw err('bad_request', 'step wajib 1..14');
    extra.step = step;
  } else if (action === 'SIM_TEMP') {
    const t = Number(cmd.temp_c != null ? cmd.temp_c : cmd.tempC);
    if (!Number.isFinite(t)) throw err('bad_request', 'temp_c wajib angka (negatif = matikan simulasi)');
    extra.temp_c = t;
  }
  // STANDBY, SNAPSHOT, CALIBRATE, TRACK_ON, TRACK_OFF: tanpa field tambahan.

  return { action, extra };
}

// Kirim satu perintah ke Node 1.
async function sendServoCommand(cmd = {}) {
  if (!configured()) throw err('rtdb_unconfigured', 'GRID_HW_RTDB_URL belum diset di server');

  const { action, extra } = resolveCommand(cmd);

  // seq unik sebagai STRING (firmware membandingkan string). Date.now() sudah cukup unik.
  const seq = String(Date.now());
  const body = Object.assign({ seq, action }, extra);

  // PUT (ganti seluruh node commands) — sama persis dengan dashboard lokal.
  await rtdb('PUT', 'commands', body);
  return body;
}

// (opsional) Baca balasan terakhir dari alat untuk seq tertentu.
async function readAck() {
  if (!configured()) return null;
  return rtdb('GET', 'commands_ack');
}

module.exports = {
  sendServoCommand,
  readAck,
  configured,
  limits: { PAN_MIN, PAN_MAX, TILT_MIN, TILT_MAX },
};
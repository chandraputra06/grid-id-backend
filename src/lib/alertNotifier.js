// src/lib/alertNotifier.js
// Resolusi penerima email per role + dua jenis notifikasi:
//   A) Alert hardware baru        -> role supervisor + hardware
//   B) Laporan warga jadi KRITIS  -> role admin + supervisor + b2b, plus warga di radius 5 km
// Email ada di auth.users (bukan profiles); warga "berdekatan" = yang pernah melapor dalam radius.
const supabase = require('../config/supabase');
const mailer = require('./mailer');

const CRITICAL_SEVERITY = 70; // ambang 'kritis' (selaras risk score & severityColor)
const AREA_RADIUS_KM = 5;
const AREA_MIN_INTERVAL_MS = 30 * 60 * 1000; // jeda minimum per area (in-memory, reset saat restart)
const lastAreaSent = new Map();

const distKm = (a, b) => {
  const dLat = (a.lat - b.lat) * 111.2;
  const dLng = (a.lng - b.lng) * 111.2 * Math.cos((a.lat * Math.PI) / 180);
  return Math.sqrt(dLat * dLat + dLng * dLng);
};

const esc = (s) =>
  String(s == null ? '' : s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

// Email akun berdasarkan role (gabungkan profiles.role dengan email di auth.users).
async function emailsByRole(roles) {
  const { data: profs, error } = await supabase.from('profiles').select('id').in('role', roles);
  if (error) return [];
  const ids = new Set((profs || []).map((p) => p.id));
  if (!ids.size) return [];
  const emails = [];
  let page = 1;
  for (;;) {
    const { data, error: e2 } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
    if (e2) break;
    const users = (data && data.users) || [];
    for (const u of users) if (ids.has(u.id) && u.email) emails.push(u.email);
    if (users.length < 1000 || page >= 20) break;
    page++;
  }
  return [...new Set(emails)];
}

// Email warga yang pernah melapor dalam radius (km) dari titik — proxy "warga berdekatan".
async function wargaEmailsNear(lat, lng, radiusKm = AREA_RADIUS_KM) {
  const dLat = radiusKm / 111.2;
  const dLng = radiusKm / (111.2 * Math.cos((lat * Math.PI) / 180));
  const { data } = await supabase
    .from('reports')
    .select('reporter_contact, lat, lng')
    .gte('lat', lat - dLat)
    .lte('lat', lat + dLat)
    .gte('lng', lng - dLng)
    .lte('lng', lng + dLng)
    .not('reporter_contact', 'is', null)
    .limit(3000);
  const set = new Set();
  for (const r of data || []) {
    if (r.lat == null || r.lng == null) continue;
    if (!/@/.test(r.reporter_contact)) continue; // reporter_contact bisa berisi no. HP; ambil yang email saja
    if (distKm({ lat, lng }, { lat: Number(r.lat), lng: Number(r.lng) }) <= radiusKm) set.add(r.reporter_contact);
  }
  return [...set];
}

// --- Alur A: alert hardware baru -> supervisor + hardware ---
async function notifyHardwareAlert(device, cand) {
  try {
    if (!mailer.isConfigured()) return;
    const to = await emailsByRole(['supervisor', 'hardware']);
    if (!to.length) return;
    const name = (device && (device.name || device.device_code)) || 'Perangkat';
    const val =
      cand.trigger_value != null ? `${cand.trigger_value}${cand.trigger_unit ? ' ' + cand.trigger_unit : ''}` : '—';
    const subject = `[GRID.ID] Alert ${cand.priority || ''} — ${name}`.trim();
    const html = `
      <div style="font-family:Arial,sans-serif;max-width:560px">
        <h2 style="color:#B91C1C;margin:0 0 8px">Peringatan Perangkat</h2>
        <p style="margin:0 0 12px">${esc(cand.message || 'Alert perangkat baru.')}</p>
        <table style="border-collapse:collapse;font-size:14px">
          <tr><td style="padding:4px 10px;color:#555">Perangkat</td><td style="padding:4px 10px"><b>${esc(name)}</b></td></tr>
          <tr><td style="padding:4px 10px;color:#555">Kategori</td><td style="padding:4px 10px">${esc(cand.category || '-')}</td></tr>
          <tr><td style="padding:4px 10px;color:#555">Prioritas</td><td style="padding:4px 10px">${esc(cand.priority || '-')}</td></tr>
          <tr><td style="padding:4px 10px;color:#555">Nilai pemicu</td><td style="padding:4px 10px">${esc(val)}${cand.threshold != null ? ` (ambang ${esc(cand.threshold)})` : ''}</td></tr>
        </table>
        <p style="color:#777;font-size:12px;margin-top:16px">Email otomatis GRID.ID. Buka dashboard Hardware Monitoring untuk detail.</p>
      </div>`;
    const text = `[GRID.ID] ${subject}\n${cand.message || ''}\nPerangkat: ${name}\nKategori: ${cand.category || '-'}\nPrioritas: ${cand.priority || '-'}\nNilai: ${val}`;
    await mailer.sendBroadcast({ recipients: to, subject, html, text });
  } catch (e) {
    console.error('[alertNotifier] hardware gagal:', e && e.message);
  }
}

// --- Alur B: laporan warga jadi KRITIS -> admin+supervisor+b2b + warga sekitar ---
async function notifyCriticalArea(report, opt = {}) {
  try {
    if (!mailer.isConfigured()) return;
    if (!report || report.lat == null || report.lng == null) return;
    const sev = Number(opt.severity != null ? opt.severity : report.ai_severity_max);
    if (!(sev >= CRITICAL_SEVERITY)) return;

    const lat = Number(report.lat);
    const lng = Number(report.lng);
    const key = `${lat.toFixed(2)},${lng.toFixed(2)}`; // sel ~1 km untuk throttle
    const now = Date.now();
    if (now - (lastAreaSent.get(key) || 0) < AREA_MIN_INTERVAL_MS) return;
    lastAreaSent.set(key, now);

    const staff = await emailsByRole(['admin', 'supervisor', 'b2b']);
    const warga = await wargaEmailsNear(lat, lng, AREA_RADIUS_KM);
    const to = [...new Set([...staff, ...warga])];
    if (!to.length) return;

    const koord = `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
    const subject = '[GRID.ID] Peringatan: area berisiko tinggi terdeteksi';
    const html = `
      <div style="font-family:Arial,sans-serif;max-width:560px">
        <h2 style="color:#B91C1C;margin:0 0 8px">Area Berisiko Tinggi</h2>
        <p style="margin:0 0 12px">AI GRID.ID mendeteksi indikasi kerusakan <b>berisiko tinggi</b> pada infrastruktur listrik di sekitar koordinat <b>${koord}</b>.</p>
        <p style="margin:0 0 12px"><b>Imbauan keselamatan:</b> jaga jarak minimal 5 meter dari tiang/kabel di area tersebut, hindari menyentuh kabel yang menjuntai, dan segera hubungi <b>PLN 123</b> bila melihat percikan, asap, atau kabel putus.</p>
        <p style="color:#777;font-size:12px;margin-top:16px">Email otomatis GRID.ID. Keputusan akhir tetap melalui verifikasi petugas.</p>
      </div>`;
    const text = `Area berisiko tinggi terdeteksi di sekitar ${koord}. Jaga jarak dari infrastruktur listrik; hubungi PLN 123.`;
    await mailer.sendBroadcast({ recipients: to, subject, html, text });
  } catch (e) {
    console.error('[alertNotifier] area kritis gagal:', e && e.message);
  }
}

module.exports = { notifyHardwareAlert, notifyCriticalArea, emailsByRole, wargaEmailsNear };
// Sistem poin / level / misi / lencana GRID.ID — SEMUA dihitung dari data yang sudah ada.
// Tidak ada tabel baru: poin diturunkan dari tabel `reports` (+ penugasan selesai),
// sehingga tidak bisa dipalsukan dari browser. Satu-satunya data yang disimpan adalah
// riwayat penukaran reward, di auth `app_metadata.grid_redeems` (hanya bisa ditulis server).
const supabase = require('../config/supabase');

/* ================= ATURAN (ubah angka di sini) ================= */
const TZ_MS = 8 * 3600 * 1000; // WITA
const DAY = 86400000;

const POINTS = {
  submit: 10, // 1 laporan valid (foto + lokasi), belum ditolak
  submitMaxPerDay: 5, // batas anti-spam: laporan ke-6 di hari yang sama tidak dapat poin
  verified: 30, // laporan di-ACC supervisor (terverifikasi / diproses)
  handled: 40, // laporan sudah ditindaklanjuti sampai penugasan selesai (berdampak nyata)
};

// Misi dinamis: terpenuhi otomatis kalau datanya ada. Bonus dihitung per hari/minggu.
const MISI = [
  { key: 'lapor_harian', label: 'Kirim 1 laporan temuan hari ini', pts: 20, period: 'day', need: (r) => true, hint: 'Kirim laporan lewat Scan (foto + lokasi aktif).' },
  { key: 'terverifikasi', label: '1 laporanmu terverifikasi minggu ini', pts: 50, period: 'week', need: (r) => r.verified, hint: 'Kirim laporan; poin cair setelah di-ACC supervisor.' },
  { key: 'ditangani', label: '1 laporanmu selesai ditangani minggu ini', pts: 80, period: 'week', need: (r) => r.handled, hint: 'Poin cair setelah petugas menyelesaikan penanganan.' },
];

// Level dari TOTAL poin yang pernah didapat (tidak turun saat tukar reward)
const LEVELS = [0, 200, 500, 1000, 2000, 3500, 5500, 8000, 12000, 18000];

// Lencana statis, terbuka otomatis saat total poin mencapai `at` (gambar: /public/<file>)
const MEDALS = [
  { file: 'medali1.png', name: 'Level 1', desc: 'Awal perjalananmu sebagai Penjaga Grid. Laporan pertamamu sudah menyalakan percikan.', at: 10 },
  { file: 'medali2.png', name: 'Level 2', desc: 'Sigap melaporkan kondisi berisiko saat cuaca ekstrem.', at: 100 },
  { file: 'medali3.png', name: 'Level 3', desc: 'Rajin menemukan kabel dan jaringan yang bermasalah di sekitarmu.', at: 250 },
  { file: 'medali4.png', name: 'Level 4', desc: 'Peduli pada pohon dan lingkungan di sekitar jaringan listrik.', at: 500 },
  { file: 'medali5.png', name: 'Level 5', desc: 'Jeli melihat tanda bahaya sebelum menjadi gangguan.', at: 800 },
  { file: 'medali6.png', name: 'Level 6', desc: 'Konsisten berkontribusi dan menjaga semangat komunitas.', at: 1200 },
  { file: 'medali7.png', name: 'Level 7', desc: 'Waspada terhadap genangan di sekitar gardu dan panel.', at: 1800 },
  { file: 'medali8.png', name: 'Level 8', desc: 'Laporanmu terbukti melindungi warga dan jaringan listrik.', at: 2500 },
  { file: 'medali9.png', name: 'Level 9', desc: 'Puncak kontribusi: panutan seluruh Penjaga Grid.', at: 4000 },
];

const REWARDS = {
  token: {
    title: 'Voucher Token Listrik', icon: 'bolt', note: 'Token dikirim ke meteran prabayarmu',
    items: [
      { id: 't20', name: 'Token Rp20.000', cost: 500 },
      { id: 't50', name: 'Token Rp50.000', cost: 1100 },
      { id: 't100', name: 'Token Rp100.000', cost: 2200 },
    ],
  },
  donasi: {
    title: 'Donasi Lingkungan', icon: 'volunteer_activism', note: 'Poinmu jadi aksi nyata untuk lingkungan',
    items: [
      { id: 'd1', name: 'Tanam 1 Pohon', cost: 100 },
      { id: 'd2', name: 'Bersihkan Sungai', cost: 250 },
      { id: 'd3', name: 'Panel Surya Desa', cost: 500 },
    ],
  },
};

const VERIFIED_STATUS = ['terverifikasi', 'diproses'];

/* ================= HELPER WAKTU (WITA) ================= */
const dayKey = (t) => new Date(t + TZ_MS).toISOString().slice(0, 10);
function weekStartMs(t) {
  const d = new Date(t + TZ_MS);
  const dow = (d.getUTCDay() + 6) % 7; // Senin = 0
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow); // dalam "waktu lokal" ms
}
const weekKey = (t) => new Date(weekStartMs(t)).toISOString().slice(0, 10);
const periodKey = (p, t) => (p === 'day' ? dayKey(t) : weekKey(t));
const daysLeftInWeek = (now) => Math.max(1, Math.ceil((weekStartMs(now) + 7 * DAY - (now + TZ_MS)) / DAY));

/* ================= DATA (dengan cache pendek) ================= */
let cache = { at: 0, val: null };

async function loadUsers({ fresh = false } = {}) {
  if (!fresh && cache.val && Date.now() - cache.at < 20000) return cache.val;

  const { data: reps, error } = await supabase
    .from('reports')
    .select('id, reporter_name, reporter_contact, status, created_at')
    .not('reporter_contact', 'is', null)
    .not('photo_url', 'is', null)
    .not('lat', 'is', null)
    .not('lng', 'is', null)
    .neq('status', 'ditolak')
    .order('created_at', { ascending: false })
    .limit(5000);
  if (error) throw new Error(error.message);

  // laporan yang penugasannya sudah selesai (penanda "#LPR:<id>" di assignments.problem_desc)
  const handled = new Set();
  const { data: as } = await supabase
    .from('assignments').select('problem_desc').eq('status', 'selesai').like('problem_desc', '%#LPR:%').limit(5000);
  for (const a of as || []) {
    const m = /#LPR:([\w-]+)/.exec(a.problem_desc || '');
    if (m) handled.add(m[1]);
  }

  const users = new Map(); // email -> { name, reports: [{t, verified, handled}] }
  for (const r of reps || []) {
    const key = String(r.reporter_contact).trim().toLowerCase();
    if (!key) continue;
    const u = users.get(key) || { key, name: r.reporter_name || key.split('@')[0], reports: [] };
    u.reports.push({
      t: new Date(r.created_at).getTime(),
      verified: VERIFIED_STATUS.includes(r.status) || handled.has(String(r.id)),
      handled: handled.has(String(r.id)),
    });
    users.set(key, u);
  }
  cache = { at: Date.now(), val: users };
  return users;
}

/* ================= HITUNG POIN ================= */
// Daftar kejadian berpoin: [{ t, pts }]
function buildEvents(reports) {
  const ev = [];
  const sorted = [...reports].sort((a, b) => a.t - b.t);
  const perDay = new Map();
  for (const r of sorted) {
    const dk = dayKey(r.t);
    const n = (perDay.get(dk) || 0) + 1;
    perDay.set(dk, n);
    if (n <= POINTS.submitMaxPerDay) ev.push({ t: r.t, pts: POINTS.submit });
    if (r.verified) ev.push({ t: r.t, pts: POINTS.verified });
    if (r.handled) ev.push({ t: r.t, pts: POINTS.handled });
  }
  // bonus misi: sekali per hari / per minggu yang terpenuhi
  for (const m of MISI) {
    const seen = new Set();
    for (const r of sorted) {
      if (!m.need(r)) continue;
      const k = periodKey(m.period, r.t);
      if (seen.has(k)) continue;
      seen.add(k);
      ev.push({ t: r.t, pts: m.pts });
    }
  }
  return ev;
}

const sumUntil = (ev, t) => ev.reduce((s, e) => (e.t <= t ? s + e.pts : s), 0);

function missionStatus(reports, now) {
  return MISI.map((m, i) => {
    const k = periodKey(m.period, now);
    const done = reports.some((r) => periodKey(m.period, r.t) === k && m.need(r));
    const left = daysLeftInWeek(now);
    return {
      id: i + 1,
      key: m.key,
      label: m.label,
      pts: m.pts,
      done,
      sub: done ? 'Selesai' : m.period === 'day' ? 'Batas: hari ini' : `Batas: ${left} hari lagi`,
      hint: m.hint,
    };
  });
}

function levelInfo(total) {
  let lv = 0;
  for (let i = 0; i < LEVELS.length; i++) if (total >= LEVELS[i]) lv = i;
  const next = lv + 1 < LEVELS.length ? LEVELS[lv + 1] : null;
  return { level: lv + 1, level_start: LEVELS[lv], next_level_at: next, max_level: next == null };
}

const shortName = (n) => {
  const p = String(n || '').trim().split(/\s+/).filter(Boolean);
  if (!p.length) return 'Warga';
  return p.length === 1 ? p[0] : `${p[0]} ${p[1][0].toUpperCase()}.`;
};

/* Ringkasan lengkap untuk satu user (by email) */
async function summarize(email, { fresh = false } = {}) {
  const now = Date.now();
  const users = await loadUsers({ fresh });
  const me = String(email || '').trim().toLowerCase();

  const rows = [];
  for (const u of users.values()) {
    const ev = buildEvents(u.reports);
    rows.push({ key: u.key, name: u.name, reports: u.reports, ev, total: sumUntil(ev, now), prev: sumUntil(ev, now - 7 * DAY) });
  }
  const mine = rows.find((r) => r.key === me) || { key: me, name: '', reports: [], ev: [], total: 0, prev: 0 };
  if (!rows.includes(mine)) rows.push(mine);

  const rankOf = (field) => {
    const sorted = [...rows].sort((a, b) => b[field] - a[field] || (a.key === me ? -1 : 0) - (b.key === me ? -1 : 0) || a.key.localeCompare(b.key));
    return { sorted, rank: sorted.findIndex((r) => r.key === me) + 1 };
  };
  const cur = rankOf('total');
  const prev = rankOf('prev');

  // papan peringkat: 2 teratas + kamu (kalau kamu sudah di 2 teratas, tampilkan peringkat 3)
  const top = cur.sorted.slice(0, 2);
  const extra = top.some((r) => r.key === me) ? cur.sorted[2] : mine;
  const board = [...top, extra].filter(Boolean).map((r) => ({
    rank: cur.sorted.indexOf(r) + 1,
    name: r.key === me ? 'Kamu' : shortName(r.name),
    pts: r.total,
    me: r.key === me,
  }));

  // riwayat poin kumulatif 6 titik mingguan sebelum "Kini"
  const history = [6, 5, 4, 3, 2, 1].map((w) => sumUntil(mine.ev, now - w * 7 * DAY));

  return {
    total: mine.total,
    history,
    missions: missionStatus(mine.reports, now),
    rank: cur.rank,
    rank_delta: prev.rank - cur.rank, // >0 = naik
    board,
    total_users: rows.length,
  };
}

/* ================= REDEEM (disimpan di app_metadata) ================= */
async function getRedeems(userId) {
  const { data, error } = await supabase.auth.admin.getUserById(userId);
  if (error) throw new Error(error.message);
  const meta = (data && data.user && data.user.app_metadata) || {};
  return { meta, list: Array.isArray(meta.grid_redeems) ? meta.grid_redeems : [] };
}

const spentOf = (list) => list.reduce((s, r) => s + (Number(r.cost) || 0), 0);

module.exports = {
  POINTS, MISI, LEVELS, MEDALS, REWARDS,
  summarize, levelInfo, getRedeems, spentOf,
  invalidate: () => { cache = { at: 0, val: null }; },
};
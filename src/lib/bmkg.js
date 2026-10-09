const env = require('../config/env');
const supabase = require('../config/supabase');

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function avg(a) {
  return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
}
function round(v) {
  return v == null ? null : Math.round(v * 10) / 10;
}

// ---- 1) Ambil JSON mentah dari BMKG ----
async function fetchBmkgRaw(adm4) {
  const url = `${env.BMKG_BASE_URL}?adm4=${encodeURIComponent(adm4)}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'GRID.ID/0.1 (prototype)' },
  });
  if (!res.ok) throw new Error(`BMKG HTTP ${res.status}`);
  return res.json();
}

// ---- 2) Normalisasi: data[].cuaca[][] -> array slot datar ----
// Catatan: nama field dikonfirmasi lewat smoke test (npm run smoke:bmkg).
function normalizeForecast(raw, adm4) {
  const out = [];
  const data = Array.isArray(raw && raw.data) ? raw.data : [];
  for (const d of data) {
    const cuaca = Array.isArray(d && d.cuaca) ? d.cuaca.flat() : [];
    for (const s of cuaca) {
      const valid_from = s.utc_datetime || s.datetime || s.local_datetime || null;
      if (!valid_from) continue;
      out.push({
        adm4,
        t: num(s.t),
        hu: num(s.hu),
        ws: num(s.ws),
        wd: s.wd ?? null,
        weather_desc: s.weather_desc ?? s.weather ?? null,
        tcc: num(s.tcc),
        analysis_date: s.analysis_date || null,
        valid_from,
        valid_to: null,
        status: 'fresh',
      });
    }
  }
  return out;
}

const RAIN_RE = /hujan|petir|badai|gerimis/i;

// ---- 3) Ekstrak faktor cuaca pada horizon keputusan (jam ke depan) ----
function extractFactors(slots, horizonHours = 24) {
  const now = Date.now();
  const until = now + horizonHours * 3600 * 1000;
  const win = slots.filter((s) => {
    const t = Date.parse(s.valid_from);
    return Number.isFinite(t) && t >= now - 3 * 3600 * 1000 && t <= until;
  });
  const use = win.length ? win : slots.slice(0, 8);
  const wsMax = use.length ? Math.max(0, ...use.map((s) => s.ws ?? 0)) : null;
  const hujan = use.some((s) => s.weather_desc && RAIN_RE.test(s.weather_desc));
  return {
    angin_max_kmh: round(wsMax),
    hujan,
    kelembapan_avg: round(avg(use.map((s) => s.hu).filter((v) => v != null))),
    suhu_avg: round(avg(use.map((s) => s.t).filter((v) => v != null))),
    slot_dipakai: use.length,
    horizon_jam: horizonHours,
  };
}

// ---- 4) Cache ke weather_forecasts (upsert per adm4+valid_from) ----
async function cacheForecast(slots) {
  if (!slots.length) return { cached: 0 };
  const now = new Date().toISOString();
  const rows = slots.map((s) => ({ ...s, fetched_at: now }));
  const { error, count } = await supabase
    .from('weather_forecasts')
    .upsert(rows, { onConflict: 'adm4,valid_from', count: 'exact' });
  if (error) throw new Error(`Cache gagal: ${error.message}`);
  return { cached: count ?? rows.length };
}

async function getFreshFromDb(adm4) {
  const since = new Date(Date.now() - env.WEATHER_CACHE_MINUTES * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('weather_forecasts')
    .select('*')
    .eq('adm4', adm4)
    .gte('fetched_at', since)
    .order('valid_from', { ascending: true });
  if (error) throw new Error(error.message);
  return data || [];
}

async function getLastCached(adm4) {
  const { data, error } = await supabase
    .from('weather_forecasts')
    .select('*')
    .eq('adm4', adm4)
    .order('valid_from', { ascending: true })
    .limit(200);
  if (error) throw new Error(error.message);
  return data || [];
}

// ---- 5) Orkestrasi: cache-first -> BMKG -> fallback stale ----
async function getForecast(adm4, horizonHours = 24) {
  let slots = await getFreshFromDb(adm4);
  let status = 'fresh';

  if (!slots.length) {
    try {
      const raw = await fetchBmkgRaw(adm4);
      slots = normalizeForecast(raw, adm4);
      await cacheForecast(slots);
      status = 'fresh';
    } catch (e) {
      const last = await getLastCached(adm4);
      if (last.length) {
        slots = last;
        status = 'stale';
      } else {
        return { adm4, status: 'unavailable', fetched_at: null, factors: null, forecast: [], error: e.message };
      }
    }
  }

  const fetched_at = (slots[0] && slots[0].fetched_at) || null;
  return { adm4, status, fetched_at, factors: extractFactors(slots, horizonHours), forecast: slots };
}

module.exports = { getForecast, fetchBmkgRaw, normalizeForecast, extractFactors, cacheForecast };

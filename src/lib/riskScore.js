const supabase = require('../config/supabase');
const { getForecast } = require('./bmkg');

const WEIGHTS = { severity: 0.40, weather: 0.35, density: 0.25 };
const THRESHOLD = { kritis: 70, waspada: 40 };

const clamp = (v, min = 0, max = 100) => Math.max(min, Math.min(max, v));
const round = (v) => Math.round(v * 10) / 10;

function levelFromScore(score) {
  if (score >= THRESHOLD.kritis) return 'kritis';
  if (score >= THRESHOLD.waspada) return 'waspada';
  return 'aman';
}

// sub-skor cuaca 0-100 dari faktor BMKG (transparan & sederhana)
function weatherSubscore(factors) {
  if (!factors) return 0;
  const windNorm = clamp((factors.angin_max_kmh || 0) / 40 * 100); // 40 km/jam -> 100
  const rainBonus = factors.hujan ? 40 : 0;
  return clamp(windNorm * 0.6 + rainBonus);
}

async function computeForAsset(asset, { persist = true } = {}) {
  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();

  // 1) severity dari detections terbaru (7 hari)
  const { data: reps } = await supabase
    .from('reports').select('id').eq('asset_id', asset.id).gte('created_at', since);
  const reportIds = (reps || []).map((r) => r.id);
  let sevSub = 0;
  const density = reportIds.length;
  if (reportIds.length) {
    const { data: dets } = await supabase.from('detections').select('severity').in('report_id', reportIds);
    const sevs = (dets || []).map((d) => Number(d.severity)).filter(Number.isFinite);
    sevSub = sevs.length ? Math.max(...sevs) : 0; // severity 0-100
  }

  // 2) cuaca dari BMKG (adm4 aset) — cache-first
  let weather = { status: 'unavailable', factors: null };
  if (asset.adm4) {
    try {
      const f = await getForecast(asset.adm4, 24);
      weather = { status: f.status, factors: f.factors };
    } catch { /* biarkan unavailable */ }
  }
  const weaSub = weatherSubscore(weather.factors);

  // 3) kepadatan laporan 7 hari (cap 5 laporan = 100)
  const denSub = clamp((density / 5) * 100);

  // komponen berbobot (maks 40 / 35 / 25)
  const severity_component = round(sevSub * WEIGHTS.severity);
  const weather_component = round(weaSub * WEIGHTS.weather);
  const density_component = round(denSub * WEIGHTS.density);
  const score = round(severity_component + weather_component + density_component);
  const level = levelFromScore(score);

  const { data: mc } = await supabase
    .from('maximo_conditions').select('id').eq('asset_id', asset.id)
    .order('fetched_at', { ascending: false }).limit(1);

  const row = {
    asset_id: asset.id, score, level,
    severity_component, weather_component, density_component,
    weather_status: weather.status,
    maximo_condition_id: mc && mc[0] ? mc[0].id : null,
  };

  if (persist) {
    const { data, error } = await supabase.from('risk_scores').insert(row).select().single();
    if (error) throw new Error(error.message);
    return data;
  }
  return { ...row, computed_at: new Date().toISOString() };
}

module.exports = { computeForAsset, levelFromScore, WEIGHTS, THRESHOLD };
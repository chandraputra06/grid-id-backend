// src/lib/aiClient.js
// Client untuk layanan AI inference GRID.ID (YOLOv8) di VPS Biznet.
// Hanya dipanggil dari backend. API key TIDAK pernah dikirim ke frontend & tidak di-log.
// Butuh Node 18+ (fetch, FormData, Blob global). Cek NIXPACKS_NODE_VERSION di Railway >= 18.

const AI_URL = (process.env.GRID_AI_URL || '').replace(/\/+$/, '');
const AI_KEY = process.env.GRID_AI_API_KEY || '';
const TIMEOUT_MS = 30000;

// Kirim satu foto ke layanan AI. Return Response (fetch).
async function postDetect(imageBuffer, filename) {
  const form = new FormData();
  // field WAJIB bernama "image"
  form.append('image', new Blob([imageBuffer]), filename || 'upload.jpg');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(`${AI_URL}/v1/detect`, {
      method: 'POST',
      headers: { 'X-API-Key': AI_KEY }, // jangan tambahkan Content-Type; FormData set boundary sendiri
      body: form,
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Deteksi kerusakan pada satu foto.
 * Return objek status eksplisit — pemanggil WAJIB memakai `status`, bukan menebak "aman".
 *   { ok:true,  status:'done',           model_version, inference_ms, detections:[...], note }
 *   { ok:false, status:'ai_unavailable', error }   // 5xx / timeout / env belum diset
 *   { ok:false, status:'ai_error',       http, error }  // 4xx (401/413/400) — jangan retry
 */
async function detect(imageBuffer, filename) {
  if (!AI_URL || !AI_KEY) {
    return { ok: false, status: 'ai_unavailable', error: 'GRID_AI_URL / GRID_AI_API_KEY belum diset' };
  }

  let lastErr = null;
  // maksimal 2 percobaan: retry 1x HANYA untuk 5xx/timeout
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await postDetect(imageBuffer, filename);

      if (res.ok) {
        const json = await res.json().catch(() => ({}));
        return {
          ok: true,
          status: 'done',
          model_version: json.model_version || null,
          inference_ms: typeof json.inference_ms === 'number' ? json.inference_ms : null,
          detections: Array.isArray(json.detections) ? json.detections : [],
          note: json.note || null,
        };
      }

      // 4xx -> kesalahan permanen untuk request ini, jangan retry (jangan cetak body/key)
      if (res.status >= 400 && res.status < 500) {
        console.error(`[aiClient] layanan AI menolak permintaan: HTTP ${res.status}`);
        return { ok: false, status: 'ai_error', http: res.status, error: `AI HTTP ${res.status}` };
      }

      lastErr = `AI HTTP ${res.status}`; // 5xx -> boleh retry
    } catch (e) {
      lastErr = e && e.name === 'AbortError' ? 'AI timeout (30s)' : (e && e.message) || 'AI error';
    }
    if (attempt === 1) console.warn(`[aiClient] percobaan ${attempt} gagal (${lastErr}), retry...`);
  }

  console.error(`[aiClient] layanan AI tidak tersedia: ${lastErr}`);
  return { ok: false, status: 'ai_unavailable', error: lastErr };
}

// Cek kesehatan layanan AI (untuk health internal backend).
async function health() {
  if (!AI_URL) return { ok: false, error: 'GRID_AI_URL belum diset' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(`${AI_URL}/health`, { signal: ctrl.signal });
    if (!res.ok) return { ok: false, http: res.status };
    return { ok: true, data: await res.json().catch(() => ({})) };
  } catch (e) {
    return { ok: false, error: e && e.name === 'AbortError' ? 'timeout' : (e && e.message) || 'error' };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { detect, health };
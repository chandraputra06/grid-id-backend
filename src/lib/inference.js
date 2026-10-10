// Mock AI Screening — deterministik dari photo_url.
// GANTI dengan panggilan ke inference service (FastAPI/YOLOv8) saat siap.
const CLASSES = ['isolator_pecah', 'korosi', 'kabel_bermasalah', 'komponen_hilang'];

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function mockInfer(photoUrl = '') {
  const url = String(photoUrl);
  const h = hashStr(url);
  const n = h % 10 < 2 ? 0 : h % 10 < 8 ? 1 : 2; // ~20% nol, ~60% 1, ~20% 2 deteksi
  const dets = [];
  for (let i = 0; i < n; i++) {
    const hi = hashStr(`${url}:${i}`);
    dets.push({
      defect: CLASSES[hi % CLASSES.length],
      confidence: Number((0.55 + (hi % 40) / 100).toFixed(3)), // 0.55–0.94
      severity: 40 + (hi % 51),                                // 40–90
      bbox: { x: Number(((hi % 50) / 100).toFixed(2)), y: Number((((hi >> 3) % 50) / 100).toFixed(2)), w: 0.2, h: 0.2 },
      model_version: 'mock-v0',
    });
  }
  return dets;
}

module.exports = { mockInfer };
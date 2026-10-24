// src/lib/mailer.js
// Pengirim email transaksional via Resend (REST API, tanpa dependency npm tambahan).
// Butuh env: RESEND_API_KEY, MAIL_FROM (mis. "GRID.ID <onboarding@resend.dev>").
// Node 18+ (global fetch). API key TIDAK pernah di-log.

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const MAIL_FROM = process.env.MAIL_FROM || 'GRID.ID <onboarding@resend.dev>';
const RESEND_URL = 'https://api.resend.com/emails';
const MAX_BCC = 49; // Resend ~50 penerima/email; sisakan 1 untuk 'to'.

function isConfigured() {
  return !!RESEND_API_KEY;
}

// Ambil alamat murni dari MAIL_FROM: "Nama <a@b.com>" -> "a@b.com".
function fromAddress() {
  const m = /<([^>]+)>/.exec(MAIL_FROM);
  return m ? m[1].trim() : MAIL_FROM.trim();
}

async function postResend(payload) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(RESEND_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      return { ok: false, status: res.status, error: t.slice(0, 300) };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e && e.message };
  } finally {
    clearTimeout(timer);
  }
}

// Kirim ke banyak penerima lewat BCC (privasi — alamat tidak saling terlihat),
// otomatis dipotong per 49 penerima. Gagal kirim tidak melempar error.
async function sendBroadcast({ recipients, subject, html, text }) {
  if (!isConfigured()) return { ok: false, skipped: true };
  const list = [...new Set((recipients || []).filter((e) => typeof e === 'string' && /@/.test(e)))];
  if (!list.length) return { ok: false, empty: true };
  const self = fromAddress();
  let sent = 0;
  for (let i = 0; i < list.length; i += MAX_BCC) {
    const bcc = list.slice(i, i + MAX_BCC);
    const r = await postResend({ from: MAIL_FROM, to: [self], bcc, subject, html, text });
    if (r.ok) sent += bcc.length;
    else console.error('[mailer] gagal kirim:', r.status || '', r.error || '');
  }
  return { ok: sent > 0, sent, total: list.length };
}

module.exports = { isConfigured, sendBroadcast, fromAddress };
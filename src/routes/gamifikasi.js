const router = require('express').Router();
const crypto = require('crypto');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/apiError');
const supabase = require('../config/supabase');
const g = require('../lib/gamifikasi');

const rnd4 = () => crypto.randomBytes(3).toString('hex').slice(0, 4).toUpperCase();

function requireEmail(req) {
  if (!req.user || !req.user.email) throw new ApiError(401, 'unauthorized', 'Perlu login');
  return req.user.email;
}

// GET /api/gamifikasi/me — semua data halaman Grid Mission untuk user yang login.
router.get(
  '/me',
  asyncHandler(async (req, res) => {
    const email = requireEmail(req);
    const [s, red] = await Promise.all([g.summarize(email), g.getRedeems(req.user.id)]);
    const spent = g.spentOf(red.list);
    const lv = g.levelInfo(s.total);

    res.json({
      ok: true,
      data: {
        points: s.total, // total poin yang pernah didapat (dasar level & lencana)
        balance: Math.max(0, s.total - spent), // saldo yang bisa ditukar
        spent,
        ...lv,
        history: s.history,
        missions: s.missions,
        medals: g.MEDALS.map((m) => ({ file: m.file, name: m.name, desc: m.desc, threshold: m.at, unlocked: s.total >= m.at })),
        rank: s.rank,
        rank_delta: s.rank_delta,
        board: s.board,
        rewards: g.REWARDS,
        redeems: red.list.slice(-10).reverse(),
        rules: g.POINTS,
      },
    });
  })
);

// POST /api/gamifikasi/redeem { item_id } — tukar saldo poin dengan reward.
router.post(
  '/redeem',
  asyncHandler(async (req, res) => {
    const email = requireEmail(req);
    const itemId = String((req.body || {}).item_id || '');
    let kind = null;
    let item = null;
    for (const [k, cfg] of Object.entries(g.REWARDS)) {
      const f = cfg.items.find((i) => i.id === itemId);
      if (f) { kind = k; item = f; }
    }
    if (!item) throw new ApiError(400, 'bad_request', 'item_id tidak dikenal');

    const [s, red] = await Promise.all([g.summarize(email, { fresh: true }), g.getRedeems(req.user.id)]);
    const balance = s.total - g.spentOf(red.list);
    if (balance < item.cost) throw new ApiError(400, 'insufficient_points', 'Poin tidak cukup');

    const code = `GRID-${rnd4()}-${rnd4()}`;
    const record = { id: crypto.randomUUID(), item_id: item.id, kind, name: item.name, cost: item.cost, code, at: new Date().toISOString() };
    const list = [...red.list, record].slice(-200);

    const { error } = await supabase.auth.admin.updateUserById(req.user.id, {
      app_metadata: { ...red.meta, grid_redeems: list },
    });
    if (error) throw new ApiError(500, 'db_error', error.message);

    res.status(201).json({ ok: true, data: { code, kind, item, balance: balance - item.cost } });
  })
);

module.exports = router;
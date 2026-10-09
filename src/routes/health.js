const router = require('express').Router();
const supabase = require('../config/supabase');

// GET /api/health
router.get('/', async (req, res) => {
  let db = 'unknown';
  try {
    const { error } = await supabase.from('assets').select('id', { head: true, count: 'exact' }).limit(1);
    db = error ? 'error' : 'ok';
  } catch {
    db = 'error';
  }
  res.json({ ok: true, data: { service: 'grid-id-backend', status: 'up', db, time: new Date().toISOString() } });
});

module.exports = router;

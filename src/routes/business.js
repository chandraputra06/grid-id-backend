// /api/business — GRID.ID Business Portal (role 'b2b').
// Dipasang di index.js di belakang requireAuth + requireRole('b2b') + resolveBusinessScope.
// Semua data dibatasi ke aset yang diberikan ke organisasi pengguna (organization_assets).
// Pelanggan B2B HANYA membaca: tidak ada endpoint untuk mengubah status alert Supervisor PLN
// atau mengontrol perangkat.
const router = require('express').Router();
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/apiError');
const supabase = require('../config/supabase');
const svc = require('../lib/hardware/service');

const UUID_RE = svc.UUID_RE;

function requireOrgOwner(req, res, next) {
  if (req.orgRole !== 'owner') return next(new ApiError(403, 'forbidden', 'Hanya pemilik (owner) organisasi'));
  return next();
}

// ---------------------------------------------------------------- Organisasi
router.get(
  '/organization',
  asyncHandler(async (req, res) => {
    const { data: members, error } = await supabase
      .from('profiles')
      .select('id, full_name, phone, org_role, role, created_at')
      .eq('organization_id', req.org.id)
      .order('created_at', { ascending: true });
    if (error) throw new ApiError(500, 'db_error', error.message);

    // Email dari Supabase Auth (hanya untuk anggota organisasi ini).
    const withEmail = await Promise.all(
      (members || []).map(async (m) => {
        const { data } = await supabase.auth.admin.getUserById(m.id);
        return { ...m, email: (data && data.user && data.user.email) || null };
      })
    );
    res.json({
      ok: true,
      data: {
        organization: req.org,
        my_role: req.orgRole,
        assets_granted: req.scope.assetIds.length,
        members: withEmail,
      },
    });
  })
);

// POST /api/business/members — owner menambah anggota (role b2b) ke organisasinya sendiri.
router.post(
  '/members',
  requireOrgOwner,
  asyncHandler(async (req, res) => {
    const { email, password, full_name = '', org_role = 'viewer' } = req.body || {};
    if (!email || !password) throw new ApiError(400, 'bad_request', 'Email dan password wajib diisi');
    if (String(password).length < 8) throw new ApiError(400, 'bad_request', 'Password minimal 8 karakter');
    if (!['owner', 'viewer'].includes(org_role)) throw new ApiError(400, 'bad_request', "org_role harus 'owner' atau 'viewer'");

    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name, role: 'b2b' },
    });
    if (error) throw new ApiError(400, 'create_failed', error.message);
    const { error: pe } = await supabase
      .from('profiles')
      .update({ role: 'b2b', organization_id: req.org.id, org_role, full_name })
      .eq('id', data.user.id);
    if (pe) throw new ApiError(500, 'db_error', pe.message);
    res.status(201).json({ ok: true, data: { id: data.user.id, email, full_name, org_role } });
  })
);

// PATCH /api/business/members/:id — ubah peran anggota dalam organisasi yang sama.
router.patch(
  '/members/:id',
  requireOrgOwner,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) throw new ApiError(400, 'bad_request', 'id harus UUID');
    const { org_role } = req.body || {};
    if (!['owner', 'viewer'].includes(org_role)) throw new ApiError(400, 'bad_request', "org_role harus 'owner' atau 'viewer'");
    const { data: target } = await supabase.from('profiles').select('id, organization_id, org_role').eq('id', id).maybeSingle();
    if (!target || target.organization_id !== req.org.id) throw new ApiError(404, 'not_found', 'Anggota tidak ditemukan');
    if (target.org_role === 'owner' && org_role !== 'owner') {
      const { count } = await supabase
        .from('profiles')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', req.org.id)
        .eq('org_role', 'owner');
      if ((count || 0) <= 1) throw new ApiError(409, 'last_owner', 'Organisasi harus memiliki minimal satu owner');
    }
    const { data, error } = await supabase.from('profiles').update({ org_role }).eq('id', id).select('id, full_name, org_role').maybeSingle();
    if (error) throw new ApiError(500, 'db_error', error.message);
    res.json({ ok: true, data });
  })
);

// ---------------------------------------------------------------- Aset
function monitoringStatus(devs) {
  if (!devs.length) return 'tanpa_perangkat';
  const on = devs.filter((d) => d.connection === 'online' || d.connection === 'late').length;
  if (on === devs.length) return 'terpantau';
  if (on > 0) return 'sebagian';
  if (devs.every((d) => d.connection === 'never')) return 'belum_ada_data';
  return 'offline';
}

async function assetSummaries(scope, q = {}) {
  const ids = scope.assetIds;
  if (!ids.length) return [];
  let aq = supabase.from('assets').select('id, asset_code, name, asset_type, lat, lng, unit, adm4, criticality').in('id', ids);
  if (q.unit) aq = aq.eq('unit', q.unit);
  const { data: assets, error } = await aq.order('name', { ascending: true });
  if (error) throw new ApiError(500, 'db_error', error.message);
  const { devices } = await svc.listDevices(scope, {});
  return (assets || []).map((a) => {
    const devs = devices.filter((d) => d.asset_id === a.id);
    const ai = devs
      .map((d) => d.last_ai)
      .filter(Boolean)
      .sort((x, y) => (y.captured_at || '').localeCompare(x.captured_at || ''))[0] || null;
    const priority = devs.map((d) => d.priority).find(Boolean) || null;
    return {
      asset: a,
      devices: devs.map((d) => ({ id: d.id, device_code: d.device_code, name: d.name, connection: d.connection, last_telemetry_at: d.last_telemetry_at })),
      monitoring_status: monitoringStatus(devs),
      last_inspection: ai,
      open_alerts: devs.reduce((s, d) => s + d.open_alerts, 0),
      priority,
      last_telemetry_at: devs.map((d) => d.last_telemetry_at).filter(Boolean).sort().pop() || null,
    };
  });
}

router.get(
  '/assets',
  asyncHandler(async (req, res) => {
    let list = await assetSummaries(req.scope, req.query);
    if (req.query.q) {
      const s = String(req.query.q).toLowerCase();
      list = list.filter((x) => [x.asset.name, x.asset.asset_code, x.asset.unit].filter(Boolean).some((v) => v.toLowerCase().includes(s)));
    }
    if (req.query.status) list = list.filter((x) => x.monitoring_status === req.query.status);
    const units = [...new Set(list.map((x) => x.asset.unit).filter(Boolean))].sort();
    res.json({ ok: true, data: { assets: list, units } });
  })
);

router.get(
  '/assets/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) throw new ApiError(400, 'bad_request', 'id harus UUID');
    if (!req.scope.assetIds.includes(id)) throw new ApiError(404, 'not_found', 'Aset tidak ditemukan');
    const [summary] = (await assetSummaries({ ...req.scope, assetIds: [id] })) || [];
    if (!summary) throw new ApiError(404, 'not_found', 'Aset tidak ditemukan');
    const { devices } = await svc.listDevices(req.scope, { asset_id: id });
    res.json({ ok: true, data: { ...summary, devices } });
  })
);

// ---------------------------------------------------------------- Data hardware (read-only)
router.get('/overview', asyncHandler(async (req, res) => {
  const ov = await svc.overview(req.scope, req.query);
  const assets = await assetSummaries(req.scope, {});
  res.json({
    ok: true,
    data: {
      ...ov,
      assets_total: req.scope.assetIds.length,
      assets_by_status: assets.reduce((m, a) => ({ ...m, [a.monitoring_status]: (m[a.monitoring_status] || 0) + 1 }), {}),
      assets_attention: assets.filter((a) => a.open_alerts > 0 || a.monitoring_status === 'offline').slice(0, 8),
    },
  });
}));
router.get('/devices', asyncHandler(async (req, res) => res.json({ ok: true, data: await svc.listDevices(req.scope, req.query) })));
router.get('/devices/:id', asyncHandler(async (req, res) => res.json({ ok: true, data: await svc.getDevice(req.scope, req.params.id) })));
router.get('/devices/:id/telemetry', asyncHandler(async (req, res) => res.json({ ok: true, data: await svc.telemetryHistory(req.scope, req.params.id, req.query) })));
router.get('/frames', asyncHandler(async (req, res) => res.json({ ok: true, data: await svc.listFrames(req.scope, req.query) })));
router.get('/frames/:frameId', asyncHandler(async (req, res) => res.json({ ok: true, data: await svc.getFrame(req.scope, req.params.frameId) })));
router.get('/frames/:frameId/thermal', asyncHandler(async (req, res) => res.json({ ok: true, data: await svc.thermalData(req.scope, req.params.frameId) })));
router.get('/inspections', asyncHandler(async (req, res) => res.json({ ok: true, data: await svc.listInspections(req.scope, req.query) })));
router.get('/alerts', asyncHandler(async (req, res) => res.json({ ok: true, data: await svc.listAlerts(req.scope, req.query) })));
router.get('/report', asyncHandler(async (req, res) => res.json({ ok: true, data: await svc.report(req.scope, req.query) })));

module.exports = router;

// /api/organizations — manajemen organisasi B2B oleh admin GRID.ID.
// Dipasang di index.js di belakang requireAuth + requireRole('admin').
const router = require('express').Router();
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/apiError');
const supabase = require('../config/supabase');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuid(v, name = 'id') {
  if (!UUID_RE.test(v || '')) throw new ApiError(400, 'bad_request', `${name} harus UUID`);
  return v;
}

function cleanPermissions(p) {
  const x = p || {};
  return { view_stream: x.view_stream !== false };
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { data, error } = await supabase.from('organizations').select('*').order('created_at', { ascending: false });
    if (error) throw new ApiError(500, 'db_error', error.message);
    const { data: grants } = await supabase.from('organization_assets').select('organization_id');
    const { data: members } = await supabase.from('profiles').select('organization_id').not('organization_id', 'is', null);
    const count = (rows, id) => (rows || []).filter((r) => r.organization_id === id).length;
    res.json({ ok: true, data: (data || []).map((o) => ({ ...o, assets: count(grants, o.id), members: count(members, o.id) })) });
  })
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    if (!b.name) throw new ApiError(400, 'bad_request', 'name wajib');
    const row = {
      name: String(b.name).slice(0, 160),
      code: b.code || null,
      type: b.type || null,
      contact: b.contact || null,
      status: b.status === 'nonaktif' ? 'nonaktif' : 'aktif',
      permissions: cleanPermissions(b.permissions),
    };
    const { data, error } = await supabase.from('organizations').insert(row).select('*').single();
    if (error) throw new ApiError(400, 'create_failed', error.message);
    res.status(201).json({ ok: true, data });
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = uuid(req.params.id);
    const { data: org } = await supabase.from('organizations').select('*').eq('id', id).maybeSingle();
    if (!org) throw new ApiError(404, 'not_found', 'Organisasi tidak ditemukan');
    const { data: grants } = await supabase
      .from('organization_assets')
      .select('asset_id, granted_at, asset:asset_id(id, asset_code, name, unit)')
      .eq('organization_id', id);
    const { data: members } = await supabase
      .from('profiles')
      .select('id, full_name, role, org_role, created_at')
      .eq('organization_id', id);
    res.json({ ok: true, data: { organization: org, assets: grants || [], members: members || [] } });
  })
);

router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = uuid(req.params.id);
    const b = req.body || {};
    const patch = {};
    ['name', 'code', 'type', 'contact'].forEach((k) => {
      if (b[k] !== undefined) patch[k] = b[k] || null;
    });
    if (b.status !== undefined) {
      if (!['aktif', 'nonaktif'].includes(b.status)) throw new ApiError(400, 'bad_request', 'status harus aktif/nonaktif');
      patch.status = b.status;
    }
    if (b.permissions !== undefined) patch.permissions = cleanPermissions(b.permissions);
    if (!Object.keys(patch).length) throw new ApiError(400, 'bad_request', 'Tidak ada field untuk diupdate');
    const { data, error } = await supabase.from('organizations').update(patch).eq('id', id).select('*').maybeSingle();
    if (error) throw new ApiError(500, 'db_error', error.message);
    if (!data) throw new ApiError(404, 'not_found', 'Organisasi tidak ditemukan');
    res.json({ ok: true, data });
  })
);

// Beri / cabut akses aset untuk organisasi.
router.post(
  '/:id/assets',
  asyncHandler(async (req, res) => {
    const id = uuid(req.params.id);
    const assetId = uuid((req.body || {}).asset_id, 'asset_id');
    const { error } = await supabase
      .from('organization_assets')
      .upsert({ organization_id: id, asset_id: assetId, granted_by: req.user.id }, { onConflict: 'organization_id,asset_id' });
    if (error) throw new ApiError(400, 'grant_failed', error.message);
    res.status(201).json({ ok: true, data: { organization_id: id, asset_id: assetId } });
  })
);

router.delete(
  '/:id/assets/:assetId',
  asyncHandler(async (req, res) => {
    const id = uuid(req.params.id);
    const assetId = uuid(req.params.assetId, 'assetId');
    const { error } = await supabase.from('organization_assets').delete().eq('organization_id', id).eq('asset_id', assetId);
    if (error) throw new ApiError(500, 'db_error', error.message);
    res.json({ ok: true, data: { revoked: true } });
  })
);

// Tambah anggota: buat akun baru (email+password) ATAU hubungkan user existing (user_id).
router.post(
  '/:id/members',
  asyncHandler(async (req, res) => {
    const id = uuid(req.params.id);
    const { user_id, email, password, full_name = '', org_role = 'viewer' } = req.body || {};
    if (!['owner', 'viewer'].includes(org_role)) throw new ApiError(400, 'bad_request', "org_role harus 'owner' atau 'viewer'");
    const { data: org } = await supabase.from('organizations').select('id').eq('id', id).maybeSingle();
    if (!org) throw new ApiError(404, 'not_found', 'Organisasi tidak ditemukan');

    let uid = user_id;
    if (uid) {
      uuid(uid, 'user_id');
      const { data: prof } = await supabase.from('profiles').select('role').eq('id', uid).maybeSingle();
      if (!prof) throw new ApiError(404, 'not_found', 'User tidak ditemukan');
      if (prof.role !== 'b2b') throw new ApiError(409, 'role_conflict', 'Hanya akun role b2b yang dapat dihubungkan ke organisasi');
    } else {
      if (!email || !password) throw new ApiError(400, 'bad_request', 'user_id, atau email + password, wajib');
      if (String(password).length < 8) throw new ApiError(400, 'bad_request', 'Password minimal 8 karakter');
      const { data, error } = await supabase.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name, role: 'b2b' },
      });
      if (error) throw new ApiError(400, 'create_failed', error.message);
      uid = data.user.id;
    }
    const patch = { role: 'b2b', organization_id: id, org_role };
    if (full_name) patch.full_name = full_name;
    const { error: pe } = await supabase.from('profiles').update(patch).eq('id', uid);
    if (pe) throw new ApiError(500, 'db_error', pe.message);
    res.status(201).json({ ok: true, data: { user_id: uid, organization_id: id, org_role } });
  })
);

router.delete(
  '/:id/members/:userId',
  asyncHandler(async (req, res) => {
    const id = uuid(req.params.id);
    const userId = uuid(req.params.userId, 'userId');
    const { error } = await supabase
      .from('profiles')
      .update({ organization_id: null, org_role: null })
      .eq('id', userId)
      .eq('organization_id', id);
    if (error) throw new ApiError(500, 'db_error', error.message);
    res.json({ ok: true, data: { removed: true } });
  })
);

module.exports = router;

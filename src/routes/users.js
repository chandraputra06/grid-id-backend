const router = require('express').Router();
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/apiError');
const supabase = require('../config/supabase');

const ROLES = ['admin', 'petugas', 'warga', 'supervisor', 'hardware', 'b2b'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Role apa yang boleh DIBERIKAN oleh si aktor.
// admin: semua. supervisor: hanya petugas.
function assignableBy(actorRole) {
  if (actorRole === 'admin') return ROLES;
  if (actorRole === 'supervisor') return ['petugas'];
  return [];
}
// Supervisor tidak boleh mengutak-atik akun role tinggi.
function canTouchTarget(actorRole, targetRole) {
  if (actorRole === 'admin') return true;
  if (actorRole === 'supervisor') return targetRole === 'petugas' || targetRole === 'warga';
  return false;
}

// GET /api/users — daftar user (profil + email). Admin & supervisor.
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { data: profiles, error } = await supabase
      .from('profiles')
      .select('id, full_name, role, phone, unit, created_at')
      .order('created_at', { ascending: false });
    if (error) throw new ApiError(500, 'db_error', error.message);

    const { data: authData, error: authErr } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (authErr) throw new ApiError(500, 'auth_error', authErr.message);
    const emailById = new Map((authData?.users || []).map((u) => [u.id, u.email]));

    const data = (profiles || []).map((p) => ({ ...p, email: emailById.get(p.id) || null }));
    res.json({ ok: true, data });
  })
);

// POST /api/users — buat akun. Admin: role apa saja. Supervisor: hanya petugas.
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { email, password, full_name = '', role = 'petugas', phone = null, unit = null } = req.body || {};
    if (!email || !password) throw new ApiError(400, 'bad_request', 'Email dan password wajib diisi');
    if (String(password).length < 8) throw new ApiError(400, 'bad_request', 'Password minimal 8 karakter');
    if (!ROLES.includes(role)) throw new ApiError(400, 'bad_request', 'Role tidak valid');
    if (!assignableBy(req.user.role).includes(role)) {
      throw new ApiError(403, 'forbidden', `Role '${req.user.role}' tidak boleh membuat akun role '${role}'`);
    }

    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name, role },
    });
    if (error) throw new ApiError(400, 'create_failed', error.message);

    if (phone || unit) {
      await supabase.from('profiles').update({ phone, unit }).eq('id', data.user.id);
    }

    res.status(201).json({ ok: true, data: { id: data.user.id, email, role, full_name, phone, unit } });
  })
);

// PATCH /api/users/:id/role — ubah role user.
router.patch(
  '/:id/role',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) throw new ApiError(400, 'bad_request', 'id harus UUID');
    const { role } = req.body || {};
    if (!ROLES.includes(role)) throw new ApiError(400, 'bad_request', 'Role tidak valid');
    if (!assignableBy(req.user.role).includes(role)) {
      throw new ApiError(403, 'forbidden', `Role '${req.user.role}' tidak boleh menetapkan role '${role}'`);
    }

    // Lindungi akun role tinggi dari supervisor.
    const { data: target } = await supabase.from('profiles').select('role').eq('id', id).maybeSingle();
    if (!target) throw new ApiError(404, 'not_found', 'User tidak ditemukan');
    if (!canTouchTarget(req.user.role, target.role)) {
      throw new ApiError(403, 'forbidden', 'Tidak boleh mengubah akun ini');
    }

    const { data, error } = await supabase
      .from('profiles')
      .update({ role })
      .eq('id', id)
      .select('id, full_name, role, phone, unit')
      .maybeSingle();
    if (error) throw new ApiError(500, 'db_error', error.message);
    if (!data) throw new ApiError(404, 'not_found', 'User tidak ditemukan');

    res.json({ ok: true, data });
  })
);

module.exports = router;
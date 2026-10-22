// Resolusi scope akses data hardware.
const supabase = require('../../config/supabase');
const ApiError = require('../../utils/apiError');

const STAFF_SCOPE = Object.freeze({ kind: 'staff', assetIds: null, viewStream: true });

// Middleware: untuk role b2b, muat organisasi + aset yang diberikan -> req.scope.
// Pelanggan tanpa organisasi / organisasi nonaktif ditolak (403).
async function resolveBusinessScope(req, res, next) {
  try {
    const { data: prof, error } = await supabase
      .from('profiles')
      .select('organization_id, org_role')
      .eq('id', req.user.id)
      .maybeSingle();
    if (error) throw new ApiError(500, 'db_error', error.message);
    if (!prof || !prof.organization_id) {
      throw new ApiError(403, 'no_organization', 'Akun belum terhubung ke organisasi. Hubungi admin GRID.ID.');
    }
    const { data: org, error: oe } = await supabase
      .from('organizations')
      .select('id, name, code, type, status, permissions, contact, created_at')
      .eq('id', prof.organization_id)
      .maybeSingle();
    if (oe) throw new ApiError(500, 'db_error', oe.message);
    if (!org) throw new ApiError(403, 'no_organization', 'Organisasi tidak ditemukan');
    if (org.status !== 'aktif') throw new ApiError(403, 'organization_inactive', 'Organisasi sedang nonaktif');

    const { data: grants, error: ge } = await supabase
      .from('organization_assets')
      .select('asset_id')
      .eq('organization_id', org.id);
    if (ge) throw new ApiError(500, 'db_error', ge.message);

    const perms = org.permissions || {};
    req.org = org;
    req.orgRole = prof.org_role || 'viewer';
    req.scope = {
      kind: 'b2b',
      orgId: org.id,
      assetIds: (grants || []).map((g) => g.asset_id),
      viewStream: perms.view_stream !== false,
    };
    next();
  } catch (e) {
    next(e);
  }
}

function staffScope(req, res, next) {
  req.scope = STAFF_SCOPE;
  next();
}

module.exports = { resolveBusinessScope, staffScope, STAFF_SCOPE };

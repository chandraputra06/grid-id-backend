const test = require('node:test');
const assert = require('node:assert');
const { withFakes } = require('./helpers/load');
const { createFakeSupabase } = require('./helpers/fake-supabase');

test('modul rute hardware/business/organizations termuat & endpoint terdaftar', () => {
  const load = withFakes(createFakeSupabase());
  const hw = load('src/routes/hardware.js');
  const biz = load('src/routes/business.js');
  const org = load('src/routes/organizations.js');
  const paths = (r) => r.routes.map((x) => `${x.method.toUpperCase()} ${x.path}`);
  for (const p of ['GET /status', 'GET /overview', 'GET /devices/:id', 'GET /frames/:frameId/thermal', 'PATCH /alerts/:id', 'PUT /settings', 'PUT /devices/:id/snapshot-interval']) {
    assert.ok(paths(hw).includes(p), p);
  }
  // B2B: tidak ada endpoint mutasi alert / kontrol perangkat
  assert.ok(!paths(biz).some((p) => p.startsWith('PATCH /alerts') || p.includes('snapshot-interval') || p.includes('/config')));
  assert.ok(paths(biz).includes('POST /members'));
  assert.ok(paths(org).includes('POST /:id/assets'));
});

test('resolveBusinessScope menolak akun tanpa organisasi & org nonaktif', async () => {
  const sb = createFakeSupabase({
    profiles: [
      { id: 'u1', organization_id: null },
      { id: 'u2', organization_id: 'o2', org_role: 'viewer' },
      { id: 'u3', organization_id: 'o3', org_role: 'owner' },
    ],
    organizations: [{ id: 'o2', status: 'nonaktif' }, { id: 'o3', status: 'aktif', permissions: { view_stream: false } }],
    organization_assets: [{ organization_id: 'o3', asset_id: 'a1' }, { organization_id: 'o2', asset_id: 'a2' }],
  });
  const { resolveBusinessScope } = withFakes(sb)('src/lib/hardware/access.js');
  const run = (id) => new Promise((resolve) => {
    const req = { user: { id } };
    resolveBusinessScope(req, {}, (err) => resolve({ err, req }));
  });
  assert.strictEqual((await run('u1')).err.status, 403);
  assert.strictEqual((await run('u2')).err.code, 'organization_inactive');
  const ok = await run('u3');
  assert.strictEqual(ok.err, undefined);
  assert.deepStrictEqual(ok.req.scope.assetIds, ['a1']);
  assert.strictEqual(ok.req.scope.viewStream, false);
  assert.strictEqual(ok.req.orgRole, 'owner');
});

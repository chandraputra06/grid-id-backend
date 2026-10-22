// Seed organisasi B2B contoh + akun owner (DEMO). Aset diberikan secara eksplisit.
//   node scripts/seed-b2b.js --asset <ASSET_UUID> [--asset <ASSET_UUID> ...]
require('dotenv').config();
const supabase = require('../src/config/supabase');

async function main() {
  const assets = [];
  process.argv.forEach((a, i) => { if (a === '--asset' && process.argv[i + 1]) assets.push(process.argv[i + 1]); });

  let { data: org } = await supabase.from('organizations').select('*').eq('code', 'DEMO-B2B').maybeSingle();
  if (!org) {
    const r = await supabase
      .from('organizations')
      .insert({ name: 'DEMO — PT Contoh Kawasan Industri', code: 'DEMO-B2B', type: 'kawasan_industri', permissions: { view_stream: true } })
      .select('*').single();
    if (r.error) throw r.error;
    org = r.data;
  }
  console.log(`✓ organisasi ${org.name} (${org.id})`);

  for (const id of assets) {
    const { error } = await supabase.from('organization_assets').upsert({ organization_id: org.id, asset_id: id }, { onConflict: 'organization_id,asset_id' });
    if (error) throw error;
    console.log(`  ✓ akses aset ${id}`);
  }

  const email = 'b2b@grid.id';
  const { data, error } = await supabase.auth.admin.createUser({
    email, password: 'password', email_confirm: true, user_metadata: { full_name: 'Klien B2B (DEMO)', role: 'b2b' },
  });
  let uid = data && data.user && data.user.id;
  if (error) {
    if (!/already|registered|exists/i.test(error.message)) throw error;
    const { data: list } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
    uid = (list.users || []).find((u) => u.email === email)?.id;
  }
  await supabase.from('profiles').update({ role: 'b2b', organization_id: org.id, org_role: 'owner' }).eq('id', uid);
  console.log(`✓ ${email} (b2b, owner) — password: password`);
}

main().catch((e) => {
  console.error('Seed B2B gagal:', e.message);
  process.exit(1);
});

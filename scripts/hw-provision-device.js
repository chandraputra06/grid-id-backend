// Buat kredensial Firebase untuk satu perangkat (dijalankan tim hardware/admin, server-side).
// Menghasilkan akun Firebase Auth (email/password) dengan custom claim { device_id } —
// dipakai firmware untuk login dan dibatasi oleh database.rules.json & storage.rules
// sehingga perangkat hanya bisa menulis ke path miliknya sendiri.
//
//   node scripts/hw-provision-device.js --device GARDU-001 --password "<min 12 karakter>"
require('dotenv').config();
const crypto = require('crypto');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main() {
  const deviceCode = arg('device');
  if (!deviceCode || !/^[A-Za-z0-9_-]{1,64}$/.test(deviceCode)) throw new Error('--device wajib (huruf/angka/-/_)');
  const password = arg('password') || crypto.randomBytes(18).toString('base64url');
  if (password.length < 12) throw new Error('Password minimal 12 karakter');

  const fb = require('../src/config/firebase').init();
  if (!fb.app) throw new Error(`Firebase tidak siap: ${fb.error}`);
  const auth = fb.app.auth();
  const email = `${deviceCode.toLowerCase()}@devices.grid.id`;

  let user;
  try {
    user = await auth.getUserByEmail(email);
    await auth.updateUser(user.uid, { password });
  } catch (e) {
    if (e.code !== 'auth/user-not-found') throw e;
    user = await auth.createUser({ email, password, displayName: deviceCode });
  }
  await auth.setCustomUserClaims(user.uid, { device_id: deviceCode });
  console.log('Kredensial perangkat (simpan di firmware, JANGAN di frontend):');
  console.log(`  email    : ${email}`);
  console.log(`  password : ${password}`);
  console.log(`  claim    : device_id=${deviceCode}`);
  console.log('Pastikan perangkat juga terdaftar di GRID.ID: POST /api/devices { device_code, type:"multisensor", asset_id }');
  process.exit(0);
}

main().catch((e) => {
  console.error('Provisioning gagal:', e.message);
  process.exit(1);
});

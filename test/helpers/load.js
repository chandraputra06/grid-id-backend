// Muat modul backend dengan dependensi eksternal di-stub (dotenv, supabase-js, firebase).
const Module = require('module');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const origLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'dotenv') return { config: () => ({}) };
  if (request === '@supabase/supabase-js') return { createClient: () => ({}) };
  if (request === 'express') {
    // Router minimal: catat rute agar bisa diperiksa di test.
    const Router = () => {
      const routes = [];
      const r = { routes };
      ['get', 'post', 'patch', 'put', 'delete', 'use'].forEach((m) => {
        r[m] = (p, ...h) => { routes.push({ method: m, path: typeof p === 'string' ? p : '(mw)', handlers: h.length }); return r; };
      });
      return r;
    };
    return { Router };
  }
  return origLoad.call(this, request, parent, isMain);
};

function withFakes(fakeSupabase, fakeFirebase) {
  const sbPath = path.join(root, 'src/config/supabase.js');
  const fbPath = path.join(root, 'src/config/firebase.js');
  // reset cache modul hardware agar memakai fake baru
  for (const k of Object.keys(require.cache)) if (k.includes(`${path.sep}src${path.sep}`)) delete require.cache[k];
  require.cache[sbPath] = { id: sbPath, filename: sbPath, loaded: true, exports: fakeSupabase };
  require.cache[fbPath] = {
    id: fbPath, filename: fbPath, loaded: true,
    exports: fakeFirebase || { init: () => ({ status: 'not_configured', db: null, bucket: null }), publicStatus: () => ({ status: 'not_configured' }) },
  };
  return (rel) => require(path.join(root, rel));
}

module.exports = { withFakes, root };

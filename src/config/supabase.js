const { createClient } = require('@supabase/supabase-js');
const env = require('./env');

// Pakai service_role: backend menembus RLS. Key ini WAJIB rahasia (server-only).
const supabase = createClient(env.SUPABASE_URL || '', env.SUPABASE_SERVICE_ROLE_KEY || '', {
  auth: { persistSession: false, autoRefreshToken: false },
});

module.exports = supabase;

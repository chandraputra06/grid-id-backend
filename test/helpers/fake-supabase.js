// Supabase query-builder palsu (in-memory) untuk pengujian unit/integrasi tanpa jaringan.
// Mendukung subset API yang dipakai lapisan hardware.
const crypto = require('crypto');

function createFakeSupabase(seed = {}) {
  const tables = {};
  for (const [k, rows] of Object.entries(seed)) tables[k] = rows.map((r) => ({ ...r }));
  const t = (name) => (tables[name] = tables[name] || []);

  class Query {
    constructor(table) {
      this.table = table;
      this.filters = [];
      this.op = 'select';
      this.orders = [];
      this.lim = null;
      this.singleMode = null;
      this.countMode = null;
      this.head = false;
      this.returning = false;
    }
    select(cols, opts = {}) {
      if (this.op === 'select') this.countMode = opts.count || null;
      else this.returning = true;
      this.head = !!opts.head;
      return this;
    }
    eq(c, v) { this.filters.push((r) => r[c] === v); return this; }
    neq(c, v) { this.filters.push((r) => r[c] !== v); return this; }
    in(c, vs) { this.filters.push((r) => vs.includes(r[c])); return this; }
    gte(c, v) { this.filters.push((r) => r[c] != null && r[c] >= v); return this; }
    lte(c, v) { this.filters.push((r) => r[c] != null && r[c] <= v); return this; }
    lt(c, v) { this.filters.push((r) => r[c] != null && r[c] < v); return this; }
    not(c, op, v) { if (op === 'is' && v === null) this.filters.push((r) => r[c] != null); return this; }
    order(c, { ascending = true } = {}) { this.orders.push([c, ascending]); return this; }
    limit(n) { this.lim = n; return this; }
    maybeSingle() { this.singleMode = 'maybe'; return this; }
    single() { this.singleMode = 'one'; return this; }
    insert(rows) { this.op = 'insert'; this.payload = Array.isArray(rows) ? rows : [rows]; this.multi = Array.isArray(rows); return this; }
    update(patch) { this.op = 'update'; this.payload = patch; return this; }
    upsert(rows, opts = {}) { this.op = 'upsert'; this.payload = Array.isArray(rows) ? rows : [rows]; this.upsertOpts = opts; return this; }
    delete() { this.op = 'delete'; return this; }
    match(r) { return this.filters.every((f) => f(r)); }
    run() {
      const rows = t(this.table);
      let out;
      if (this.op === 'insert') {
        out = this.payload.map((p) => {
          const row = { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...defaults(this.table), ...p };
          rows.push(row);
          return row;
        });
      } else if (this.op === 'upsert') {
        const keys = (this.upsertOpts.onConflict || 'id').split(',');
        out = [];
        for (const p of this.payload) {
          const ex = rows.find((r) => keys.every((k) => r[k] === p[k] && p[k] != null));
          if (ex) {
            if (!this.upsertOpts.ignoreDuplicates) { Object.assign(ex, p); out.push(ex); }
          } else {
            const row = { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...defaults(this.table), ...p };
            rows.push(row);
            out.push(row);
          }
        }
      } else if (this.op === 'update') {
        out = rows.filter((r) => this.match(r));
        out.forEach((r) => Object.assign(r, this.payload));
      } else if (this.op === 'delete') {
        out = rows.filter((r) => this.match(r));
        tables[this.table] = rows.filter((r) => !this.match(r));
      } else {
        out = rows.filter((r) => this.match(r));
        for (const [c, asc] of [...this.orders].reverse()) {
          out = [...out].sort((a, b) => (a[c] === b[c] ? 0 : (a[c] > b[c] ? 1 : -1) * (asc ? 1 : -1)));
        }
        if (this.lim != null) out = out.slice(0, this.lim);
      }
      out = out.map((r) => ({ ...r }));
      if (this.countMode) return { data: this.head ? null : out, count: out.length, error: null };
      if (this.singleMode === 'maybe') return { data: out[0] || null, error: null };
      if (this.singleMode === 'one') return out[0] ? { data: out[0], error: null } : { data: null, error: { message: 'no rows' } };
      return { data: out, error: null };
    }
    then(res, rej) { try { return Promise.resolve(this.run()).then(res, rej); } catch (e) { return Promise.reject(e).then(res, rej); } }
  }
  function defaults(table) {
    const now = new Date().toISOString();
    if (table === 'device_telemetry') return { received_at: now, valid: true, validation_errors: [] };
    if (table === 'device_alerts') return { status: 'baru', active: true, occurrences: 1, first_seen_at: now, last_seen_at: now };
    if (table === 'device_frames') return { received_at: now };
    return {};
  }

  return {
    tables,
    from(name) { return new Query(name); },
    auth: { admin: { getUserById: async (id) => ({ data: { user: { id, email: `${id.slice(0, 4)}@x.id` } } }) } },
  };
}

module.exports = { createFakeSupabase };

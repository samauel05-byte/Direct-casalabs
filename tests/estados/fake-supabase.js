// Mini «supabase-js» en memoria para probar la lógica de Estados Financieros sin base de datos:
// implementa solo lo que el módulo usa. NO sustituye las restricciones reales de Postgres (esas se
// verificaron aparte contra la migración).
const crypto = require('crypto');

class Query {
  constructor(db, table) { this.db = db; this.table = table; this.op = 'select'; this.filters = []; this.orders = []; this.rangeV = null; this.limitV = null; this.payload = null; this.opts = {}; this.head = false; this.wantCount = false; this.single_ = null; this.conflict = null; }
  select(cols, opts = {}) { if (this.op === 'select') this.op = 'select'; this.wantCount = opts.count === 'exact'; this.head = !!opts.head; this.returning = true; return this; }
  insert(p) { this.op = 'insert'; this.payload = Array.isArray(p) ? p : [p]; return this; }
  update(p) { this.op = 'update'; this.payload = p; return this; }
  delete() { this.op = 'delete'; return this; }
  upsert(p, o = {}) { this.op = 'upsert'; this.payload = Array.isArray(p) ? p : [p]; this.conflict = o.onConflict ? o.onConflict.split(',') : null; return this; }
  eq(k, v) { this.filters.push(r => r[k] === v); return this; }
  neq(k, v) { this.filters.push(r => r[k] !== v); return this; }
  in(k, vs) { this.filters.push(r => vs.includes(r[k])); return this; }
  or(expr) { const terms = expr.split(',').map(t => /^(\w+)\.ilike\.%(.*)%$/.exec(t)).filter(Boolean); this.filters.push(r => terms.some(([, k, v]) => String(r[k] ?? '').toLowerCase().includes(v.toLowerCase()))); return this; }
  order(k, o = {}) { this.orders.push([k, o.ascending === false ? -1 : 1]); return this; }
  range(a, b) { this.rangeV = [a, b]; return this; }
  limit(n) { this.limitV = n; return this; }
  maybeSingle() { this.single_ = 'maybe'; return this; }
  single() { this.single_ = 'one'; return this; }
  then(res, rej) { return Promise.resolve(this.run()).then(res, rej); }
  run() {
    const t = this.db.tables[this.table] || (this.db.tables[this.table] = []);
    const match = r => this.filters.every(f => f(r));
    let rows;
    if (this.op === 'insert' || this.op === 'upsert') {
      rows = [];
      for (const p of this.payload) {
        const row = { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...this.db.defaults[this.table], ...p };
        if (this.op === 'upsert' && this.conflict) { const ex = t.find(r => this.conflict.every(k => r[k] === row[k])); if (ex) { Object.assign(ex, p); rows.push(ex); continue; } }
        const uq = this.db.unique[this.table];
        if (uq && t.some(r => uq.every(k => r[k] === row[k]))) return { data: null, error: { code: '23505', message: 'duplicate key' } };
        t.push(row); rows.push(row);
      }
    } else if (this.op === 'update') { rows = t.filter(match); rows.forEach(r => Object.assign(r, this.payload)); }
    else if (this.op === 'delete') { rows = t.filter(match); this.db.tables[this.table] = t.filter(r => !rows.includes(r)); }
    else rows = t.filter(match);
    for (const [k, d] of [...this.orders].reverse()) rows = [...rows].sort((a, b) => (a[k] > b[k] ? 1 : a[k] < b[k] ? -1 : 0) * d);
    const count = rows.length;
    if (this.rangeV) rows = rows.slice(this.rangeV[0], this.rangeV[1] + 1);
    if (this.limitV) rows = rows.slice(0, this.limitV);
    const clone = rows.map(r => ({ ...r }));
    if (this.head) return { data: null, error: null, count };
    if (this.single_) { if (!clone.length) return this.single_ === 'one' ? { data: null, error: { message: 'no rows' } } : { data: null, error: null }; return { data: clone[0], error: null, count }; }
    return { data: this.op === 'select' || this.returning ? clone : null, error: null, count: this.wantCount ? count : undefined };
  }
}

function createFake() {
  const db = { tables: {}, users: {}, uploads: [], defaults: { fin_reports: { version: 1, prepared_on: '2026-11-13' }, fin_entries: { active: true }, fin_assumptions: { active: true, pending: false }, fin_adjustments: { active: true }, fin_imports: { status: 'applied' } },
    unique: { fin_versions: ['report_id', 'version'] } };
  return {
    db,
    from: t => new Query(db, t),
    auth: { admin: { getUserById: async id => ({ data: { user: db.users[id] ? { id, email: `${db.users[id]}@direct.local` } : null } }) } },
    storage: { from: () => ({ upload: async (path, buf) => { db.uploads.push({ path, size: buf.length }); return { error: null }; } }) },
  };
}
module.exports = { createFake };

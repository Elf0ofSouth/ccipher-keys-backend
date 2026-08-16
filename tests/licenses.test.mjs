// ============================================================
// Teste do núcleo de licenciamento.
//
// Roda contra SQLite de verdade, com um dublê do cliente Supabase por
// cima. Prova a LÓGICA (ativação, expiração, trial, trava de
// dispositivo, revogação), não o Postgres em si.
//
//   node tests/licenses.test.mjs
// ============================================================

import { DatabaseSync } from 'node:sqlite';
import { validateLicense, generateKey, PLANS } from '../lib/licenses.js';

// ------------------------------------------------------------
// Schema equivalente ao supabase-migration.sql, em dialeto SQLite
// ------------------------------------------------------------
const db = new DatabaseSync(':memory:');
db.exec(`
  create table licenses (
    id integer primary key autoincrement,
    license_key text not null unique,
    plan text not null,
    duration_seconds integer not null,
    status text not null default 'unused',
    max_devices integer not null default 1,
    user_name text, note text, batch text,
    created_at text not null default (datetime('now')),
    activated_at text, expires_at text, last_seen_at text,
    validate_count integer not null default 0
  );
  create table license_devices (
    id integer primary key autoincrement,
    license_id integer not null references licenses(id) on delete cascade,
    device_id text not null,
    first_seen_at text not null default (datetime('now')),
    last_seen_at text not null default (datetime('now')),
    ip text, country text, user_agent text,
    unique(license_id, device_id)
  );
  create table license_trial_claims (
    device_id text primary key,
    license_id integer,
    claimed_at text not null default (datetime('now'))
  );
  create table license_events (
    id integer primary key autoincrement,
    at text not null default (datetime('now')),
    kind text not null, license_id integer, device_id text, detail text, ip text
  );
`);

// ------------------------------------------------------------
// Dublê do cliente Supabase (só o que licenses.js usa)
// ------------------------------------------------------------
class Query {
  constructor(table) {
    this.table = table;
    this.op = 'select';
    this.cols = '*';
    this.filters = [];
    this.orders = [];
    this.limitN = null;
    this.payload = null;
    this.wantSingle = false;
    this.countMode = false;
    this.headMode = false;
  }
  select(cols = '*', opts = {}) {
    if (this.op === 'select') this.cols = cols === '*' ? '*' : cols;
    else this.returning = cols;
    if (opts.count) this.countMode = true;
    if (opts.head) this.headMode = true;
    return this;
  }
  insert(payload) { this.op = 'insert'; this.payload = payload; return this; }
  update(payload) { this.op = 'update'; this.payload = payload; return this; }
  upsert(payload) { this.op = 'upsert'; this.payload = payload; return this; }
  delete() { this.op = 'delete'; return this; }
  eq(col, val) { this.filters.push([col, '=', val]); return this; }
  gte(col, val) { this.filters.push([col, '>=', val]); return this; }
  order(col, o = {}) { this.orders.push(`${col} ${o.ascending === false ? 'desc' : 'asc'}`); return this; }
  limit(n) { this.limitN = n; return this; }
  maybeSingle() { this.wantSingle = true; return this; }
  single() { this.wantSingle = true; return this; }

  _where() {
    if (!this.filters.length) return { sql: '', args: [] };
    return {
      sql: ' where ' + this.filters.map(([c, o]) => `${c} ${o} ?`).join(' and '),
      args: this.filters.map(([, , v]) => v),
    };
  }

  _run() {
    const w = this._where();
    try {
      if (this.op === 'select') {
        if (this.countMode && this.headMode) {
          const r = db.prepare(`select count(*) as c from ${this.table}${w.sql}`).get(...w.args);
          return { data: null, error: null, count: r.c };
        }
        let sql = `select ${this.cols} from ${this.table}${w.sql}`;
        if (this.orders.length) sql += ' order by ' + this.orders.join(', ');
        if (this.limitN != null) sql += ` limit ${this.limitN}`;
        const rows = db.prepare(sql).all(...w.args);
        if (this.wantSingle) return { data: rows[0] ?? null, error: null };
        return { data: rows, error: null, count: rows.length };
      }

      if (this.op === 'insert' || this.op === 'upsert') {
        const rows = Array.isArray(this.payload) ? this.payload : [this.payload];
        const out = [];
        for (const r of rows) {
          const cols = Object.keys(r);
          const verbo = this.op === 'upsert' ? 'insert or replace' : 'insert';
          const sql = `${verbo} into ${this.table} (${cols.join(',')}) values (${cols.map(() => '?').join(',')})`;
          const info = db.prepare(sql).run(...cols.map((c) => r[c]));
          out.push(db.prepare(`select * from ${this.table} where rowid = ?`).get(info.lastInsertRowid));
        }
        return { data: out, error: null };
      }

      if (this.op === 'update') {
        const cols = Object.keys(this.payload);
        const sql = `update ${this.table} set ${cols.map((c) => `${c}=?`).join(',')}${w.sql}`;
        db.prepare(sql).run(...cols.map((c) => this.payload[c]), ...w.args);
        return { data: null, error: null };
      }

      if (this.op === 'delete') {
        db.prepare(`delete from ${this.table}${w.sql}`).run(...w.args);
        return { data: null, error: null };
      }
    } catch (e) {
      const code = /UNIQUE/i.test(e.message) ? '23505' : 'XX000';
      return { data: null, error: { message: e.message, code } };
    }
  }

  then(resolve, reject) {
    try { resolve(this._run()); } catch (e) { reject(e); }
  }
}

const sb = { from: (table) => new Query(table) };

// ------------------------------------------------------------
// Helpers de teste
// ------------------------------------------------------------
function seed(plan, opts = {}) {
  const key = generateKey(plan);
  const def = PLANS[plan];
  db.prepare(
    `insert into licenses (license_key, plan, duration_seconds, status, max_devices, created_at)
     values (?, ?, ?, 'unused', ?, ?)`
  ).run(key, plan, opts.seconds ?? def.seconds, opts.maxDevices ?? def.maxDevices, new Date().toISOString());
  return key;
}

let pass = 0, fail = 0;
function check(nome, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${nome}`); }
  else { fail++; console.log(`  FAIL  ${nome} ${extra}`); }
}

// ------------------------------------------------------------
// Testes
// ------------------------------------------------------------
console.log('\n--- Formato das keys ---');
for (const [plan, def] of Object.entries(PLANS)) {
  const k = generateKey(plan);
  check(`${plan} -> ${k}`, new RegExp(`^CPHR-${def.tag}-[2-9A-Z]{5}-[2-9A-Z]{5}-[2-9A-Z]{5}$`).test(k), k);
}

console.log('\n--- Rejeições básicas ---');
{
  const r = await validateLicense(sb, 'CPHR-MTH-XXXXX-XXXXX-XXXXX', 'dev-1');
  check('key desconhecida', !r.valid && r.reason === 'not_found', JSON.stringify(r));
  const v = await validateLicense(sb, '   ', 'dev-1');
  check('key vazia', !v.valid, JSON.stringify(v));
}

console.log('\n--- Ativação: relógio começa no primeiro uso ---');
{
  const key = seed('monthly');
  const antes = Date.now();
  const r = await validateLicense(sb, key, 'dev-A');
  check('valida', r.valid, r.message);
  check('plano correto', r.plan === 'monthly' && r.plan_label === 'Mensal', r.plan);
  check('não é vitalícia', r.lifetime === false);
  const dias = (new Date(r.expires_at).getTime() - antes) / 86400000;
  check('expira em ~30 dias', Math.abs(dias - 30) < 0.01, `${dias}d`);
  check('activated_at preenchido', !!r.activated_at);
  check('seconds_remaining ~30d', Math.abs(r.seconds_remaining - 30 * 86400) < 5, r.seconds_remaining);
  check('session_id gerado', /^cph_[0-9a-f]{24}$/.test(r.session_id || ''), r.session_id);
}

console.log('\n--- Key gerada há tempo não perde validade antes da venda ---');
{
  const key = seed('daily');
  db.prepare('update licenses set created_at = ? where license_key = ?')
    .run(new Date(Date.now() - 60 * 86400000).toISOString(), key);
  const r = await validateLicense(sb, key, 'dev-B');
  check('ainda vale, contagem começa agora', r.valid, r.message);
  const horas = (new Date(r.expires_at).getTime() - Date.now()) / 3600000;
  check('24h a partir de agora', Math.abs(horas - 24) < 0.01, `${horas}h`);
}

console.log('\n--- Trial de 15 minutos ---');
{
  const key = seed('trial15');
  const r = await validateLicense(sb, key, 'dev-TRIAL');
  check('trial ativa', r.valid, r.message);
  check('license_type = trial', r.license_type === 'trial', r.license_type);
  const min = (new Date(r.expires_at).getTime() - Date.now()) / 60000;
  check('expira em ~15 min', Math.abs(min - 15) < 0.05, `${min}min`);

  const key2 = seed('trial15');
  const r2 = await validateLicense(sb, key2, 'dev-TRIAL');
  check('bloqueia 2o trial no mesmo dispositivo', !r2.valid && r2.reason === 'trial_used', JSON.stringify(r2));

  const r3 = await validateLicense(sb, key2, 'dev-OUTRO');
  check('trial funciona em dispositivo novo', r3.valid, r3.message);
}

console.log('\n--- Expiração ---');
{
  const key = seed('weekly');
  await validateLicense(sb, key, 'dev-C');
  db.prepare('update licenses set expires_at = ? where license_key = ?')
    .run(new Date(Date.now() - 1000).toISOString(), key);
  const r = await validateLicense(sb, key, 'dev-C');
  check('rejeita key expirada', !r.valid && r.reason === 'expired', JSON.stringify(r));
  const row = db.prepare('select status from licenses where license_key = ?').get(key);
  check('status vira expired no banco', row.status === 'expired', row.status);
}

console.log('\n--- Trava de dispositivo ---');
{
  const key = seed('daily'); // 1 dispositivo
  check('1o dispositivo entra', (await validateLicense(sb, key, 'pc-casa')).valid);
  check('mesmo dispositivo continua entrando', (await validateLicense(sb, key, 'pc-casa')).valid);
  const r2 = await validateLicense(sb, key, 'pc-amigo');
  check('2o dispositivo é barrado', !r2.valid && r2.reason === 'device_conflict', JSON.stringify(r2));
  const sobrou = db.prepare('select count(*) as c from license_devices where license_id = (select id from licenses where license_key = ?)').get(key);
  check('dispositivo barrado não fica sujando a tabela', sobrou.c === 1, String(sobrou.c));

  const key2 = seed('monthly'); // 2 dispositivos
  check('mensal aceita 2 dispositivos',
    (await validateLicense(sb, key2, 'd1')).valid && (await validateLicense(sb, key2, 'd2')).valid);
  check('mensal barra o 3o', !(await validateLicense(sb, key2, 'd3')).valid);
  check('o 1o continua funcionando depois da tentativa barrada',
    (await validateLicense(sb, key2, 'd1')).valid);
}

console.log('\n--- Revogação ---');
{
  const key = seed('yearly');
  check('vale antes de revogar', (await validateLicense(sb, key, 'dev-R')).valid);
  db.prepare("update licenses set status = 'revoked' where license_key = ?").run(key);
  const r = await validateLicense(sb, key, 'dev-R');
  check('cai no heartbeat seguinte', !r.valid && r.reason === 'revoked', JSON.stringify(r));
}

console.log('\n--- Vitalícia ---');
{
  const key = seed('lifetime');
  const r = await validateLicense(sb, key, 'dev-L');
  check('valida', r.valid, r.message);
  check('lifetime = true', r.lifetime === true);
  check('sem expires_at', r.expires_at === null || r.expires_at === undefined, String(r.expires_at));
}

console.log('\n--- Normalização do que o cliente digita ---');
{
  const key = seed('monthly');
  const r = await validateLicense(sb, '  ' + key.toLowerCase() + ' ', 'dev-N');
  check('aceita minúscula e espaços', r.valid, r.message);
}

console.log('\n--- Auditoria ---');
{
  const n = db.prepare('select count(*) as c from license_events').get().c;
  check('eventos registrados', n > 0, String(n));
  const ativacoes = db.prepare("select count(*) as c from license_events where kind = 'activate'").get().c;
  check('ativações registradas', ativacoes > 0, String(ativacoes));
}

console.log(`\n=============================\n  ${pass} passaram, ${fail} falharam\n=============================`);
process.exit(fail ? 1 : 0);

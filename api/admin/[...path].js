// ============================================================
// Cipher Project — API do PAINEL de revenda
//
// Tudo aqui exige:  Authorization: Bearer <CIPHER_ADMIN_TOKEN>
//
//   POST   /api/admin/keys/generate
//   GET    /api/admin/keys?status=&plan=&q=&batch=&limit=&offset=
//   GET    /api/admin/keys/:id
//   DELETE /api/admin/keys/:id
//   POST   /api/admin/keys/:id/revoke
//   POST   /api/admin/keys/:id/unrevoke
//   POST   /api/admin/keys/:id/reset-devices
//   POST   /api/admin/keys/:id/extend        { days } ou { seconds }
//   GET    /api/admin/stats
//   GET    /api/admin/events
//   GET|POST /api/admin/packages
// ============================================================

import { getSupabaseAdmin } from '../../lib/supabase.js';
import { PLANS, T, generateKey, logEvent } from '../../lib/licenses.js';
import { sendJson, preflight, readBody, isAdmin } from '../../lib/http.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return preflight(res);

  if (!isAdmin(req)) {
    return sendJson(res, { error: 'unauthorized', message: 'Token de admin inválido ou ausente.' }, 401);
  }

  // Deriva a rota direto da URL (ex.: "/api/admin/keys/generate" -> "keys/generate").
  // Ler de req.url é à prova de falha: não depende de como a Vercel preenche
  // req.query nas rotas catch-all, que varia entre builds.
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const route = pathname
    .replace(/^\/+/, '')          // tira barra inicial
    .replace(/^api\/admin\/?/, '') // tira o prefixo /api/admin
    .replace(/^\/+|\/+$/g, '');    // tira barras sobrando nas pontas
  const method = req.method;

  let sb;
  try {
    sb = getSupabaseAdmin();
  } catch (err) {
    return sendJson(res, { error: 'server_error', message: err.message }, 500);
  }

  try {
    return await handle(sb, req, res, route, method);
  } catch (err) {
    const detalhe = err?.message ?? String(err);
    console.error('[cipher/admin]', err);

    let message = `Erro interno no painel: ${detalhe}`;
    if (/Could not find the table|does not exist|schema cache|relation .* does not exist/i.test(detalhe)) {
      message =
        'As tabelas de licença ainda não existem no seu Supabase. ' +
        'Rode o supabase-migration.sql no SQL Editor do Supabase e tente de novo.';
    }
    return sendJson(res, { error: 'server_error', message }, 500);
  }
}

async function handle(sb, req, res, route, method) {
  const url = new URL(req.url, 'http://localhost');

  // ---------------- Gerar keys em lote ----------------
  if (route === 'keys/generate' && method === 'POST') {
    const b = await readBody(req);
    const plan = String(b.plan ?? '');
    if (!PLANS[plan]) {
      return sendJson(
        res,
        { error: 'invalid_plan', message: `Plano desconhecido: ${plan}`, plans: Object.keys(PLANS) },
        400,
      );
    }

    const quantity = Math.min(Math.max(parseInt(String(b.quantity ?? '1'), 10) || 1, 1), 500);
    const def = PLANS[plan];
    const maxDevices = Math.min(Math.max(parseInt(String(b.max_devices ?? ''), 10) || def.maxDevices, 1), 10);
    const batch = String(b.batch || `lote-${new Date().toISOString().slice(0, 10)}`).slice(0, 64);
    const note = b.note ? String(b.note).slice(0, 256) : null;
    const userName = b.user_name ? String(b.user_name).slice(0, 120) : null;

    const rows = Array.from({ length: quantity }, () => ({
      license_key: generateKey(plan),
      plan,
      duration_seconds: def.seconds,
      status: 'unused',
      max_devices: maxDevices,
      user_name: userName,
      note,
      batch,
    }));

    const { data, error } = await sb.from(T.licenses).insert(rows).select('license_key');
    if (error) throw new Error(error.message);

    const criadas = data ?? [];
    await logEvent(sb, 'generate', null, null, `${criadas.length}x ${plan} (lote ${batch})`, null);

    return sendJson(res, {
      ok: true,
      plan,
      plan_label: def.label,
      quantity: criadas.length,
      batch,
      keys: criadas.map((r) => r.license_key),
    });
  }

  // ---------------- Listar keys ----------------
  if (route === 'keys' && method === 'GET') {
    const status = url.searchParams.get('status');
    const plan = url.searchParams.get('plan');
    const q = url.searchParams.get('q');
    const batch = url.searchParams.get('batch');
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '', 10) || 100, 500);
    const offset = parseInt(url.searchParams.get('offset') ?? '', 10) || 0;

    let query = sb.from(T.licenses).select('*', { count: 'exact' });
    if (status) query = query.eq('status', status);
    if (plan) query = query.eq('plan', plan);
    if (batch) query = query.eq('batch', batch);
    if (q) {
      const like = `%${q}%`;
      query = query.or(`license_key.ilike.${like},user_name.ilike.${like},note.ilike.${like}`);
    }

    const { data, count, error } = await query.order('id', { ascending: false }).range(offset, offset + limit - 1);
    if (error) throw new Error(error.message);

    const keys = data ?? [];

    // Conta os dispositivos de todas as keys numa consulta só.
    const contagem = {};
    if (keys.length) {
      const { data: devs } = await sb
        .from(T.devices)
        .select('license_id')
        .in('license_id', keys.map((r) => r.id));
      for (const d of devs ?? []) contagem[d.license_id] = (contagem[d.license_id] ?? 0) + 1;
    }

    return sendJson(res, {
      ok: true,
      total: count ?? 0,
      limit,
      offset,
      keys: keys.map((r) => ({ ...r, device_count: contagem[r.id] ?? 0 })),
    });
  }

  // ---------------- Ações sobre uma key ----------------
  const keyMatch = route.match(/^keys\/(\d+)(?:\/([a-z-]+))?$/);
  if (keyMatch) {
    const id = Number(keyMatch[1]);
    const action = keyMatch[2] ?? '';

    const { data: row } = await sb.from(T.licenses).select('*').eq('id', id).maybeSingle();
    if (!row) return sendJson(res, { error: 'not_found', message: 'Key não encontrada.' }, 404);

    if (!action && method === 'GET') {
      const { data: devices } = await sb
        .from(T.devices)
        .select('*')
        .eq('license_id', id)
        .order('last_seen_at', { ascending: false });
      const { data: events } = await sb
        .from(T.events)
        .select('*')
        .eq('license_id', id)
        .order('id', { ascending: false })
        .limit(50);
      return sendJson(res, { ok: true, key: row, devices: devices ?? [], events: events ?? [] });
    }

    if (!action && method === 'DELETE') {
      const { error } = await sb.from(T.licenses).delete().eq('id', id);
      if (error) throw new Error(error.message);
      return sendJson(res, { ok: true, deleted: id });
    }

    if (action === 'revoke' && method === 'POST') {
      await sb.from(T.licenses).update({ status: 'revoked' }).eq('id', id);
      await logEvent(sb, 'revoke', id, null, 'revogada pelo painel', null);
      return sendJson(res, { ok: true, id, status: 'revoked' });
    }

    if (action === 'unrevoke' && method === 'POST') {
      const back = row.activated_at ? 'active' : 'unused';
      await sb.from(T.licenses).update({ status: back }).eq('id', id);
      return sendJson(res, { ok: true, id, status: back });
    }

    // Libera a key para um dispositivo novo (cliente trocou de PC).
    if (action === 'reset-devices' && method === 'POST') {
      await sb.from(T.devices).delete().eq('license_id', id);
      await logEvent(sb, 'reset_device', id, null, 'dispositivos liberados pelo painel', null);
      return sendJson(res, { ok: true, id, devices_cleared: true });
    }

    // Estende a validade. Aceita { days } ou { seconds }.
    if (action === 'extend' && method === 'POST') {
      const b = await readBody(req);
      const seconds = parseInt(String(b.seconds ?? ''), 10) || (parseFloat(String(b.days ?? '')) || 0) * 86400;
      if (!seconds) {
        return sendJson(res, { error: 'invalid_request', message: 'Informe days ou seconds.' }, 400);
      }
      const base = row.expires_at && new Date(row.expires_at) > new Date() ? new Date(row.expires_at) : new Date();
      const next = new Date(base.getTime() + seconds * 1000).toISOString();
      await sb.from(T.licenses).update({ expires_at: next, status: 'active' }).eq('id', id);
      return sendJson(res, { ok: true, id, expires_at: next });
    }
  }

  // ---------------- Estatísticas ----------------
  if (route === 'stats' && method === 'GET') {
    const { data, error } = await sb.from(T.licenses).select('status, plan');
    if (error) throw new Error(error.message);
    const all = data ?? [];

    const byStatus = {};
    const byPlan = {};
    for (const r of all) {
      byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
      byPlan[r.plan] = (byPlan[r.plan] ?? 0) + 1;
    }

    const fiveMin = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { data: recentes } = await sb.from(T.devices).select('license_id').gte('last_seen_at', fiveMin);
    const online = new Set((recentes ?? []).map((d) => d.license_id)).size;

    return sendJson(res, {
      ok: true,
      total: all.length,
      online_now: online,
      by_status: Object.entries(byStatus).map(([status, count]) => ({ status, count })),
      by_plan: Object.entries(byPlan).map(([plan, count]) => ({ plan, count })),
      plans: Object.entries(PLANS).map(([id, p]) => ({ id, ...p })),
    });
  }

  // ---------------- Eventos recentes ----------------
  if (route === 'events' && method === 'GET') {
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '', 10) || 100, 500);
    const { data } = await sb.from(T.events).select('*').order('id', { ascending: false }).limit(limit);
    const events = data ?? [];

    const ids = [...new Set(events.map((e) => e.license_id).filter((v) => v != null))];
    const chaves = {};
    if (ids.length) {
      const { data: lics } = await sb.from(T.licenses).select('id, license_key').in('id', ids);
      for (const l of lics ?? []) chaves[l.id] = l.license_key;
    }

    return sendJson(res, {
      ok: true,
      events: events.map((e) => ({
        ...e,
        license_key: e.license_id != null ? (chaves[e.license_id] ?? null) : null,
      })),
    });
  }

  // ---------------- Planos exibidos na loja ----------------
  if (route === 'packages') {
    if (method === 'GET') {
      const { data } = await sb.from(T.packages).select('*').order('sort_order', { ascending: true });
      return sendJson(res, { ok: true, packages: data ?? [] });
    }
    if (method === 'POST') {
      const b = await readBody(req);
      if (!b.id || !b.name || !b.plan) {
        return sendJson(res, { error: 'invalid_request', message: 'id, name e plan são obrigatórios.' }, 400);
      }
      const { error } = await sb.from(T.packages).upsert(
        {
          id: String(b.id),
          name: String(b.name),
          description: b.description ? String(b.description) : null,
          price: Number(b.price) || 0,
          currency: String(b.currency ?? 'BRL'),
          plan: String(b.plan),
          checkout_url: b.checkout_url ? String(b.checkout_url) : null,
          is_active: b.is_active !== false,
          sort_order: parseInt(String(b.sort_order ?? '0'), 10) || 0,
        },
        { onConflict: 'id' },
      );
      if (error) throw new Error(error.message);
      return sendJson(res, { ok: true, id: b.id });
    }
  }

  return sendJson(
    res,
    {
      error: 'not_found',
      // DIAGNÓSTICO temporário: mostra o que a Vercel entregou, para
      // descobrir de onde tirar a rota. Some quando o roteamento acertar.
      message: `[v2] Rota admin desconhecida: ${method} /${route} · req.url=${req.url} · query.path=${JSON.stringify(req.query?.path)}`,
      seen: { url: req.url, route, query: req.query },
    },
    404,
  );
}

// ============================================================
// Cipher Project — rotas PÚBLICAS de licença
//
//   POST /api/license/validate    ativa / valida uma key
//   POST /api/license/heartbeat   revalidação periódica (extensão)
//   GET  /api/license/packages    planos à venda (para a loja)
//   GET  /api/license/plans       catálogo de durações
//   GET  /api/license/health      teste rápido de que a API subiu
//
// Sempre responde 200 com { valid: bool, ... } nas validações —
// a extensão lê o campo `valid`, não o status HTTP.
// ============================================================

import { getSupabaseAdmin } from '../../lib/supabase.js';
import { PLANS, validateLicense } from '../../lib/licenses.js';
import { sendJson, preflight, readBody, requestMeta } from '../../lib/http.js';

// Roda a limpeza de expiradas de vez em quando, sem precisar de cron.
let ultimaLimpeza = 0;
const INTERVALO_LIMPEZA = 30 * 60 * 1000; // 30 min

export default async function handler(req, res) {
  const action = String(req.query.action || '');

  if (req.method === 'OPTIONS') return preflight(res);

  // health não toca no banco: serve para saber se o deploy subiu.
  if (req.method === 'GET' && action === 'health') {
    return sendJson(res, { ok: true, service: 'Cipher Project', time: new Date().toISOString() });
  }

  let sb;
  try {
    sb = getSupabaseAdmin();
  } catch (err) {
    console.error('[cipher/license] supabase', err);
    return sendJson(res, { error: 'server_error', message: err.message }, 500);
  }

  try {
    // ---------------- GET ----------------
    if (req.method === 'GET') {
      if (action === 'packages') {
        const { data, error } = await sb
          .from('license_packages')
          .select('id, name, description, price, currency, plan, checkout_url, sort_order')
          .eq('is_active', true)
          .order('sort_order', { ascending: true });
        if (error) throw new Error(error.message);
        return sendJson(res, data ?? []);
      }

      if (action === 'plans') {
        return sendJson(
          res,
          Object.entries(PLANS).map(([id, p]) => ({
            id,
            label: p.label,
            seconds: p.seconds,
            max_devices: p.maxDevices,
          })),
        );
      }

      return sendJson(res, { error: 'not_found', message: `Rota desconhecida: GET /api/license/${action}` }, 404);
    }

    // ---------------- POST ----------------
    if (req.method === 'POST') {
      if (action !== 'validate' && action !== 'heartbeat') {
        return sendJson(res, { error: 'not_found', message: `Rota desconhecida: POST /api/license/${action}` }, 404);
      }

      const body = await readBody(req);
      const result = await validateLicense(
        sb,
        body.license_key ?? body.key,
        body.device_id ?? body.deviceId,
        requestMeta(req),
      );

      if (action === 'validate') {
        // Limpeza oportunista de keys vencidas, sem bloquear a resposta.
        if (Date.now() - ultimaLimpeza > INTERVALO_LIMPEZA) {
          ultimaLimpeza = Date.now();
          try {
            void Promise.resolve(sb.rpc('cipher_expire_old_licenses')).catch(() => {});
          } catch {
            // manutenção é best-effort; nunca afeta o cliente
          }
        }
        return sendJson(res, result);
      }

      // Heartbeat devolve só o necessário para a UI e o contador.
      return sendJson(res, {
        valid: result.valid,
        reason: result.reason,
        message: result.message,
        status: result.status,
        expires_at: result.expires_at,
        activated_at: result.activated_at,
        lifetime: result.lifetime,
        license_type: result.license_type,
        seconds_remaining: result.seconds_remaining,
        online_count: result.online_count,
        plan: result.plan,
        plan_label: result.plan_label,
        server_time: result.server_time,
      });
    }

    return sendJson(res, { error: 'method_not_allowed', message: `Método ${req.method} não suportado.` }, 405);
  } catch (err) {
    console.error('[cipher/license]', err);
    return sendJson(res, { error: 'server_error', message: 'Erro interno no servidor de licenças.' }, 500);
  }
}

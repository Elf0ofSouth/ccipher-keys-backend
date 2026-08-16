// ============================================================
// Cipher Project — cliente Supabase com service_role
//
// A service_role key IGNORA o RLS. Ela é SEGREDO e só existe aqui,
// lida de variável de ambiente no servidor. NUNCA vai para a
// extensão nem para o navegador.
//
// Este é o SEU Supabase (o das keys) — não tem relação com o
// Supabase que a extensão usa para os recursos. São dois projetos
// diferentes, de propósito.
// ============================================================

import { createClient } from '@supabase/supabase-js';

let _client;

export function getSupabaseAdmin() {
  if (_client) return _client;

  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) {
    const missing = [
      ...(!url ? ['SUPABASE_URL'] : []),
      ...(!serviceKey ? ['SUPABASE_SERVICE_ROLE_KEY'] : []),
    ].join(', ');
    throw new Error(
      `Faltando variável de ambiente: ${missing}. ` +
        'Defina em Vercel → Settings → Environment Variables e faça Redeploy.',
    );
  }

  _client = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _client;
}

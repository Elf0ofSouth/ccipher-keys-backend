// ============================================================
// Cipher Project — helpers de HTTP para as functions da Vercel
//
// Sem segredos aqui. As functions recebem (req, res) no estilo
// Node/Vercel; estes helpers padronizam CORS, JSON e auth de admin.
// ============================================================

/**
 * A extensão roda dentro de qualquer página (content script no
 * lovable.dev), então o CORS precisa ser aberto.
 *
 * Isso é seguro porque nenhuma rota depende de cookie de sessão:
 * quem autentica é a key da licença ou o token de admin, ambos
 * enviados explicitamente. Um site malicioso não ganha nada
 * chamando a API sem possuir uma key válida.
 */
export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-license-key, x-device-id',
  'Access-Control-Max-Age': '86400',
};

export function applyCors(res) {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);
}

export function sendJson(res, data, status = 200) {
  applyCors(res);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.status(status).send(JSON.stringify(data));
}

export function preflight(res) {
  applyCors(res);
  res.status(204).end();
}

/**
 * Lê o corpo da requisição como JSON. Na Vercel `req.body` às vezes
 * já vem parseado, às vezes vem string, às vezes chega vazio — este
 * helper cobre os três casos e nunca estoura.
 */
export async function readBody(req) {
  try {
    if (req.body && typeof req.body === 'object') return req.body;
    if (typeof req.body === 'string' && req.body.trim()) return JSON.parse(req.body);

    // Fallback: lê o stream manualmente.
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (!chunks.length) return {};
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function requestMeta(req) {
  const forwarded = String(req.headers['x-forwarded-for'] ?? '');
  return {
    ip: forwarded.split(',')[0].trim() || null,
    country: req.headers['x-vercel-ip-country'] ?? null,
    userAgent: req.headers['user-agent'] ?? null,
  };
}

/** Comparação em tempo constante — evita descobrir o token por cronometragem. */
export function safeEqual(a, b) {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
  return diff === 0;
}

export function isAdmin(req) {
  const header = String(req.headers['authorization'] ?? '');
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const expected = process.env.CIPHER_ADMIN_TOKEN ?? '';
  if (!expected) return false;
  return safeEqual(token, expected);
}

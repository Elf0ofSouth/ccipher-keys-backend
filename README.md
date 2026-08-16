# Cipher Project — Backend de Keys

Sistema de licenciamento por key **independente**, para você revender a
extensão. Roda no **seu** Supabase + **sua** Vercel, sem depender de
ninguém. Não tem relação com o Supabase que a extensão usa para os
recursos (aquele continua igual).

O que ele faz:

- Gera keys em lote por plano (trial, diária, semanal, mensal, anual, vitalícia)
- Valida a key no servidor a cada uso (revalidação a cada ~20s)
- **A contagem começa no primeiro uso**, não na geração — pode gerar hoje e vender depois
- Trava a key por dispositivo (fingerprint) — bloqueia compartilhamento
- Trial de 15 min é uma vez por dispositivo, para sempre
- Revogar uma key derruba o cliente em até ~1 min, sem update
- Painel web pronto (`/admin.html`) para gerar/revogar/liberar/estender
- Não derruba cliente pagante numa queda de internet (tolera 6h offline, nunca além da validade)

A lógica passa em **39 testes** (`npm test`).

---

## Passo a passo (uma vez só)

### 1. Criar o seu Supabase

1. Entre em [supabase.com](https://supabase.com) → **New project** (o plano free serve).
2. Quando abrir, vá em **SQL Editor** → **New query**.
3. Cole todo o conteúdo de `supabase-migration.sql` → **Run**.
4. Em **Table Editor**, confirme que apareceram: `licenses`, `license_devices`,
   `license_trial_claims`, `license_events`, `license_packages` — todas com o
   cadeado **RLS enabled**.
5. Em **Project Settings → API**, guarde dois valores:
   - **Project URL** → vira `SUPABASE_URL`
   - **service_role** (clique em *Reveal*) → vira `SUPABASE_SERVICE_ROLE_KEY` (é SEGREDO)

### 2. Subir o backend na Vercel

1. Suba esta pasta (`cipher-keys-backend`) para um repositório no GitHub.
2. Em [vercel.com](https://vercel.com) → **Add New → Project** → importe esse repo.
3. Antes de finalizar, em **Environment Variables**, adicione:

   | Nome | Valor |
   |---|---|
   | `SUPABASE_URL` | Project URL do passo 1 |
   | `SUPABASE_SERVICE_ROLE_KEY` | service_role do passo 1 |
   | `CIPHER_ADMIN_TOKEN` | você inventa — senha longa e aleatória (é a senha do painel) |
   | `CIPHER_RESET_PAGE_URL` | (opcional) link p/ o cliente pedir reset de PC |

4. **Deploy**. Ao terminar, você terá um domínio, ex.: `https://cipher-keys.vercel.app`.
5. Teste: abra `https://SEU-DOMINIO/api/license/health` → deve responder
   `{"ok":true,"service":"Cipher Project",...}`.

> Mudou variável depois? Vá em **Deployments → ⋯ → Redeploy**. Variável nova
> só vale no próximo build.

### 3. Apontar a extensão

Abra `fnx-license.js` na pasta da extensão e edite **as duas primeiras linhas**:

```js
var LICENSE_API_BASE = "https://cipher-keys.vercel.app";  // domínio da Vercel do passo 2
var STORE_BASE       = "https://sua-loja.com";            // p/ onde o botão "Comprar" leva
```

Salve. Esse é o **único** arquivo da extensão que muda.

### 4. Empacotar e vender

1. Compacte a pasta da extensão num `.zip`.
2. O cliente instala em `chrome://extensions` → Modo desenvolvedor → Carregar sem compactação.
3. Para gerar keys: abra `https://SEU-DOMINIO/admin.html`, cole o
   `CIPHER_ADMIN_TOKEN`, escolha plano e quantidade, copie as keys e entregue
   ao cliente após o pagamento.

O pagamento acontece na **sua** loja/checkout (Kirvano, Mercado Pago, Hotmart…),
fora da extensão. Você recebe, gera a key no painel e entrega.

---

## Planos

| Plano | Duração | Dispositivos | Formato da key |
|---|---|---|---|
| `trial15` | 15 minutos | 1 | `CPHR-TRL-…` |
| `daily` | 1 dia | 1 | `CPHR-DAY-…` |
| `weekly` | 7 dias | 1 | `CPHR-WEK-…` |
| `monthly` | 30 dias | 2 | `CPHR-MTH-…` |
| `yearly` | 365 dias | 2 | `CPHR-YER-…` |
| `lifetime` | sem expiração | 2 | `CPHR-LIF-…` |

Para mudar durações/dispositivos, edite `PLANS` em `lib/licenses.js` e faça
push. Preços e links de checkout ficam na tabela `license_packages` (edite pelo
Table Editor do Supabase).

---

## Rotas

Públicas (a extensão usa):

- `POST /api/license/validate` — ativa/valida uma key
- `POST /api/license/heartbeat` — revalidação leve
- `GET  /api/license/packages` — planos à venda (para a sua loja)
- `GET  /api/license/health` — teste de que subiu

Painel (exigem `Authorization: Bearer <CIPHER_ADMIN_TOKEN>`):

- `POST /api/admin/keys/generate`
- `GET  /api/admin/keys` · `GET/DELETE /api/admin/keys/:id`
- `POST /api/admin/keys/:id/revoke` · `/unrevoke` · `/reset-devices` · `/extend`
- `GET  /api/admin/stats` · `GET /api/admin/events`

---

## Se der errado

| Sintoma | Causa provável |
|---|---|
| `/api/license/health` dá 500 | Falta `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`, ou não fez Redeploy depois de adicioná-las. |
| Painel diz "Token inválido" | `CIPHER_ADMIN_TOKEN` não definido, ou definido depois do último deploy. |
| Toda key dá `not_found` | A migration não rodou, ou rodou em outro projeto do Supabase. |
| Extensão diz "sem backend configurado" | `LICENSE_API_BASE` em `fnx-license.js` ainda tem `SEU-BACKEND`. |
| "não respondeu como servidor de licenças" | O `LICENSE_API_BASE` aponta para um domínio que não é este backend. |

---

## Rodar os testes

```bash
npm install
npm test
```

39 verificações sobre ativação, expiração, trial, trava de dispositivo,
revogação e vitalícia. Rodam contra SQLite local, sem tocar no Supabase.

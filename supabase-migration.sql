-- ============================================================
-- Cipher Project — sistema de licenças da extensão
--
-- Rode isto no SEU Supabase novo (o das keys), NÃO no do seu amigo.
-- Supabase → SQL Editor → cole tudo → Run.
--
-- Cria as tabelas do zero. Não toca em mais nada.
-- ============================================================


-- ---------- Keys ----------
create table if not exists public.licenses (
  id                bigint generated always as identity primary key,
  license_key       text        not null unique,
  plan              text        not null,   -- trial15 | daily | weekly | monthly | yearly | lifetime
  duration_seconds  integer     not null,   -- 0 = vitalícia
  status            text        not null default 'unused',  -- unused | active | expired | revoked
  max_devices       integer     not null default 1,
  user_name         text,
  note              text,
  batch             text,
  created_at        timestamptz not null default now(),
  activated_at      timestamptz,            -- preenchido na PRIMEIRA validação
  expires_at        timestamptz,            -- activated_at + duration_seconds
  last_seen_at      timestamptz,
  validate_count    integer     not null default 0
);

create index if not exists idx_licenses_status  on public.licenses (status);
create index if not exists idx_licenses_plan    on public.licenses (plan);
create index if not exists idx_licenses_batch   on public.licenses (batch);
create index if not exists idx_licenses_expires on public.licenses (expires_at);


-- ---------- Dispositivos vinculados a cada key ----------
create table if not exists public.license_devices (
  id            bigint      generated always as identity primary key,
  license_id    bigint      not null references public.licenses (id) on delete cascade,
  device_id     text        not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  ip            text,
  country       text,
  user_agent    text,
  unique (license_id, device_id)
);

create index if not exists idx_license_devices_license on public.license_devices (license_id);
create index if not exists idx_license_devices_device  on public.license_devices (device_id);


-- ---------- Anti-farm de trial ----------
-- Um dispositivo só usa UMA key de teste, para sempre.
create table if not exists public.license_trial_claims (
  device_id  text        primary key,
  license_id bigint      references public.licenses (id) on delete set null,
  claimed_at timestamptz not null default now()
);


-- ---------- Log de eventos (auditoria / suporte) ----------
create table if not exists public.license_events (
  id         bigint      generated always as identity primary key,
  at         timestamptz not null default now(),
  kind       text        not null,   -- activate | reject | revoke | reset_device | generate | expire
  license_id bigint      references public.licenses (id) on delete set null,
  device_id  text,
  detail     text,
  ip         text
);

create index if not exists idx_license_events_at      on public.license_events (at desc);
create index if not exists idx_license_events_license on public.license_events (license_id);


-- ---------- Planos exibidos ao cliente na loja ----------
create table if not exists public.license_packages (
  id           text    primary key,
  name         text    not null,
  description  text,
  price        numeric not null default 0,
  currency     text    not null default 'BRL',
  plan         text    not null,   -- casa com licenses.plan
  checkout_url text,               -- link do seu gateway (Kirvano, Mercado Pago…)
  is_active    boolean not null default true,
  sort_order   integer not null default 0
);


-- ============================================================
-- SEGURANÇA (RLS)
-- ============================================================
-- O Supabase publica as tabelas do schema `public` numa API REST que
-- aceita a publishable/anon key — e essa chave é pública.
--
-- RLS ligado + zero policies = ninguém entra por essas chaves.
-- Só a service_role key (que fica em variável de ambiente no servidor)
-- ignora o RLS, e é ela que a API usa.

alter table public.licenses             enable row level security;
alter table public.license_devices      enable row level security;
alter table public.license_trial_claims enable row level security;
alter table public.license_events       enable row level security;
alter table public.license_packages     enable row level security;

revoke all on public.licenses             from anon, authenticated;
revoke all on public.license_devices      from anon, authenticated;
revoke all on public.license_trial_claims from anon, authenticated;
revoke all on public.license_events       from anon, authenticated;
revoke all on public.license_packages     from anon, authenticated;

grant all on public.licenses             to service_role;
grant all on public.license_devices      to service_role;
grant all on public.license_trial_claims to service_role;
grant all on public.license_events       to service_role;
grant all on public.license_packages     to service_role;


-- ============================================================
-- MANUTENÇÃO
-- ============================================================
-- Marca como expiradas as keys que passaram da validade, para o painel
-- mostrar números certos mesmo sem o cliente abrir a extensão.
-- A API chama isso sozinha de vez em quando; não precisa agendar nada.
create or replace function public.cipher_expire_old_licenses()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  afetadas integer;
begin
  update public.licenses
     set status = 'expired'
   where status = 'active'
     and expires_at is not null
     and expires_at <= now();
  get diagnostics afetadas = row_count;
  return afetadas;
end;
$$;

revoke execute on function public.cipher_expire_old_licenses() from public, anon, authenticated;
grant  execute on function public.cipher_expire_old_licenses() to service_role;


-- ============================================================
-- PLANOS INICIAIS (ajuste preços e checkout_url pelo painel)
-- ============================================================
insert into public.license_packages (id, name, description, price, plan, sort_order) values
  ('trial15', 'Teste 15 minutos', 'Acesso completo por 15 minutos. Uma vez por dispositivo.', 0,      'trial15', 1),
  ('daily',   'Diária',           'Acesso completo por 24 horas.',                             9.90,   'daily',   2),
  ('weekly',  'Semanal',          'Acesso completo por 7 dias.',                               29.90,  'weekly',  3),
  ('monthly', 'Mensal',           'Acesso completo por 30 dias.',                              79.90,  'monthly', 4),
  ('yearly',  'Anual',            'Acesso completo por 365 dias. Melhor custo-benefício.',     499.90, 'yearly',  5)
on conflict (id) do nothing;

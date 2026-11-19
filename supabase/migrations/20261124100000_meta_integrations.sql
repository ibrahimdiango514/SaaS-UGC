-- VYORA Meta Integrations — socle de données.
--
-- Produits : WhatsApp Business (Embedded Signup), Facebook Pages, Messenger,
-- Instagram Business (Facebook Login for Business). Une application Meta
-- unique, des connexions par (utilisateur, entreprise, produit).
--
-- Principes :
--  * Aucun jeton en clair en base : les jetons vivent dans Vault
--    (`vault.create_secret`), la table ne porte que le NOM du secret
--    (`token_ref`), comme `integration_connections.credential_ref`.
--  * RLS activée et FORCÉE partout ; aucune politique pour `anon` ni
--    `authenticated` : l'accès passe par les fonctions `security definer`
--    ci-dessous, appelées par la fonction Edge `meta-connect` après contrôle
--    GoTrue + abonnement (`bg_import_access`) + droits d'entreprise
--    (`bg_can_workspace`). Elles ne font PAS confiance à `auth.uid()` : le
--    `p_user_id` vient du JWT vérifié côté Edge, comme pour `store-connect`.
--  * Idempotence des Webhooks : `meta_webhook_events.dedupe_key` unique.
--  * Journal : `integration_connection_checks` (existant) pour chaque
--    connexion/vérification, sans jeton.
--
-- Retour arrière : drop des tables `saas_business.meta_*` et des fonctions
-- `saas_business.meta_*` ; suppression des lignes `whatsapp`/`messenger` de
-- `integration_providers` (seulement si aucune `oauth_accounts` ne les référence).

-- 1) Fournisseurs reconnus par le socle (clé de connecteur valide).
insert into saas_business.integration_providers (provider_key, auth_mode, capabilities, implemented) values
  ('whatsapp',  'oauth2', array['read','send','modify'], false),
  ('messenger', 'oauth2', array['read','send'],          false)
on conflict (provider_key) do nothing;

-- 2) États OAuth (usage unique, expiration courte).
create table if not exists saas_business.meta_oauth_states (
  state         text primary key,
  user_id       uuid not null,
  workspace_id  uuid not null,
  product       text not null check (product in ('whatsapp','facebook','messenger','instagram')),
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  consumed_at   timestamptz
);
create index if not exists meta_oauth_states_expires_idx on saas_business.meta_oauth_states (expires_at);
alter table saas_business.meta_oauth_states enable row level security;
alter table saas_business.meta_oauth_states force row level security;
revoke all on saas_business.meta_oauth_states from anon, authenticated;

-- 3) Connexions Meta.
create table if not exists saas_business.meta_connections (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null,
  workspace_id         uuid not null,
  product              text not null check (product in ('whatsapp','facebook','messenger','instagram')),
  status               text not null default 'connected'
                       check (status in ('connected','expired','revoked','error','disconnected')),
  -- Identifiant externe principal : identifiant utilisateur Facebook (Login
  -- for Business) ou identifiant du compte WhatsApp Business (WABA).
  external_account_id  text not null,
  display_name         text,
  granted_scopes       text[] not null default '{}',
  -- Nom du secret Vault portant le jeton (utilisateur long ou système WhatsApp).
  token_ref            text,
  token_expires_at     timestamptz,
  -- WhatsApp : waba_id, phone_number_id, display_phone_number, verified_name,
  -- quality_rating, registered, webhook_subscribed. Facebook : business_id.
  metadata             jsonb not null default '{}'::jsonb,
  last_error           text,
  last_verified_at     timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (user_id, workspace_id, product)
);
create index if not exists meta_connections_workspace_idx on saas_business.meta_connections (workspace_id, product);
create index if not exists meta_connections_phone_idx on saas_business.meta_connections ((metadata->>'phone_number_id')) where product = 'whatsapp';
alter table saas_business.meta_connections enable row level security;
alter table saas_business.meta_connections force row level security;
revoke all on saas_business.meta_connections from anon, authenticated;

-- 4) Pages sélectionnées (Facebook Pages, Messenger, Instagram via page).
create table if not exists saas_business.meta_pages (
  id                             uuid primary key default gen_random_uuid(),
  connection_id                  uuid not null references saas_business.meta_connections (id) on delete cascade,
  user_id                        uuid not null,
  workspace_id                   uuid not null,
  page_id                        text not null,
  name                           text not null,
  category                       text,
  tasks                          text[] not null default '{}',
  -- Nom du secret Vault portant le jeton de page.
  token_ref                      text,
  instagram_business_account_id  text,
  instagram_username             text,
  webhook_subscribed             boolean not null default false,
  created_at                     timestamptz not null default now(),
  updated_at                     timestamptz not null default now(),
  unique (connection_id, page_id)
);
create index if not exists meta_pages_page_idx on saas_business.meta_pages (page_id);
create index if not exists meta_pages_ig_idx on saas_business.meta_pages (instagram_business_account_id) where instagram_business_account_id is not null;
alter table saas_business.meta_pages enable row level security;
alter table saas_business.meta_pages force row level security;
revoke all on saas_business.meta_pages from anon, authenticated;

-- 5) Événements Webhook (déduplication + trace).
create table if not exists saas_business.meta_webhook_events (
  id           bigserial primary key,
  object       text not null,
  kind         text not null,
  dedupe_key   text not null unique,
  received_at  timestamptz not null default now(),
  payload      jsonb not null,
  processed    boolean not null default false,
  error        text
);
alter table saas_business.meta_webhook_events enable row level security;
alter table saas_business.meta_webhook_events force row level security;
revoke all on saas_business.meta_webhook_events from anon, authenticated;

-- 6) Messages (WhatsApp, Messenger) : historique des conversations.
create table if not exists saas_business.meta_messages (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null,
  workspace_id         uuid not null,
  connection_id        uuid references saas_business.meta_connections (id) on delete set null,
  channel              text not null check (channel in ('whatsapp','messenger','instagram')),
  -- WhatsApp : phone_number_id ; Messenger : page_id.
  account_ref          text not null,
  -- WhatsApp : wa_id du contact ; Messenger : PSID.
  conversation_ref     text not null,
  external_message_id  text not null unique,
  direction            text not null check (direction in ('in','out')),
  message_type         text not null default 'text',
  body                 text,
  status               text not null default 'received',
  error_code           integer,
  error_message        text,
  sent_at              timestamptz not null default now(),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index if not exists meta_messages_conv_idx on saas_business.meta_messages (workspace_id, channel, account_ref, conversation_ref, sent_at desc);
alter table saas_business.meta_messages enable row level security;
alter table saas_business.meta_messages force row level security;
revoke all on saas_business.meta_messages from anon, authenticated;

-- 7) Événements de page (commentaires, publications) rattachés à une entreprise.
create table if not exists saas_business.meta_page_events (
  id            bigserial primary key,
  user_id       uuid not null,
  workspace_id  uuid not null,
  page_id       text not null,
  channel       text not null check (channel in ('facebook','instagram')),
  item          text,
  verb          text,
  post_id       text,
  comment_id    text,
  from_id       text,
  message       text,
  occurred_at   timestamptz not null default now(),
  created_at    timestamptz not null default now()
);
create index if not exists meta_page_events_idx on saas_business.meta_page_events (workspace_id, page_id, occurred_at desc);
alter table saas_business.meta_page_events enable row level security;
alter table saas_business.meta_page_events force row level security;
revoke all on saas_business.meta_page_events from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Fonctions (security definer). `p_user_id` et `p_workspace_id` proviennent
-- de la fonction Edge après vérification ; chaque fonction re-filtre dessus.
-- ---------------------------------------------------------------------------

create or replace function saas_business.meta_state_create(
  p_state text, p_user_id uuid, p_workspace_id uuid, p_product text, p_ttl_seconds integer default 600
) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if p_state is null or length(p_state) < 40 then raise exception 'meta_invalid:STATE' using errcode = '22023'; end if;
  if p_user_id is null or p_workspace_id is null then raise exception 'meta_forbidden:NOT_AUTHENTICATED' using errcode = '42501'; end if;
  -- Nettoyage opportuniste des états périmés.
  delete from saas_business.meta_oauth_states where expires_at < now() - interval '1 hour';
  insert into saas_business.meta_oauth_states (state, user_id, workspace_id, product, expires_at)
  values (p_state, p_user_id, p_workspace_id, p_product, now() + make_interval(secs => greatest(60, least(p_ttl_seconds, 900))));
  return true;
end $$;

-- Consomme un état : une seule fois, non expiré. Rend la ligne ou rien.
create or replace function saas_business.meta_state_consume(p_state text)
returns table (user_id uuid, workspace_id uuid, product text)
language plpgsql security definer set search_path = '' as $$
begin
  return query
  update saas_business.meta_oauth_states s
     set consumed_at = now()
   where s.state = p_state and s.consumed_at is null and s.expires_at >= now()
  returning s.user_id, s.workspace_id, s.product;
end $$;

create or replace function saas_business.meta_connection_upsert(p_payload jsonb)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_user uuid := (p_payload->>'user_id')::uuid;
  v_ws uuid := (p_payload->>'workspace_id')::uuid;
  v_product text := p_payload->>'product';
begin
  if v_user is null or v_ws is null then raise exception 'meta_forbidden:NOT_AUTHENTICATED' using errcode = '42501'; end if;
  insert into saas_business.meta_connections as c (
    user_id, workspace_id, product, status, external_account_id, display_name, granted_scopes,
    token_ref, token_expires_at, metadata, last_error, last_verified_at
  ) values (
    v_user, v_ws, v_product, coalesce(p_payload->>'status', 'connected'),
    p_payload->>'external_account_id', p_payload->>'display_name',
    coalesce(array(select jsonb_array_elements_text(coalesce(p_payload->'granted_scopes', '[]'::jsonb))), '{}'),
    p_payload->>'token_ref', (p_payload->>'token_expires_at')::timestamptz,
    coalesce(p_payload->'metadata', '{}'::jsonb), null, now()
  )
  on conflict (user_id, workspace_id, product) do update set
    status = excluded.status,
    external_account_id = excluded.external_account_id,
    display_name = excluded.display_name,
    granted_scopes = excluded.granted_scopes,
    token_ref = excluded.token_ref,
    token_expires_at = excluded.token_expires_at,
    metadata = c.metadata || excluded.metadata,
    last_error = null,
    last_verified_at = now(),
    updated_at = now()
  returning id into v_id;
  return v_id;
end $$;

create or replace function saas_business.meta_connection_set_status(
  p_user_id uuid, p_workspace_id uuid, p_product text, p_status text, p_error text default null
) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  update saas_business.meta_connections
     set status = p_status,
         last_error = left(p_error, 500),
         last_verified_at = case when p_status = 'connected' then now() else last_verified_at end,
         updated_at = now()
   where user_id = p_user_id and workspace_id = p_workspace_id and product = p_product;
  return found;
end $$;

create or replace function saas_business.meta_connection_merge_metadata(
  p_user_id uuid, p_workspace_id uuid, p_product text, p_metadata jsonb
) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  update saas_business.meta_connections
     set metadata = metadata || coalesce(p_metadata, '{}'::jsonb), updated_at = now()
   where user_id = p_user_id and workspace_id = p_workspace_id and product = p_product;
  return found;
end $$;

-- Liste pour l'interface : jamais `token_ref` (nom interne) ni jeton.
create or replace function saas_business.meta_connections_list(p_user_id uuid, p_workspace_id uuid, p_product text default null)
returns jsonb
language sql security definer stable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', c.id,
    'product', c.product,
    'status', case when c.status = 'connected' and c.token_expires_at is not null and c.token_expires_at < now() then 'expired' else c.status end,
    'external_account_id', c.external_account_id,
    'display_name', c.display_name,
    'granted_scopes', to_jsonb(c.granted_scopes),
    'token_expires_at', c.token_expires_at,
    'has_token', c.token_ref is not null,
    'metadata', c.metadata,
    'last_error', c.last_error,
    'last_verified_at', c.last_verified_at,
    'updated_at', c.updated_at,
    'pages', coalesce((
      select jsonb_agg(jsonb_build_object(
        'page_id', p.page_id, 'name', p.name, 'category', p.category, 'tasks', to_jsonb(p.tasks),
        'instagram_business_account_id', p.instagram_business_account_id,
        'instagram_username', p.instagram_username,
        'webhook_subscribed', p.webhook_subscribed, 'has_token', p.token_ref is not null
      ) order by p.name)
      from saas_business.meta_pages p where p.connection_id = c.id
    ), '[]'::jsonb)
  ) order by c.product), '[]'::jsonb)
  from saas_business.meta_connections c
  where c.user_id = p_user_id and c.workspace_id = p_workspace_id
    and (p_product is null or c.product = p_product);
$$;

-- Lecture interne (fonction Edge) : rend aussi `token_ref` pour relire Vault.
create or replace function saas_business.meta_connection_internal(p_user_id uuid, p_workspace_id uuid, p_product text)
returns jsonb
language sql security definer stable set search_path = '' as $$
  select to_jsonb(c) from saas_business.meta_connections c
  where c.user_id = p_user_id and c.workspace_id = p_workspace_id and c.product = p_product
  limit 1;
$$;

create or replace function saas_business.meta_connection_delete(p_user_id uuid, p_workspace_id uuid, p_product text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_refs text[]; v_conn_ref text;
begin
  select array_agg(p.token_ref) filter (where p.token_ref is not null) into v_refs
    from saas_business.meta_pages p
    join saas_business.meta_connections c on c.id = p.connection_id
   where c.user_id = p_user_id and c.workspace_id = p_workspace_id and c.product = p_product;
  select c.token_ref into v_conn_ref from saas_business.meta_connections c
   where c.user_id = p_user_id and c.workspace_id = p_workspace_id and c.product = p_product;
  delete from saas_business.meta_connections c
   where c.user_id = p_user_id and c.workspace_id = p_workspace_id and c.product = p_product;
  return jsonb_build_object('deleted', found, 'token_refs', to_jsonb(coalesce(v_refs, '{}'::text[]) || coalesce(array[v_conn_ref], '{}'::text[])));
end $$;

-- Remplace la sélection de pages d'une connexion.
create or replace function saas_business.meta_pages_replace(p_user_id uuid, p_workspace_id uuid, p_product text, p_pages jsonb)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_conn uuid; v_old text[];
begin
  select c.id into v_conn from saas_business.meta_connections c
   where c.user_id = p_user_id and c.workspace_id = p_workspace_id and c.product = p_product;
  if v_conn is null then raise exception 'meta_invalid:CONNECTION_REQUIRED' using errcode = '22023'; end if;
  select array_agg(p.token_ref) filter (where p.token_ref is not null) into v_old
    from saas_business.meta_pages p where p.connection_id = v_conn
     and p.page_id not in (select x->>'page_id' from jsonb_array_elements(coalesce(p_pages, '[]'::jsonb)) x);
  delete from saas_business.meta_pages p where p.connection_id = v_conn
     and p.page_id not in (select x->>'page_id' from jsonb_array_elements(coalesce(p_pages, '[]'::jsonb)) x);
  insert into saas_business.meta_pages as mp (connection_id, user_id, workspace_id, page_id, name, category, tasks, token_ref,
    instagram_business_account_id, instagram_username, webhook_subscribed)
  select v_conn, p_user_id, p_workspace_id, x->>'page_id', coalesce(x->>'name', ''), x->>'category',
         coalesce(array(select jsonb_array_elements_text(coalesce(x->'tasks', '[]'::jsonb))), '{}'),
         x->>'token_ref', x->>'instagram_business_account_id', x->>'instagram_username',
         coalesce((x->>'webhook_subscribed')::boolean, false)
    from jsonb_array_elements(coalesce(p_pages, '[]'::jsonb)) x
  on conflict (connection_id, page_id) do update set
    name = excluded.name, category = excluded.category, tasks = excluded.tasks,
    token_ref = coalesce(excluded.token_ref, mp.token_ref),
    instagram_business_account_id = excluded.instagram_business_account_id,
    instagram_username = excluded.instagram_username,
    webhook_subscribed = excluded.webhook_subscribed, updated_at = now();
  return jsonb_build_object('connection_id', v_conn, 'removed_token_refs', to_jsonb(coalesce(v_old, '{}'::text[])));
end $$;

-- Page d'une connexion (contrôle d'appartenance + token_ref pour Vault).
create or replace function saas_business.meta_page_internal(p_user_id uuid, p_workspace_id uuid, p_product text, p_page_id text)
returns jsonb
language sql security definer stable set search_path = '' as $$
  select to_jsonb(p) from saas_business.meta_pages p
  join saas_business.meta_connections c on c.id = p.connection_id
  where c.user_id = p_user_id and c.workspace_id = p_workspace_id and c.product = p_product and p.page_id = p_page_id
  limit 1;
$$;

-- Résolution par identifiant Meta (Webhooks) : aucune donnée utilisateur reçue.
create or replace function saas_business.meta_resolve_phone(p_phone_number_id text)
returns jsonb
language sql security definer stable set search_path = '' as $$
  select jsonb_build_object('connection_id', c.id, 'user_id', c.user_id, 'workspace_id', c.workspace_id)
  from saas_business.meta_connections c
  where c.product = 'whatsapp' and c.metadata->>'phone_number_id' = p_phone_number_id and c.status <> 'disconnected'
  order by c.updated_at desc limit 1;
$$;

create or replace function saas_business.meta_resolve_page(p_page_id text, p_product text)
returns jsonb
language sql security definer stable set search_path = '' as $$
  select jsonb_build_object('connection_id', c.id, 'user_id', c.user_id, 'workspace_id', c.workspace_id)
  from saas_business.meta_pages p
  join saas_business.meta_connections c on c.id = p.connection_id
  where p.page_id = p_page_id and c.product = p_product and c.status <> 'disconnected'
  order by p.updated_at desc limit 1;
$$;

create or replace function saas_business.meta_resolve_instagram(p_ig_id text)
returns jsonb
language sql security definer stable set search_path = '' as $$
  select jsonb_build_object('connection_id', c.id, 'user_id', c.user_id, 'workspace_id', c.workspace_id, 'page_id', p.page_id)
  from saas_business.meta_pages p
  join saas_business.meta_connections c on c.id = p.connection_id
  where p.instagram_business_account_id = p_ig_id and c.product = 'instagram' and c.status <> 'disconnected'
  order by p.updated_at desc limit 1;
$$;

-- Enregistre un événement Webhook ; rend false s'il était déjà connu.
create or replace function saas_business.meta_webhook_event_record(p_object text, p_kind text, p_dedupe_key text, p_payload jsonb)
returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  insert into saas_business.meta_webhook_events (object, kind, dedupe_key, payload)
  values (p_object, p_kind, p_dedupe_key, coalesce(p_payload, '{}'::jsonb))
  on conflict (dedupe_key) do nothing;
  return found;
end $$;

create or replace function saas_business.meta_webhook_event_finish(p_dedupe_key text, p_error text default null)
returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  update saas_business.meta_webhook_events set processed = (p_error is null), error = left(p_error, 500)
   where dedupe_key = p_dedupe_key;
  return found;
end $$;

create or replace function saas_business.meta_message_record(p_payload jsonb)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  insert into saas_business.meta_messages (user_id, workspace_id, connection_id, channel, account_ref, conversation_ref,
    external_message_id, direction, message_type, body, status, sent_at)
  values (
    (p_payload->>'user_id')::uuid, (p_payload->>'workspace_id')::uuid, (p_payload->>'connection_id')::uuid,
    p_payload->>'channel', p_payload->>'account_ref', p_payload->>'conversation_ref',
    p_payload->>'external_message_id', p_payload->>'direction', coalesce(p_payload->>'message_type', 'text'),
    left(p_payload->>'body', 4000), coalesce(p_payload->>'status', 'received'),
    coalesce((p_payload->>'sent_at')::timestamptz, now())
  )
  on conflict (external_message_id) do nothing
  returning id into v_id;
  return v_id;
end $$;

create or replace function saas_business.meta_message_set_status(p_external_message_id text, p_status text, p_error_code integer default null, p_error_message text default null)
returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  update saas_business.meta_messages
     set status = p_status, error_code = p_error_code, error_message = left(p_error_message, 500), updated_at = now()
   where external_message_id = p_external_message_id;
  return found;
end $$;

create or replace function saas_business.meta_messages_list(
  p_user_id uuid, p_workspace_id uuid, p_channel text, p_account_ref text default null, p_conversation_ref text default null, p_limit integer default 50
) returns jsonb
language sql security definer stable set search_path = '' as $$
  select coalesce(jsonb_agg(to_jsonb(m) - 'user_id' order by m.sent_at desc), '[]'::jsonb)
  from (
    select m.id, m.channel, m.account_ref, m.conversation_ref, m.external_message_id, m.direction, m.message_type,
           m.body, m.status, m.error_code, m.error_message, m.sent_at, m.user_id
      from saas_business.meta_messages m
     where m.user_id = p_user_id and m.workspace_id = p_workspace_id and m.channel = p_channel
       and (p_account_ref is null or m.account_ref = p_account_ref)
       and (p_conversation_ref is null or m.conversation_ref = p_conversation_ref)
     order by m.sent_at desc
     limit greatest(1, least(coalesce(p_limit, 50), 200))
  ) m;
$$;

-- Conversations : dernier message par contact.
create or replace function saas_business.meta_conversations_list(p_user_id uuid, p_workspace_id uuid, p_channel text, p_account_ref text default null, p_limit integer default 50)
returns jsonb
language sql security definer stable set search_path = '' as $$
  select coalesce(jsonb_agg(to_jsonb(x) order by x.last_at desc), '[]'::jsonb)
  from (
    select distinct on (m.account_ref, m.conversation_ref)
           m.account_ref, m.conversation_ref, m.body as last_body, m.direction as last_direction,
           m.status as last_status, m.sent_at as last_at
      from saas_business.meta_messages m
     where m.user_id = p_user_id and m.workspace_id = p_workspace_id and m.channel = p_channel
       and (p_account_ref is null or m.account_ref = p_account_ref)
     order by m.account_ref, m.conversation_ref, m.sent_at desc
  ) x
  limit greatest(1, least(coalesce(p_limit, 50), 200));
$$;

create or replace function saas_business.meta_page_event_record(p_payload jsonb)
returns bigint
language plpgsql security definer set search_path = '' as $$
declare v_id bigint;
begin
  insert into saas_business.meta_page_events (user_id, workspace_id, page_id, channel, item, verb, post_id, comment_id, from_id, message, occurred_at)
  values ((p_payload->>'user_id')::uuid, (p_payload->>'workspace_id')::uuid, p_payload->>'page_id', p_payload->>'channel',
          p_payload->>'item', p_payload->>'verb', p_payload->>'post_id', p_payload->>'comment_id', p_payload->>'from_id',
          left(p_payload->>'message', 4000), coalesce((p_payload->>'occurred_at')::timestamptz, now()))
  returning id into v_id;
  return v_id;
end $$;

create or replace function saas_business.meta_page_events_list(p_user_id uuid, p_workspace_id uuid, p_channel text, p_page_id text default null, p_limit integer default 50)
returns jsonb
language sql security definer stable set search_path = '' as $$
  select coalesce(jsonb_agg(to_jsonb(e) - 'user_id' order by e.occurred_at desc), '[]'::jsonb)
  from (
    select e.* from saas_business.meta_page_events e
     where e.user_id = p_user_id and e.workspace_id = p_workspace_id and e.channel = p_channel
       and (p_page_id is null or e.page_id = p_page_id)
     order by e.occurred_at desc
     limit greatest(1, least(coalesce(p_limit, 50), 200))
  ) e;
$$;

-- Les fonctions ne sont pas exposées à PostgREST : seule la fonction Edge
-- (rôle de connexion serveur) les appelle.
revoke all on function saas_business.meta_state_create(text, uuid, uuid, text, integer) from public, anon, authenticated;
revoke all on function saas_business.meta_state_consume(text) from public, anon, authenticated;
revoke all on function saas_business.meta_connection_upsert(jsonb) from public, anon, authenticated;
revoke all on function saas_business.meta_connection_set_status(uuid, uuid, text, text, text) from public, anon, authenticated;
revoke all on function saas_business.meta_connection_merge_metadata(uuid, uuid, text, jsonb) from public, anon, authenticated;
revoke all on function saas_business.meta_connections_list(uuid, uuid, text) from public, anon, authenticated;
revoke all on function saas_business.meta_connection_internal(uuid, uuid, text) from public, anon, authenticated;
revoke all on function saas_business.meta_connection_delete(uuid, uuid, text) from public, anon, authenticated;
revoke all on function saas_business.meta_pages_replace(uuid, uuid, text, jsonb) from public, anon, authenticated;
revoke all on function saas_business.meta_page_internal(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function saas_business.meta_resolve_phone(text) from public, anon, authenticated;
revoke all on function saas_business.meta_resolve_page(text, text) from public, anon, authenticated;
revoke all on function saas_business.meta_resolve_instagram(text) from public, anon, authenticated;
revoke all on function saas_business.meta_webhook_event_record(text, text, text, jsonb) from public, anon, authenticated;
revoke all on function saas_business.meta_webhook_event_finish(text, text) from public, anon, authenticated;
revoke all on function saas_business.meta_message_record(jsonb) from public, anon, authenticated;
revoke all on function saas_business.meta_message_set_status(text, text, integer, text) from public, anon, authenticated;
revoke all on function saas_business.meta_messages_list(uuid, uuid, text, text, text, integer) from public, anon, authenticated;
revoke all on function saas_business.meta_conversations_list(uuid, uuid, text, text, integer) from public, anon, authenticated;
revoke all on function saas_business.meta_page_event_record(jsonb) from public, anon, authenticated;
revoke all on function saas_business.meta_page_events_list(uuid, uuid, text, text, integer) from public, anon, authenticated;

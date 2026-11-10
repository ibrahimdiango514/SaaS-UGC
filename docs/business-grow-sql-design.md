# Business Grow — dossier SQL autonome (proposition)

**Statut :** document de conception seulement. Aucun SQL n'a été exécuté, aucun fichier de migration n'a été créé et aucune configuration Supabase n'a été modifiée. Le dossier cible PostgreSQL 17 et conserve 18 tables dans `saas_business`; il ne modifie aucune table `saas_ugc`.

> **Important :** ce SQL est fourni pour revue et préparation d'un environnement jetable. Il n'est pas certifié exécutable tant qu'il n'a pas été appliqué à une base de test PostgreSQL 17 avec les prérequis ci-dessous, puis testé. Il n'est pas à lancer en production.

Les blocs d'installation doivent être concaténés et exécutés dans une même session, dans l'ordre du document : `SET ROLE bg_owner` est maintenu jusqu'au `RESET ROLE` du bloc de privilèges. Les tests emploient des marqueurs `<USER_A>`/`<USER_B>` à remplacer par des UUID réels du fixture avant exécution.

## 1. Prérequis et modèle d'accès

Le SQL s'appuie sur le schéma Supabase `auth.users`, `auth.uid()`, ainsi que sur `saas_ugc.ugc_workspaces` et `ugc_private.is_workspace_member(uuid)`. Sur PostgreSQL isolé, créer des rôles et tables de test équivalents avant de charger le script; ne pas remplacer ni créer ces objets en production.

Séparation des rôles :

- `bg_owner` : propriétaire sans login des objets et fonctions; utilisé seulement pour les migrations.
- `bg_edge` : rôle serveur dédié, login côté Edge uniquement, exécution de fonctions explicitement accordées, aucun DML direct.
- `bg_billing_worker` : rôle serveur de traitement des webhooks; fonctions dédiées seulement.
- `bg_erasure` : rôle d'effacement de compte; exécution de la seule fonction de préparation de suppression.
- `anon`, `authenticated`, `service_role` : rôles Supabase. Aucun accès de table n'est accordé à `anon` ni `service_role`.

Exemple de bootstrap à exécuter **seulement dans la base de test** (Supabase possède déjà ses rôles) :

```sql
CREATE ROLE bg_owner NOLOGIN;
CREATE ROLE bg_edge LOGIN;
CREATE ROLE bg_billing_worker LOGIN;
CREATE ROLE bg_erasure LOGIN;
```

En production, préférer des rôles de connexion distincts et des secrets de connexion Edge dédiés. Ne pas accorder `bg_owner` à une fonction d'exécution ou à un rôle d'application. Ne jamais exposer le secret DB au navigateur.

## 2. DDL des 18 tables

```sql
CREATE SCHEMA saas_business AUTHORIZATION bg_owner;
REVOKE ALL ON SCHEMA saas_business FROM PUBLIC, anon, authenticated, service_role;
GRANT USAGE ON SCHEMA saas_business TO bg_edge, bg_billing_worker, bg_erasure;

SET ROLE bg_owner;

CREATE TABLE saas_business.ai_providers (
  provider_key text PRIMARY KEY,
  display_name text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'unverified'
    CHECK (status IN ('unverified','available','degraded','unavailable')),
  checked_at timestamptz,
  error_code text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE saas_business.ai_provider_configs (
  provider_key text PRIMARY KEY REFERENCES saas_business.ai_providers ON DELETE CASCADE,
  config_status text NOT NULL DEFAULT 'missing'
    CHECK (config_status IN ('missing','configured','error')),
  secret_ref text,
  config_version text,
  verified_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE saas_business.ai_models (
  provider_key text NOT NULL REFERENCES saas_business.ai_providers ON DELETE RESTRICT,
  model_key text NOT NULL,
  provider_model_key text NOT NULL,
  display_name text NOT NULL,
  capabilities jsonb NOT NULL DEFAULT '{}',
  enabled boolean NOT NULL DEFAULT false,
  verification_status text NOT NULL DEFAULT 'unverified'
    CHECK (verification_status IN ('unverified','verified','unavailable')),
  max_input_tokens integer CHECK (max_input_tokens IS NULL OR max_input_tokens > 0),
  max_output_tokens integer CHECK (max_output_tokens IS NULL OR max_output_tokens > 0),
  verified_at timestamptz,
  error_code text,
  PRIMARY KEY (provider_key, model_key),
  UNIQUE (provider_key, provider_model_key)
);

CREATE TABLE saas_business.ai_roles (
  role_key text PRIMARY KEY,
  description text NOT NULL,
  required_capabilities jsonb NOT NULL DEFAULT '{}',
  enabled boolean NOT NULL DEFAULT true
);

CREATE TABLE saas_business.ai_routing_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role_key text NOT NULL REFERENCES saas_business.ai_roles ON DELETE CASCADE,
  provider_key text NOT NULL,
  model_key text NOT NULL,
  priority smallint NOT NULL CHECK (priority >= 0),
  enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (role_key, priority),
  FOREIGN KEY (provider_key, model_key)
    REFERENCES saas_business.ai_models(provider_key, model_key) ON DELETE RESTRICT
);

CREATE TABLE saas_business.ai_provider_health_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_key text NOT NULL REFERENCES saas_business.ai_providers ON DELETE RESTRICT,
  model_key text,
  status text NOT NULL CHECK (status IN ('healthy','degraded','unavailable','failed')),
  latency_ms integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
  error_code text,
  checked_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (provider_key, model_key)
    REFERENCES saas_business.ai_models(provider_key, model_key) ON DELETE RESTRICT
);

CREATE TABLE saas_business.conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  workspace_id uuid REFERENCES saas_ugc.ugc_workspaces(id) ON DELETE SET NULL,
  title text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id)
);

CREATE TABLE saas_business.messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  author_role text NOT NULL CHECK (author_role IN ('user','assistant','tool')),
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id, conversation_id),
  FOREIGN KEY (conversation_id, user_id)
    REFERENCES saas_business.conversations(id, user_id) ON DELETE CASCADE
);

CREATE TABLE saas_business.ai_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  role_key text REFERENCES saas_business.ai_roles ON DELETE RESTRICT,
  provider_key text,
  model_key text,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','succeeded','failed','canceled')),
  input_message_id uuid,
  output_message_id uuid,
  input_tokens integer CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens integer CHECK (output_tokens IS NULL OR output_tokens >= 0),
  provider_cost_micros bigint CHECK (provider_cost_micros IS NULL OR provider_cost_micros >= 0),
  currency char(3),
  latency_ms integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key),
  UNIQUE (id, user_id, conversation_id),
  FOREIGN KEY (conversation_id, user_id)
    REFERENCES saas_business.conversations(id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (provider_key, model_key)
    REFERENCES saas_business.ai_models(provider_key, model_key) ON DELETE RESTRICT,
  FOREIGN KEY (input_message_id, user_id, conversation_id)
    REFERENCES saas_business.messages(id, user_id, conversation_id)
    ON DELETE SET NULL (input_message_id),
  FOREIGN KEY (output_message_id, user_id, conversation_id)
    REFERENCES saas_business.messages(id, user_id, conversation_id)
    ON DELETE SET NULL (output_message_id),
  CHECK ((provider_key IS NULL) = (model_key IS NULL)),
  CHECK (finished_at IS NULL OR started_at IS NULL OR finished_at >= started_at)
);

CREATE TABLE saas_business.ai_request_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL,
  user_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  provider_key text NOT NULL,
  model_key text NOT NULL,
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running','succeeded','failed','canceled')),
  fallback_from_attempt_id uuid,
  fallback_reason text,
  input_tokens integer CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens integer CHECK (output_tokens IS NULL OR output_tokens >= 0),
  provider_cost_micros bigint CHECK (provider_cost_micros IS NULL OR provider_cost_micros >= 0),
  latency_ms integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
  error_code text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (request_id, attempt_number),
  UNIQUE (id, request_id, user_id, conversation_id),
  UNIQUE (id, request_id, user_id, conversation_id, provider_key, model_key),
  FOREIGN KEY (request_id, user_id, conversation_id)
    REFERENCES saas_business.ai_requests(id, user_id, conversation_id) ON DELETE CASCADE,
  FOREIGN KEY (provider_key, model_key)
    REFERENCES saas_business.ai_models(provider_key, model_key) ON DELETE RESTRICT,
  FOREIGN KEY (fallback_from_attempt_id, request_id, user_id, conversation_id)
    REFERENCES saas_business.ai_request_attempts(id, request_id, user_id, conversation_id)
    ON DELETE CASCADE,
  CHECK (fallback_from_attempt_id IS NULL OR fallback_from_attempt_id <> id),
  CHECK (finished_at IS NULL OR finished_at >= started_at)
);

CREATE TABLE saas_business.memory_consent_events (
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN ('granted','revoked')),
  policy_version text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE saas_business.memory_profiles (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  profile_data jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE saas_business.memory_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  category text NOT NULL,
  content jsonb NOT NULL,
  source_kind text NOT NULL DEFAULT 'manual'
    CHECK (source_kind IN ('manual','conversation','reelora_activity','campaign')),
  source_ref uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE saas_business.usage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id uuid NOT NULL,
  request_id uuid NOT NULL,
  user_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  provider_key text NOT NULL,
  model_key text NOT NULL,
  input_tokens integer NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens integer NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  latency_ms integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
  provider_cost_micros bigint CHECK (provider_cost_micros IS NULL OR provider_cost_micros >= 0),
  billable_amount_micros bigint CHECK (billable_amount_micros IS NULL OR billable_amount_micros >= 0),
  currency char(3),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (attempt_id),
  FOREIGN KEY (attempt_id, request_id, user_id, conversation_id, provider_key, model_key)
    REFERENCES saas_business.ai_request_attempts
      (id, request_id, user_id, conversation_id, provider_key, model_key) ON DELETE CASCADE
);

CREATE TABLE saas_business.plans (
  plan_key text PRIMARY KEY,
  display_name text NOT NULL,
  billing_enabled boolean NOT NULL DEFAULT false,
  monthly_request_limit integer CHECK (monthly_request_limit IS NULL OR monthly_request_limit >= 0),
  monthly_token_limit bigint CHECK (monthly_token_limit IS NULL OR monthly_token_limit >= 0),
  active boolean NOT NULL DEFAULT false
);

CREATE TABLE saas_business.subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  plan_key text NOT NULL REFERENCES saas_business.plans ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'pending_integration'
    CHECK (status IN ('pending_integration','trialing','active','past_due','canceled','expired')),
  billing_provider text,
  external_customer_id text,
  external_subscription_id text,
  current_period_start timestamptz,
  current_period_end timestamptz,
  billing_updated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id, billing_provider),
  CHECK (
    (external_customer_id IS NULL AND external_subscription_id IS NULL)
    OR billing_provider IS NOT NULL
  ),
  CHECK (
    status NOT IN ('trialing','active','past_due')
    OR (billing_provider IS NOT NULL AND external_subscription_id IS NOT NULL)
  ),
  CHECK (current_period_end IS NULL OR current_period_start IS NULL
    OR current_period_end > current_period_start)
);

CREATE TABLE saas_business.billing_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  billing_provider text NOT NULL,
  external_event_id text NOT NULL,
  event_type text NOT NULL,
  payload_hash text NOT NULL,
  event_data jsonb NOT NULL DEFAULT '{}',
  provider_event_at timestamptz,
  user_id uuid,
  subscription_id uuid,
  processing_status text NOT NULL DEFAULT 'received'
    CHECK (processing_status IN ('received','processing','processed','ignored','retryable','dead_letter')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_token uuid,
  lease_until timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  error_code text,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE (billing_provider, external_event_id),
  FOREIGN KEY (subscription_id, user_id, billing_provider)
    REFERENCES saas_business.subscriptions(id, user_id, billing_provider)
    ON DELETE SET NULL (subscription_id, user_id),
  CHECK ((subscription_id IS NULL) = (user_id IS NULL)),
  CHECK (
    (processing_status = 'processing' AND lease_token IS NOT NULL AND lease_until IS NOT NULL)
    OR
    (processing_status <> 'processing' AND lease_token IS NULL AND lease_until IS NULL)
  )
);

CREATE TABLE saas_business.integration_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  workspace_id uuid REFERENCES saas_ugc.ugc_workspaces(id) ON DELETE SET NULL,
  connector_key text NOT NULL,
  external_account_ref text,
  credential_ref text,
  status text NOT NULL DEFAULT 'unconfigured'
    CHECK (status IN ('unconfigured','pending','connected','disconnected','error')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id),
  UNIQUE (user_id, connector_key, external_account_ref)
);

INSERT INTO saas_business.ai_providers(provider_key,display_name,enabled,status)
VALUES
  ('gemini','Gemini',false,'unverified'),
  ('groq','Groq',false,'unverified'),
  ('gonka','Gonka',false,'unverified'),
  ('kilo','Kilo',false,'unverified'),
  ('openrouter','OpenRouter',false,'unverified'),
  ('llm7','LLM7',false,'unverified')
ON CONFLICT (provider_key) DO NOTHING;

INSERT INTO saas_business.ai_provider_configs(provider_key,config_status)
SELECT provider_key,'missing' FROM saas_business.ai_providers
WHERE provider_key IN ('gemini','groq','gonka','kilo','openrouter','llm7')
ON CONFLICT (provider_key) DO NOTHING;

INSERT INTO saas_business.ai_roles(role_key,description,required_capabilities,enabled)
VALUES
  ('business_advisor','Assistant général Business Grow','{}'::jsonb,true),
  ('business_analysis','Analyse métier et stratégie','{"reasoning":true}'::jsonb,true),
  ('content_strategy','Stratégie de contenu','{"writing":true}'::jsonb,true)
ON CONFLICT (role_key) DO NOTHING;
```

## 3. Indexes

Les index des PK et `UNIQUE` sont créés par les contraintes. Le doublon `(request_id, attempt_number)` n'est donc pas recréé.

```sql
CREATE INDEX ai_routing_model_fk_idx ON saas_business.ai_routing_rules(provider_key, model_key);
CREATE INDEX health_provider_latest_idx ON saas_business.ai_provider_health_checks(provider_key, checked_at DESC);
CREATE INDEX health_model_latest_idx ON saas_business.ai_provider_health_checks(provider_key, model_key, checked_at DESC)
  WHERE model_key IS NOT NULL;
CREATE INDEX conversations_owner_updated_idx ON saas_business.conversations(user_id, updated_at DESC);
CREATE INDEX conversations_workspace_fk_idx ON saas_business.conversations(workspace_id)
  WHERE workspace_id IS NOT NULL;
CREATE INDEX messages_conversation_created_idx ON saas_business.messages(conversation_id, user_id, created_at);
CREATE INDEX messages_user_created_idx ON saas_business.messages(user_id, created_at DESC);
CREATE INDEX requests_conversation_created_idx ON saas_business.ai_requests(conversation_id, user_id, created_at DESC);
CREATE INDEX requests_role_fk_idx ON saas_business.ai_requests(role_key) WHERE role_key IS NOT NULL;
CREATE INDEX requests_input_message_fk_idx ON saas_business.ai_requests(input_message_id, user_id, conversation_id)
  WHERE input_message_id IS NOT NULL;
CREATE INDEX requests_output_message_fk_idx ON saas_business.ai_requests(output_message_id, user_id, conversation_id)
  WHERE output_message_id IS NOT NULL;
CREATE INDEX attempts_request_owner_idx ON saas_business.ai_request_attempts(request_id, user_id, conversation_id);
CREATE INDEX attempts_user_started_idx ON saas_business.ai_request_attempts(user_id, started_at DESC);
CREATE UNIQUE INDEX attempts_one_running_per_request_idx ON saas_business.ai_request_attempts(request_id)
  WHERE status = 'running';
CREATE INDEX consent_user_event_idx ON saas_business.memory_consent_events(user_id, event_id DESC);
CREATE INDEX memory_items_owner_category_idx ON saas_business.memory_items(user_id, category, updated_at DESC);
CREATE INDEX usage_user_created_idx ON saas_business.usage_events(user_id, created_at DESC);
CREATE INDEX subscriptions_user_created_idx ON saas_business.subscriptions(user_id, created_at DESC);
CREATE UNIQUE INDEX subscriptions_one_current_per_user_idx ON saas_business.subscriptions(user_id)
  WHERE status IN ('trialing','active','past_due');
CREATE UNIQUE INDEX subscriptions_external_id_idx ON saas_business.subscriptions(billing_provider, external_subscription_id)
  WHERE external_subscription_id IS NOT NULL;
CREATE INDEX billing_subscription_fk_idx ON saas_business.billing_events(subscription_id, user_id, billing_provider)
  WHERE subscription_id IS NOT NULL;
CREATE INDEX billing_retry_idx ON saas_business.billing_events(next_attempt_at, received_at)
  WHERE processing_status IN ('received','retryable');
CREATE INDEX billing_expired_lease_idx ON saas_business.billing_events(lease_until)
  WHERE processing_status = 'processing';
CREATE INDEX integrations_workspace_fk_idx ON saas_business.integration_connections(workspace_id)
  WHERE workspace_id IS NOT NULL;
```

## 4. Fonctions et triggers

### Horodatage et immuabilité des consentements

Le journal de consentement est append-only pour tous les rôles applicatifs. Le compte est supprimé par une opération explicite d'effacement qui purge d'abord les événements sous une fonction non exposée, puis supprime le compte Auth. Cette purge constitue l'exception de conformité à l'append-only. Il n'y a pas de `pg_trigger_depth()` ni de droit direct de suppression pour `service_role`.

```sql
CREATE FUNCTION saas_business.touch_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, saas_business AS $$
BEGIN NEW.updated_at := clock_timestamp(); RETURN NEW; END $$;

CREATE TRIGGER providers_touch BEFORE UPDATE ON saas_business.ai_providers
  FOR EACH ROW EXECUTE FUNCTION saas_business.touch_updated_at();
CREATE TRIGGER configs_touch BEFORE UPDATE ON saas_business.ai_provider_configs
  FOR EACH ROW EXECUTE FUNCTION saas_business.touch_updated_at();
CREATE TRIGGER rules_touch BEFORE UPDATE ON saas_business.ai_routing_rules
  FOR EACH ROW EXECUTE FUNCTION saas_business.touch_updated_at();
CREATE TRIGGER conversations_touch BEFORE UPDATE ON saas_business.conversations
  FOR EACH ROW EXECUTE FUNCTION saas_business.touch_updated_at();
CREATE TRIGGER requests_touch BEFORE UPDATE ON saas_business.ai_requests
  FOR EACH ROW EXECUTE FUNCTION saas_business.touch_updated_at();
CREATE TRIGGER profiles_touch BEFORE UPDATE ON saas_business.memory_profiles
  FOR EACH ROW EXECUTE FUNCTION saas_business.touch_updated_at();
CREATE TRIGGER items_touch BEFORE UPDATE ON saas_business.memory_items
  FOR EACH ROW EXECUTE FUNCTION saas_business.touch_updated_at();
CREATE TRIGGER subscriptions_touch BEFORE UPDATE ON saas_business.subscriptions
  FOR EACH ROW EXECUTE FUNCTION saas_business.touch_updated_at();
CREATE TRIGGER integrations_touch BEFORE UPDATE ON saas_business.integration_connections
  FOR EACH ROW EXECUTE FUNCTION saas_business.touch_updated_at();

CREATE FUNCTION saas_business.reject_consent_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP='DELETE' AND session_user='bg_erasure' THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'memory consent events are append-only';
END $$;
CREATE TRIGGER consent_append_only
BEFORE UPDATE OR DELETE ON saas_business.memory_consent_events
FOR EACH ROW EXECUTE FUNCTION saas_business.reject_consent_mutation();
```

L'exception d'effacement est limitée par `session_user='bg_erasure'`, rôle qui n'a aucun DML et ne peut appeler que la fonction suivante. Le journal reste immuable pour les rôles ordinaires et pour `service_role`. Le processus supprime les événements avant l'appel Auth Admin qui supprime le compte; une défaillance de la seconde étape doit être reprise/compensée par l'Edge Function d'administration.

```sql
CREATE FUNCTION saas_business.bg_prepare_account_erasure(p_user_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, saas_business AS $$
BEGIN
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'user id required'; END IF;
  PERFORM 1 FROM auth.users WHERE id=p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'user not found'; END IF;
  DELETE FROM saas_business.memory_consent_events WHERE user_id=p_user_id;
  DELETE FROM saas_business.memory_profiles WHERE user_id=p_user_id;
  DELETE FROM saas_business.memory_items WHERE user_id=p_user_id;
END $$;
```

### Consentement et mémoire

Les fonctions mémoire ci-dessous sont définies pour le rôle Edge serveur. L'identité reçue doit être le `sub` du JWT validé par GoTrue dans l'Edge Function; l'API ne fournit jamais un identifiant utilisateur libre au navigateur.

```sql
CREATE FUNCTION saas_business.bg_set_memory_consent(
  p_user_id uuid, p_enabled boolean, p_policy_version text
) RETURNS TABLE(event_id bigint, occurred_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, saas_business AS $$
DECLARE v_action text;
BEGIN
  IF p_user_id IS NULL OR p_policy_version IS NULL OR btrim(p_policy_version) = '' THEN
    RAISE EXCEPTION 'invalid consent request';
  END IF;
  PERFORM 1 FROM auth.users WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'user not found'; END IF;
  v_action := CASE WHEN p_enabled THEN 'granted' ELSE 'revoked' END;
  INSERT INTO saas_business.memory_consent_events(user_id, action, policy_version)
  VALUES (p_user_id, v_action, p_policy_version)
  RETURNING memory_consent_events.event_id, memory_consent_events.occurred_at
  INTO event_id, occurred_at;
  IF NOT p_enabled THEN
    DELETE FROM saas_business.memory_profiles WHERE user_id = p_user_id;
    DELETE FROM saas_business.memory_items WHERE user_id = p_user_id;
  END IF;
  RETURN NEXT;
END $$;

CREATE FUNCTION saas_business.bg_upsert_memory_profile(
  p_user_id uuid, p_profile_data jsonb
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, saas_business AS $$
BEGIN
  PERFORM 1 FROM auth.users WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM saas_business.memory_consent_events
    WHERE user_id = p_user_id
    ORDER BY event_id DESC LIMIT 1
  ) THEN RAISE EXCEPTION 'memory consent required'; END IF;
  IF (SELECT action FROM saas_business.memory_consent_events
      WHERE user_id = p_user_id ORDER BY event_id DESC LIMIT 1) <> 'granted'
  THEN RAISE EXCEPTION 'memory consent revoked'; END IF;
  INSERT INTO saas_business.memory_profiles(user_id, profile_data)
  VALUES (p_user_id, COALESCE(p_profile_data, '{}'::jsonb))
  ON CONFLICT (user_id) DO UPDATE SET profile_data = EXCLUDED.profile_data;
END $$;

CREATE FUNCTION saas_business.bg_put_memory_item(
  p_user_id uuid, p_item_id uuid, p_category text, p_content jsonb,
  p_source_kind text DEFAULT 'manual', p_source_ref uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, saas_business AS $$
DECLARE v_id uuid := COALESCE(p_item_id, gen_random_uuid());
BEGIN
  PERFORM 1 FROM auth.users WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND OR COALESCE((
    SELECT action FROM saas_business.memory_consent_events
    WHERE user_id = p_user_id ORDER BY event_id DESC LIMIT 1
  ), 'revoked') <> 'granted' THEN RAISE EXCEPTION 'active memory consent required'; END IF;
  IF p_item_id IS NOT NULL THEN
    UPDATE saas_business.memory_items
    SET category = p_category, content = p_content,
        source_kind = p_source_kind, source_ref = p_source_ref
    WHERE id = p_item_id AND user_id = p_user_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'memory item not found'; END IF;
  ELSE
    INSERT INTO saas_business.memory_items(id,user_id,category,content,source_kind,source_ref)
    VALUES (v_id,p_user_id,p_category,p_content,p_source_kind,p_source_ref);
  END IF;
  RETURN v_id;
END $$;

CREATE FUNCTION saas_business.bg_delete_memory_item(p_user_id uuid, p_item_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, saas_business AS $$
DECLARE n integer;
BEGIN
  DELETE FROM saas_business.memory_items WHERE id = p_item_id AND user_id = p_user_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n = 1;
END $$;

CREATE FUNCTION saas_business.bg_clear_memory(p_user_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, saas_business AS $$
BEGIN
  PERFORM 1 FROM auth.users WHERE id = p_user_id FOR UPDATE;
  DELETE FROM saas_business.memory_profiles WHERE user_id = p_user_id;
  DELETE FROM saas_business.memory_items WHERE user_id = p_user_id;
END $$;

CREATE FUNCTION saas_business.bg_append_message(
  p_user_id uuid,p_conversation_id uuid,p_author_role text,p_content text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,saas_business AS $$
DECLARE v_id uuid;
BEGIN
  IF p_author_role NOT IN ('user','assistant','tool') OR p_content IS NULL THEN
    RAISE EXCEPTION 'invalid message';
  END IF;
  INSERT INTO saas_business.messages(user_id,conversation_id,author_role,content)
  VALUES(p_user_id,p_conversation_id,p_author_role,p_content)
  RETURNING id INTO v_id;
  UPDATE saas_business.conversations SET updated_at=clock_timestamp()
  WHERE id=p_conversation_id AND user_id=p_user_id;
  RETURN v_id;
END $$;

CREATE FUNCTION saas_business.bg_create_conversation(
  p_user_id uuid,p_title text,p_workspace_id uuid DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,saas_business,saas_ugc AS $$
DECLARE v_id uuid;
BEGIN
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'user id required'; END IF;
  IF p_workspace_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM saas_ugc.ugc_workspaces w
    WHERE w.id=p_workspace_id AND (
      w.owner_user_id=p_user_id OR EXISTS (
        SELECT 1 FROM saas_ugc.ugc_workspace_members m
        WHERE m.workspace_id=w.id AND m.user_id=p_user_id
      )
    )
  ) THEN RAISE EXCEPTION 'workspace access denied'; END IF;
  INSERT INTO saas_business.conversations(user_id,title,workspace_id)
  VALUES(p_user_id,p_title,p_workspace_id) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE FUNCTION saas_business.bg_rename_conversation(
  p_user_id uuid,p_conversation_id uuid,p_title text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,saas_business AS $$
DECLARE v_count integer;
BEGIN
  IF p_user_id IS NULL OR p_conversation_id IS NULL
     OR p_title IS NULL OR btrim(p_title)='' OR length(p_title)>160 THEN
    RAISE EXCEPTION 'invalid conversation title';
  END IF;
  UPDATE saas_business.conversations
  SET title=btrim(p_title),updated_at=clock_timestamp()
  WHERE id=p_conversation_id AND user_id=p_user_id;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  RETURN v_count=1;
END $$;

CREATE FUNCTION saas_business.bg_delete_conversation(
  p_user_id uuid,p_conversation_id uuid
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,saas_business AS $$
DECLARE v_count integer;
BEGIN
  DELETE FROM saas_business.conversations
  WHERE id=p_conversation_id AND user_id=p_user_id;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  RETURN v_count=1;
END $$;

CREATE FUNCTION saas_business.bg_list_conversations(p_user_id uuid,p_limit integer DEFAULT 50)
RETURNS TABLE(id uuid,title text,created_at timestamptz,updated_at timestamptz,last_message text)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,saas_business AS $$
  SELECT c.id,c.title,c.created_at,c.updated_at,m.content
  FROM saas_business.conversations c
  LEFT JOIN LATERAL (
    SELECT msg.content FROM saas_business.messages msg
    WHERE msg.user_id=c.user_id AND msg.conversation_id=c.id
    ORDER BY msg.created_at DESC,msg.id DESC LIMIT 1
  ) m ON true
  WHERE c.user_id=p_user_id
  ORDER BY c.updated_at DESC,c.id DESC
  LIMIT greatest(1,least(COALESCE(p_limit,50),100))
$$;

CREATE FUNCTION saas_business.bg_list_messages(
  p_user_id uuid,p_conversation_id uuid,p_limit integer DEFAULT 200
) RETURNS TABLE(
  id uuid,author_role text,content text,created_at timestamptz,
  request_status text,request_error_code text,
  request_provider_key text,request_model_key text
)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,saas_business AS $$
  SELECT m.id,m.author_role,m.content,m.created_at,r.status,r.error_code,
    r.provider_key,r.model_key
  FROM saas_business.messages m
  LEFT JOIN LATERAL (
    SELECT req.status,req.error_code,req.provider_key,
      COALESCE(model.provider_model_key,req.model_key) AS model_key
    FROM saas_business.ai_requests req
    LEFT JOIN saas_business.ai_models model
      ON model.provider_key=req.provider_key AND model.model_key=req.model_key
    WHERE req.user_id=m.user_id AND (req.input_message_id=m.id OR req.output_message_id=m.id)
    ORDER BY req.created_at DESC LIMIT 1
  ) r ON true
  WHERE m.user_id=p_user_id AND m.conversation_id=p_conversation_id
  ORDER BY m.created_at,m.id
  LIMIT greatest(1,least(COALESCE(p_limit,200),500))
$$;

CREATE FUNCTION saas_business.bg_get_memory(p_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,saas_business AS $$
DECLARE v_action text; v_policy text; v_profile jsonb; v_items jsonb;
BEGIN
  SELECT action,policy_version INTO v_action,v_policy
  FROM saas_business.memory_consent_events
  WHERE user_id=p_user_id ORDER BY event_id DESC LIMIT 1;
  IF v_action='granted' THEN
    SELECT profile_data INTO v_profile FROM saas_business.memory_profiles WHERE user_id=p_user_id;
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id',id,'category',category,'content',content,'created_at',created_at,'updated_at',updated_at
    ) ORDER BY updated_at DESC,id), '[]'::jsonb)
    INTO v_items FROM saas_business.memory_items WHERE user_id=p_user_id;
  ELSE
    v_profile := NULL;
    v_items := '[]'::jsonb;
  END IF;
  RETURN jsonb_build_object(
    'consent',v_action='granted',
    'policyVersion',v_policy,
    'profile',v_profile,
    'items',COALESCE(v_items,'[]'::jsonb)
  );
END $$;

CREATE FUNCTION saas_business.bg_list_providers()
RETURNS TABLE(
  provider_key text,display_name text,enabled boolean,status text,
  config_status text,checked_at timestamptz,verified_model_keys text[]
)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,saas_business AS $$
  SELECT p.provider_key,p.display_name,p.enabled,p.status,
         COALESCE(pc.config_status,'missing'),p.checked_at,
         ARRAY(
           SELECT m.provider_model_key
           FROM saas_business.ai_models m
           WHERE m.provider_key=p.provider_key AND m.enabled
             AND m.verification_status='verified'
             AND EXISTS (
               SELECT 1 FROM saas_business.ai_provider_health_checks h
               WHERE h.provider_key=m.provider_key AND h.model_key=m.model_key
                 AND h.status='healthy' AND h.checked_at >= now()-interval '5 minutes'
             )
           ORDER BY m.model_key
         )
  FROM saas_business.ai_providers p
  LEFT JOIN saas_business.ai_provider_configs pc USING(provider_key)
  WHERE p.provider_key <> 'muapi'
  ORDER BY p.display_name
$$;

CREATE FUNCTION saas_business.bg_submit_user_message(
  p_user_id uuid,p_conversation_id uuid,p_content text,p_idempotency_key text,
  p_request_hash text,p_role_key text
) RETURNS TABLE(request_id uuid,input_message_id uuid,status text,created boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,saas_business AS $$
DECLARE v_request saas_business.ai_requests%ROWTYPE; v_message_id uuid;
BEGIN
  IF p_user_id IS NULL OR p_conversation_id IS NULL OR p_content IS NULL
     OR btrim(p_content)='' OR length(p_content)>12000
     OR p_idempotency_key IS NULL OR p_request_hash IS NULL THEN
    RAISE EXCEPTION 'invalid message request';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text||':'||p_idempotency_key,0));
  SELECT * INTO v_request FROM saas_business.ai_requests
  WHERE user_id=p_user_id AND idempotency_key=p_idempotency_key;
  IF FOUND THEN
    IF v_request.request_hash<>p_request_hash OR v_request.conversation_id<>p_conversation_id THEN
      RAISE EXCEPTION 'idempotency key reused with different request';
    END IF;
    request_id:=v_request.id;
    input_message_id:=v_request.input_message_id;
    status:=v_request.status;
    created:=false;
    RETURN NEXT;
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM saas_business.conversations
    WHERE id=p_conversation_id AND user_id=p_user_id
  ) THEN RAISE EXCEPTION 'conversation not found'; END IF;
  INSERT INTO saas_business.messages(user_id,conversation_id,author_role,content)
  VALUES(p_user_id,p_conversation_id,'user',p_content)
  RETURNING id INTO v_message_id;
  UPDATE saas_business.conversations SET updated_at=clock_timestamp()
  WHERE id=p_conversation_id AND user_id=p_user_id;
  INSERT INTO saas_business.ai_requests(
    user_id,conversation_id,idempotency_key,request_hash,role_key,input_message_id
  ) VALUES (
    p_user_id,p_conversation_id,p_idempotency_key,p_request_hash,p_role_key,v_message_id
  ) RETURNING id INTO request_id;
  input_message_id:=v_message_id;
  status:='queued';
  created:=true;
  RETURN NEXT;
END $$;

CREATE FUNCTION saas_business.bg_fail_request(
  p_request_id uuid,p_user_id uuid,p_error_code text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,saas_business AS $$
BEGIN
  UPDATE saas_business.ai_requests SET status='failed',
    error_code=left(COALESCE(NULLIF(p_error_code,''),'AI_REQUEST_FAILED'),120),
    finished_at=clock_timestamp()
  WHERE id=p_request_id AND user_id=p_user_id AND status IN ('queued','running');
  IF NOT FOUND THEN RAISE EXCEPTION 'request cannot be failed'; END IF;
END $$;
```

### Identité, idempotence, transitions et tentatives IA

Les transitions valides sont `queued → running|failed|canceled`, puis `running → succeeded|failed|canceled`. Les états terminaux ne changent plus. Les tentatives naissent `running`; seule une tentative échouée peut être suivie d'un fallback. Les identifiants, propriétaire, conversation et clé d'idempotence sont immuables.

```sql
CREATE FUNCTION saas_business.guard_request()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, saas_business AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'queued' THEN RAISE EXCEPTION 'request must start queued'; END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id,NEW.user_id,NEW.conversation_id,NEW.idempotency_key,NEW.request_hash,NEW.created_at)
     IS DISTINCT FROM
     (OLD.id,OLD.user_id,OLD.conversation_id,OLD.idempotency_key,OLD.request_hash,OLD.created_at)
  THEN RAISE EXCEPTION 'request identity is immutable'; END IF;
  IF OLD.status IN ('succeeded','failed','canceled') THEN
    RAISE EXCEPTION 'terminal request is immutable';
  END IF;
  IF OLD.status='queued' AND NEW.status NOT IN ('queued','running','failed','canceled') THEN
    RAISE EXCEPTION 'invalid request transition';
  END IF;
  IF OLD.status='running' AND NEW.status NOT IN ('running','succeeded','failed','canceled') THEN
    RAISE EXCEPTION 'invalid request transition';
  END IF;
  IF NEW.status='running' AND NEW.started_at IS NULL THEN NEW.started_at := clock_timestamp(); END IF;
  IF NEW.status IN ('succeeded','failed','canceled') THEN NEW.finished_at := COALESCE(NEW.finished_at,clock_timestamp()); END IF;
  IF NEW.status='succeeded' AND NEW.output_message_id IS NULL THEN
    RAISE EXCEPTION 'successful request needs output message';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER request_guard BEFORE INSERT OR UPDATE ON saas_business.ai_requests
FOR EACH ROW EXECUTE FUNCTION saas_business.guard_request();

CREATE FUNCTION saas_business.guard_billing_event()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, saas_business AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.processing_status<>'received' OR NEW.attempt_count<>0 THEN
      RAISE EXCEPTION 'billing event must start received';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id,NEW.billing_provider,NEW.external_event_id,NEW.event_type,
      NEW.payload_hash,NEW.event_data,NEW.provider_event_at,NEW.received_at)
     IS DISTINCT FROM
     (OLD.id,OLD.billing_provider,OLD.external_event_id,OLD.event_type,
      OLD.payload_hash,OLD.event_data,OLD.provider_event_at,OLD.received_at)
  THEN RAISE EXCEPTION 'billing event identity is immutable'; END IF;
  IF OLD.processing_status IN ('processed','ignored','dead_letter') THEN
    RAISE EXCEPTION 'terminal billing event is immutable';
  END IF;
  IF OLD.processing_status='received'
     AND NEW.processing_status NOT IN ('received','processing','ignored','dead_letter') THEN
    RAISE EXCEPTION 'invalid billing event transition';
  END IF;
  IF OLD.processing_status='retryable'
     AND NEW.processing_status NOT IN ('retryable','processing','dead_letter') THEN
    RAISE EXCEPTION 'invalid billing event transition';
  END IF;
  IF OLD.processing_status='processing'
     AND NEW.processing_status NOT IN ('processing','processed','ignored','retryable','dead_letter') THEN
    RAISE EXCEPTION 'invalid billing event transition';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER billing_event_guard BEFORE INSERT OR UPDATE ON saas_business.billing_events
FOR EACH ROW EXECUTE FUNCTION saas_business.guard_billing_event();

CREATE FUNCTION saas_business.guard_attempt()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, saas_business AS $$
DECLARE v_status text; v_prev saas_business.ai_request_attempts%ROWTYPE;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF (NEW.id,NEW.request_id,NEW.user_id,NEW.conversation_id,NEW.attempt_number,
        NEW.provider_key,NEW.model_key,NEW.fallback_from_attempt_id,NEW.started_at)
       IS DISTINCT FROM
       (OLD.id,OLD.request_id,OLD.user_id,OLD.conversation_id,OLD.attempt_number,
        OLD.provider_key,OLD.model_key,OLD.fallback_from_attempt_id,OLD.started_at)
    THEN RAISE EXCEPTION 'attempt identity is immutable'; END IF;
    IF OLD.status <> 'running' OR NEW.status NOT IN ('succeeded','failed','canceled') THEN
      RAISE EXCEPTION 'invalid attempt transition';
    END IF;
    NEW.finished_at := COALESCE(NEW.finished_at,clock_timestamp());
    RETURN NEW;
  END IF;
  IF NEW.status <> 'running' THEN RAISE EXCEPTION 'attempt must start running'; END IF;
  SELECT status INTO v_status FROM saas_business.ai_requests
    WHERE id=NEW.request_id AND user_id=NEW.user_id AND conversation_id=NEW.conversation_id
    FOR UPDATE;
  IF v_status <> 'running' THEN RAISE EXCEPTION 'request is not running'; END IF;
  IF NEW.attempt_number <> COALESCE((
    SELECT max(attempt_number)+1 FROM saas_business.ai_request_attempts WHERE request_id=NEW.request_id
  ),1) THEN RAISE EXCEPTION 'attempt number must be sequential'; END IF;
  IF NEW.attempt_number=1 AND NEW.fallback_from_attempt_id IS NOT NULL THEN
    RAISE EXCEPTION 'first attempt cannot be fallback';
  ELSIF NEW.attempt_number>1 THEN
    SELECT * INTO v_prev FROM saas_business.ai_request_attempts
    WHERE id=NEW.fallback_from_attempt_id
      AND request_id=NEW.request_id AND user_id=NEW.user_id
      AND conversation_id=NEW.conversation_id FOR UPDATE;
    IF NOT FOUND OR v_prev.attempt_number <> NEW.attempt_number-1 OR v_prev.status <> 'failed' THEN
      RAISE EXCEPTION 'fallback must reference immediately preceding failed attempt';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER attempt_guard BEFORE INSERT OR UPDATE ON saas_business.ai_request_attempts
FOR EACH ROW EXECUTE FUNCTION saas_business.guard_attempt();

CREATE FUNCTION saas_business.bg_create_request(
  p_user_id uuid,p_conversation_id uuid,p_idempotency_key text,p_request_hash text,
  p_role_key text,p_input_message_id uuid
) RETURNS TABLE(request_id uuid, created boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,saas_business AS $$
DECLARE v_id uuid; v_hash text;
BEGIN
  IF p_user_id IS NULL OR p_idempotency_key IS NULL OR p_request_hash IS NULL THEN
    RAISE EXCEPTION 'invalid request';
  END IF;
  INSERT INTO saas_business.ai_requests(user_id,conversation_id,idempotency_key,request_hash,
    role_key,input_message_id)
  VALUES(p_user_id,p_conversation_id,p_idempotency_key,p_request_hash,p_role_key,p_input_message_id)
  ON CONFLICT(user_id,idempotency_key) DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NOT NULL THEN request_id:=v_id; created:=true; RETURN NEXT; RETURN; END IF;
  SELECT id,request_hash INTO v_id,v_hash FROM saas_business.ai_requests
    WHERE user_id=p_user_id AND idempotency_key=p_idempotency_key FOR UPDATE;
  IF v_hash <> p_request_hash THEN RAISE EXCEPTION 'idempotency key reused with different request'; END IF;
  request_id:=v_id; created:=false; RETURN NEXT;
END $$;

CREATE FUNCTION saas_business.bg_start_request(p_request_id uuid,p_user_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,saas_business AS $$
BEGIN
  UPDATE saas_business.ai_requests SET status='running',started_at=clock_timestamp()
  WHERE id=p_request_id AND user_id=p_user_id AND status='queued';
  IF NOT FOUND THEN RAISE EXCEPTION 'request cannot start'; END IF;
END $$;

CREATE FUNCTION saas_business.bg_add_attempt(
  p_request_id uuid,p_user_id uuid,p_conversation_id uuid,p_attempt_number integer,
  p_provider_key text,p_model_key text,p_fallback_from uuid,p_fallback_reason text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,saas_business AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO saas_business.ai_request_attempts(request_id,user_id,conversation_id,
    attempt_number,provider_key,model_key,fallback_from_attempt_id,fallback_reason)
  VALUES(p_request_id,p_user_id,p_conversation_id,p_attempt_number,
    p_provider_key,p_model_key,p_fallback_from,p_fallback_reason)
  RETURNING id INTO v_id;
  UPDATE saas_business.ai_requests SET provider_key=p_provider_key,model_key=p_model_key
  WHERE id=p_request_id AND user_id=p_user_id AND status='running';
  RETURN v_id;
END $$;

CREATE FUNCTION saas_business.bg_finalize_attempt(
  p_attempt_id uuid,p_request_id uuid,p_user_id uuid,p_attempt_status text,
  p_input_tokens integer,p_output_tokens integer,p_cost_micros bigint,
  p_latency_ms integer,p_error_code text,p_billable_micros bigint,
  p_currency char(3),p_request_status text,p_output_message_id uuid
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, saas_business AS $$
DECLARE v_attempt saas_business.ai_request_attempts%ROWTYPE;
  v_input_total integer; v_output_total integer; v_latency_total integer; v_cost_total bigint;
BEGIN
  IF p_attempt_status NOT IN ('succeeded','failed','canceled')
     OR p_request_status NOT IN ('running','succeeded','failed','canceled') THEN
    RAISE EXCEPTION 'invalid final status';
  END IF;
  IF (p_attempt_status='succeeded' AND p_request_status<>'succeeded')
     OR (p_attempt_status IN ('failed','canceled') AND p_request_status='succeeded')
     OR (p_request_status='running' AND p_attempt_status<>'failed') THEN
    RAISE EXCEPTION 'attempt and request statuses conflict';
  END IF;
  SELECT * INTO v_attempt FROM saas_business.ai_request_attempts
   WHERE id=p_attempt_id AND request_id=p_request_id AND user_id=p_user_id FOR UPDATE;
  IF NOT FOUND OR v_attempt.status<>'running' THEN RAISE EXCEPTION 'attempt is not running'; END IF;

  UPDATE saas_business.ai_request_attempts SET status=p_attempt_status,
    input_tokens=p_input_tokens,output_tokens=p_output_tokens,
    provider_cost_micros=p_cost_micros,latency_ms=p_latency_ms,error_code=p_error_code,
    finished_at=clock_timestamp()
  WHERE id=p_attempt_id;

  INSERT INTO saas_business.usage_events(attempt_id,request_id,user_id,conversation_id,
    provider_key,model_key,input_tokens,output_tokens,latency_ms,provider_cost_micros,
    billable_amount_micros,currency)
  VALUES(p_attempt_id,p_request_id,p_user_id,v_attempt.conversation_id,
    v_attempt.provider_key,v_attempt.model_key,COALESCE(p_input_tokens,0),
    COALESCE(p_output_tokens,0),p_latency_ms,p_cost_micros,p_billable_micros,p_currency)
  ON CONFLICT(attempt_id) DO NOTHING;

  SELECT COALESCE(sum(input_tokens),0)::integer,COALESCE(sum(output_tokens),0)::integer,
    COALESCE(sum(latency_ms),0)::integer,COALESCE(sum(provider_cost_micros),0)::bigint
  INTO v_input_total,v_output_total,v_latency_total,v_cost_total
  FROM saas_business.usage_events WHERE request_id=p_request_id;

  IF p_request_status IN ('succeeded','failed','canceled') THEN
    UPDATE saas_business.ai_requests SET status=p_request_status,
      output_message_id=p_output_message_id,input_tokens=v_input_total,
      output_tokens=v_output_total,provider_cost_micros=v_cost_total,
      currency=p_currency,latency_ms=v_latency_total,error_code=p_error_code,
      finished_at=clock_timestamp()
    WHERE id=p_request_id AND user_id=p_user_id AND status='running';
    IF NOT FOUND THEN RAISE EXCEPTION 'request cannot be finalized'; END IF;
  END IF;
END $$;
```

For a successful provider call, the assistant message and request finalization must be committed atomically. The Edge Function calls this wrapper instead of inserting an assistant message and finalizing the attempt in separate transactions:

```sql
CREATE FUNCTION saas_business.bg_complete_attempt(
  p_attempt_id uuid,p_request_id uuid,p_user_id uuid,p_output_content text,
  p_input_tokens integer,p_output_tokens integer,p_latency_ms integer
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,saas_business AS $$
DECLARE v_conversation_id uuid; v_message_id uuid;
BEGIN
  IF p_output_content IS NULL OR btrim(p_output_content)=''
     OR (p_input_tokens IS NOT NULL AND p_input_tokens<0)
     OR (p_output_tokens IS NOT NULL AND p_output_tokens<0)
     OR (p_latency_ms IS NOT NULL AND p_latency_ms<0) THEN
    RAISE EXCEPTION 'invalid provider result';
  END IF;
  SELECT conversation_id INTO v_conversation_id
  FROM saas_business.ai_request_attempts
  WHERE id=p_attempt_id AND request_id=p_request_id AND user_id=p_user_id
    AND status='running'
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'attempt is not running'; END IF;

  v_message_id := saas_business.bg_append_message(
    p_user_id,v_conversation_id,'assistant',p_output_content
  );
  PERFORM saas_business.bg_finalize_attempt(
    p_attempt_id,p_request_id,p_user_id,'succeeded',p_input_tokens,p_output_tokens,
    NULL,p_latency_ms,NULL,NULL,NULL,'succeeded',v_message_id
  );
  RETURN v_message_id;
END $$;
```

### AI Director et contrôles au moment du routage

Cette fonction sélectionne et enregistre la première cible éligible. La fraîcheur est fixée ici à cinq minutes; les capacités sont comparées en tant qu'objets JSONB requis/contenus. En l'absence de candidat, elle renvoie zéro ligne; l'Edge Function convertit ce cas attendu en `NO_VERIFIED_PROVIDER`. Les autres erreurs SQL restent des échecs de sélection, et ne sont pas masquées comme une indisponibilité fournisseur. Les appels fournisseur restent dans l'Edge Function et ne sont pas simulés.

```sql
CREATE FUNCTION saas_business.bg_select_route(
  p_request_id uuid,p_user_id uuid,p_conversation_id uuid,p_attempt_number integer,
  p_fallback_from uuid,p_fallback_reason text,
  p_preferred_provider_keys text[] DEFAULT ARRAY[]::text[],
  p_excluded_provider_keys text[] DEFAULT ARRAY[]::text[]
) RETURNS TABLE(attempt_id uuid,provider_key text,model_key text,provider_model_key text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,saas_business AS $$
DECLARE v_role text; v_provider text; v_model text; v_provider_model text;
BEGIN
  SELECT role_key INTO v_role FROM saas_business.ai_requests
   WHERE id=p_request_id AND user_id=p_user_id AND conversation_id=p_conversation_id
     AND status='running' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'running request not found'; END IF;
  SELECT rr.provider_key,rr.model_key,m.provider_model_key
    INTO v_provider,v_model,v_provider_model
  FROM saas_business.ai_routing_rules rr
  JOIN saas_business.ai_roles ar ON ar.role_key=rr.role_key AND ar.enabled
  JOIN saas_business.ai_providers p ON p.provider_key=rr.provider_key
     AND p.enabled AND p.status='available'
  JOIN saas_business.ai_provider_configs pc ON pc.provider_key=p.provider_key
     AND pc.config_status='configured'
  JOIN saas_business.ai_models m ON m.provider_key=rr.provider_key
     AND m.model_key=rr.model_key AND m.enabled
     AND m.verification_status='verified'
  WHERE rr.role_key=v_role AND rr.enabled
    AND (cardinality(p_preferred_provider_keys)=0
      OR rr.provider_key=ANY(p_preferred_provider_keys))
    AND NOT (rr.provider_key=ANY(COALESCE(p_excluded_provider_keys,ARRAY[]::text[])))
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_each(ar.required_capabilities) req
      WHERE m.capabilities->req.key IS DISTINCT FROM req.value
    )
    AND EXISTS (SELECT 1 FROM saas_business.ai_provider_health_checks h
      WHERE h.provider_key=p.provider_key AND h.model_key IS NULL
        AND h.status='healthy' AND h.checked_at >= now()-interval '5 minutes')
    AND EXISTS (SELECT 1 FROM saas_business.ai_provider_health_checks h
      WHERE h.provider_key=m.provider_key AND h.model_key=m.model_key
        AND h.status='healthy' AND h.checked_at >= now()-interval '5 minutes')
  ORDER BY
    CASE WHEN cardinality(p_preferred_provider_keys)>0
      THEN array_position(p_preferred_provider_keys,rr.provider_key) END NULLS LAST,
    rr.priority
  LIMIT 1;
  IF v_provider IS NULL THEN RETURN; END IF;
  attempt_id := saas_business.bg_add_attempt(p_request_id,p_user_id,p_conversation_id,
    p_attempt_number,v_provider,v_model,p_fallback_from,p_fallback_reason);
  provider_key:=v_provider; model_key:=v_model;
  provider_model_key:=v_provider_model; RETURN NEXT;
END $$;

CREATE FUNCTION saas_business.bg_record_health_check(
  p_provider_key text,p_model_key text,p_status text,p_latency_ms integer,p_error_code text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,saas_business AS $$
DECLARE v_check_id uuid;
BEGIN
  IF p_status NOT IN ('healthy','degraded','unavailable','failed')
     OR (p_latency_ms IS NOT NULL AND p_latency_ms<0) THEN
    RAISE EXCEPTION 'invalid health result';
  END IF;
  INSERT INTO saas_business.ai_provider_health_checks
    (provider_key,model_key,status,latency_ms,error_code)
  VALUES(p_provider_key,p_model_key,p_status,p_latency_ms,p_error_code)
  RETURNING id INTO v_check_id;
  IF p_model_key IS NULL THEN
    UPDATE saas_business.ai_providers SET
      status=CASE p_status WHEN 'healthy' THEN 'available' WHEN 'failed' THEN 'unavailable' ELSE p_status END,
      checked_at=clock_timestamp(),
      error_code=p_error_code WHERE provider_key=p_provider_key;
    IF NOT FOUND THEN RAISE EXCEPTION 'provider not found'; END IF;
  ELSE
    UPDATE saas_business.ai_models SET
      verification_status=CASE
        WHEN p_status='healthy' THEN 'verified'
        WHEN p_status IN ('unavailable','failed') THEN 'unavailable'
        ELSE verification_status END,
      verified_at=CASE WHEN p_status='healthy' THEN clock_timestamp() ELSE verified_at END,
      error_code=p_error_code
    WHERE provider_key=p_provider_key AND model_key=p_model_key;
    IF NOT FOUND THEN RAISE EXCEPTION 'model not found'; END IF;
  END IF;
  RETURN v_check_id;
END $$;
```

### Abonnements et webhooks

Un événement est enregistré après validation de signature dans l'Edge Function. Une même paire `(provider,event_id)` est idempotente; un hash différent est une anomalie. La lease expirée permet la reprise. La fonction d'application vérifie la lease et traite abonnement + événement dans une transaction PostgreSQL.

```sql
CREATE FUNCTION saas_business.bg_receive_billing_event(
  p_provider text,p_event_id text,p_event_type text,p_payload_hash text,
  p_event_data jsonb,p_provider_event_at timestamptz
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,saas_business AS $$
DECLARE v_id uuid; v_hash text; v_data jsonb;
BEGIN
  IF jsonb_typeof(p_event_data)<>'object'
     OR NOT (p_event_data ?& ARRAY['user_id','subscription_id','plan_key','status']) THEN
    RAISE EXCEPTION 'invalid normalized billing event';
  END IF;
  INSERT INTO saas_business.billing_events(billing_provider,external_event_id,event_type,
    payload_hash,event_data,provider_event_at)
  VALUES(p_provider,p_event_id,p_event_type,p_payload_hash,p_event_data,p_provider_event_at)
  ON CONFLICT(billing_provider,external_event_id) DO NOTHING RETURNING id INTO v_id;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;
  SELECT id,payload_hash,event_data INTO v_id,v_hash,v_data FROM saas_business.billing_events
    WHERE billing_provider=p_provider AND external_event_id=p_event_id FOR UPDATE;
  IF v_hash <> p_payload_hash OR v_data IS DISTINCT FROM p_event_data THEN
    RAISE EXCEPTION 'external event id reused with different payload';
  END IF;
  RETURN v_id;
END $$;

CREATE FUNCTION saas_business.bg_claim_billing_event(p_lease_seconds integer DEFAULT 60)
RETURNS TABLE(event_id uuid,lease_token uuid,billing_provider text,external_event_id text,event_type text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,saas_business AS $$
DECLARE v_row saas_business.billing_events%ROWTYPE; v_token uuid := gen_random_uuid();
BEGIN
  IF p_lease_seconds < 10 OR p_lease_seconds > 900 THEN RAISE EXCEPTION 'invalid lease duration'; END IF;
  SELECT * INTO v_row FROM saas_business.billing_events
  WHERE (processing_status IN ('received','retryable') AND next_attempt_at<=now())
     OR (processing_status='processing' AND lease_until<now())
  ORDER BY received_at FOR UPDATE SKIP LOCKED LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE saas_business.billing_events SET processing_status='processing',
    lease_token=v_token,lease_until=now()+make_interval(secs=>p_lease_seconds),
    attempt_count=attempt_count+1
  WHERE id=v_row.id
  RETURNING * INTO v_row;
  event_id:=v_row.id;
  lease_token:=v_row.lease_token;
  billing_provider:=v_row.billing_provider;
  external_event_id:=v_row.external_event_id;
  event_type:=v_row.event_type;
  RETURN NEXT;
END $$;

CREATE FUNCTION saas_business.guard_subscription_activation()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,saas_business AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF (NEW.id,NEW.user_id,NEW.billing_provider,NEW.external_customer_id,NEW.external_subscription_id,NEW.created_at)
       IS DISTINCT FROM
       (OLD.id,OLD.user_id,OLD.billing_provider,OLD.external_customer_id,OLD.external_subscription_id,OLD.created_at)
    THEN RAISE EXCEPTION 'subscription identity is immutable'; END IF;
  END IF;
  IF NEW.status IN ('active','trialing')
     AND NOT EXISTS (SELECT 1 FROM saas_business.plans
       WHERE plan_key=NEW.plan_key AND active AND billing_enabled)
  THEN RAISE EXCEPTION 'billing plan is not enabled'; END IF;
  IF NEW.status IN ('active','trialing','past_due') AND NEW.billing_provider IS NULL THEN
    RAISE EXCEPTION 'active subscription requires billing provider';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER subscription_activation_guard
BEFORE INSERT OR UPDATE ON saas_business.subscriptions
FOR EACH ROW EXECUTE FUNCTION saas_business.guard_subscription_activation();

CREATE FUNCTION saas_business.guard_plan_billing()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,saas_business AS $$
BEGIN
  IF OLD.billing_enabled AND NOT NEW.billing_enabled AND EXISTS (
    SELECT 1 FROM saas_business.subscriptions
    WHERE plan_key=OLD.plan_key AND status IN ('trialing','active','past_due')
  ) THEN RAISE EXCEPTION 'cannot disable billing for a current subscription'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER plan_billing_guard BEFORE UPDATE ON saas_business.plans
FOR EACH ROW EXECUTE FUNCTION saas_business.guard_plan_billing();

CREATE FUNCTION saas_business.bg_apply_billing_event(
  p_event_id uuid,p_lease_token uuid
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,saas_business AS $$
DECLARE
  v_event saas_business.billing_events%ROWTYPE;
  v_user_id uuid; v_subscription_id uuid; v_customer_id text;
  v_external_subscription_id text; v_plan_key text; v_status text;
  v_period_start timestamptz; v_period_end timestamptz;
BEGIN
  SELECT * INTO v_event FROM saas_business.billing_events WHERE id=p_event_id FOR UPDATE;
  IF NOT FOUND OR v_event.processing_status<>'processing'
     OR v_event.lease_token IS DISTINCT FROM p_lease_token
     OR v_event.lease_until<=now() THEN RAISE EXCEPTION 'billing lease invalid or expired'; END IF;
  v_user_id := (v_event.event_data->>'user_id')::uuid;
  v_subscription_id := (v_event.event_data->>'subscription_id')::uuid;
  v_customer_id := v_event.event_data->>'external_customer_id';
  v_external_subscription_id := v_event.event_data->>'external_subscription_id';
  v_plan_key := v_event.event_data->>'plan_key';
  v_status := v_event.event_data->>'status';
  v_period_start := NULLIF(v_event.event_data->>'period_start','')::timestamptz;
  v_period_end := NULLIF(v_event.event_data->>'period_end','')::timestamptz;
  IF v_status NOT IN ('pending_integration','trialing','active','past_due','canceled','expired')
  THEN RAISE EXCEPTION 'invalid subscription status'; END IF;
  INSERT INTO saas_business.subscriptions(id,user_id,plan_key,status,billing_provider,
    external_customer_id,external_subscription_id,current_period_start,current_period_end,billing_updated_at)
  VALUES(v_subscription_id,v_user_id,v_plan_key,v_status,v_event.billing_provider,v_customer_id,
    v_external_subscription_id,v_period_start,v_period_end,v_event.provider_event_at)
  ON CONFLICT(id) DO UPDATE SET
    status=EXCLUDED.status,plan_key=EXCLUDED.plan_key,
    external_customer_id=EXCLUDED.external_customer_id,
    external_subscription_id=EXCLUDED.external_subscription_id,
    current_period_start=EXCLUDED.current_period_start,
    current_period_end=EXCLUDED.current_period_end,
    billing_updated_at=EXCLUDED.billing_updated_at
  WHERE saas_business.subscriptions.billing_provider=EXCLUDED.billing_provider
    AND (saas_business.subscriptions.billing_updated_at IS NULL
      OR EXCLUDED.billing_updated_at >= saas_business.subscriptions.billing_updated_at);
  IF NOT FOUND THEN RAISE EXCEPTION 'stale or mismatched subscription event'; END IF;
  UPDATE saas_business.billing_events SET user_id=v_user_id,subscription_id=v_subscription_id,
    processing_status='processed',processed_at=now(),lease_token=NULL,lease_until=NULL
  WHERE id=p_event_id;
END $$;

CREATE FUNCTION saas_business.bg_fail_billing_event(
  p_event_id uuid,p_lease_token uuid,p_error_code text,p_retry_at timestamptz,p_dead boolean
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,saas_business AS $$
BEGIN
  UPDATE saas_business.billing_events SET
    processing_status=CASE WHEN p_dead OR attempt_count>=10 THEN 'dead_letter' ELSE 'retryable' END,
    error_code=p_error_code,next_attempt_at=COALESCE(p_retry_at,now()+interval '5 minutes'),
    lease_token=NULL,lease_until=NULL
  WHERE id=p_event_id AND processing_status='processing' AND lease_token=p_lease_token
    AND lease_until>clock_timestamp();
  IF NOT FOUND THEN RAISE EXCEPTION 'billing lease invalid'; END IF;
END $$;

CREATE FUNCTION saas_business.bg_ignore_billing_event(
  p_event_id uuid,p_lease_token uuid,p_reason text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,saas_business AS $$
BEGIN
  UPDATE saas_business.billing_events SET processing_status='ignored',
    error_code=p_reason,processed_at=clock_timestamp(),lease_token=NULL,lease_until=NULL
  WHERE id=p_event_id AND processing_status='processing' AND lease_token=p_lease_token
    AND lease_until>clock_timestamp();
  IF NOT FOUND THEN RAISE EXCEPTION 'billing lease invalid'; END IF;
END $$;
```

La signature webhook est nécessairement vérifiée dans l'adaptateur Edge propre au prestataire avant `bg_receive_billing_event`; aucun prestataire de paiement n'étant choisi, son format de signature ne peut pas être codé ici. L'adaptateur transforme alors l'événement vérifié en `event_data` normalisé, associant l'utilisateur à l'abonnement uniquement depuis un mapping serveur de confiance. La fonction SQL impose lease, cohérence du provider, idempotence, activation du plan et ordre d'événements.

## 5. RLS, GRANT/REVOKE et fonctions

```sql
ALTER TABLE saas_business.ai_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_business.ai_provider_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_business.ai_models ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_business.ai_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_business.ai_routing_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_business.ai_provider_health_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_business.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_business.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_business.ai_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_business.ai_request_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_business.memory_consent_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_business.memory_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_business.memory_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_business.usage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_business.plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_business.subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_business.billing_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_business.integration_connections ENABLE ROW LEVEL SECURITY;

ALTER TABLE saas_business.ai_providers FORCE ROW LEVEL SECURITY;
ALTER TABLE saas_business.ai_provider_configs FORCE ROW LEVEL SECURITY;
ALTER TABLE saas_business.ai_models FORCE ROW LEVEL SECURITY;
ALTER TABLE saas_business.ai_roles FORCE ROW LEVEL SECURITY;
ALTER TABLE saas_business.ai_routing_rules FORCE ROW LEVEL SECURITY;
ALTER TABLE saas_business.ai_provider_health_checks FORCE ROW LEVEL SECURITY;
ALTER TABLE saas_business.conversations FORCE ROW LEVEL SECURITY;
ALTER TABLE saas_business.messages FORCE ROW LEVEL SECURITY;
ALTER TABLE saas_business.ai_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE saas_business.ai_request_attempts FORCE ROW LEVEL SECURITY;
ALTER TABLE saas_business.memory_consent_events FORCE ROW LEVEL SECURITY;
ALTER TABLE saas_business.memory_profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE saas_business.memory_items FORCE ROW LEVEL SECURITY;
ALTER TABLE saas_business.usage_events FORCE ROW LEVEL SECURITY;
ALTER TABLE saas_business.plans FORCE ROW LEVEL SECURITY;
ALTER TABLE saas_business.subscriptions FORCE ROW LEVEL SECURITY;
ALTER TABLE saas_business.billing_events FORCE ROW LEVEL SECURITY;
ALTER TABLE saas_business.integration_connections FORCE ROW LEVEL SECURITY;

CREATE POLICY owner_providers ON saas_business.ai_providers TO bg_owner USING (true) WITH CHECK (true);
CREATE POLICY owner_configs ON saas_business.ai_provider_configs TO bg_owner USING (true) WITH CHECK (true);
CREATE POLICY owner_models ON saas_business.ai_models TO bg_owner USING (true) WITH CHECK (true);
CREATE POLICY owner_roles ON saas_business.ai_roles TO bg_owner USING (true) WITH CHECK (true);
CREATE POLICY owner_rules ON saas_business.ai_routing_rules TO bg_owner USING (true) WITH CHECK (true);
CREATE POLICY owner_health ON saas_business.ai_provider_health_checks TO bg_owner USING (true) WITH CHECK (true);
CREATE POLICY owner_conversations ON saas_business.conversations TO bg_owner USING (true) WITH CHECK (true);
CREATE POLICY owner_messages ON saas_business.messages TO bg_owner USING (true) WITH CHECK (true);
CREATE POLICY owner_requests ON saas_business.ai_requests TO bg_owner USING (true) WITH CHECK (true);
CREATE POLICY owner_attempts ON saas_business.ai_request_attempts TO bg_owner USING (true) WITH CHECK (true);
CREATE POLICY owner_consents ON saas_business.memory_consent_events TO bg_owner USING (true) WITH CHECK (true);
CREATE POLICY owner_profiles ON saas_business.memory_profiles TO bg_owner USING (true) WITH CHECK (true);
CREATE POLICY owner_items ON saas_business.memory_items TO bg_owner USING (true) WITH CHECK (true);
CREATE POLICY owner_usage ON saas_business.usage_events TO bg_owner USING (true) WITH CHECK (true);
CREATE POLICY owner_plans ON saas_business.plans TO bg_owner USING (true) WITH CHECK (true);
CREATE POLICY owner_subscriptions ON saas_business.subscriptions TO bg_owner USING (true) WITH CHECK (true);
CREATE POLICY owner_billing_events ON saas_business.billing_events TO bg_owner USING (true) WITH CHECK (true);
CREATE POLICY owner_integrations ON saas_business.integration_connections TO bg_owner USING (true) WITH CHECK (true);

REVOKE ALL ON ALL TABLES IN SCHEMA saas_business
  FROM PUBLIC,anon,authenticated,service_role,bg_edge,bg_billing_worker,bg_erasure;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA saas_business
  FROM PUBLIC,anon,authenticated,service_role,bg_edge,bg_billing_worker,bg_erasure;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA saas_business
  FROM PUBLIC,anon,authenticated,service_role,bg_edge,bg_billing_worker,bg_erasure;
ALTER DEFAULT PRIVILEGES FOR ROLE bg_owner IN SCHEMA saas_business
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC,anon,authenticated,service_role,bg_edge,bg_billing_worker,bg_erasure;
ALTER DEFAULT PRIVILEGES FOR ROLE bg_owner IN SCHEMA saas_business
  REVOKE ALL ON TABLES FROM PUBLIC,anon,authenticated,service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE bg_owner IN SCHEMA saas_business
  REVOKE ALL ON SEQUENCES FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION saas_business.bg_set_memory_consent(uuid,boolean,text) TO bg_edge;
GRANT EXECUTE ON FUNCTION saas_business.bg_create_conversation(uuid,text,uuid) TO bg_edge;
GRANT EXECUTE ON FUNCTION saas_business.bg_rename_conversation(uuid,uuid,text) TO bg_edge;
GRANT EXECUTE ON FUNCTION saas_business.bg_delete_conversation(uuid,uuid) TO bg_edge;
GRANT EXECUTE ON FUNCTION saas_business.bg_list_conversations(uuid,integer) TO bg_edge;
GRANT EXECUTE ON FUNCTION saas_business.bg_list_messages(uuid,uuid,integer) TO bg_edge;
GRANT EXECUTE ON FUNCTION saas_business.bg_get_memory(uuid) TO bg_edge;
GRANT EXECUTE ON FUNCTION saas_business.bg_list_providers() TO bg_edge;
GRANT EXECUTE ON FUNCTION saas_business.bg_append_message(uuid,uuid,text,text) TO bg_edge;
GRANT EXECUTE ON FUNCTION saas_business.bg_upsert_memory_profile(uuid,jsonb) TO bg_edge;
GRANT EXECUTE ON FUNCTION saas_business.bg_put_memory_item(uuid,uuid,text,jsonb,text,uuid) TO bg_edge;
GRANT EXECUTE ON FUNCTION saas_business.bg_delete_memory_item(uuid,uuid) TO bg_edge;
GRANT EXECUTE ON FUNCTION saas_business.bg_clear_memory(uuid) TO bg_edge;
GRANT EXECUTE ON FUNCTION saas_business.bg_create_request(uuid,uuid,text,text,text,uuid) TO bg_edge;
GRANT EXECUTE ON FUNCTION saas_business.bg_submit_user_message(uuid,uuid,text,text,text,text) TO bg_edge;
GRANT EXECUTE ON FUNCTION saas_business.bg_start_request(uuid,uuid) TO bg_edge;
GRANT EXECUTE ON FUNCTION saas_business.bg_fail_request(uuid,uuid,text) TO bg_edge;
GRANT EXECUTE ON FUNCTION saas_business.bg_finalize_attempt(uuid,uuid,uuid,text,integer,integer,bigint,integer,text,bigint,char,text,uuid) TO bg_edge;
GRANT EXECUTE ON FUNCTION saas_business.bg_complete_attempt(uuid,uuid,uuid,text,integer,integer,integer) TO bg_edge;
GRANT EXECUTE ON FUNCTION saas_business.bg_select_route(uuid,uuid,uuid,integer,uuid,text,text[],text[]) TO bg_edge;
GRANT EXECUTE ON FUNCTION saas_business.bg_record_health_check(text,text,text,integer,text) TO bg_edge;
GRANT EXECUTE ON FUNCTION saas_business.bg_receive_billing_event(text,text,text,text,jsonb,timestamptz) TO bg_billing_worker;
GRANT EXECUTE ON FUNCTION saas_business.bg_claim_billing_event(integer) TO bg_billing_worker;
GRANT EXECUTE ON FUNCTION saas_business.bg_apply_billing_event(uuid,uuid) TO bg_billing_worker;
GRANT EXECUTE ON FUNCTION saas_business.bg_fail_billing_event(uuid,uuid,text,timestamptz,boolean) TO bg_billing_worker;
GRANT EXECUTE ON FUNCTION saas_business.bg_ignore_billing_event(uuid,uuid,text) TO bg_billing_worker;
GRANT EXECUTE ON FUNCTION saas_business.bg_prepare_account_erasure(uuid) TO bg_erasure;

GRANT USAGE ON SCHEMA saas_business TO bg_edge,bg_billing_worker,bg_erasure;
RESET ROLE;
```

`bg_add_attempt` est le seul helper `SECURITY DEFINER` sans `GRANT EXECUTE` à un rôle d'exécution. Il est invoqué par `bg_select_route` sous l'identité `bg_owner`; les connexions Edge ne peuvent pas l'appeler directement.

**Décision de cette proposition : `saas_business` n'est pas exposé à PostgREST et `authenticated` n'a ni `USAGE` du schéma ni privilèges sur les tables/fonctions.** Les Edge Functions renvoient des réponses minimales. L'accès DB est dédié aux rôles serveur de connexion ci-dessus. L'Edge Function préparée attend un secret serveur `BUSINESS_GROW_DATABASE_URL` pour une connexion TLS en tant que `bg_edge`; ce secret n'existe pas dans le dépôt et ne doit jamais être envoyé au navigateur. Elle vérifie séparément le JWT auprès de Supabase Auth et n'accepte jamais un `user_id` dans les données client.

### Chemin Edge Functions et validation d'identité

L'architecture recommandée n'expose pas `saas_business` à la Data API. Une Edge Function reçoit le JWT du navigateur, vérifie le JWT avec GoTrue (`GET /auth/v1/user` avec anon/publishable key) ou une vérification JWT/JWKS rigoureuse, puis prend l'UUID `user.id` de la réponse vérifiée — jamais un `user_id` du body. Elle utilise ensuite une connexion PostgreSQL TLS stockée dans les secrets Edge, avec le rôle `bg_edge`, et appelle uniquement les fonctions accordées. L'utilisateur d'exécution DB ne peut pas faire de DML direct. Les webhooks valident la signature du prestataire, puis utilisent `bg_billing_worker`. Ni service-role key ni mot de passe DB ne sont transmis au navigateur.

Présence dans le dépôt (au moment de la vérification) :

| Edge Function | Présente | Responsabilité | Authentification observée |
|---|---:|---|---|
| `reelora-ai` | Oui | Génération texte Groq et opérations de quota Studio | `verify_jwt=true`; validation de l'utilisateur via Auth; RPC utilisateur avec JWT; RPC de remboursement via service key |
| `reelora-video` | Oui | Catalogue, devis, démarrage et état des tâches vidéo MuAPI | `verify_jwt=true`; appels backend/service-role et contrôles Auth côté code |
| `reelora-video-worker` | Oui | Callback MuAPI et réconciliation planifiée | `verify_jwt=false`; jeton worker stocké côté serveur; callback traité comme signal non fiable, statut relu auprès de MuAPI |
| `reelora-health` | Oui | Indique la présence de secrets serveur, sans en révéler les valeurs | `verify_jwt=false`; endpoint de santé non authentifié |
| Business Grow / AI Director (`supabase/functions/business-grow/`) | Présent localement | Conversations/messages/mémoire via RPC privées; adaptateurs REST Groq/Gemini, sélection configurée, historique et fallback traçable; non déployé et non configuré sur le projet | `verify_jwt=true`; validation supplémentaire du JWT par Auth. Les opérations persistent restent inactives tant que le schéma et le secret DB ne sont pas installés |

`supabase/config.toml` montre `schemas = ["public"]` en local, et `verify_jwt` pour les fonctions ci-dessus. Il ne prouve pas la configuration Data API live.

### Contrat d'exécution Groq / Gemini

L'Edge Function utilise les API HTTPS officielles avec `fetch`, sans SDK fournisseur supplémentaire :

- Groq Chat Completions : `POST https://api.groq.com/openai/v1/chat/completions`.
- Gemini REST : `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`, clé transmise dans l'en-tête serveur `x-goog-api-key`, pas dans l'URL.

Les secrets sont exclusivement des secrets Edge Supabase dédiés à Business Grow : `BUSINESS_GROW_GROQ_API_KEY` et `BUSINESS_GROW_GEMINI_API_KEY`. Les identifiants de modèles sont configurés séparément via `BUSINESS_GROW_GROQ_MODEL` et `BUSINESS_GROW_GEMINI_MODEL`; aucun modèle n'est figé dans le code. Ces variables sont volontairement distinctes des clés Groq du Studio afin de séparer leur configuration et leur facturation fournisseur. `BUSINESS_GROW_PROVIDER_ORDER` accepte `groq,gemini` ou l'ordre inverse. Les modèles configurés doivent correspondre au `provider_model_key` de la cible validée par l'AI Director; la base reste la source de vérité pour `enabled`, la vérification individuelle et les contrôles de santé récents.

Ne pas mettre ces valeurs dans `VITE_*`, un fichier `.env` suivi, une réponse HTTP ou un log. Les secrets ne sont pas configurés dans cette étape; ne pas réutiliser une clé déjà partagée dans une conversation. Les clés précédemment communiquées doivent être révoquées/renouvelées avant un test réel.

L'Edge Function récupère l'historique de la conversation avec l'UUID dérivé de la session Auth et l'UUID de conversation, filtre les rôles `user`/`assistant`, impose un message système serveur, applique un délai limite de 25 secondes et limite le contexte aux 40 derniers messages. Un fallback n'est tenté qu'en enregistrant un nouvel `ai_request_attempts`, après exclusion du fournisseur déjà essayé; la réponse révèle explicitement le fournisseur/modèle qui a répondu. Les erreurs fournisseur sont réduites à des codes sûrs; le corps et les en-têtes fournisseurs (qui peuvent contenir des informations sensibles) ne sont ni renvoyés ni consignés.

À la réussite, `bg_complete_attempt` écrit le message assistant, les tokens/latence et clôt la tentative/la requête au sein d'une même transaction. Aucun coût n'est estimé ou facturé par ce client tant qu'un prix vérifiable n'est pas disponible. Les crédits et tables Studio ne sont pas utilisés.

**Prérequis de déploiement non satisfaits par le dépôt seul :** le schéma `saas_business`, les fonctions `bg_select_route` mises à jour et `bg_complete_attempt` doivent exister dans un environnement autorisé; `BUSINESS_GROW_DATABASE_URL`, `SUPABASE_URL`, la clé publique Supabase, les clés fournisseur Business Grow dédiées, les modèles vérifiés et l'ordre du routeur doivent être configurés comme secrets/variables serveur. Aucun de ces secrets ne doit être ajouté au frontend. Après installation en staging, exécuter les tests d'isolation A/B puis seulement un test de chat non payant autorisé.

### État d'installation vérifié le 2026-11-10

L'inspection distante en lecture seule n'a trouvé aucune table dans `saas_business`. Le projet n'a qu'une branche Supabase `main` par défaut; aucune branche ou cible staging isolée n'a été identifiée. `business-grow` n'apparaît pas dans la liste des fonctions Edge déployées. Le DDL ci-dessus demeure une proposition non appliquée : ne pas l'exécuter sur `main`/production. Réaliser l'installation et les tests transactionnels uniquement après mise à disposition d'une base staging isolée et confirmation de ses paramètres de connexion. Aucun secret fournisseur n'a été configuré.

## 6. Script de vérification des droits effectifs

À exécuter en staging avec les rôles Supabase et `bg_owner` présents. Le script détecte privilèges table/fonction/schéma inattendus et vérifie RLS.

```sql
WITH role_names AS (
  SELECT unnest(ARRAY['anon','authenticated','service_role','bg_owner','bg_edge','bg_billing_worker','bg_erasure']) AS role_name
),
table_privs AS (
  SELECT r.role_name, c.relname,
    has_table_privilege(r.role_name, c.oid, 'SELECT') AS can_select,
    has_table_privilege(r.role_name, c.oid, 'INSERT') AS can_insert,
    has_table_privilege(r.role_name, c.oid, 'UPDATE') AS can_update,
    has_table_privilege(r.role_name, c.oid, 'DELETE') AS can_delete,
    c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS rls_forced
  FROM role_names r
  CROSS JOIN pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='saas_business' AND c.relkind='r'
),
function_privs AS (
  SELECT r.role_name, p.oid::regprocedure AS function_name,
    has_function_privilege(r.role_name,p.oid,'EXECUTE') AS can_execute
  FROM role_names r
  CROSS JOIN pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='saas_business'
)
SELECT 'TABLE' AS object_type, role_name, relname AS object_name,
       can_select::text||','||can_insert||','||can_update||','||can_delete AS privileges,
       'rls='||rls_enabled||';force='||rls_forced AS details
FROM table_privs
UNION ALL
SELECT 'FUNCTION', role_name, function_name::text, can_execute::text, NULL
FROM function_privs
ORDER BY 1,2,3;
```

Complément de vérification des schémas et propriétaires :

```sql
SELECT r.rolname,
  has_schema_privilege(r.rolname,'saas_business','USAGE') AS schema_usage
FROM pg_roles r
WHERE r.rolname IN ('anon','authenticated','service_role','bg_owner','bg_edge','bg_billing_worker','bg_erasure')
ORDER BY r.rolname;

SELECT 'table' AS object_type,c.relname AS object_name,pg_get_userbyid(c.relowner) AS object_owner,
       c.relrowsecurity,c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='saas_business' AND c.relkind='r'
UNION ALL
SELECT 'function',p.oid::regprocedure::text,pg_get_userbyid(p.proowner),NULL,NULL
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='saas_business'
ORDER BY 1,2;

DO $$
DECLARE r text; v_priv text; t record; f record; n_tables integer;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF has_schema_privilege(r,'saas_business','USAGE') THEN
      RAISE EXCEPTION '% unexpectedly has schema USAGE',r;
    END IF;
  END LOOP;

  SELECT count(*) INTO n_tables FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='saas_business' AND c.relkind='r';
  IF n_tables<>18 THEN RAISE EXCEPTION 'expected 18 tables, found %',n_tables; END IF;

  FOR t IN SELECT c.* FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
           WHERE n.nspname='saas_business' AND c.relkind='r'
  LOOP
    IF NOT t.relrowsecurity OR NOT t.relforcerowsecurity THEN
      RAISE EXCEPTION 'RLS missing or not forced on %',t.relname;
    END IF;
    FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role','bg_edge','bg_billing_worker','bg_erasure'] LOOP
      FOREACH v_priv IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] LOOP
        IF has_table_privilege(r,t.oid,v_priv) THEN
          RAISE EXCEPTION '% has % on table %',r,v_priv,t.relname;
        END IF;
      END LOOP;
    END LOOP;
    IF pg_get_userbyid(t.relowner)<>'bg_owner' THEN
      RAISE EXCEPTION 'unexpected owner for table %',t.relname;
    END IF;
  END LOOP;

  FOR f IN SELECT p.* FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
           WHERE n.nspname='saas_business'
  LOOP
    IF pg_get_userbyid(f.proowner)<>'bg_owner' THEN
      RAISE EXCEPTION 'unexpected function owner for %',f.oid::regprocedure;
    END IF;
    FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
      IF has_function_privilege(r,f.oid,'EXECUTE') THEN
        RAISE EXCEPTION '% unexpectedly can execute %',r,f.oid::regprocedure;
      END IF;
    END LOOP;
    IF has_function_privilege('bg_edge',f.oid,'EXECUTE')
       AND f.proname NOT IN ('bg_set_memory_consent','bg_create_conversation',
         'bg_append_message','bg_upsert_memory_profile','bg_put_memory_item',
         'bg_delete_memory_item','bg_clear_memory','bg_create_request',
         'bg_start_request','bg_finalize_attempt','bg_complete_attempt','bg_select_route',
         'bg_record_health_check') THEN
      RAISE EXCEPTION 'bg_edge has unexpected EXECUTE on %',f.oid::regprocedure;
    END IF;
    IF has_function_privilege('bg_billing_worker',f.oid,'EXECUTE')
       AND f.proname NOT IN ('bg_receive_billing_event','bg_claim_billing_event',
         'bg_apply_billing_event','bg_fail_billing_event','bg_ignore_billing_event') THEN
      RAISE EXCEPTION 'bg_billing_worker has unexpected EXECUTE on %',f.oid::regprocedure;
    END IF;
    IF has_function_privilege('bg_erasure',f.oid,'EXECUTE')
       AND f.proname<>'bg_prepare_account_erasure' THEN
      RAISE EXCEPTION 'bg_erasure has unexpected EXECUTE on %',f.oid::regprocedure;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='saas_business'
      AND p.proname IN ('bg_set_memory_consent','bg_create_conversation','bg_append_message',
        'bg_upsert_memory_profile','bg_put_memory_item','bg_delete_memory_item',
        'bg_clear_memory','bg_create_request','bg_start_request','bg_finalize_attempt',
        'bg_complete_attempt','bg_select_route','bg_record_health_check')
      AND NOT has_function_privilege('bg_edge',p.oid,'EXECUTE')
  ) THEN RAISE EXCEPTION 'expected bg_edge EXECUTE grant missing'; END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='saas_business'
      AND p.proname IN ('bg_receive_billing_event','bg_claim_billing_event',
        'bg_apply_billing_event','bg_fail_billing_event','bg_ignore_billing_event')
      AND NOT has_function_privilege('bg_billing_worker',p.oid,'EXECUTE')
  ) THEN RAISE EXCEPTION 'expected billing-worker EXECUTE grant missing'; END IF;
  IF NOT has_function_privilege('bg_erasure',
       'saas_business.bg_prepare_account_erasure(uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'expected erasure EXECUTE grant missing';
  END IF;
END $$;
```

Le bloc `DO` est une assertion échouant dès qu'un de ces droits est inattendu. `bg_owner` est propriétaire et peut administrer. `bg_edge`/`bg_billing_worker`/`bg_erasure` ne reçoivent aucun privilège direct de table.

## 7. Tests transactionnels SQL proposés

Les tests doivent tourner uniquement sur PostgreSQL 17 de test avec comptes A/B dédiés. Les lignes marquées « doit échouer » sont à exécuter dans des sous-transactions (`SAVEPOINT`/`ROLLBACK TO`) ou via le harness d'intégration.

### Isolation A/B et FK composites

```sql
BEGIN;
-- Préparer deux utilisateurs de test et une conversation A selon le fixture auth.
INSERT INTO saas_business.conversations(id,user_id,title)
VALUES ('10000000-0000-0000-0000-000000000001','<USER_A>','A');
-- Doit échouer : user B ne correspond pas au propriétaire de conversation A.
INSERT INTO saas_business.messages(conversation_id,user_id,author_role,content)
VALUES ('10000000-0000-0000-0000-000000000001','<USER_B>','user','cross owner');
ROLLBACK;
```

Avec les rôles/JWT A et B, tester `SELECT/UPDATE/DELETE` croisés sur conversations, messages, requêtes, mémoire, usages et abonnements. Tester également une requête de B associée à la conversation ou aux messages de A; une tentative de B associée à la requête de A; et un usage avec bon `attempt_id` mais modèle/fournisseur différent. Toutes ces opérations doivent être refusées par RLS ou FK.

### Consentement, révocation, append-only

```sql
BEGIN;
SELECT * FROM saas_business.bg_set_memory_consent('<USER_A>',true,'v1');
SELECT saas_business.bg_upsert_memory_profile('<USER_A>','{"business":"A"}');
SELECT saas_business.bg_put_memory_item('<USER_A>',NULL,'goal','{"text":"grow"}');
SELECT * FROM saas_business.bg_set_memory_consent('<USER_A>',false,'v1');
-- Attendu : aucun profil/item de A après révocation.
SELECT count(*) FROM saas_business.memory_profiles WHERE user_id='<USER_A>';
SELECT count(*) FROM saas_business.memory_items WHERE user_id='<USER_A>';
ROLLBACK;
```

Tester qu'un `UPDATE`/`DELETE` direct du journal échoue pour `bg_edge`, `bg_billing_worker`, `authenticated` et `service_role`; qu'une mémoire sans consentement est refusée; que B ne lit pas le journal A; et qu'un compte Auth ne peut être supprimé avant la purge de ses événements de consentement.

### Idempotence IA, transitions et fallback

Créer deux fois une requête avec le même utilisateur, clé et hash : une ligne et le même identifiant doivent être retournés. Même clé avec hash différent : erreur. Même clé avec utilisateur B : requête distincte. Vérifier transitions interdites, immuabilité de l'identité, tentative 1 échouée puis tentative 2 fallback autorisée; fallback vers une tentative future, en cours, réussie, autre requête ou autre utilisateur : rejeté. Une tentative terminale et une requête terminale ne peuvent être réouvertes.

### Paiement, leases et billing_enabled

Recevoir deux fois événement/hash identiques : un événement. Identifiant identique/hash différent : erreur. Réclamer un événement : `processing` avec les deux champs lease non NULL; fail retryable/dead-letter : les deux champs deviennent NULL; crash simulé : après expiration une nouvelle lease est attribuée. Un lease ancien ne peut appliquer la souscription. Prestataire différent de celui de l'abonnement : FK/contrôle échoue. Activation avec `billing_enabled=false` : refusée. Deux abonnements courants pour le même utilisateur : refusés.

### Non-interférence Studio

Dans une transaction de test, prendre les comptes des tables Studio avant et après `bg_create_request`, génération de tentatives et insertion d'usage; aucun objet `ugc_*` ne doit changer. Les tokens/coûts ne doivent exister que dans `saas_business`. Les tests Studio existants restent exécutés séparément; le DDL Business Grow n'y touche pas.

## 8. Vérifications et limites

**Écrit dans ce livrable :** un document SQL autonome dans `docs/`, contenant les 18 tables, RLS, privilèges, fonctions proposées, chemin Edge, script de vérification et tests.

**Contrôles statiques effectués :** présence locale des Edge Functions et lecture de leur mode d'authentification; config locale (`schemas=["public"]`, JWT des fonctions); la CLI Supabase liste le projet Reelora `xbuuhfwobrafcbgtdgjx`, mais aucun projet n'est lié au dépôt et l'inspection locale est bloquée par l'absence de Docker/Podman. L'état live des tables/fonctions Business Grow n'est donc pas vérifié dans cette révision. Aucun SQL mutatif ni migration n'a été exécuté.

**Non exécuté / non compilé :** tout le SQL de ce document, le script de droits et les tests transactionnels. Aucun test PostgreSQL réel n'a été exécuté. Restent à tester en PostgreSQL 17 les transitions et cascades, l'identité de session `bg_erasure`, les capacités JSON du routage, la reprise concurrente des leases et l'intégration Edge des rôles de connexion. La validation de signature des paiements demeure spécifique au prestataire qui sera choisi. Le document ne doit pas être qualifié de « DDL validé » avant compilation et tests sur une base PostgreSQL 17 isolée.

**Pas d'opération distante :** aucun SQL mutatif n'a été lancé sur Supabase; aucun commit, push ou déploiement n'a été fait.

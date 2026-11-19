-- VYORA — Phase 0.3 : quotas côté serveur.
--
-- Principe : une fonction SQL atomique consomme N unités ou refuse. Le client ne
-- décide jamais du solde ; il demande, la base tranche.
--
-- Le modèle distingue trois natures d'usage, parce qu'elles n'ont pas le même
-- coût réel et ne se mesurent pas de la même façon :
--   1. `quotas_actions`   : compteurs mensuels (prospects, clients, produits,
--                            e-mails, imports, audits, analyses d'images) ;
--   2. `quotas_ia`        : unités pondérées d'IA (lecture 1, écriture 2,
--                            image 5, audit de boutique 20 — pondération
--                            modifiable en base, jamais en dur) ;
--   3. `quotas_stockage`  : octets occupés, calculés, pas incrémentés à la main.

-- ---------------------------------------------------------------------------
-- 1. Plans et droits
-- ---------------------------------------------------------------------------
-- On garde `saas_ugc.ugc_plans` comme source des plans Studio existants, et on
-- ajoute une table de droits qui couvre les deux univers. Un plan peut donc
-- porter à la fois des limites Studio et des limites Business Grow.
CREATE TABLE IF NOT EXISTS public.plan_entitlements (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_key          text NOT NULL,
  -- 'business' | 'studio' | 'commun'
  univers           text NOT NULL DEFAULT 'commun' CHECK (univers IN ('business', 'studio', 'commun')),
  -- Limites mensuelles. NULL = non limité (et l'UI doit le dire tel quel,
  -- jamais « illimité » si une limite technique existe ailleurs).
  max_prospects     integer,
  max_clients       integer,
  max_produits      integer,
  max_emails_mois   integer,
  max_imports_mois  integer,
  max_audits_mois   integer,
  max_analyses_image_mois integer,
  -- Unités d'IA pondérées par mois (voir `ai_action_weights`).
  ai_units_mois     integer,
  max_stockage_mo   integer,
  -- Coût de l'offre, en unité mineure (XOF = centimes).
  prix_minor        bigint NOT NULL DEFAULT 0,
  devise            text NOT NULL DEFAULT 'XOF',
  periode_jours     integer NOT NULL DEFAULT 30,
  -- Étiquetage commercial.
  libelle_prix      text,
  est_essai         boolean NOT NULL DEFAULT false,
  actif             boolean NOT NULL DEFAULT true,
  sort_order        integer NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_key, univers)
);

COMMENT ON TABLE public.plan_entitlements IS
  'Droits par plan et par univers. Les valeurs NULL signifient « non limité » ; l''interface doit l''écrire en toutes lettres, jamais « illimité » si une contrainte technique subsiste.';

-- ---------------------------------------------------------------------------
-- 2. Poids des actions IA (modifiables depuis l'admin)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ai_action_weights (
  action_key   text PRIMARY KEY,
  libelle      text NOT NULL,
  poids        integer NOT NULL CHECK (poids >= 0),
  description  text,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.ai_action_weights (action_key, libelle, poids, description) VALUES
  ('lecture',        'Lecture et analyse',            1,  'Lire des données, répondre à une question, expliquer une liste'),
  ('ecriture',       'Écriture réversible',           2,  'Créer un prospect, un client, une tâche, une note'),
  ('image',          'Analyse d''image',              5,  'Lire une photo de facture, un carnet, une capture d''écran'),
  ('email',          'Rédaction d''e-mail',           3,  'Composer une relance destinée à être envoyée'),
  ('audit_boutique', 'Audit de boutique en ligne',   20,  'Analyse complète d''un catalogue importé'),
  ('generation',     'Génération de contenu',         8,  'Script, hooks, scènes')
ON CONFLICT (action_key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. Compteurs d'usage par workspace et par période
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.usage_counters (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES saas_ugc.ugc_workspaces (id) ON DELETE CASCADE,
  plan_key      text NOT NULL,
  -- Premier jour de la période courante. Une période dure `periode_jours`.
  periode_debut date NOT NULL,
  periode_fin   date NOT NULL,
  prospects     integer NOT NULL DEFAULT 0,
  clients       integer NOT NULL DEFAULT 0,
  produits      integer NOT NULL DEFAULT 0,
  emails        integer NOT NULL DEFAULT 0,
  imports       integer NOT NULL DEFAULT 0,
  audits        integer NOT NULL DEFAULT 0,
  analyses_image integer NOT NULL DEFAULT 0,
  ai_units      integer NOT NULL DEFAULT 0,
  stockage_octets bigint NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, periode_debut)
);

CREATE INDEX IF NOT EXISTS usage_counters_workspace_idx
  ON public.usage_counters (workspace_id, periode_debut DESC);

COMMENT ON TABLE public.usage_counters IS
  'Compteurs d''usage par workspace et par période. Mis à jour uniquement par les fonctions SECURITY DEFINER ci-dessous : un client ne peut pas s''auto-créditer.';

ALTER TABLE public.usage_counters ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS usage_counters_lecture_membre ON public.usage_counters;
CREATE POLICY usage_counters_lecture_membre
  ON public.usage_counters FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM saas_ugc.ugc_workspace_members m
      WHERE m.workspace_id = usage_counters.workspace_id AND m.user_id = auth.uid()
    )
  );

-- Aucune politique d'écriture : seules les fonctions SECURITY DEFINER écrivent.

-- ---------------------------------------------------------------------------
-- 4. Journal des événements de quota (traçabilité et recours)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.quota_events (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id  uuid NOT NULL,
  action        text NOT NULL,
  quantite      integer NOT NULL,
  autorise      boolean NOT NULL,
  -- Valeur du compteur après l'opération, et limite appliquée. Permet de
  -- répondre à « pourquoi ça a bloqué ? » sans reconstituer l'historique.
  valeur_apres  integer,
  limite        integer,
  detail        jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS quota_events_workspace_idx
  ON public.quota_events (workspace_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 5. Période courante : créée à la demande, jamais supposée
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.quota_periode_courante(p_workspace_id uuid)
RETURNS public.usage_counters
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_plan_key   text;
  v_periode    integer;
  v_debut      date;
  v_ligne      public.usage_counters;
BEGIN
  -- Plan actif du workspace : abonnement Studio s'il existe, sinon le plan
  -- gratuit. On ne prend jamais le plan « le plus favorable » : une erreur de
  -- données ne doit pas offrir un plan payant gratuitement.
  SELECT s.plan_key INTO v_plan_key
  FROM saas_ugc.ugc_subscriptions s
  WHERE s.workspace_id = p_workspace_id
    AND s.status IN ('active', 'trialing')
  ORDER BY s.created_at DESC
  LIMIT 1;

  IF v_plan_key IS NULL THEN
    v_plan_key := 'free';
  END IF;

  SELECT COALESCE(pe.periode_jours, 30) INTO v_periode
  FROM public.plan_entitlements pe
  WHERE pe.plan_key = v_plan_key
  ORDER BY (pe.univers = 'commun') DESC
  LIMIT 1;

  v_periode := COALESCE(v_periode, 30);

  -- Période glissante alignée sur le premier jour d'usage, pas sur le mois civil :
  -- un client qui s'inscrit le 28 n'est pas pénalisé deux jours plus tard.
  SELECT uc.* INTO v_ligne
  FROM public.usage_counters uc
  WHERE uc.workspace_id = p_workspace_id
    AND uc.periode_fin >= current_date
  ORDER BY uc.periode_debut DESC
  LIMIT 1;

  IF v_ligne.id IS NOT NULL THEN
    RETURN v_ligne;
  END IF;

  v_debut := current_date;
  INSERT INTO public.usage_counters (workspace_id, plan_key, periode_debut, periode_fin)
  VALUES (p_workspace_id, v_plan_key, v_debut, v_debut + (v_periode - 1))
  RETURNING * INTO v_ligne;

  RETURN v_ligne;
END;
$$;

REVOKE ALL ON FUNCTION public.quota_periode_courante(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.quota_periode_courante(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- 6. La fonction centrale : consommer N unités ou refuser
-- ---------------------------------------------------------------------------
-- Renvoie toujours un objet lisible par l'interface :
--   { "autorise": bool, "utilise": n, "limite": m|null, "restant": r|null,
--     "periode_fin": date, "plan": "...", "raison": "quota_atteint"|null }
-- L'interface n'a donc jamais à deviner pourquoi une action est bloquée.
CREATE OR REPLACE FUNCTION public.quota_consommer(
  p_workspace_id uuid,
  p_action       text,
  p_quantite     integer DEFAULT 1
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_uid        uuid := auth.uid();
  v_membre     boolean;
  v_periode    public.usage_counters;
  v_droits     public.plan_entitlements;
  v_poids      integer;
  v_unites     integer;
  v_limite     integer;
  v_utilise    integer;
  v_colonne    text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'authentification requise' USING ERRCODE = '42501';
  END IF;
  IF p_quantite IS NULL OR p_quantite < 1 OR p_quantite > 10000 THEN
    RAISE EXCEPTION 'quantité invalide' USING ERRCODE = '22023';
  END IF;

  -- Isolation : on ne consomme que dans un workspace dont on est membre.
  SELECT EXISTS (
    SELECT 1 FROM saas_ugc.ugc_workspace_members m
    WHERE m.workspace_id = p_workspace_id AND m.user_id = v_uid
  ) INTO v_membre;
  IF NOT v_membre THEN
    RAISE EXCEPTION 'workspace non accessible' USING ERRCODE = '42501';
  END IF;

  -- Verrou de ligne : deux appels simultanés ne peuvent pas dépasser ensemble
  -- la limite (c'est le défaut classique d'un compteur lu puis écrit).
  PERFORM pg_advisory_xact_lock(hashtextextended('quota:' || p_workspace_id::text, 0));

  v_periode := public.quota_periode_courante(p_workspace_id);

  SELECT * INTO v_droits
  FROM public.plan_entitlements pe
  WHERE pe.plan_key = v_periode.plan_key
  ORDER BY (pe.univers = 'commun') DESC
  LIMIT 1;

  -- L'action détermine la colonne et, pour l'IA, le poids en unités.
  CASE p_action
    WHEN 'prospect'        THEN v_colonne := 'prospects';
    WHEN 'client'          THEN v_colonne := 'clients';
    WHEN 'produit'         THEN v_colonne := 'produits';
    WHEN 'email'           THEN v_colonne := 'emails';
    WHEN 'import'          THEN v_colonne := 'imports';
    WHEN 'audit'           THEN v_colonne := 'audits';
    WHEN 'analyse_image'   THEN v_colonne := 'analyses_image';
    WHEN 'ia_lecture'      THEN v_colonne := 'ai_units';
    WHEN 'ia_ecriture'     THEN v_colonne := 'ai_units';
    WHEN 'ia_email'        THEN v_colonne := 'ai_units';
    WHEN 'ia_image'        THEN v_colonne := 'ai_units';
    WHEN 'ia_audit'        THEN v_colonne := 'ai_units';
    WHEN 'ia_generation'   THEN v_colonne := 'ai_units';
    ELSE RAISE EXCEPTION 'action de quota inconnue : %', p_action USING ERRCODE = '22023';
  END CASE;

  IF v_colonne = 'ai_units' THEN
    SELECT w.poids INTO v_poids
    FROM public.ai_action_weights w
    WHERE w.action_key = CASE p_action
      WHEN 'ia_lecture' THEN 'lecture'
      WHEN 'ia_ecriture' THEN 'ecriture'
      WHEN 'ia_email' THEN 'email'
      WHEN 'ia_image' THEN 'image'
      WHEN 'ia_audit' THEN 'audit_boutique'
      WHEN 'ia_generation' THEN 'generation'
    END;
    v_poids := COALESCE(v_poids, 1);
    v_unites := p_quantite * v_poids;
  ELSE
    v_unites := p_quantite;
  END IF;

  -- Limite associée.
  v_limite := CASE v_colonne
    WHEN 'prospects'      THEN v_droits.max_prospects
    WHEN 'clients'        THEN v_droits.max_clients
    WHEN 'produits'       THEN v_droits.max_produits
    WHEN 'emails'         THEN v_droits.max_emails_mois
    WHEN 'imports'        THEN v_droits.max_imports_mois
    WHEN 'audits'         THEN v_droits.max_audits_mois
    WHEN 'analyses_image' THEN v_droits.max_analyses_image_mois
    WHEN 'ai_units'       THEN v_droits.ai_units_mois
  END;

  v_utilise := CASE v_colonne
    WHEN 'prospects'      THEN v_periode.prospects
    WHEN 'clients'        THEN v_periode.clients
    WHEN 'produits'       THEN v_periode.produits
    WHEN 'emails'         THEN v_periode.emails
    WHEN 'imports'        THEN v_periode.imports
    WHEN 'audits'         THEN v_periode.audits
    WHEN 'analyses_image' THEN v_periode.analyses_image
    WHEN 'ai_units'       THEN v_periode.ai_units
  END;

  -- Refus : on journalise et on renvoie un objet explicite.
  IF v_limite IS NOT NULL AND (v_utilise + v_unites) > v_limite THEN
    INSERT INTO public.quota_events (workspace_id, action, quantite, autorise, valeur_apres, limite)
    VALUES (p_workspace_id, p_action, v_unites, false, v_utilise, v_limite);

    RETURN jsonb_build_object(
      'autorise', false,
      'utilise', v_utilise,
      'limite', v_limite,
      'restant', GREATEST(v_limite - v_utilise, 0),
      'periode_fin', v_periode.periode_fin,
      'plan', v_periode.plan_key,
      'raison', 'quota_atteint'
    );
  END IF;

  -- Consommation, dans une seule mise à jour.
  EXECUTE format(
    'UPDATE public.usage_counters SET %I = %I + $1, updated_at = now() WHERE id = $2 RETURNING %I',
    v_colonne, v_colonne, v_colonne
  ) INTO v_utilise USING v_unites, v_periode.id;

  INSERT INTO public.quota_events (workspace_id, action, quantite, autorise, valeur_apres, limite)
  VALUES (p_workspace_id, p_action, v_unites, true, v_utilise, v_limite);

  RETURN jsonb_build_object(
    'autorise', true,
    'utilise', v_utilise,
    'limite', v_limite,
    'restant', CASE WHEN v_limite IS NULL THEN NULL ELSE GREATEST(v_limite - v_utilise, 0) END,
    'periode_fin', v_periode.periode_fin,
    'plan', v_periode.plan_key,
    'raison', NULL
  );
END;
$$;

REVOKE ALL ON FUNCTION public.quota_consommer(uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.quota_consommer(uuid, text, integer) TO authenticated;

-- ---------------------------------------------------------------------------
-- 7. Lecture de l'état des quotas (pour l'affichage et les messages de blocage)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.quota_etat(p_workspace_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_membre  boolean;
  v_periode public.usage_counters;
  v_droits  public.plan_entitlements;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'authentification requise' USING ERRCODE = '42501';
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM saas_ugc.ugc_workspace_members m
    WHERE m.workspace_id = p_workspace_id AND m.user_id = v_uid
  ) INTO v_membre;
  IF NOT v_membre THEN
    RAISE EXCEPTION 'workspace non accessible' USING ERRCODE = '42501';
  END IF;

  v_periode := public.quota_periode_courante(p_workspace_id);
  SELECT * INTO v_droits FROM public.plan_entitlements pe
  WHERE pe.plan_key = v_periode.plan_key ORDER BY (pe.univers = 'commun') DESC LIMIT 1;

  RETURN jsonb_build_object(
    'plan', v_periode.plan_key,
    'periode_debut', v_periode.periode_debut,
    'periode_fin', v_periode.periode_fin,
    'compteurs', jsonb_build_object(
      'prospects', jsonb_build_object('utilise', v_periode.prospects, 'limite', v_droits.max_prospects),
      'clients', jsonb_build_object('utilise', v_periode.clients, 'limite', v_droits.max_clients),
      'produits', jsonb_build_object('utilise', v_periode.produits, 'limite', v_droits.max_produits),
      'emails', jsonb_build_object('utilise', v_periode.emails, 'limite', v_droits.max_emails_mois),
      'imports', jsonb_build_object('utilise', v_periode.imports, 'limite', v_droits.max_imports_mois),
      'audits', jsonb_build_object('utilise', v_periode.audits, 'limite', v_droits.max_audits_mois),
      'analyses_image', jsonb_build_object('utilise', v_periode.analyses_image, 'limite', v_droits.max_analyses_image_mois),
      'ai_units', jsonb_build_object('utilise', v_periode.ai_units, 'limite', v_droits.ai_units_mois),
      'stockage_octets', jsonb_build_object('utilise', v_periode.stockage_octets, 'limite', (v_droits.max_stockage_mo::bigint * 1048576))
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.quota_etat(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.quota_etat(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- 8. Plans de lancement : Starter / Professional / Business
-- ---------------------------------------------------------------------------
-- Aucun prix définitif : `prix_minor = 0` et `libelle_prix` porte « tarif de
-- lancement ». L'admin tranche plus tard, sans migration.
INSERT INTO public.plan_entitlements
  (plan_key, univers, max_prospects, max_clients, max_produits, max_emails_mois,
   max_imports_mois, max_audits_mois, max_analyses_image_mois, ai_units_mois,
   max_stockage_mo, prix_minor, libelle_prix, actif, sort_order)
VALUES
  ('starter_business', 'business', 200, 200, 100, 100, 2, 2, 20, 300, 500, 0, 'Tarif de lancement', true, 10),
  ('professional_business', 'business', 1000, 1000, 500, 600, 10, 10, 150, 2000, 2048, 0, 'Tarif de lancement', true, 20),
  ('business_business', 'business', NULL, NULL, NULL, 3000, 50, 50, 800, 12000, 10240, 0, 'Tarif de lancement', true, 30),
  ('essential_studio', 'studio', NULL, NULL, NULL, 100, 1, 1, 50, 200, 1024, 0, 'Tarif de lancement', true, 10),
  ('studio_studio', 'studio', NULL, NULL, NULL, 400, 3, 3, 200, 900, 5120, 0, 'Tarif de lancement', true, 20),
  ('pro_studio', 'studio', NULL, NULL, NULL, 2000, 20, 20, 1000, 5000, 20480, 0, 'Tarif de lancement', true, 30)
ON CONFLICT (plan_key, univers) DO NOTHING;

-- Le plan gratuit existant doit avoir des droits, sinon `quota_consommer` refuse
-- tout dès la première action : c'est le pire accueil possible.
INSERT INTO public.plan_entitlements
  (plan_key, univers, max_prospects, max_clients, max_produits, max_emails_mois,
   max_imports_mois, max_audits_mois, max_analyses_image_mois, ai_units_mois,
   max_stockage_mo, prix_minor, libelle_prix, est_essai, actif, sort_order)
VALUES
  ('free', 'commun', 30, 30, 20, 20, 1, 1, 3, 60, 200, 0, 'Gratuit', false, true, 0)
ON CONFLICT (plan_key, univers) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 9. Désinscription e-mail (exigence 0.4) — stockée ici car transverse
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.email_optouts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES saas_ugc.ugc_workspaces (id) ON DELETE CASCADE,
  email        text NOT NULL,
  motif        text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Une adresse ne peut être désinscrite qu'une fois par workspace. L'unicité
-- porte sur la forme normalisée : « Jean@X.com » et « jean@x.com » sont la même
-- personne, et un index fonctionnel est la seule façon correcte de l'exprimer.
CREATE UNIQUE INDEX IF NOT EXISTS email_optouts_uniq
  ON public.email_optouts (workspace_id, lower(email));

ALTER TABLE public.email_optouts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS email_optouts_membre ON public.email_optouts;
CREATE POLICY email_optouts_membre
  ON public.email_optouts FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM saas_ugc.ugc_workspace_members m
      WHERE m.workspace_id = email_optouts.workspace_id AND m.user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM saas_ugc.ugc_workspace_members m
      WHERE m.workspace_id = email_optouts.workspace_id AND m.user_id = auth.uid()
    )
  );

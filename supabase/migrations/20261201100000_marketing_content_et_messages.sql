-- VYORA — Phase 0/1 : contenu marketing piloté par l'admin.
--
-- Objectif : plus aucun texte de vente, message de bienvenue ou message du jour
-- en dur dans le code. Tout est semé ici, puis modifiable depuis l'admin.
--
-- Trois usages :
--   1. `marketing_content`       : landing, textes publics ;
--   2. `app_messages`            : messages DANS l'application (bienvenue, jour) ;
--   3. `app_message_deliveries`  : trace des messages délivrés (idempotence).

-- ---------------------------------------------------------------------------
-- 1. Contenu marketing
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.marketing_content (
  content_key    text PRIMARY KEY,
  content_value  text NOT NULL DEFAULT '',
  description    text,
  surface        text NOT NULL DEFAULT 'landing',
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid
);

COMMENT ON TABLE public.marketing_content IS
  'Textes publics (landing, aide). Lecture anonyme autorisée : ce sont des contenus de vitrine, sans aucune donnée personnelle.';

ALTER TABLE public.marketing_content ENABLE ROW LEVEL SECURITY;

-- Lecture publique : la landing s'affiche même sans compte.
DROP POLICY IF EXISTS marketing_content_lecture_publique ON public.marketing_content;
CREATE POLICY marketing_content_lecture_publique
  ON public.marketing_content FOR SELECT
  TO anon, authenticated
  USING (true);

-- Écriture réservée aux administrateurs (rôle porté par saas_ugc.ugc_user_roles).
DROP POLICY IF EXISTS marketing_content_ecriture_admin ON public.marketing_content;
CREATE POLICY marketing_content_ecriture_admin
  ON public.marketing_content FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM saas_ugc.ugc_user_roles r
      WHERE r.user_id = auth.uid() AND r.role IN ('admin', 'owner')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM saas_ugc.ugc_user_roles r
      WHERE r.user_id = auth.uid() AND r.role IN ('admin', 'owner')
    )
  );

-- ---------------------------------------------------------------------------
-- 2. Messages dans l'application (bienvenue + message du jour)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.app_messages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 'bienvenue' = une fois par utilisateur et par espace ;
  -- 'jour'      = banque de messages quotidiens, aucune répétition sur 90 jours.
  kind          text NOT NULL CHECK (kind IN ('bienvenue', 'jour')),
  -- 'business' | 'studio' | 'commun'
  univers       text NOT NULL DEFAULT 'commun' CHECK (univers IN ('business', 'studio', 'commun')),
  -- Emplacement pour les messages de bienvenue : 'accueil' apparaît à l'ouverture.
  emplacement   text NOT NULL DEFAULT 'accueil',
  titre         text NOT NULL DEFAULT '',
  corps         text NOT NULL DEFAULT '',
  -- Action proposée : { "label": "...", "to": "/app/business" }
  action        jsonb,
  -- Ton et variants : permet d'avoir plusieurs accroches par message.
  actif         boolean NOT NULL DEFAULT true,
  -- Rotation : un message `jour` ne revient pas avant N jours.
  repetition_jours integer NOT NULL DEFAULT 90,
  -- Ordre stable de la banque quotidienne.
  rang          integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS app_messages_kind_univers_idx
  ON public.app_messages (kind, univers, actif);

COMMENT ON TABLE public.app_messages IS
  'Messages affichés DANS l''application. Aucun e-mail, aucune notification push : le message attend l''utilisateur.';

ALTER TABLE public.app_messages ENABLE ROW LEVEL SECURITY;

-- Un utilisateur connecté peut lire les messages : ils ne contiennent aucune
-- donnée d'un autre compte. La personnalisation (prénom, chiffres réels) est
-- faite côté serveur à la lecture, jamais stockée dans le contenu.
DROP POLICY IF EXISTS app_messages_lecture ON public.app_messages;
CREATE POLICY app_messages_lecture
  ON public.app_messages FOR SELECT
  TO authenticated
  USING (actif = true);

DROP POLICY IF EXISTS app_messages_admin ON public.app_messages;
CREATE POLICY app_messages_admin
  ON public.app_messages FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM saas_ugc.ugc_user_roles r
      WHERE r.user_id = auth.uid() AND r.role IN ('admin', 'owner')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM saas_ugc.ugc_user_roles r
      WHERE r.user_id = auth.uid() AND r.role IN ('admin', 'owner')
    )
  );

-- ---------------------------------------------------------------------------
-- 3. Trace de délivrance : garantit l'idempotence du message de bienvenue
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.app_message_deliveries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  message_id    uuid NOT NULL REFERENCES public.app_messages (id) ON DELETE CASCADE,
  univers       text NOT NULL,
  -- Une seule ligne possible par (user, message, univers) : c'est la garantie
  -- « une seule fois par utilisateur et par espace », portée par la base et non
  -- par le composant React.
  delivered_at  timestamptz NOT NULL DEFAULT now(),
  seen_at       timestamptz,
  dismissed_at  timestamptz,
  UNIQUE (user_id, message_id, univers)
);

CREATE INDEX IF NOT EXISTS app_message_deliveries_user_idx
  ON public.app_message_deliveries (user_id, delivered_at DESC);

ALTER TABLE public.app_message_deliveries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS app_message_deliveries_soi ON public.app_message_deliveries;
CREATE POLICY app_message_deliveries_soi
  ON public.app_message_deliveries FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS app_message_deliveries_ecriture_soi ON public.app_message_deliveries;
CREATE POLICY app_message_deliveries_ecriture_soi
  ON public.app_message_deliveries FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS app_message_deliveries_maj_soi ON public.app_message_deliveries;
CREATE POLICY app_message_deliveries_maj_soi
  ON public.app_message_deliveries FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 4. Seed : contenu de la landing
-- ---------------------------------------------------------------------------
INSERT INTO public.marketing_content (content_key, content_value, surface, description) VALUES
  ('landing.hero.surtitre', 'Business Grow · VYORA Studio', 'landing', 'Petite ligne au-dessus du titre'),
  ('landing.hero.titre', 'Récupérez l’argent qu’on vous doit, et les clients que vous oubliez.', 'landing', 'Titre principal'),
  ('landing.hero.sous_titre', 'VYORA relance vos clients à votre place, suit vos impayés et produit vos contenus vidéo. Un seul outil, deux espaces : gérer votre business, ou créer pour vos clients.', 'landing', 'Sous-titre'),
  ('landing.hero.cta_principal', 'Créer mon espace gratuit', 'landing', 'Bouton principal'),
  ('landing.hero.cta_secondaire', 'Voir une démonstration', 'landing', 'Bouton secondaire'),
  ('landing.hero.rassurance', 'Sans carte bancaire · Prêt en 2 minutes · En français', 'landing', 'Ligne de réassurance'),
  ('landing.probleme.titre', 'Ce qui vous coûte de l’argent, chaque semaine', 'landing', 'Titre de la section problème'),
  ('landing.probleme.item1.titre', 'Les relances oubliées', 'landing', 'Douleur 1'),
  ('landing.probleme.item1.texte', 'Un client devait payer vendredi. Vous y pensez lundi. Le devis dort dans un carnet ou dans WhatsApp, et personne ne le retrouve.', 'landing', 'Douleur 1 détail'),
  ('landing.probleme.item2.titre', 'Les dettes qui traînent', 'landing', 'Douleur 2'),
  ('landing.probleme.item2.texte', 'Vous savez que l’argent est dehors, mais pas combien exactement, ni chez qui, ni depuis quand.', 'landing', 'Douleur 2 détail'),
  ('landing.probleme.item3.titre', 'Le temps perdu à produire du contenu', 'landing', 'Douleur 3'),
  ('landing.probleme.item3.texte', 'Publier régulièrement demande des heures de montage que vous n’avez pas — et sans contenu, personne ne vous trouve.', 'landing', 'Douleur 3 détail'),
  ('landing.solution.titre', 'Deux espaces, un seul compte', 'landing', 'Titre solution'),
  ('landing.solution.texte', 'VYORA ne vous demande pas d’apprendre un logiciel compliqué. Vous parlez, l’assistant enregistre. Vous décrivez, le studio produit.', 'landing', 'Texte solution'),
  ('landing.etapes.titre', 'Comment ça marche', 'landing', 'Titre étapes'),
  ('landing.etapes.item1.titre', 'Vous parlez à l’assistant', 'landing', 'Étape 1'),
  ('landing.etapes.item1.texte', '« Relance mes clients qui n’ont pas payé. » L’assistant lit vos données, propose les messages, vous validez.', 'landing', 'Étape 1 détail'),
  ('landing.etapes.item2.titre', 'VYORA prépare, vous montrez', 'landing', 'Étape 2'),
  ('landing.etapes.item2.texte', 'Les relances partent, les tâches se créent, les factures se suivent. Rien ne s’envoie sans votre accord.', 'landing', 'Étape 2 détail'),
  ('landing.etapes.item3.titre', 'Vous voyez ce que ça rapporte', 'landing', 'Étape 3'),
  ('landing.etapes.item3.texte', 'Chaque semaine : combien récupéré, quels clients relancés, quels contenus produits.', 'landing', 'Étape 3 détail'),
  ('landing.tarifs.titre', 'Tarifs', 'landing', 'Titre tarifs'),
  ('landing.tarifs.sous_titre', 'Prix de lancement. Ils changent sans préavis, jamais sans vous prévenir.', 'landing', 'Sous-titre tarifs'),
  ('landing.tarifs.note', 'Paiement par Orange Money, Moov Money ou Mobi Cash. Crédits sans expiration.', 'landing', 'Note tarifs'),
  ('landing.faq.titre', 'Questions fréquentes', 'landing', 'Titre FAQ'),
  ('landing.cta_final.titre', 'Commencez par récupérer ce qu’on vous doit.', 'landing', 'Titre CTA final'),
  ('landing.cta_final.texte', 'Créez votre espace, entrez trois clients, et laissez VYORA vous dire qui relancer demain matin.', 'landing', 'Texte CTA final'),
  ('landing.cta_final.bouton', 'Créer mon espace', 'landing', 'Bouton CTA final'),
  ('landing.social.titre', 'Ils utilisent VYORA', 'landing', 'Titre preuve sociale'),
  -- Désactivé par défaut : aucun faux témoignage possible tant qu'il est à false.
  ('landing.social.actif', 'false', 'landing', 'Active la preuve sociale (à ne passer à true que si les témoignages sont réels)'),
  ('brand.nom', 'VYORA', 'global', 'Nom affiché'),
  ('brand.support_email', 'support@vyora.app', 'global', 'Adresse de support affichée'),
  ('brand.devise', 'Create. Evolve. Grow.', 'global', 'Devise de marque')
ON CONFLICT (content_key) DO NOTHING;

-- Le nom public était resté « Reelora » en base : on aligne sans supprimer
-- l'ancienne valeur, qui reste consultable dans les paramètres historiques.
UPDATE saas_ugc.ugc_app_settings
SET setting_value = jsonb_set(
      jsonb_set(coalesce(setting_value, '{}'::jsonb), '{name}', '"VYORA"', true),
      '{support_email}', '"support@vyora.app"', true
    )
WHERE setting_key = 'platform'
  AND setting_value->>'name' = 'Reelora';

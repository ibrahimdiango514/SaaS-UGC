-- Reelora v1 — initial, non-fake configuration data.

insert into saas_ugc.ugc_plans(plan_key, display_name, tagline, monthly_price_minor, currency, monthly_credits,
  max_projects, max_scripts_per_month, max_prompts_per_month, max_videos_per_month, max_avatars, features, sort_order)
values
 ('free', 'Découverte', 'Pour tester le studio UGC', 0, 'XOF', 9, 2, 5, 5, 1, 1,
  '["2 projets actifs","1 vidéo par mois","5 scripts IA par mois","1 avatar","Filigrane Reelora"]'::jsonb, 1),
 ('studio', 'Studio', 'Pour les créateurs réguliers', 1500000, 'XOF', 120, 15, 80, 60, 20, 5,
  '["15 projets actifs","20 vidéos par mois","80 scripts IA","5 avatars","Export HD sans filigrane","Bibliothèque illimitée"]'::jsonb, 2),
 ('pro', 'Pro', 'Pour les agences et marques', 4500000, 'XOF', 400, 60, 400, 300, 80, 20,
  '["60 projets actifs","80 vidéos par mois","400 scripts IA","20 avatars","Espace équipe","Support prioritaire"]'::jsonb, 3),
 ('enterprise', 'Entreprise', 'Volume et intégrations sur mesure', 0, 'XOF', 0, 500, 5000, 5000, 1000, 100,
  '["Quotas sur mesure","Intégrations API","Gestion multi-équipes","SLA dédié"]'::jsonb, 4)
on conflict (plan_key) do update set
  display_name = excluded.display_name, tagline = excluded.tagline,
  monthly_price_minor = excluded.monthly_price_minor, currency = excluded.currency,
  monthly_credits = excluded.monthly_credits, max_projects = excluded.max_projects,
  max_scripts_per_month = excluded.max_scripts_per_month, max_prompts_per_month = excluded.max_prompts_per_month,
  max_videos_per_month = excluded.max_videos_per_month, max_avatars = excluded.max_avatars,
  features = excluded.features, sort_order = excluded.sort_order, updated_at = now();

insert into saas_ugc.ugc_country_pricing(country_code, currency, min_amount_minor, max_amount_minor, credits_per_1000_minor, active)
values ('ML', 'XOF', 100000, 50000000, 0.2, true), ('FR', 'EUR', 500, 500000, 0.5, true)
on conflict (country_code) do update set
  currency = excluded.currency,
  min_amount_minor = excluded.min_amount_minor, max_amount_minor = excluded.max_amount_minor,
  credits_per_1000_minor = excluded.credits_per_1000_minor, active = excluded.active, updated_at = now();

update saas_ugc.ugc_service_catalog set
  active = true,
  config = coalesce(config, '{}'::jsonb) || '{"pricing_status":"active","provider_ready":true}'::jsonb,
  updated_at = now()
where service_key in ('script','ugc_clip_8s','ugc_clip_15s','ugc_ad_4clips','product_image','image_retouch','cutaway');

insert into saas_ugc.ugc_app_settings(setting_key, setting_value, description) values
 ('signup_bonus', '{"credits":9,"enabled":true}'::jsonb, 'Crédits offerts à chaque nouvelle inscription'),
 ('video_defaults', '{"provider":"heygen","duration_seconds":15,"aspect_ratio":"9:16","resolution":"1080p","captions":true,"voice_speed":1,"style":"ugc_naturel"}'::jsonb, 'Réglages vidéo proposés par défaut'),
 ('platform', '{"name":"Reelora","support_email":"support@reelora.app","language":"fr"}'::jsonb, 'Identité de la plateforme')
on conflict (setting_key) do update set setting_value = excluded.setting_value, description = excluded.description, updated_at = now();

insert into saas_ugc.ugc_prompt_templates(title, category, content, variables, is_system)
values
 ('Script UGC — accroche problème/solution', 'script',
  'Tu es un créateur UGC francophone. Rédige un script de {{duree}} secondes pour {{produit}} destiné à {{audience}} sur {{plateforme}}. Structure : accroche percutante (2 s), problème vécu, démonstration du produit, bénéfice concret, appel à l’action. Ton : {{ton}}. Interdiction d’inventer des chiffres, des certifications ou des allégations médicales. Réponds uniquement en JSON valide avec les clés : hook, script_text, call_to_action, marketing_angle, claims_to_avoid (tableau), scenes (tableau d’objets avec scene_type, duration_seconds, visual_prompt, spoken_text, subtitle_text).',
  '["duree","produit","audience","plateforme","ton"]'::jsonb, true),
 ('Script UGC — témoignage authentique', 'script',
  'Écris un script UGC de {{duree}} secondes sous forme de témoignage spontané à la première personne pour {{produit}}. Cible : {{audience}}. Plateau : {{plateforme}}. Ton : {{ton}}, naturel, sans jargon publicitaire. Commence par une accroche qui casse le scroll. Termine par un appel à l’action clair. Réponds uniquement en JSON valide avec les clés : hook, script_text, call_to_action, marketing_angle, claims_to_avoid, scenes (tableau d’objets scene_type, duration_seconds, visual_prompt, spoken_text, subtitle_text).',
  '["duree","produit","audience","plateforme","ton"]'::jsonb, true),
 ('Script UGC — démonstration produit', 'script',
  'Conçois un script de démonstration produit de {{duree}} secondes pour {{produit}} à destination de {{audience}} sur {{plateforme}}. Montre 3 bénéfices observables, sans promesse irréaliste. Ton : {{ton}}. Réponds uniquement en JSON valide avec les clés : hook, script_text, call_to_action, marketing_angle, claims_to_avoid, scenes (tableau d’objets scene_type, duration_seconds, visual_prompt, spoken_text, subtitle_text).',
  '["duree","produit","audience","plateforme","ton"]'::jsonb, true),
 ('Variantes d’accroches', 'hook',
  'Propose 5 accroches différentes (max 12 mots chacune) pour une vidéo UGC de {{produit}} ciblant {{audience}}. styles : question, constat, contraste, chiffre non inventé, curiosité. Réponds uniquement en JSON valide : {"hooks": ["..."]}.',
  '["produit","audience"]'::jsonb, true),
 ('Prompt visuel de scène', 'visual',
  'Décris en une phrase un plan visuel pour une vidéo UGC verticale 9:16. Produit : {{produit}}. Action : {{action}}. Ambiance : {{ambiance}}. Décris cadrage, lumière, geste et texte à l’écran. Pas de marque tierce. Réponds en texte brut.',
  '["produit","action","ambiance"]'::jsonb, true),
 ('Optimiseur de prompt', 'system',
  'Réécris le prompt suivant pour le rendre plus précis, structuré et exploitable par un modèle de génération de contenu UGC, en français, sans ajouter de faits inventés : {{prompt}}. Réponds uniquement en JSON valide : {"content": "...", "variables": ["..."]}.',
  '["prompt"]'::jsonb, true);

create unique index if not exists ugc_promo_codes_code_idx on saas_ugc.ugc_promo_codes(code);
insert into saas_ugc.ugc_promo_codes(code, bonus_credits, max_redemptions, per_user_limit, active)
values ('REELORA2026', 25, 500, 1, true)
on conflict (code) do nothing;

-- Initialise every existing auth user in the UGC schema (idempotent).
insert into saas_ugc.ugc_profiles(user_id, display_name)
select u.id, coalesce(u.raw_user_meta_data->>'full_name', split_part(u.email, '@', 1))
from auth.users u on conflict (user_id) do nothing;
insert into saas_ugc.ugc_wallets(user_id) select u.id from auth.users u on conflict (user_id) do nothing;
insert into saas_ugc.ugc_subscriptions(user_id, plan_key) select u.id, 'free' from auth.users u on conflict (user_id) do nothing;
insert into saas_ugc.ugc_user_roles(user_id, role) select u.id, 'user' from auth.users u on conflict (user_id, role) do nothing;

-- The project owner is the first platform administrator.
insert into saas_ugc.ugc_user_roles(user_id, role)
select u.id, 'admin' from auth.users u where lower(u.email) = 'ibrahimdiango514@gmail.com'
on conflict (user_id, role) do nothing;

notify pgrst, 'reload schema';

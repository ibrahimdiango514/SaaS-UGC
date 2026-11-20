# Increment 08 — publication progressive effective, 20 novembre 2026

## Livré et vérifié

PR36 fusionnée normalement après CI44670424263 verte : main
`25854eca3f9ccd9e18dae8ae4d482ba2e88e2233`.
CI : typechecks frontend/Edge, imports, parité des artefacts, 3189 tests et build.

Migration principale version **20261120035256**, nom studio_runtime. SQL récupéré
du commit4ab98ab via pg_net17900 HTTP200, SHA256
`5df15d716b5c5ffefd1a6860c179e01891eeb1b6a62644761a16f45dc4ea249a`
vérifié avant exécution transactionnelle. Fichier renommé au timestamp réellement
attribué par Supabase pour éviter une nouvelle application.

Artefact immuable publié (pg_net17901), SQL SHA256
`43804a46c524d5746445c2c9b6ac18e966f0c9b3be9d5a288f784b98aa41412f`.
`studio-runtime` **v1 ACTIVE**, verify_jwt=false : chaque action client vérifie le
JWT par Auth ; chaque action worker exige le jeton Vault existant en comparaison
constante. Ce réglage permet au cron serveur de ne pas transporter de JWT client.
Le chargeur vérifie avant exécution le SHA256 du bundle
`7721de42924dfa5cea2a9ed6c7f36b23b68a0be0ef982856dfcecde5e4eeccea`,
31710 caractères, 8 tranches. Les anciennes fonctions restent en place.

## Défaut détecté par la sonde réelle, corrigé

Premier worker HTTP409 : le CTE d’UPDATE était imbriqué dans une expression SQL,
ce que PostgreSQL interdit. Migration corrective **20261120035400** appliquée :
CTE au niveau supérieur avec SELECT INTO puis RETURN. Le test PGlite couvre
maintenant la prise d’une tâche et l’absence de seconde prise avant l’échéance.
Ce défaut n’a pas produit de génération : aucune tâche n’existait.

## Preuves HTTP production, sans coût fournisseur

- pg_net17911 : appel models sans JWT → **401 UNAUTHENTICATED**.
- pg_net17912 : worker poll authentifié par Vault → **200**, checked0/reconciled0.
- pg_net17913 : frontend Netlify principal → **200**, révision **25854ec** servie.
- pg_net17914 : sync publique → **200**, total861, added0/changed0/missing0.
- pg_net17915 : fiches officielles → **200**, attempted10/saved10.
- Cron installé/actif : poll chaque minute, catalogue toutes les6h, dix fiches
  toutes les5min. Les tâches cron ne soumettent jamais de génération.

Permissions réelles : anon SELECT jobs=false ; authenticated SELECT configs=false ;
authenticated attestation=false ; service_role attestation=true.
861 fiches, 415 vidéos historiques conservées, **0 configuration d’exécution,
0 accès fournisseur confirmé par modèle, 0 activé, 0 tâche universelle**.

## Sécurité ajoutée

- Réservation expirant après24h : restitution transactionnelle, idempotente,
  quota rendu ; état terminal expired. Une réussite tardive ne peut plus capturer
  de crédits. VYORA assume le coût tardif éventuel, pas le client.
- Réussite sans coût réel vérifiable : capture refusée ; réconciliation GET
  jusqu’à coût confirmé ou expiration. Jamais de coût réel inventé.
- Verrou dans la RPC quota historique elle-même : ancienne vidéo et universel
  partagent le même verrou sans changer les limites existantes.
- Accès disponible exigé dans l’assessment et dans la réservation SQL.
- Endpoint d’estimation explicitement attesté, jamais construit depuis l’ID.
- Sortie attendue figée sur la tâche ; pas de changement de parseur provoqué
  par une modification admin pendant son traitement.

## Limites actuelles — ne pas confondre déploiement et génération validée

L’interface, les fonctions, les tables et le suivi automatique sont déployés ;
**aucune génération universelle n’est déclarée opérationnelle**. Les861 modèles
restent en attente d’une combinaison de preuves de protocole/accès, tarification,
contraintes complètes et validation technique autorisée. Le catalogue complet
n’équivaut pas à861 adaptateurs validés.

Il manque notamment : preuves officielles des variantes de résultats et contraintes
conditionnelles, politique quota audio/autres, tests complets des formats média,
nettoyage Storage des imports orphelins et budget fournisseur global partagé avec
l’ancien moteur (le plafond universel est séparé). Ne pas ouvrir l’exécution globale
avant résolution. Aucun plafond ou prix client n’est inventé pour activer un modèle.

Pas de preuve de parcours navigateur avec session admin/client réelle : seules
permissions SQL, rejets anonymes, sync et worker à vide ont été mesurés en production.
Aucune génération payante, aucun débit/réservation réel, aucun achat.

## Fournisseurs et secrets

`MUAPI_API_KEY` existe déjà sur le principal. Sa présence ne prouve pas le droit
d’exécuter chaque modèle. Rien à demander dans le chat.

Les autres fournisseurs restent indépendants ; adaptateurs génériques LLM déjà
présents dans `_shared/ai-core`, pas raccordés au wallet Studio. Les noms ci-dessous
sont les **noms proposés pour le futur Studio**, pas des secrets déjà configurés :

| Fournisseur | Secret Studio à configurer dans Supabase / Edge Functions / Secrets | Fonction |
|---|---|---|
| OpenAI | STUDIO_OPENAI_API_KEY | Texte/multimodal, protocole à vérifier par modèle |
| Anthropic | STUDIO_ANTHROPIC_API_KEY | Messages, adaptateur natif existant à raccorder |
| Google | STUDIO_GEMINI_API_KEY | Gemini natif |
| Groq | STUDIO_GROQ_API_KEY | Texte compatible OpenAI |
| Mistral | STUDIO_MISTRAL_API_KEY | Texte compatible OpenAI |
| DeepSeek | STUDIO_DEEPSEEK_API_KEY | Texte compatible OpenAI |
| xAI | STUDIO_XAI_API_KEY | Texte compatible OpenAI |

Ne pas réutiliser silencieusement les secrets BUSINESS_GROW_* ni son wallet.
Le registre Business existant contient des entrées sans api_key_env ; les noms
proposés ci-dessus doivent être explicitement raccordés avant de demander ces clés.
Métadonnées seules inspectées, aucune valeur de clé récupérée.

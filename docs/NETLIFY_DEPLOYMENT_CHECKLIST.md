# Checklist de déploiement — nouveau site Netlify

> Procédure reproductible. **Rien n'est exécuté à la lecture de ce document.**
> Chaque case doit être cochée dans l'ordre : les étapes sont ordonnées pour
> qu'un échec arrive **avant** toute dépense de crédit.
>
> Vocabulaire : « la garde » = les deux rideaux décrits dans `netlify.toml`.
> État actuel : le dépôt est prêt ; **le nouveau site n'existe pas encore**.

---

## Étape 0 — Ce que je dois recevoir de vous

Rien ne peut être finalisé sans ces informations :

| # | Information | Utilisée pour |
| --- | --- | --- |
| 1 | **Nom du site** (ex. `sorahnex`) | `SITE_NAME` dans `netlify.site.conf` |
| 2 | **Site ID** (UUID du site) | `SITE_ID` dans `netlify.site.conf` |
| 3 | Origine complète | `VITE_SITE_URL`, CORS Supabase, `uri_allow_list` |
| 4 | Confirmation du compte Netlify utilisé | Vérifier qu'aucun site ne partage le pool de crédits |

Une fois ces quatre éléments fournis, la bascule est une **PR de deux lignes**.

---

## Étape 1 — Avant de toucher à Netlify (local, aucun crédit)

Tout ce qui suit ne consomme aucun crédit et ne dépend pas du nouveau site.

- [ ] **Arbre propre** : `git status --short` vide sur la branche de travail.
- [ ] **CI verte** sur la branche : `validate` + `verifier`.
- [ ] `npm ci` (installation reproductible).
- [ ] `npm run typecheck` → 0 erreur.
- [ ] `npm run typecheck:edge` → 0 erreur.
- [ ] `npm test` → tous les fichiers verts (dernier relevé : 230 fichiers / 4364 tests).
- [ ] `node scripts/build-studio-runtime.mjs --check` → artefact à jour.
- [ ] `node scripts/build-universal-validation.mjs --check` → à jour.
- [ ] `npm run check:edge-imports` → conforme.
- [ ] `npm run build` → build de production local réussi (c'est la même commande que Netlify).
- [ ] `sh scripts/netlify-ignore.sh` sans variable → **annule** (code 0), sans rien écrire.
- [ ] `sh scripts/netlify-build-guard.sh` sans variable → **refuse** (code 1), message explicite.

> Si l'un de ces points échoue, **s'arrêter ici**. Rien ne sert de créer un site
> qui ne pourra pas être publié.

---

## Étape 2 — Préparer le dépôt pour le nouveau site (PR, sans fusionner)

> ✅ **FAIT le 25 novembre 2026.** Le site autorisé est `2135cb38-c4ba-4be2-9392-4b75ff414364`
> (identité fournie par le propriétaire après recréation du site par Netlify).
> Le nom n'est **pas** contraint (`SITE_NAME_FACULTATIF=true`) : l'identifiant,
> unique et attribué par Netlify, fait foi. `vyora-saas-ugc` (`fc88d197-…`) est
> passé en `ANCIEN_SITE_ID` et reste refusé nommément.

- [ ] Pour un futur changement, remplacer les **deux** valeurs dans `netlify.site.conf` :

```sh
SITE_ID=<NOUVEAU_SITE_ID>
SITE_NAME=<nouveau-nom>
```

- [ ] Ce changement se fait **par PR** (jamais à la main dans l'interface Netlify :
      une valeur modifiée dans le tableau de bord ne serait pas revue).
- [ ] Et déplacer l'ancien identifiant sur `ANCIEN_SITE_ID`, avec son nom sur
      `ANCIEN_SITE_NAME` : un site quitté doit être **refusé explicitement**, pas
      simplement oublié. Oublier produit un message générique ; refuser produit
      la vraie raison dans le journal.

- [ ] Cas vécu le 25/11/2026, à connaître : `saas-ugc` a tenté un déploiement de
      production depuis `main` alors qu'il n'était pas encore déclaré. La garde a
      refusé (zéro crédit), mais le message accusait `VYORA_BUILD_ENABLED` — une
      variable, au lieu de l'identité. **C'est corrigé** : un site ni autorisé ni
      ancien est nommé, et le message renvoie au fichier d'identité. La leçon
      reste : quand un build est refusé, lire la ligne `Raison :` — elle dit
      désormais la vraie cause.
- [ ] Vérifier qu'aucune autre modification n'est nécessaire :
      `grep -rn "fc88d197\|vyora-saas-ugc" --include=*.toml --include=*.sh --include=*.conf .`
      → ne doit apparaître **que** dans des commentaires historiques.
- [ ] `npx vitest run tests/netlify-deployment-guard.test.ts` → vert.
      Le test « après remplacement de l'identité, le NOUVEAU site passe et
      l'ancien est refusé » couvre exactement ce changement.
- [ ] Ouvrir une PR. **Ne pas fusionner** tant que l'étape 4 n'est pas atteinte.

---

### Si le build est refusé alors que les trois variables sont déclarées

Cas vécu le 25/11/2026 : le site et les trois variables étaient bons, et le build
était quand même refusé. La cause était une **comparaison de valeur exacte**, et
elle était écrite *avant* les lignes que Netlify conserve dans son journal — donc
invisible dans l'extrait de 8 lignes.

Deux corrections ont été apportées à la garde :

1. **La raison est répétée en dernière ligne**, préfixée `À CORRIGER :`. C'est la
   seule partie qu'on est certain de voir quand Netlify tronque.
2. **Un diagnostic nomme le piège de saisie** quand la valeur est *presque*
   correcte : espace final, retour chariot d'un copier-coller Windows, majuscule,
   tiret oublié. La longueur en caractères est affichée pour lever le doute.

Le cas le plus fréquent, et le plus invisible : `sorahnex-deploy ` avec un espace
final. La valeur paraît juste à l'écran. La garde compare à l'identique — c'est
ce qui empêche de contourner le verrou en renommant — et le dit désormais.

**Ce qu'il ne faut surtout pas faire** : retirer la garde de `netlify.toml`
(`command = "npm ci && npm run build"`) pour « tester ». Cela supprimerait le
verrou de crédits sur le seul site de production, et un push publierait seul. Si
le refus persiste, lire la ligne `À CORRIGER` et corriger la variable.

---

## Étape 3 — Créer le site Netlify (aucune publication)

- [ ] Netlify › Add new site › **Import an existing project** › GitHub ›
      `ibrahimdiango514/SaaS-UGC`.
- [ ] **Branche de production** : `main`.
- [ ] Netlify lit `netlify.toml` : build command, publish `dist`, `ignore`,
      redirections et en-têtes — **ne rien saisir à la main** dans l'interface,
      cela écraserait le fichier.
- [ ] Enregistrer le **Site ID** et le **nom** pour l'étape 2.
- [ ] **Le premier déploiement automatique doit être ANNULÉ par la garde.**
      Vérifier dans le journal : `garde ignore: build annule (conditions non reunies)`.
      Attendu : `SITE_ID` ≠ celui encore inscrit dans `netlify.site.conf`, ou
      `VYORA_BUILD_ENABLED` absent. **Si un build part, s'arrêter immédiatement**
      et vérifier `netlify.site.conf`.

> Un build annulé par `ignore` ne consomme **aucun** crédit (comportement vérifié
> sur deux déploiements réels). C'est la raison d'être du rideau 1.

---

## Étape 4 — Variables du site (Site configuration → Environment variables)

Déclarer, **dans cet ordre**, sans encore autoriser la publication :

| # | Variable | Valeur | Portée |
| --- | --- | --- | --- |
| 1 | `VITE_SUPABASE_URL` | `https://xbuuhfwobrafcbgtdgjx.supabase.co` | Build |
| 2 | `VITE_SUPABASE_PUBLISHABLE_KEY` | clé `sb_publishable_…` du projet | Build |
| 3 | `VITE_SITE_URL` | `https://<nouveau-site>.netlify.app` | Build |
| 4 | `VYORA_BUILD_ENABLED` | `true` | Build + Runtime |

- [ ] Les quatre sont présentes et **exactes** (pas d'espace, pas de `/` final sur l'URL).
- [ ] **Ne pas encore** déclarer `SORAHNEX_DEPLOY_AUTHORIZED` ni son jeton.
- [ ] Constater qu'un nouveau déclenchement est **toujours annulé** : le verrou
      de crédits tient, même avec l'opt-in de build.

---

## Étape 5 — Supabase : Auth et CORS (aucun crédit Netlify)

À faire **avant** d'autoriser la publication, sinon le site publierait avec une
authentification cassée.

### 5.1 Auth (GoTrue)

- [ ] `site_url` = `https://<nouveau-site>.netlify.app`
- [ ] `uri_allow_list` : **reprendre toute la liste existante** et y ajouter
      `https://<nouveau-site>.netlify.app/**` ainsi que ses prévisualisations.
      ⚠️ `update_auth_config` exige la liste complète : une liste partielle
      **supprime** les entrées absentes (dont `localhost`, utilisées en développement).
- [ ] Vérifier après coup que `site_url` et la liste contiennent bien le nouveau
      domaine, **et** que l'ancien y est encore (transition).

### 5.2 CORS des Edge Functions

- [ ] `BUSINESS_GROW_ALLOWED_ORIGINS` : ajouter `https://<nouveau-site>.netlify.app`
- [ ] `VYORA_ALLOWED_ORIGINS` : idem
- [ ] `STORE_IMPORT_ALLOWED_ORIGINS` : idem
- [ ] `VYORA_PAYMENTS_ALLOWED_ORIGINS` : idem
- [ ] Conserver les anciennes origines jusqu'à ce que le nouveau site soit validé.

### 5.3 Secrets — état à confirmer, pas à modifier sans décision

- [ ] `MUAPI_API_KEY` présent (Studio).
- [ ] `FREE_LLM_API_KEY` + `FREE_LLM_API_BASE_URL` présents (assistant Studio).
- [ ] `SASPAY_*` / `VYORA_SASPAY_*` présents (paiement).
- [ ] `VYORA_OAUTH_ENCRYPTION_KEY` présent (MCP/OAuth).
- [ ] **Décision explicite** : configurer ou non `BUSINESS_GROW_<FOURNISSEUR>_API_KEY`.
      Sans elle, l'assistant Grow ne génère pas de texte (tout le reste de Grow
      fonctionne). Ce n'est pas un défaut : c'est un choix à assumer.

---

## Étape 6 — Validation AVANT autorisation (le dernier point de contrôle)

C'est ici qu'on refuse de publier si quelque chose ne va pas.

- [ ] `netlify.site.conf` contient bien le **nouveau** `SITE_ID` et le **nouveau** `SITE_NAME`.
- [ ] La PR de l'étape 2 est **fusionnée dans `main`** (la garde ne lit que `main`).
- [ ] Simulation locale du déploiement, avec les valeurs réelles :

```sh
SITE_ID=<nouveau> SITE_NAME=<nouveau> BRANCH=main VYORA_BUILD_ENABLED=true \
SORAHNEX_DEPLOY_AUTHORIZED=true SORAHNEX_DEPLOY_AUTHORIZED_NAME=sorahnex-deploy \
sh scripts/netlify-build-guard.sh      # doit afficher « build autorisé »
```

- [ ] Puis **sans** les deux variables d'autorisation : doit **refuser** avec
      « AUTORISATION HUMAINE ABSENTE ».
- [ ] Le build local avec les variables `VITE_*` réelles produit un `dist/` valide
      (vérifier que `https://<nouveau-site>` apparaît dans le bundle généré).
- [ ] Décision prise sur les migrations Studio lot16/17 (voir §8) — **à trancher
      avant** si les quotas Studio doivent fonctionner dès la mise en ligne.

> **Ne pas continuer** si un point ci-dessus échoue.

---

## Étape 7 — Autoriser et publier (le seul moment qui coûte des crédits)

Coût : **15 crédits** pour un déploiement de production réussi. Vérifier le solde
du compte **avant**.

- [ ] Solde Netlify suffisant pour au moins un déploiement.
- [ ] Déclarer `SORAHNEX_DEPLOY_AUTHORIZED=true`.
- [ ] Déclarer `SORAHNEX_DEPLOY_AUTHORIZED_NAME=sorahnex-deploy`.
- [ ] Déclencher **un seul** déploiement.
- [ ] Surveiller le journal : `GARDE NETLIFY — build autorisé`.
- [ ] **Aussitôt le déploiement terminé, retirer les deux variables.** Le verrou
      se réarme ; un push ultérieur ne publiera plus rien.
- [ ] Exécuter `docs/NETLIFY_POST_DEPLOY_SMOKE_TEST.md`.

---

## Étape 8 — Migrations Studio lot16/17 (décision séparée, non appliquées)

État vérifié sur la production le 2026-11-25 :

| Objet | Présent en production ? | Conséquence |
| --- | --- | --- |
| `studio_runtime_access`, `studio_runtime_models`, `studio_runtime_rate`, `studio_runtime_model`, `studio_runtime_issue_quote`, `studio_runtime_start`, `studio_runtime_finish`, `studio_runtime_expire`, `studio_catalog_admin_summary`, `reelora_consume_quota` | **Oui** | Parcours de génération fonctionnel |
| `studio_runtime_quotas` | **Non** | `action: 'quotas'` répond 409 `SUBSCRIPTION_REQUIRED` (message corrigé : il ne parle plus de « génération ») |
| `studio_runtime_plan_matrix` | **Non** | `StudioPlanMatrix.tsx` reste en erreur ; le reste du Studio dégrade proprement |
| `studio_set_plan_quota`, `studio_runtime_prepare`, `studio_runtime_prepare_batch`, `studio_runtime_readiness` | **Non** | Outils d'administration seulement |

**Pourquoi elles ne sont pas appliquées** : lot16 remplace
`public.reelora_consume_quota` et `public.studio_runtime_finish` — le chemin qui
débite un portefeuille client. Une erreur y facture deux fois, ou plus du tout.

**Ce qui est prouvé** (`tests/studio-lot16-17-database.test.ts`, base éphémère) :

- les trois migrations s'appliquent sans erreur sur le schéma réel ;
- lot16 **n'approuve aucune famille** de quota : l'ensemble approuvé reste
  `export, image, prompt, script, video`, et cinq familles gardent une limite
  **non approuvée** — c'est ce piège qui fait échouer la consommation en mode
  fermé au lieu de laisser passer un débit jamais arbitré ;
- proposer ou approuver une politique ne touche **aucun** centime ;
- une action externe, même confirmée, n'exécute rien et ne débite rien.

**Procédure de résolution, quand vous l'autoriserez** :

1. Sauvegarde de la base (Supabase › Database › Backups) et relevé des soldes
   de portefeuille.
2. Appliquer **lot16 seule**, puis rejouer la suite de tests DB locale.
3. Vérifier sur un compte de test : une génération débite exactement une fois ;
   un échec de génération rembourse ; un second appel avec la même clé ne
   débite pas deux fois.
4. Puis lot17 et actions externes, séparément.
5. Si un débit double apparaît : restaurer la sauvegarde de l'étape 1. Le
   rollback est la restauration, pas une migration inverse.

---

## Étape 9 — Après publication

- [ ] `docs/NETLIFY_POST_DEPLOY_SMOKE_TEST.md` entièrement coché.
- [ ] Retirer les anciennes origines des variables CORS (une fois le nouveau site
      validé) — sinon une origine morte reste autorisée indéfiniment.
- [ ] Décider du sort de l'ancien site Netlify : **ne pas le supprimer** avant
      d'avoir constaté que le nouveau fonctionne (retour arrière possible).

---

## Aide-mémoire : ce qui coûte un crédit, et ce qui n'en coûte pas

| Opération | Coût |
| --- | --- |
| Déploiement de production réussi | **15 crédits** |
| Deploy Preview de PR | 0 |
| Déploiement de branche | 0 |
| Build annulé par `ignore` | 0 |
| Build en échec | 0 |
| Rollback | 0 |
| Bande passante | 20 / Go |
| Requêtes | 2 / 10 000 |
| Compute des fonctions | 10 / Go-heure |

**Épuisement du pool = mise en pause de TOUS les sites de l'équipe.** C'est la
raison du verrou, pas une méfiance envers vous.

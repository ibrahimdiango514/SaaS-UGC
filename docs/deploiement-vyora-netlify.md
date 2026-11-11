# Déploiement VYORA — état réel et procédure

> Dernière vérification : 2026-11-11. Ce document décrit **uniquement des faits mesurés**
> (empreintes de build, statuts GitHub, config Supabase). Aucun déploiement n'est
> annoncé comme réussi tant qu'il n'est pas observé sur l'URL publique.

---

## 1. Production identifiée

| Élément | Valeur vérifiée |
| --- | --- |
| Dépôt GitHub | `ibrahimdiango514/SaaS-UGC` (public, branche par défaut `main`) |
| Branche de production | `main` |
| Commit de `main` | `36e80107f48690b0534e31233a15a6157489c94e` (merge PR #4) |
| Site Netlify | **`vyora-ugc`** → https://vyora-ugc.netlify.app |
| Commit réellement servi avant le merge | `068709cc0a5d5d231cad338dfca2ee47476bd612` |
| Ancien site Reelora | `saas-ugc-growth` → **supprimé** (« Site not found ») |

### Empreinte du build (méthode de preuve)

`vite` produit des noms de fichiers hachés et déterministes. Un build local du commit X
redonne exactement les mêmes noms qu'un déploiement Netlify du commit X.

| Build local | Fichier d'entrée | Servi par https://vyora-ugc.netlify.app |
| --- | --- | --- |
| `main` @ `068709c` | `assets/index-EkW74nqn.js` | **Oui** (200) |
| `main` @ `36e8010` (nouveau) | `assets/index-Bnv4Ju49.js` | **Non** (404) |

Conclusion : la production sert l'état `068709c` ; le nouveau commit n'est pas déployé.
`/api/business-grow` (edge function introduite par les nouveaux commits) renvoie 404,
ce qui confirme la même conclusion par un second chemin.

---

## 2. Ce qui a été fait

1. **Merge de la PR #4** (`arena/147ca0c8-saas-ugc` → `main`), état `CLEAN`.
   - Arbre du commit de merge **identique** à celui de la tête de PR : aucune
     modification perdue, aucun fichier supprimé.
   - Contenu intégré : moteur IA central multi-fournisseurs, routage Business Grow,
     contrats plateforme, relais Netlify, durcissement isolation des comptes,
     5 migrations Supabase, pagination et reprise sur erreur, lots de tests.
2. **Validation du commit de production** (`36e8010`) :
   - `npm ci && npm run build` → succès, 62 fichiers, `dist/` = 2,1 Mo.
   - `npm test` → **336 tests / 29 fichiers, tous verts**.
   - Aucun secret dans le bundle (seule la clé *publishable* Supabase, publique par conception).
3. **Audit secrets** : aucun `.env` suivi, `.gitignore` couvre `.env*`, `.netlify/`.
4. **Supabase** (projet `xbuuhfwobrafcbgtdgjx`) :
   - les 5 migrations `business_grow_*` sont **déjà appliquées** ;
   - la fonction Edge `business-grow` est **ACTIVE** ;
   - `site_url` et `uri_allow_list` mis à jour pour inclure
     `https://vyora-ugc.netlify.app` (les liens de confirmation e-mail fonctionnent).

---

## 3. Ce qui bloque le déploiement

Le site `vyora-ugc` **ne redéploie pas depuis GitHub** :

- aucun statut Netlify n'est apparu sur `main`@`36e8010` (contrairement aux branches de PR
  qui reçoivent `netlify/saas-ugc-growth/deploy-preview` en ~30 s) ;
- aucun webhook/build hook Netlify n'est configuré côté dépôt ;
- la production est restée figée sur `068709c`.

De plus, l'agent n'a **aucun accès Netlify** : pas de jeton API, pas de CLI authentifiée,
et aucun connecteur Netlify disponible. Le déclenchement doit donc se faire depuis le
compte Netlify du propriétaire.

---

## 4. Procédure recommandée (rapide) — déploiement manuel

Un artefact prêt à publier est fourni : `vyora-dist-36e8010.zip` (build de `36e8010`).

1. Ouvrir le site **`vyora-ugc`** dans https://app.netlify.com (pas `saas-ugc-growth`).
2. Onglet **Deploys** → **Deploy manually** → glisser-déposer le contenu de `dist/`
   (ou le zip).
3. Attendre l'état `Published`.

> Limite : le déploiement manuel ne publie pas les **edge functions** Netlify.
> Le front en production interroge directement la fonction Supabase `business-grow`
> (déjà déployée), donc l'application reste fonctionnelle. Le relais
> `/api/business-grow` ne sert qu'aux Deploy Previews.

## 5. Procédure pérenne — relier le site à GitHub

Dans **Site configuration → Build & deploy** :

| Champ | Valeur |
| --- | --- |
| Repository | `ibrahimdiango514/SaaS-UGC` |
| Production branch | `main` |
| Build command | `npm ci && npm run build` (déjà dans `netlify.toml`) |
| Publish directory | `dist` |
| Functions directory | `netlify/edge-functions` + `netlify/functions` |
| Node version | `22` |

Variables d'environnement (noms seulement — facultatives, des valeurs par défaut
publiques existent dans `src/lib/supabase.ts`) :

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`
- `VITE_SITE_URL` = `https://vyora-ugc.netlify.app`

Vérifier ensuite que le déploiement **`main@36e8010`** passe en `Published`
(et non en Deploy Preview).

## 6. Vérification post-déploiement (à refaire après publication)

1. `https://vyora-ugc.netlify.app/assets/index-Bnv4Ju49.js` → **200** (et non 404).
2. `https://vyora-ugc.netlify.app/api/business-grow` → n'est plus une 404 de SPA.
3. L'URL `/app/business` affiche l'espace Business Grow.
4. Onglet Deploys : commit affiché = `36e8010`, contexte **production**.

---

## 7. Points restants

- **Marque** : le code ne contient **aucune occurrence de « VYORA »** (0), tout est
  encore libellé « Reelora » (titre, meta description, textes). Le nom `vyora` n'existe
  que dans le sous-domaine Netlify. Un renommage de marque reste à décider.
- **Nommage** : `package.json` porte encore `"name": "reelora"`.
- **Collision de nom** : `vyora.netlify.app` appartient à un tiers (site « CIVICBOND ») ;
  ne pas compter sur ce sous-domaine.

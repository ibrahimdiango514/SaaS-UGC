# VYORA — Continuité Business Grow ↔ Studio UGC (itération 2026-11-11, soir)

Cette itération prolonge le déploiement réussi de `business-grow` en production.
Elle **ne modifie aucune migration, aucune clé, aucun prix, aucun crédit** et ne
touche pas à la logique de quota.

## 1. Navigation continue Business Grow ↔ Studio UGC (priorité 2)

### Ce qui existait
- `BusinessGrowEntryIntent` (contrat typé) permettait à Dashboard / Projets
  d'ouvrir Business Grow avec un projet et un brouillon.
- Le Studio savait recevoir un brief via `ugcBrief` (`BuildStudioLocationState`)
  et le préchargeait dans le prompt.

### Ce qui manquait réellement
1. **Studio → Business Grow** : aucune entrée. Depuis la création vidéo, il était
   impossible de repartir vers l'analyse/stratégie en conservant le projet,
   le produit, le brief et le script.
2. **Ancrage profond** : `GrowthWorkspace` démarrait toujours sur l'onglet
   « Vue d'ensemble », même quand la navigation demandait la stratégie ou le CRM.
3. **Boucle catalogue** : un produit réel du catalogue n'avait aucun chemin
   direct vers la création vidéo correspondante.
4. **Retour** : le brief transféré ne conservait pas l'identifiant du produit /
   du projet, donc le Studio ne pouvait pas sélectionner le bon projet.

### Implémentation
- `src/contracts/business-grow.ts`
  - `buildBusinessGrowLocationStateFromStudio(context, options)` : construit
    l'état de navigation Studio → Business Grow à partir de **données réelles
    uniquement** (projet, marque, produit, objectif, audience, brief, script).
    Le brouillon de conversation est borné à 4 000 caractères.
  - `BusinessGrowGrowthTab` + champ `growthTab` validé dans
    `BusinessGrowEntryIntent` (aucun onglet arbitraire accepté).
  - `BusinessGrowUgcHandoffBrief` enrichi de `productId`, `projectId`,
    `projectTitle`, `platform` — **UUID strictement validés** (`optionalUuid`),
    toute valeur non-UUID est ignorée au lieu d'être propagée.
- `src/studio/GenerationStudio.tsx`
  - Carte « Continuité Business Grow » avec le contexte réellement disponible
    et lien vers `/app/business` (état typé, `growthTab: 'strategy'`).
  - Le projet transmis par un brief est désormais sélectionné à l'arrivée
    (`?projet=` reste prioritaire), et le repli ne remplace plus un projet
    valide par le premier de la liste.
- `src/business/BusinessGrowWorkspace.tsx` : transmet `growthTab` au cockpit.
- `src/business/growth/GrowthWorkspace.tsx` : prop `initialTab`, appliquée une
  fois à l'arrivée — l'utilisateur reprend ensuite la main.
- `src/business/growth/GrowthPanels.tsx` : chaque produit du catalogue expose
  « Créer la vidéo UGC de ce produit » avec son identifiant réel.

Aucun crédit n'est consommé par ces transferts : ils ne font que naviguer.

## 2. Correctif réel de fiabilité : expiration des contrôles fournisseur

### Diagnostic live (production `xbuuhfwobrafcbgtdgjx`, 2026-11-11 22:59 UTC)
`{action:'status'}` a renvoyé :

| Fournisseur | `config_status` | `checked_at` | État exposé |
|---|---|---|---|
| Groq | `configured` | `2026-11-11T21:46:34Z` (1 h 13) | `available`, `enabled: true` |
| Gemini | `configured` | `2026-11-10T18:55:21Z` (**> 24 h**) | `unverified`, `enabled: false` |

`saas_business.bg_select_route` exige un contrôle `healthy` de **moins de 24 h**
pour le fournisseur *et* le modèle. Conséquence réelle : le secours automatique
Groq → Gemini est déjà cassé aujourd'hui, et si Groq expire à son tour
(`2026-11-12T21:46Z`), **tous** les envois échoueront en `NO_VERIFIED_PROVIDER`
sans qu'aucun écran ne l'explique.

### Correctif appliqué (frontend uniquement, aucun déploiement requis)
- `providersNeedingVerification(statuses, now)` : fonction pure exportée qui
  identifie les fournisseurs configurés dont le contrôle est absent ou
  vieux de plus de 24 h (MuAPI et fournisseurs non configurés exclus).
- Bannière `business-stale-providers` :
  - tous les services périmés → « Aucune réponse ne sera simulée… »
    avec accès direct à l'écran Services IA ;
  - secours partiellement périmé → « Le secours automatique est dégradé… »
    (avertissement neutre, sans dramatiser puisqu'un service reste opérationnel).
- Message d'erreur `NO_VERIFIED_PROVIDER` remplacé par une consigne actionnable :
  ouvrir « Services IA » → « Vérifier la connexion », en précisant que le
  message est conservé et qu'aucun crédit n'a été débité.

**Choix explicite : aucun sondage automatique côté navigateur.** Un premier
essai de vérification automatique a été retiré : il déclenchait des appels
fournisseur non sollicités (et deux requêtes concurrentes), ce qui contredit la
règle « aucune opération simulée ou implicite ». La vérification reste une
action explicite de l'utilisateur ; seule la *détection* est automatique.

### Ce qui reste à décider (non appliqué)
Un job `pg_cron` (par ex. toutes les 12 h) appelant
`business-grow {action:'providers.verify'}` pour chaque fournisseur configuré
supprimerait la classe entière de panne. Cela nécessite une **migration SQL** et
un jeton d'invocation : **non appliqué**, en attente de validation.

## 3. Priorité 3 (import multi-images / vidéo de référence) — blocage backend identifié

Le Studio sait déjà téléverser une image de référence (`uploadReferenceImage`,
bucket privé `ugc-assets`, URL signée au moment de la soumission) et la base
catalogue expose bien les modèles multi-images (`images_list`, `image_urls`) et
vidéo (`video_url`, `input_video`).

Le blocage est **côté serveur** dans `supabase/functions/reelora-video/index.ts` :
- `SUPPORTED_REQUIRED_FIELDS = new Set(["prompt", "image_url"])` ;
- `buildMuapiBody()` ne transmet que `prompt`, `image_url`, `last_image` et les
  paramètres scalaires — `images_list`, `image_urls`, `video_url`, `input_video`
  ne sont **jamais** envoyés à MuAPI.

Ouvrir l'import multi-images côté navigateur produirait donc des jobs qui
échouent (`UNSUPPORTED_INPUT`) ou, pire, une UI qui laisse croire à une capacité
inexistante. La modification nécessaire touche le chemin de facturation
(`pricingParameters` + devis signé) : elle est **volontairement non appliquée**
et nécessite une validation explicite.

## 4. Vérifications techniques de cette itération

| Vérification | Résultat |
|---|---|
| `npx tsc --noEmit -p tsconfig.json` | 0 erreur |
| `npx vitest run` | **42 fichiers · 447 tests ✓** |
| `npm run build` | ✓ (bundle `BusinessGrow` 136,95 kB / 34,87 kB gzip) |
| `npm run check:edge-imports` | conforme (aucune modification Edge) |
| Tests ajoutés | `tests/business-continuity.test.ts` (8), `tests/business-provider-staleness.test.tsx` (8) |

Aucune Edge Function n'a été redéployée : les changements sont exclusivement
frontend + contrats partagés.

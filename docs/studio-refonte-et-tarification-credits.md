# Studio VYORA — refonte immersive et tarification par crédits

> Rapport de livraison · branche `arena/323bad30-saas-ugc`
> Commit `9327e4d` (précédé de `e4d1007`), base `ff49e4e`, `main` inchangée à `1a572be`.
> Aucun déploiement Netlify, aucune fusion dans `main`, aucune migration exécutée
> en production, aucun paiement, aucune génération IA payante.

---

## 1. Ce qui a été livré

### 1.1 Canvas immersif du Studio (`/app/studio`)

La page suit désormais la référence fournie : un canvas noir plein écran, une
navigation par catégories en haut, un hero centré avec carrousel d'exemples, et
**une seule barre de prompt dockée en bas**.

| Élément | Avant | Après |
| --- | --- | --- |
| Coque applicative | barre latérale 252 px + en-tête 64 px visibles | masquées sur `/app/studio`, remplacées par le canvas |
| Navigation | barre latérale verticale | onglets horizontaux : Vidéo, Image, Audio Studio, Lip Sync, Montage, Mes créations |
| Zone centrale | cartes d'état empilées, textes explicatifs, liste permanente de modèles | hero + carrousel de 4 exemples, puis **rien d'autre** que le composer |
| Barre de prompt | bloc en flux, sous le contenu | dockée en bas (`sticky bottom-0` + `mt-auto`), toujours atteignable |
| Plan de production | carte dépliée occupant le centre | `<details>` replié, résumé sur une ligne |
| Devis détaillé / paramètres / devis fournisseur | cartes dupliquées | `<details>` refermé dans une colonne latérale |
| Bandeau « Poursuivre dans Business Grow » | bandeau permanent | lien discret dans le pied de page |

Capacités réelles conservées et vérifiables dans le panneau « Explorer les
capacités vidéo » : catalogue MuAPI filtré (statut, catégorie, capacité, tri),
sélection de modèle, paramètres réellement déclarés (`param_schema ∩
input_fields`), import d'image de référence, mode texte→vidéo / image→vidéo /
avatar / script, durée / format / résolution, sous-titres, devis serveur et
confirmation explicite, timeline et éditeur, prévisualisation, historique.
Aucune commande décorative : les catégories sans moteur connecté sont
explicitement non cliquables.

### 1.2 Distinction honnête des catégories non intégrées

Les onglets annoncent désormais deux niveaux distincts :

- Image, Audio Studio → badge **« À venir »** (« Aucun modèle image intégré »,
  « Aucun moteur audio / TTS connecté ») ;
- Lip Sync → badge **« Démo »** (la capacité existe côté fournisseur mais n'est
  pas exécutable sans source audio produite par VYORA).

### 1.3 Anomalies d'interface corrigées pendant la vérification visuelle

| Anomalie constatée sur capture | Cause | Correction |
| --- | --- | --- |
| Erreur PostCSS `bg-[#050505]/92 does not exist` (page blanche) | opacité arbitraire invalide en `@apply` | `bg-[#050505]/[0.92]` |
| Composer collé sous le contenu au lieu du bas de l'écran | `.studio-canvas` n'était pas une colonne flex | `.studio-canvas` en `flex flex-col min-h-dvh`, nouvelle zone `.studio-stage` en `flex-1`, composer en `mt-auto` |
| `mt-3` annulait le `margin-top:auto` du composer | les utilitaires Tailwind sont émis après `@layer components` | la marge est portée uniquement par `.studio-composer-dock` quand le canvas est actif |
| Barre de prompt qui disparaissait derrière le footer | `overflow-hidden` + hauteur de canvas dépassée | `overflow-x-hidden` |
| Deuxième logo VYORA vide (barre de studio, panneau crédits) | `<linearGradient id="vyora-mark">` dupliqué | identifiant de dégradé unique par instance (`useId`) |
| Bouton « Générer » coupé sur mobile | ligne de paramètres et ligne d'action partagées | paramètres sur une ligne défilante, devis + bouton sur la ligne suivante |

---

## 2. Tarification Studio (inspirée de la grille Vizuely, sans la recopier)

### 2.1 Grille effectivement appliquée

| Pack | Prix | Crédits | Prix au crédit | Avantage |
| --- | --- | --- | --- | --- |
| Creator | **5 000 FCFA** | 27 | 185,19 FCFA | référence |
| Pro Creator (recommandé) | **15 000 FCFA** | 95 | 157,89 FCFA | ≈ 15 % de moins |
| Studio Business | **35 000 FCFA** | 265 | 132,08 FCFA | ≈ 29 % de moins |

Paramètres serveur (`ugc_app_settings.studio_pricing_config`) :
`usd_to_xof = 620`, `credit_value_xof = 100`, `target_margin_percent = 60`,
`processing_cost_usd = 0.01`, recharge libre 5 000 → 350 000 FCFA par pas de
1 000. Ces prix n'ont pas été modifiés.

La page `/app/credits` couvre : packs et prix affichés avant achat, prix au
crédit et avantage progressif, pack recommandé, recharge personnalisée bornée,
historique des recharges, mouvements de crédits, et un encart de périmètre
rappelant que ces crédits ne concernent **que le Studio**.

### 2.2 Autorité serveur

- `studio_purchase_pack(p_pack_key, p_provider, p_idempotency_key)` : le
  navigateur ne transmet **qu'une clé de pack**. Le prix, le nombre de crédits et
  le prix au crédit sont relus dans la configuration, recalculés, puis **figés**
  sur `saas_ugc.ugc_credit_purchases` (avec `config_updated_at`) : une
  modification ultérieure de la grille ne réécrit jamais un achat passé.
- Aucun paiement simulé : la commande est créée en `pending`, les crédits ne
  sont accordés qu'après confirmation administrateur (`ugc_confirm_recharge`).
- `studio_credit_grid()` et `studio_credit_history()` sont en lecture seule,
  `revoke` sur `public`/`anon`.
- `studio_admin_set_credit_grid(jsonb)` est réservé aux administrateurs vérifiés
  (`ugc_private.reelora_assert_admin()`) et audité (`set_studio_credit_grid`).
- Garde-fous de configuration : `invalid_pack_values`, `invalid_credit_value`,
  `packs_required`, `pack_ladder_not_degressive`, `unknown_pack`,
  `studio_pricing_not_configured`.

### 2.3 Calcul des crédits (exclusivement serveur)

```text
crédits = ceil( ((coût_fournisseur_usd + coût_traitement_usd + Σ coûts_annexes_usd)
                × usd_to_xof × (1 + marge_cible/100)) / valeur_crédit_xof )
```

- Minimum 1 crédit ; jamais 0 ; refus des valeurs `NaN` ou négatives.
- Un paramètre manquant renvoie `null` : l'opération est **bloquée**, aucun coût
  n'est supposé. Exemple testé : `(0,10 + 0,01) × 620 × 1,6 = 109,12 → 2 crédits`.
- Le client n'expose plus aucun calcul : `GenerationStudio` consomme le devis
  (`estimateVideo`) et `creditSummary()` ; le montant débité n'est jamais fourni
  par le navigateur.

### 2.4 Parcours de bout en bout

sélection → devis serveur → affichage du prix avant génération → réservation
atomique (`reelora_start_generation`, clé d'idempotence par opération) →
exécution → capture en cas de succès / restitution en cas d'échec ou
d'annulation → mouvement de ledger → aucune double facturation (la reprise d'une
même clé renvoie la même tâche).

### 2.5 Aucun coût inventé

Les exemples de la page crédits sont stockés avec `approx_credits = null` tant
qu'ils n'ont pas été observés sur des générations réelles ; l'interface affiche
alors « Coût calculé à la demande » au lieu d'un chiffre supposé.

---

## 3. Séparation Studio / Business Grow

| | Studio | Business Grow |
| --- | --- | --- |
| Schéma | `saas_ugc.*` | `saas_business.*` |
| Portefeuille | `ugc_credit_ledger`, `ugc_credit_purchases` | portefeuille Business Grow |
| Grille | `studio_pricing_config` | sa propre grille |
| Marge | 60 % (cible Studio) | 95 % |
| Facturation | packs / recharge libre Studio | abonnements Business Grow |

Vérifications automatisées (`tests/studio-pricing.test.ts`) : la migration ne
référence aucune table `saas_business`, aucun calcul Studio n'est importé depuis
`src/business`, et la marge de 95 % n'est jamais réutilisée. Le lien vers
Business Grow reste un simple transfert de brief (aucun crédit Studio consommé).

---

## 4. Fournisseurs et routage

- Intégrations et routage existants préservés : Groq (priorité 1) et Gemini
  (repli), 7 rôles × 2 routes, bascule automatique.
- `reelora-video` conserve le catalogue MuAPI, le devis fournisseur et la
  passerelle de génération ; le moteur de crédits a été généralisé, sans changer
  les appels fournisseur.
- OpenRouter reste **prévu sans fausse intégration** : aucun appel n'est simulé.
- Fournisseurs LLM (Groq/Gemini) et fournisseurs vidéo/image (MuAPI) ne sont pas
  confondus dans le calcul.

### Blocages fournisseurs toujours en vigueur (non contournés)

1. **Plafond fournisseur à 0 USD** : toute génération vidéo payante reste
   refusée côté serveur. Aucune n'a été lancée.
2. **Clé MuAPI non validée** auprès du fournisseur ; le secret est présent.
3. **Tarification vidéo non configurée en production** : la migration de la
   grille Studio n'a pas été appliquée (pas d'autorisation). Tant qu'elle ne
   l'est pas, `/app/credits` affiche un état d'erreur explicite et aucune
   commande ne peut être créée.
4. **`video-quote` v4 / `reelora-video` v10** sont déployés en production, mais
   le corps déployé peut différer du workspace tant qu'un déploiement n'est pas
   autorisé : le code du moteur de crédits généralisé n'est donc **pas** en
   production.

---

## 5. Tests et commandes (résultats réels)

| Commande | Résultat |
| --- | --- |
| `npx tsc -b --pretty false` | **0 erreur** |
| `npx vitest run` | **44 fichiers / 478 tests — tous verts** |
| `npx vitest run tests/studio-pricing.test.ts` | **21 tests — tous verts** |
| `npm run check:edge-imports` | « Imports relatifs conformes au bundler Deno » |
| `npm run build` | **build réussi** (4,77 s, `dist/` généré) |
| `git diff --check` | **aucune erreur d'espacement** |
| `git status --porcelain` | **propre** après commits |

Couverture des tests de crédits (`tests/studio-pricing.test.ts`) : formule
nominale, arrondi supérieur, refus de deviner (paramètre manquant), refus des
valeurs négatives/`NaN`, coûts annexes, jamais 0 crédit, dégressivité des packs,
prix au crédit, interdiction du calcul client (aucun `credits_cost` calculé dans
`GenerationStudio`), isolation des schémas, garde-fous des RPC, statut `pending`.

Régression détectée et corrigée pendant la refonte : le libellé « coût en
crédits à confirmer » avait été déplacé hors de `studio-credit-summary`, ce qui
cassait `tests/studio-phase2.test.tsx`. Le message a été réintégré dans cet
élément (et non le test affaibli).

---

## 6. Preview navigateur réelle

URL locale : **http://127.0.0.1:4180** — `npm run dev -- --port 4180 --strictPort`
(Vite 6.4.5, processus `vyora-studio-4180-f2718d97`, pid 15652, rattaché à la
session courante). Les serveurs orphelins des sessions précédentes (5173, 5174)
sont arrêtés ; un seul serveur de développement tourne.

Captures reproductibles dans `preview-studio/` :

| Fichier | Contenu |
| --- | --- |
| `01-studio-desktop.png` | canvas immersif, nav catégories, hero + carrousel, composer docké |
| `02-studio-devis-desktop.png` | prompt saisi, devis en crédits avant génération |
| `03-studio-modeles-desktop.png` | panneau catalogue / filtres / paramètres réels / coût |
| `04-credits-desktop.png` | page crédits : packs, prix au crédit, recharge, historique |
| `05-studio-mobile.png` | Studio mobile 390×844 |
| `06-credits-mobile-haut.png` | crédits mobile — packs |
| `07-credits-mobile-bas.png` | crédits mobile — recharge, historique, périmètre |

`preview-studio/verification.json` : **5/5 interactions vérifiées**, 0 erreur de
page, 6 erreurs console — toutes des polices Google Fonts injoignables depuis le
bac à sable.

### Nature exacte de la preview

Le bac à sable n'a **aucun accès réseau** à Supabase, MuAPI ou aux polices
Google, et aucun navigateur système (le CDN Playwright est également bloqué). La
preview a donc été réalisée avec un Chromium distribué par npm
(`@sparticuz/chromium`) et `puppeteer-core`, installés **hors** des dépendances
du projet, et un harnais (`scripts/studio-preview.mjs`) qui **intercepte le
réseau du navigateur** : session de démonstration, RPC et Edge Functions
simulées côté client.

Conséquences, à ne pas surestimer :

- ✅ rendu, responsive, interactions et états d'erreur réels de l'interface ;
- ❌ aucune valeur réelle en base (solde, devis fournisseur, catalogue MuAPI) ;
- ❌ aucune écriture Supabase : toutes les requêtes mutantes sont annulées ;
- ❌ aucun paiement, aucune réservation, aucune génération IA déclenchée ;
- **aucun code de démonstration n'est livré dans `src/`** : le harnais et les
  données simulées vivent uniquement dans `scripts/` et `preview-studio/`.

Pour une preview authentifiée réelle, il suffit de renseigner `.env.local`
(`VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`) et de se connecter ; le
harnais n'est alors pas nécessaire.

---

## 7. Fichiers modifiés / ajoutés

Ajoutés :
`src/pages/StudioPricing.tsx`, `supabase/migrations/20261112040000_studio_credit_grid.sql`,
`tests/studio-pricing.test.ts`, `scripts/studio-preview.mjs`, `preview-studio/`
(captures + README + verification.json), `docs/etat-depot-git-reprise-vscode.md`.

Modifiés : `src/App.tsx` (route `/app/credits`), `src/components/Layout.tsx`
(canvas), `src/components/Brand.tsx` (dégradé unique), `src/index.css` (coque
immersive, composer docké), `src/studio/GenerationStudio.tsx` (plan replié,
footer compact), `src/studio/components/PromptBar.tsx` (dock + responsive),
`src/studio/components/GenerationEmptyState.tsx` (hero), `src/studio/components/StudioTopBar.tsx`
(nav catégories, sortie vers l'espace de travail), `supabase/functions/reelora-video/index.ts`
(moteur de crédits généralisé), `package.json` (`preview:studio`), `README.md`.

---

## 8. État Git et GitHub

| | Valeur |
| --- | --- |
| Branche | `arena/323bad30-saas-ugc` |
| HEAD | `9327e4d616331910a6a2d12457af6b54bf67b2cd` (`9327e4d`) |
| Commit précédent | `e4d1007` |
| Base de branche | `ff49e4e` |
| `main` | `1a572be` — **inchangée** |
| Worktree | propre |
| Statut PR | PR #6 **ouverte**, non fusionnée |
| Déploiement | **aucun** (Netlify interdit par consigne) |

Aucun `git push` n'a été effectué pendant cette session : conformément à la
consigne, le travail reste en commits locaux tant qu'un risque de déploiement de
production ne peut pas être exclu. `netlify.toml` ne définit pas de build
automatique par branche, mais un push sur une branche suivie par Netlify peut
déclencher un build : la décision de pousser revient au propriétaire du dépôt.

---

## 9. Reste à faire (hors périmètre autorisé de cette session)

1. **Appliquer la migration** `20261112040000_studio_credit_grid.sql` — action
   irréversible sur la production, non autorisée ici.
2. **Déployer** `reelora-video` pour que le moteur de crédits généralisé soit
   actif en production (le corps déployé est actuellement antérieur).
3. **Configurer les coûts fournisseur réels** et lever le plafond à 0 USD, avec
   autorisation explicite, pour rendre la génération payante possible.
4. **Renseigner les exemples de la grille** (`approx_credits`) après mesure de
   générations réelles — le code ne les invente pas.
5. **Preview authentifiée** avec une vraie session Supabase, sur une machine
   ayant accès au réseau.
6. **Décider du push / de la fusion de la PR #6**.

# Edge Function `store-import` — import de catalogue par URL

Date : 2026-11-14 · Branche `arena/bfcedd89-saas-ugc` · Commits `85e6c21`, `8fcbc35`, `326c7ac`, `d5d4f96`

---

## 1. Le problème, en une phrase

Le panneau d'import de Business Grow savait lire un fichier CSV/XLSX/XML, mais pas
une URL de boutique : le navigateur ne peut ni résoudre le DNS ni garantir que
l'adresse **contrôlée** est bien l'adresse **contactée**. Ce second point est la
faille SSRF classique (DNS rebinding), et il ne se règle pas côté client.

## 2. Ce qui a été construit

| Couche | Fichier | Rôle |
| --- | --- | --- |
| Connexion épinglée | `supabase/functions/store-import/pinned-fetch.ts` | Ouvre le TCP **sur l'IP validée**, puis `startTls` avec le nom d'origine (SNI + certificat). HTTP/1.1 bornée, `chunked` décodé. |
| Sortie réseau sûre | `supabase/functions/store-import/safe-egress.ts` | Re-résout et revalide à **chaque saut** ; redirections jamais suivies à l'aveugle ; borne le nombre de sauts. Fournit `pinnedFetchLike`, un `FetchLike` standard. |
| Logique métier | `supabase/functions/store-import/handler.ts` | Authentification, autorisation d'entreprise, aperçu sans écriture, confirmation à usage unique. Pur : testable sans réseau ni base. |
| Point d'entrée | `supabase/functions/store-import/index.ts` | Branche GoTrue, `bg_can_workspace`, lecture des produits existants, insertion. |
| Client | `src/business/importer/relay.ts` | `previewStore` / `importStore` via `invokeEdge`. **Aucune** requête directe vers la boutique. |
| Interface | `src/business/importer/StoreImportPanel.tsx` | Champ URL, aperçu, confirmation, expiration, refus affichés tels quels. |

### Le point technique décisif

`fetch()` refait sa propre résolution DNS au moment de se connecter. Vérifier les
adresses avec `Deno.resolveDns` puis appeler `fetch` laisse une fenêtre de
rebinding : le nom peut renvoyer une autre adresse à la seconde résolution.

`Deno.connectTls` ne permet pas de dissocier l'IP contactée du nom validé (pas
d'option `serverName`). La solution retenue :

```ts
const tcp = await Deno.connect({ hostname: ip, port: 443 }); // ip = littéral déjà validé
const tls = await Deno.startTls(tcp, { hostname });          // SNI + certificat sur l'hôte
```

L'IP littérale n'est jamais résolue par Deno ; le certificat reste vérifié contre
l'hôte demandé. `unsafelyDisableHostnameVerification` n'est **jamais** utilisé.

## 3. Ce qui a été réutilisé, sans duplication

Aucune deuxième logique de validation n'a été créée :

- `parseStoreUrl`, `assertPublicAddresses`, `explainRejection`, `storeRootCandidates` (`url-guard.ts`) — mêmes règles qu'avant : HTTPS seul, port 443, hôte littéral refusé, `.local` refusé, plages privées/réservées, IPv4 mappée en IPv6, NAT64, multicast, fail-closed.
- `probeStore`, `fetchPublicCatalog`, `detectPlatform`, `normalizeCatalog` — le pipeline exact du client ; seule la sortie réseau est remplacée par `pinnedFetchLike`.
- `bg_can_workspace` / `bg_require_workspace` — l'autorisation d'entreprise existait déjà en base ; l'Edge Function l'appelle au lieu de refaire un contrôle.

## 4. Garanties vérifiées par test

| Garantie | Preuve |
| --- | --- |
| L'aperçu ne crée jamais de produit | `insertProducts` jamais appelé pendant `preview` (test d'intégration + test panneau) |
| Aucune écriture sans confirmation | `confirmed !== true` → 400 ; sans `previewId` → 400 ; aperçu d'autrui → 409 |
| Aperçu lié à l'utilisateur ET à l'entreprise | aperçu de A utilisé par B, ou dans une autre entreprise → 409 |
| Aperçu à usage unique et expirant | rejeu → 409 ; après 10 min → 409 |
| Isolation entre entreprises | `WORKSPACE_ACCESS_DENIED` avant toute lecture réseau ; rôle lecture seule refusé |
| Refus SSRF | localhost, `10/8`, `172.16/12`, `192.168/16`, `169.254.169.254`, `::1`, `fd00::/8`, `fe80::/10`, `::ffff:127.0.0.1`, `::ffff:7f00:1` |
| DNS multi-adresses | **une seule** adresse privée suffit à refuser le nom |
| Rebinding entre deux sauts | la 2ᵉ résolution privée est refusée **avant** connexion |
| Redirection vers les métadonnées | une seule connexion, vers l'adresse publique |
| Réponse trop lourde / trop lente | refus explicite (`too_large`, `timeout`) — **jamais** de troncature silencieuse |
| Aucun secret transmis | la requête sortante ne porte ni JWT ni clé (test dédié) |
| Pas de repli vers `fetch` | si `Deno.connect`/`startTls` manquent : refus, aucun appel réseau implicite |
| Réutilisation du code client | extensions `.ts` ajoutées aux imports partagés (Deno l'exige) ; 118 tests du pipeline client restent verts |

## 5. Exécution réelle (pas seulement des mocks)

`scripts/store-import-live-check.ts`, lancé dans **Deno 2.9.6 réel** contre de vrais
serveurs :

```
✔ résolution DNS + validation — github.com → 48.200.82.112
✔ connexion épinglée + TLS vérifié — IP 48.200.82.112 · HTTP 200 · 525173 octets
⛔ refus localhost — Cette adresse pointe vers un réseau privé : import refusé.
⛔ refus métadonnées cloud — Cette adresse pointe vers un réseau privé : import refusé.
⛔ refus IPv4 mappée en IPv6 — Cette adresse pointe vers un réseau privé : import refusé.
⛔ refus d'une redirection vers les métadonnées — une seule connexion, vers l'adresse publique
✔ aperçu sur un hôte non marchand — page trop volumineuse refusée explicitement (413)

7/7 contrôles conformes.
```

Cela prouve la chaîne complète **DNS → IP validée → connexion sur cette IP → TLS
vérifié au nom d'origine → HTTP réel**, et les refus.

### Trois défauts trouvés par cette exécution (et corrigés)

1. **Imports sans extension** dans `src/business/importer/*.ts` : Deno refuse
   (`Module not found … add a '.ts' extension`). Les Edge Functions bundlent ce
   dossier : 12 imports corrigés, 118 tests du pipeline toujours verts.
2. **Diagnostic faux** : `boundedGet` rapportait « boutique injoignable » pour
   *tout* refus du `fetch` épinglé (taille, SSRF, certificat). Les codes sont
   maintenant traduits ; un refus de taille donne `too_large`, pas « injoignable ».
3. **Prix faux en XOF (facteur 100)** — trouvé en écrivant les tests de l'Edge
   Function : `parsePriceMinor('12000.00', 'XOF')` renvoyait `1 200 000`, la branche
   décimale supposant `exponent > 0`. Corrigé (cas dédié, arrondi à l'unité) et
   couvert par `tests/importer-price-minor.test.ts` (14 tests, XOF et EUR).

> Une tentative de **troncature** des pages trop lourdes a été essayée puis
> **retirée** : « refuser une réponse trop volumineuse » est une exigence explicite,
> déjà couverte par deux tests de sécurité. Tronquer aurait affaibli la règle.

## 6. Mesures

| Mesure | Résultat |
| --- | --- |
| `npx tsc -b` | 0 erreur |
| `npx vitest run` | **1688 passent / 1 échec préexistant** (`tests/business-modules.test.tsx:84`, « calcule les fuites de revenus ») |
| `npm run build` | OK — `BusinessGrow-Uvlje2h4.js` 193.35 kB |
| Tests ajoutés | 40 (épinglage/SSRF) + 30 (Edge Function) + 14 (prix) + 9 (parcours URL) + 2 (panneau) = **95** |
| Contrôle réel Deno | **7/7** |

## 7. Limites restantes — à lire avant de promettre quoi que ce soit

1. **Aucun import réel d'une boutique marchande n'a encore été exécuté.** Le bac à
   sable de développement n'autorise que quelques hôtes sortants ; les boutiques de
   test sont hors de cette liste. Ce qui *est* prouvé : la chaîne réseau complète
   contre un vrai serveur (github.com), et les refus. Ce qui *reste à faire* : la
   même exécution **après déploiement** de la fonction, sur une boutique de test
   autorisée. Tant que ce n'est pas fait, aucun statut « import par URL prouvé en
   production » ne doit être affiché.
2. **La fonction n'est pas déployée.** Aucun `supabase functions deploy` n'a été
   lancé : cela exige une autorisation explicite et touche un projet partagé.
3. **Secret `STORE_IMPORT_DATABASE_URL` à définir** (ou réutiliser
   `BUSINESS_GROW_DATABASE_URL`) avant le premier appel réel.
4. **Aperçus stockés en mémoire.** Deux instances Edge ne partagent pas la carte :
   un utilisateur peut recevoir `PREVIEW_EXPIRED` et relancer l'aperçu. Aucun
   import n'a lieu à l'aveugle — c'est un désagrément, pas un risque. Un stockage
   en base (table dédiée, TTL) est la suite logique.
5. **Une page d'accueil au-delà de 256 Kio est refusée.** Décision assumée
   (exigence « refuser les réponses trop volumineuses »), mais elle rend l'import
   URL inopérant sur des boutiques très lourdes. Alternative honnête déjà affichée :
   export CSV/XLSX.
6. **`implemented = true` n'a été passé nulle part.** Aucune sonde ou connexion
   réelle à une plateforme n'a réussi : les 26 fournisseurs restent à 0.

## 8. Netlify — diagnostic fondé sur des preuves

Ce qui est **mesuré** (API GitHub, `d5d4f96` = HEAD poussé) :

```
commits/{sha}/check-suites → 3 suites : netlify (queued), render (queued), cursor (queued)
commits/{sha}/check-suites → chaque suite : latest_check_runs_count = 0
commits/{sha}/check-runs   → total_count = 0
commits/{sha}/status       → { state: "pending", total: 0 }
commits/{sha}/deployments  → aucun
```

Et surtout : **c'est identique sur `main` (`cc43bb3`), `develop` (`6f0decd`) et la
branche de travail**. Le phénomène n'est donc **pas** propre à cette branche, et
l'hypothèse « app Netlify non installée » est **fausse** (trois suites existent,
créées par les apps). L'`ignore` de `netlify.toml` ne cite ni cette branche ni
`develop` : ce n'est pas la cause non plus.

Ce qui **ne peut pas être mesuré d'ici** : le jeton disponible est une intégration
GitHub sans les permissions nécessaires (`GET /installation/repositories` → 403
« Resource not accessible by integration »). Impossible donc de lire la
configuration Netlify du site (Deploy Previews activées ou non, dernier déploiement,
journal de build). **Aucune URL de preview n'est inventée ici.**

Piste la plus probable, cohérente avec les trois suites simultanées : le compte
GitHub a **trois apps d'aperçu installées** (Netlify, Render, Cursor) et aucune ne
parvient à créer de run ; c'est un état de compte/installation (apps réinstallées,
autorisation révoquée côté fournisseur, ou build jamais déclenché), pas un problème
de code du dépôt. Vérification qui trancherait, à faire par le propriétaire du
compte : ouvrir `app.netlify.com` → site → *Deploys* → *Deploy Previews* et lire le
dernier déploiement de branche ; si la liste est vide, réinstaller l'app Netlify sur
le dépôt et relancer un commit.

## 9. Prochaine étape

Déployer la fonction (autorisation requise), puis exécuter le même contrôle sur une
boutique de test autorisée — c'est la seule preuve qui manque pour retirer la limite
n° 1. Ensuite seulement, les connecteurs réels Notion / Google Drive / Shopify.

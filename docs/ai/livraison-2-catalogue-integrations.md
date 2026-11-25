# Livraison 2 — Catalogue SORAHNEX Integrations

**Branche** : `arena/bfcedd89-saas-ugc` · **Base** : `6f0decd` (`develop`)
**Route** : `/app/connect` (déclarée hors `<Layout />`, comme `/app/ai`)

---

## 1. Ce qui est livré

Un catalogue de **26 intégrations** réparties sur les quatre catégories demandées,
avec recherche, filtres, fiches détaillées, lecture des connexions réelles et
révocation.

| Catégorie | Nb | Fournisseurs |
|---|---|---|
| Réseaux sociaux | 6 | Instagram, Facebook, TikTok, YouTube, LinkedIn, Pinterest |
| Boutiques en ligne | 9 | Shopify, WooCommerce, Prestashop, Magento, OpenCart, Wix, BigCommerce, Squarespace, Ecwid |
| Productivité | 7 | Gmail, Google Drive, Google Calendar, Microsoft 365, Outlook, Slack, Notion |
| Business et commerce | 4 | HubSpot, Stripe, SASPay, Odoo |

Chaque fiche expose : nom, description, capacités (ce que la connexion
permettra), modes d'authentification, prérequis d'approbation externe,
configuration serveur requise, lien vers la documentation officielle et état
réel.

## 2. Le principe central : l'état ne peut pas mentir

C'est la contrainte « ne jamais simuler une connexion », traduite en code.

Le statut d'une fiche n'est **jamais stocké ni saisi**. Il est **calculé** par
`deriveStatus(entry, accounts, engineImplemented)` :

```
compte réel en base ?
 ├─ status = connected  → Connecté
 ├─ status = expired    → Connexion expirée
 ├─ status = revoked    → Accès révoqué
 └─ status = error      → Erreur de connexion
sinon
 ├─ aucun connecteur écrit (engine === null)
 │   ├─ approbation externe connue → Validation externe requise
 │   └─ sinon                      → Configuration requise
 └─ connecteur présent             → Non connecté
```

Conséquences vérifiables :

- Aucune fiche ne peut afficher « Connecté » sans ligne dans `oauth_accounts`.
- `canConnect()` renvoie `false` tant que `engine === null` : **aucun bouton
  actif trompeur**, et pas de bouton inerte non plus — le motif est affiché.
- Si la lecture échoue (RLS, réseau, jeton), la page rend une erreur explicite
  et **aucun état par défaut**.

### Permissions partielles

Un utilisateur peut n'accorder qu'une partie des scopes. La connexion reste
valide — elle n'est pas « en erreur » — mais `missingCapabilities()` liste ce
qui manque et la fiche marque ces lignes en ambre avec la mention
« non accordée par le compte ». Annoncer un droit non accordé serait la même
faute que simuler une connexion.

## 3. Le socle OAuth réellement déployé (vérifié en base)

Interrogation directe du projet Supabase — ce ne sont pas des suppositions :

- Tables : `public.oauth_accounts`, `public.oauth_audit_log`, `public.oauth_states`
- RPC exécutables par `authenticated` : `oauth_list_accounts()`,
  `oauth_audit_list(p_limit)`, `oauth_revoke_account(p_account_id)`
- `oauth_accounts` contient **0 ligne** : aucun compte n'est connecté aujourd'hui.

**Contrainte découverte et corrigée :**

```sql
CHECK (provider = ANY (ARRAY['gmail', 'google_drive', 'google_calendar']))
```

Le socle stocke un identifiant **par service Google**, pas un identifiant
Google unique. Une première version de mon code fusionnait les trois en `gmail`
— ce qui aurait affiché Gmail « connecté » alors que seul Drive l'était. La
normalisation ne fait plus que passer en minuscules et retirer les espaces.
Un test verrouille cette non-fusion.

Corollaire pour la Livraison 3 : le Integration Engine devra **étendre** cette
contrainte à de nouveaux fournisseurs par migration, et non contourner le
`CHECK` par un identifiant générique.

## 4. Architecture extensible

Ajouter un connecteur (Livraison 3) demande :

1. une entrée dans `catalog.ts` (`engine` passe de `null` à l'identifiant du
   connecteur) ;
2. une migration étendant la contrainte `provider` ;
3. un module implémentant l'interface de connecteur commun.

**Le catalogue n'est pas à reconstruire** : il est déclaratif et rend le moteur
par référence. `contracts.ts` (préexistant, 6 fournisseurs) est conservé pour
`Settings.tsx` et `BusinessGrowWorkspace.tsx` ; le nouveau catalogue ne le
remplace pas, il l'étend sur le volet « état + recherche ». L'unification des
deux contrats interviendra en Livraison 3, quand un vrai connecteur existera —
pas avant, pour ne pas casser ce qui fonctionne.

## 5. Fichiers

| Fichier | Statut | Rôle |
|---|---|---|
| `src/integrations/catalog.ts` | créé | Catalogue déclaratif, 26 entrées, recherche multi-champs |
| `src/integrations/connections.ts` | créé | Lecture réelle, dérivation d'état, révocation |
| `src/integrations/CatalogPage.tsx` | créé | Interface complète |
| `src/App.tsx` | modifié | Route `/app/connect` hors `Layout` + lazy import |
| `tests/integrations-catalog.test.tsx` | créé | 38 tests |

## 6. Vérifications

| Contrôle | Résultat |
|---|---|
| `npx tsc -b` | 0 erreur |
| `npm run build` | OK — `CatalogPage-BUdRfuMN.js` |
| `vitest tests/integrations-catalog.test.tsx` | **38 / 38** |
| Suite complète | **1219 passent, 1 échec préexistant** (`tests/business-modules.test.tsx:84`, déjà présent sur `develop`) |
| `/app/connect` servi en build de production | HTTP 200 |
| `/app/ai` non régressée | HTTP 200 |

## 7. Limitations assumées

- **Aucun connecteur n'est écrit.** Ce sont les Livraisons 3 et 7. Toutes les
  fiches affichent donc « Configuration requise » ou « Validation externe
  requise », jamais « Non connecté » — ce dernier laisserait croire qu'un clic
  suffit.
- **Aucun logo tiers.** Les vignettes sont des initiales sur dégradé par
  catégorie : pas d'images à licencer, pas d'appel réseau externe.
- **Le bouton « Connecter » n'existe pas encore.** Il apparaîtra en
  Livraison 3 ; il n'y a aujourd'hui qu'un bouton « Configurer » qui ouvre la
  fiche explicative.
- **Pas de preview Netlify.** L'intégration GitHub ↔ Netlify reste inactive :
  aucun commit de ce dépôt ne porte de statut Netlify (voir
  `docs/ai/previews-netlify.md`).

## 8. Suite

Livraison 3 — SORAHNEX Integration Engine : contrat de connecteur commun,
enregistrement déclaratif, jetons chiffrés côté serveur, journalisation,
révocation immédiate, ajout d'un connecteur sans toucher au moteur.

# Livraison — unification des intégrations et moteur d'intégration

**Date** : 2026-11-14 · **Branche** : `arena/bfcedd89-saas-ugc` (PR #8)
**Commits** : `ee62aec` (unification) · `6450f3d` (moteur)

---

## 1. Ce qui est livré

### a. Un seul catalogue pour deux écrans

Grow → Intégrations et `/app/connect` rendent le **même composant**
(`IntegrationsCenter`), depuis la **même source de vérité**. L'ancien
`IntegrationsView` (6 fournisseurs, rendu séparé) est supprimé.

Preuve dans le bundle : `dist/assets/BusinessGrow-*.js` importe
`CatalogPage-*.js`. Il n'existe pas de second catalogue compilé.

### b. Les 26 fournisseurs, avec un statut honnête

Le catalogue de 26 remplace le sous-ensemble de 6. Les huit états exigés sont
dérivés, jamais saisis :

| État | Origine |
|---|---|
| Connecté | compte OAuth réel, statut `connected` |
| Non connecté | connecteur écrit, aucun compte |
| Activation demandée | demande `pending` sans compte externe |
| Configuration requise | connecteur absent, identifiants SORAHNEX manquants |
| Validation externe requise | connecteur absent, approbation fournisseur requise |
| Autorisation manquante | ligne `connected` sans compte OAuth vérifié |
| Erreur de connexion | compte ou demande en erreur |
| État inconnu | lecture échouée — aucune action proposée |

### c. Le point le plus délicat

`saas_business.integration_connections` accepte `status = 'connected'` sur
simple demande de l'utilisateur (`bg_request_scoped_integration_connection`).
Ce champ, seul, ne prouve **aucune** autorisation fournisseur.

Décision : il n'affiche « Connecté » que corroboré par un compte dans
`oauth_accounts`. Sinon : **« Autorisation manquante »**. C'est un état de plus
que les huit demandés, assumé : le dissoudre dans « Connecté » serait le faux
état interdit, le dissoudre dans « Non connecté » effacerait une donnée réelle.

### d. Le moteur — contrat avant implémentation

| Fichier | Rôle | Tests |
|---|---|---|
| `engine/contract.ts` | forme des connecteurs, capacités fermées, erreurs normalisées | 12 |
| `engine/registry.ts` | refus des connecteurs mal formés, registre vide au départ | 10 |
| `engine/pkce.ts` | RFC 7636, state opaque, URL sans secret | 9 |
| `engine/tokens.ts` | échange, renouvellement, révocation | 16 |
| `engine/webhooks.ts` | HMAC, fenêtre anti-rejeu, déduplication | 9 |

**Registre global vide** : `implementedKeys()` renvoie `[]`. Les 26
fournisseurs sont donc non implémentés, vérifié par test. Aucun connecteur
n'est prétendu disponible.

---

## 2. Base de données

### Migration `20261114200000_integration_engine_providers.sql` — appliquée

- Crée `saas_business.integration_providers` : 26 fournisseurs, mode
  d'authentification, capacités, `implemented`.
- Remplace le `CHECK (provider IN ('gmail','google_drive','google_calendar'))`
  de `oauth_accounts` par une FK vers cette table. Les trois valeurs Google y
  figurent : aucune ligne existante ne casse.
- `implemented = false` pour les 26, **sans exception**.
- RLS : lecture seule pour `authenticated`, `INSERT/UPDATE/DELETE` révoqués.
- `bg_validate_connector_key` lit la table au lieu d'une liste codée en dur.

### Vérifications exécutées

```
fournisseurs = 26 · implémentés = 0 · comptes OAuth = 0
contraintes sur oauth_accounts.provider = oauth_accounts_provider_fk
bg_validate_connector_key('notion')            → 'notion'
bg_validate_connector_key('fournisseur-invente') → 22023 (refus)
```

Le second contrôle est un bloc `do $$ … $$` qui aurait levé
`ACCEPTE A TORT` si la clé passait : le refus est prouvé, pas supposé.

### Ce qui n'a pas bougé

`oauth_accounts` (colonnes, chiffrement AES-GCM, contraintes de capacité et de
statut), `oauth_states`, `oauth_audit_log`, `integration_connections`, et les
10 fonctions `oauth_*`. Aucune ligne lue, modifiée ou supprimée.

Privilèges vérifiés en base : les fonctions sensibles (`oauth_account_secret`,
`oauth_account_upsert`, `oauth_account_update_tokens`, `oauth_state_create`)
sont **inaccessibles à `anon` et `authenticated`**, réservées à `service_role`.

---

## 3. Mesures

| Contrôle | Résultat |
|---|---|
| `npx tsc -b` | **0 erreur** |
| `npx vitest run` | **1461 passent / 1 échec préexistant** |
| dont nouveaux | +19 unification, +56 moteur |
| `npm run build` | **OK** — `BusinessGrow-aYj8LImQ.js`, 172.01 kB |
| bundle | un seul `CatalogPage-*.js`, importé par Grow |

L'échec restant est `tests/business-modules.test.tsx:84`, présent avant ce
chantier et sans rapport avec les intégrations.

---

## 4. Sécurité

- **Aucun secret côté navigateur.** `credential_ref` n'est pas retourné par
  `bg_list_scoped_integration_connections` ; les jetons sont chiffrés par le
  socle et lisibles uniquement via `service_role`.
- **PKCE obligatoire.** Vérifieur de 32 octets, défi S256, refus des formes
  invalides avant tout appel réseau.
- **Aucun `client_secret` dans une URL.** `buildAuthorizeUrl` l'ignore même
  s'il est fourni ; testé explicitement.
- **Webhooks fail-closed.** Sans signature valide, hors fenêtre de 300 s ou sur
  un corps modifié : refus.
- **Isolation par entreprise.** Une ligne portant un autre `workspace_id`
  invalide tout l'état affiché.
- **Vulnérabilité `vyora-oauth`** : aucun retour. Aucune fonction sensible
  n'est exposée à `anon`, et rien n'est résolu depuis le navigateur.

---

## 5. Fonctionnalités bloquées, et pourquoi

| Blocage | Cause | Débloqué par |
|---|---|---|
| Connecter un fournisseur | aucun connecteur écrit | les six connecteurs ci-dessous |
| Demander l'activation pour 20 fournisseurs | non, c'est débloqué : la migration a élargi la validation | — |
| Synchronisation, import | pas de connecteur | livraison suivante |
| Preview Netlify | dépôt non relié au projet | action sur le compte Netlify |

La migration a **débloqué** un point qui était hors de portée : les 20
fournisseurs autres que les 6 historiques peuvent désormais recevoir une
demande d'activation, puisque `bg_validate_connector_key` les accepte.

---

## 6. Prochaine étape

Implémenter les connecteurs réels, un par un, en commençant par les deux plus
simples à vérifier sans environnement marchand :

1. **Notion** (OAuth 2.0, `read`/`write`) — API stable, bac à sable immédiat ;
2. **Google Drive** (OAuth 2.0, socle déjà déployé) — réutilise l'existant ;
3. **Shopify** (OAuth 2.0, `read`/`draft`/`write`) — nécessite une boutique de
   développement.

Chacun suit le même ordre : connecteur + `probe`, tests avec réponses HTTP
simulées, puis passage de `implemented` à `true` **après** que la sonde réelle
a réussi — jamais avant.

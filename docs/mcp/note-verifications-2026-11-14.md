# Note intermédiaire — vérifications du 14 novembre

Ce document consigne une vérification technique réalisée pendant la revue de la
PR #12. Il ne fait pas partie du périmètre livrable de la PR : c'est un document
de travail, à retirer avant la fusion.

---

## Verdict des trois vérifications demandées

| Sujet | Résultat |
|---|---|
| **1. Ordre des migrations** | **Risque confirmé et reproductible.** #10 peut écraser le bundle corrigé de #12. Protection proposée : verrou de publication. |
| **2. Périmètre MCP réel** | **Correction importante** : les outils MCP sont livrés, mais **aucun serveur MCP**. Le catalogue MCP, la page et le serveur `vyora-mcp` sont dans #9/#10, pas dans #12. |
| **3. Migration des artefacts** | **Validée en production** (base existante et base vierge), avec 3 accès Supabase temporairement indisponibles en fin de session. |

**Recommandation** : #12 est prête sur le fond, mais **le verrou de publication
manque** si #10 doit être fusionnée dans un avenir proche. Voir §1.4.

---

## 1. Ordre des migrations

### 1.1 Timestamps réels des trois PR

| PR | Migrations ajoutées | Artefact oauth ? |
|---|---|---|
| **#9** `vyora-mcp-core` | `20261114140000`, `20261115200000`, `20261115210000`, `2026111522xx` (×3), `20261115230000`, `20261116000118`, `20261116000130`, `20261116001121` | **non** |
| **#10** `vyora-mcp-connecteurs` | les mêmes que #9, **plus** `20261116020000_vyora_mcp_artifact`, `20261116030000_vyora_oauth_connectors`, `20261116040000_vyora_oauth_artifact` | **oui, vulnérable** |
| **#12** `vyora-connect-scope` | `20261116030000_vyora_oauth_connectors`, `20261116050000_vyora_connect_provider_status`, `20261116055000_edge_function_artifact_slices`, `20261116060000_vyora_oauth_artifact` | **oui, corrigé** |

### 1.2 Une collision de fichier, mais bénigne

`20261116030000_vyora_oauth_connectors.sql` est présent dans #10 **et** #12.
Vérification : **contenu identique octet pour octet**. Ce n'est pas un conflit —
c'est le cas favorable. Les deux branches portent la même migration de socle.

La collision historique `20261116040000` est résolue : #12 a renommé la sienne en
`20261116060000`, donc plus aucun fichier commun porteur d'un contenu différent.

Un fichier apparaît dans les trois branches (`20261112190000_vyora_edge_function_artifact.sql`)
mais il est **hérité de `develop`** : présent et identique partout. Il ne compte
pas comme collision pour les fichiers ajoutés.

### 1.3 Le risque réel : la dernière publication gagne

Chaque migration d'artefact commence par :

```sql
delete from public._edge_function_artifact_slices where name = 'vyora-oauth';
insert into public._edge_function_artifact_slices ... ;
```

Ce n'est **pas un upsert conditionnel** mais un remplacement. L'ordre
d'application prime sur l'ordre des noms de fichier. Simulations exécutées
(`tests/migration-order.test.ts`, 13 tests) :

| Séquence | Résultat |
|---|---|
| #12 seule | corrigé ✅ |
| **#10 puis #12** | **corrigé** ✅ |
| **#12 puis #10** | **VULNÉRABLE** ❌ |
| production (v1) puis #12 | corrigé ✅ |
| **production → #12 → #10** | **VULNÉRABLE** ❌ |

Le scénario #12 puis #10 est réel : la migration réussit, aucune erreur n'est
levée, et le chargeur redémarre sur le bundle d'origine, **sans vérification
d'identité**. Une régression de sécurité invisible.

### 1.4 Stratégie fiable proposée : verrou de publication

Le correctif ne consiste pas à ordonner les PR, mais à rendre le bundle
**vérifiable** quels que soient les migrations appliquées. Une table de
suivi, lue par le chargeur, référencent le SHA-256 attendu :

```sql
-- suivi de la version publiée, avec l'empreinte attendue
create table if not exists public._edge_function_artifact_manifest (
  name       text primary key,
  sha256     text not null,
  chars      integer not null,
  parts      integer not null,
  updated_at timestamptz not null default now()
);
alter table public._edge_function_artifact_manifest enable row level security;
revoke all on public._edge_function_artifact_manifest from public, anon, authenticated;
grant select on public._edge_function_artifact_manifest to service_role;

-- lors de la publication : insert ... on conflict do update
-- (l'état visé est remplacé, pas ajouté)
```

Le chargeur, au démarrage, lirait le manifeste et comparerait avec les tranches.
En cas d'écart, il refuse de servir (`503 EDGE_ARTIFACT_UNAVAILABLE`) au lieu
d'exécuter silencieusement un bundle plus ancien que le chargeur.

**Bénéfice** : #10 peut être appliquée avant ou après #12. Après une publication
obsolète, le service s'arrête avec un message explicite au lieu de régresser en
silence. Un arrêt visible est préférable à une faille invisible.

### 1.5 Procédure opérationnelle simple, dès maintenant

Sans modifier le chargeur :

1. **Fusionner #12 seule** dans `develop` (elle ne dépend pas de #10).
2. Publier l'artefact `vyora-oauth` corrigé.
3. Vérifier les 4 cas de comportement (§3.4).
4. Si #10 doit être fusionnée ensuite, **vérifier après application** :
   ```sql
   select parts, chars from public._edge_function_artifact_slices
    where name = 'vyora-oauth' order by part desc limit 1;
   ```
   Attendu : 7 tranches, 34 126 caractères. Si la valeur est 4 / 18 868,
   #10 a écrasé la correction : réappliquer `20261116060000`.
5. Ajouter l'étape 4 au runbook de migration.

C'est une garde **humaine**, pas automatique. Elle suffit tant que les
migrations sont appliquées manuellement avec revue.

---

## 2. Périmètre MCP réel

### 2.1 Ce que #12 contient

| Composant | Fichier | État |
|---|---|---|
| Six outils Google (définitions, validation, exécution) | `supabase/functions/vyora-oauth/google-tools.ts` | **livré** |
| Routes `tools_list` / `tools_call` | `supabase/functions/vyora-oauth/index.ts` | **livré** |
| Tests des outils | `tests/google-tools.test.ts` (45) | **livré** |
| Tests de refus `tools_call` | `tests/oauth-connector.test.ts`, `tests/oauth-isolation.test.ts` | **livré** |

### 2.2 Ce que #12 ne contient PAS

| Composant | Où il vit | Conséquence |
|---|---|---|
| **Serveur MCP** (`vyora-mcp`) — protocole HTTP Streamable, jetons hachés | **#9** | aucun transport MCP |
| Catalogue des outils | **#9** | pas de découverte par un client |
| Page `/app/mcp` | **#9** | pas d'interface MCP |
| Connecteur MCP « boucle complète » | **#10** | pas de preuve de bout en bout |

**Constat décisif** : aucune ligne de #12 n'appelle `tools_list` ou `tools_call`.

```bash
grep -rn "tools_call|tools_list" src/ supabase/functions/ \
  | grep -v "vyora-oauth/index.ts" | grep -v test
# → aucun résultat
```

### 2.3 Distinction des tests

| Test | Dépend de | Statut |
|---|---|---|
| `tests/google-tools.test.ts` | `google-tools.ts` (**#12**) | autonome |
| `tests/oauth-connector.test.ts` | `vyora-oauth/` (**#12**) | autonome |
| `tests/oauth-isolation.test.ts` | `vyora-oauth/` (**#12**) | autonome |
| `tests/oauth-auth-faille.test.ts` | `vyora-oauth/auth.ts` (**#12**) | autonome |
| Tests du serveur MCP | `vyora-mcp/` (**#9**) | **hors de #12**, non exécutables |

**Aucun test de #12 n'importe `vyora-mcp/`.** Vérifié par recherche d'imports.

### 2.4 Formulation exacte à retenir

> #12 livre **six outils Google exposés en MCP** et les routes qui les
> exécutent. Elle ne livre **pas** de serveur MCP : le client MCP, le catalogue
> et l'interface sont dans #9. Les outils sont donc **appelables par
> `vyora-oauth`**, mais **pas encore découvrables par un client MCP**.

Cette nuance doit remplacer toute formulation laissant entendre que #12 rend
l'intégration MCP utilisable de bout en bout. Elle ne le fait pas seule.

---

## 3. Migration des artefacts

### 3.1 Base existante — données conservées ✅

Migration complète rejouée en transaction annulée sur la production :

| Mesure | Avant | Après |
|---|---|---|
| Tranches | **28** | **28** |
| Octets base64 | **50 708** | **50 708** |

Aucune perte. Les gardes (`if not exists`) sont bien des no-op sur une base déjà
conforme.

### 3.2 Base vierge ✅

Schéma temporaire isolé, DDL exact de la migration, transaction annulée :

| Propriété | Valeur |
|---|---|
| Colonnes | **3** (`name`, `part`, `chunk`) |
| Clés primaires | **1** |
| Index | **1** (celui de la clé primaire) |
| RLS | **activée** |

Double exécution testée précédemment : 3 colonnes et **1 seule** clé primaire,
la garde évitant le doublon.

### 3.3 RLS, privilèges, index, contraintes — table réelle ✅

| Contrôle | Résultat |
|---|---|
| RLS activée | **oui** |
| Politiques | **0** (refus par défaut) |
| Index | 1 |
| Clé primaire | 1 |
| `anon` SELECT | **false** |
| `authenticated` SELECT | **false** |
| `authenticated` INSERT | **false** |
| `service_role` SELECT / INSERT / UPDATE / DELETE | **true / true / true / true** |

### 3.4 État actuel de la production

| Artefact | Tranches | Base64 |
|---|---|---|
| `vyora-ai` | 9 | 16 120 |
| `vyora-ai-providers` | 9 | 16 128 |
| `vyora-mcp` | 4 | 6 728 |
| **`vyora-oauth`** | **4** | **7 764** ← vulnérable |
| `vyora-provider-health` | 2 | 3 968 |

`vyora-oauth` est bien en version vulnérable (4 tranches / 18 868 car.), alors
que #12 publierait 7 tranches / 34 126 car.

### 3.5 Vérifications nécessitant un nouvel accès Supabase

L'accès Supabase a échoué **deux fois** en fin de session (`500`,
`Failed to check user auth status`). Deux vérifications n'ont donc **pas** pu
être faites :

| Vérification | Statut |
|---|---|
| Contenu de `supabase_migrations.schema_migrations` pour les versions `20261116*` | **non fait** — utile pour savoir quelles migrations sont déjà enregistrées |
| Test de l'insertion réelle des 7 tranches en transaction annulée | **non fait** — vérifierait que la migration `20261116060000` s'applique sans erreur |

Ces deux points ne bloquent pas la fusion, mais doivent précéder la publication.

---

## 4. Recommandation

**#12 est prête à fusionner sur le fond.** Les trois corrections demandées sont
vérifiées :

- migration de la table d'artefacts : idempotente, testée dans les deux sens
- publication reproductible : deux builds → même SHA-256, délégation vérifiée
- authentification et journalisation : corrigées et testées

**Une réserve opérationnelle subsiste** : si #10 est fusionnée après #12, elle
écrase silencieusement le bundle corrigé. Trois options, par ordre de sûreté :

1. **Ne pas fusionner #10 sur `develop`** tant que sa migration d'artefact n'est
   pas retirée ou alignée — c'est la plus simple et la plus sûre.
2. **Fusionner #12 d'abord** et ajouter l'étape de vérification `parts/chars`
   au runbook (§1.5).
3. **Implémenter le verrou de publication** (§1.4) : seule option qui rende le
   système sûr quel que soit l'ordre.

Ma recommandation : **option 1**, puis fusionner #12. Si #10 doit rejoindre
`develop`, faire retirer sa publication d'artefact `vyora-oauth` — elle est
devenue obsolète et dangereuse.

---

## 5. Note de méthode

Un test de cette session s'est d'abord révélé **faux positif** : il signalait une
collision sur `20261112190000`, qui est en réalité un fichier hérité de
`develop`, identique dans les trois branches. L'assertion a été corrigée pour ne
comparer que les fichiers **ajoutés** par chaque PR, et un test explicite
documente désormais la distinction.

Ce détail est mentionné parce qu'il illustre le risque inverse : un test trop
large produit des alertes qui finissent par être ignorées.

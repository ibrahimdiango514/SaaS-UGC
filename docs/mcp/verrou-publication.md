# Verrou de publication des artefacts Edge

Ce dispositif empêche qu'une migration plus ancienne, fusionnée plus tard,
remplace un artefact corrigé par une version antérieure — sans bruit.

## Le problème qu'il résout

Contexte : la PR #10 publie `vyora-oauth` avec le bundle d'origine.

| | PR #10 | PR #12 |
|---|---|---|
| Migration | `20261116040000_vyora_oauth_artifact.sql` | `20261116060000_vyora_oauth_artifact.sql` |
| Taille du bundle | 18 868 caractères | 34 126 caractères |
| SHA-256 | `4a3f6206…` | `b2101d14…` |
| Vérifie l'identité de l'appelant | **non** | **oui** |
| Tranches | 4 | 7 |

Chaque publication s'écrit en deux temps :

```sql
delete from public._edge_function_artifact_slices where name = 'vyora-oauth';
insert into public._edge_function_artifact_slices values (…);
```

Ce n'est pas un `upsert` : **la dernière migration appliquée gagne**. Si #10
est fusionnée après #12, elle réinstalle l'ancien bundle. La migration
réussit, aucune erreur n'apparaît.

## Les trois barrières

### 1. Le chargeur refuse d'exécuter un bundle inattendu

`supabase/functions/vyora-oauth/loader.ts` épingle la taille et le SHA-256 :

```ts
const SHA256 = "b2101d1416d60022…";
const CHARS = 34126;
```

Il recompose les tranches, les décompresse, puis compare **avant**
d'exécuter. En cas d'écart : `artifact_size_mismatch` ou
`artifact_digest_mismatch`, et le service répond `503 EDGE_ARTIFACT_UNAVAILABLE`.

Conséquence : même si l'ancien bundle revient en base, **il n'est jamais
exécuté**. C'est la barrière qui protège la sécurité au sens strict.

### 2. La base refuse la réécriture (nouveau)

`20261116056000_edge_function_artifact_guard.sql` crée :

- `_edge_function_artifact_manifest` — pour chaque artefact, l'empreinte
  SHA-256 de ses tranches et sa taille attendue ;
- un déclencheur `_edge_function_artifact_guard` sur la table des tranches,
  qui refuse toute écriture contredisant une empreinte épinglée.

Sans cette barrière, l'ancien bundle reviendrait en base et le service
passerait de « sécurisé » à « indisponible » — sans raison valable, et avec
une charge prête à redevenir active au prochain déploiement.

**Pourquoi un déclencheur différé.** Une publication légitime commence par
supprimer les tranches existantes : à cet instant, l'artefact a zéro
tranche. Un déclencheur immédiat refuserait cette étape intermédiaire, et
bloquerait même les republications correctes. D'où
`constraint trigger … deferrable initially deferred` : le contrôle a lieu au
`COMMIT`, quand la suppression et l'insertion ont toutes deux eu lieu.

**Pourquoi l'empreinte porte sur les tranches, pas sur le bundle.** Les
tranches sont du gzip encodé en base64. Postgres ne sait pas les
décompresser. On épingle donc le SHA-256 de la concaténation base64 ; le
SHA-256 du bundle décompressé reste vérifié par le chargeur.

### 3. Le générateur pose l'épingle automatiquement

`renderSeedSql` émet désormais, après chaque publication, un
`insert … on conflict (name) do update` dans le manifeste. Toute migration
générée protège donc son artefact, sans dépendre de la mémoire de
l'opérateur.

## Ce que le dispositif garantit — et ce qu'il ne garantit pas

**Garanti** :

- aucune migration, quel que soit son ordre d'application, ne peut réécrire
  les tranches de `vyora-oauth` avec un contenu différent une fois l'épingle
  posée ;
- la migration fautive **échoue bruyamment** au lieu de réussir en silence ;
- l'ancien bundle n'est jamais exécuté par le chargeur corrigé.

**Non garanti** :

- **le déploiement.** Redéployer le chargeur de #10 (qui épingle lui aussi
  `4a3f6206…`) reste possible. Le dispositif protège les données, pas les
  déploiements. Repasser d'une version à une autre est un acte
  opérationnel, journalisé et réversible.
- **un artefact jamais épinglé.** Un nom absent du manifeste reste
  librement publiable. C'est voulu : sinon aucune première publication ne
  serait possible.
- **une base restaurée depuis une sauvegarde antérieure.** Le manifeste et
  les tranches reviennent ensemble ; l'état est cohérent, mais peut être
  antérieur à la correction.

## Vérifications exécutées en production

Toutes en transaction annulée (`begin … rollback`), sans effet persistant.

| Test | Résultat |
|---|---|
| Installation du verrou et pose d'une épingle | OK |
| Republication à l'identique d'un nom épinglé | **passe** (9 tranches préservées) |
| Écrasement par un contenu différent | **refusé** — `VERROU: vyora-ai refuse (attendu 9 tranches, obtenu 1)` |
| Écrasement par le vrai `delete` + `insert` de #10 | **refusé** |
| Parcours complet : publication puis pose d'épingle | OK |

## Procédure de mise en œuvre

1. Appliquer `20261116055000` (table des tranches), `20261116056000`
   (verrou), puis `20261116060000` (publication corrigée + épingle).
2. Vérifier :

   ```sql
   select name, parts, bundle_chars, left(slices_sha256, 16) as empreinte
     from public._edge_function_artifact_manifest;
   -- attendu : vyora-oauth | 7 | 34126 | 6eebdd18470425a8
   ```

3. Redéployer le chargeur `vyora-oauth` (`loader.ts`).
4. Vérifier les quatre cas de comportement (401 sans en-tête, 401 avec UUID
   nu, succès avec JWT valide, `callback` public).

## Si une migration fautive échoue en production

C'est le comportement attendu. Le message indique le nom de l'artefact et
l'écart. Il ne faut **pas** désactiver le verrou : il faut retirer la
publication obsolète de la migration concernée.

Pour lever une épingle volontairement (cas légitime : retour arrière
délibéré) :

```sql
begin;
delete from public._edge_function_artifact_manifest where name = 'vyora-oauth';
-- republier, puis reposer l'épingle
commit;
```

Cette opération doit être explicite, revue et tracée.

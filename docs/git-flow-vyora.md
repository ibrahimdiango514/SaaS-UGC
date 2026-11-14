# VYORA — Git flow : `develop` ↔ `main`

> Adopté le 2026-11-14 (mission de centralisation du développement).
> Source canonique de l'organisation Git de VYORA. Toute livraison de production est
> soumise à la procédure §5 et à l'autorisation explicite du propriétaire.

## 1. Modèle à deux branches permanentes

| Branche | Rôle | Déploiement Netlify |
|---|---|---|
| `main` | **Production uniquement** (`vyora-ugc.netlify.app`) | Auto-publish activé : chaque commit publié déclenche un build de production |
| `develop` | **Développement unique permanent** de VYORA | Jamais de publication de production (branch deploy / preview uniquement) |

Règles :

- Aucun push direct sur `main`. La protection GitHub en vigueur refuse les pushes
  directs (vérifiée comportementalement : push direct rejeté, PR squash acceptée).
- Aucun passage en production depuis `develop` directement : la production ne change
  que par **PR explicite `develop` → `main`**, validée et **autorisée explicitement**.
- Les branches `arena/*` de session Arena sont des **branches de travail éphémères** :
  elles sont basées sur `develop` (ou un commit de `develop`) et y reviennent par PR.
  Une branche de session ne vise jamais `main` directement pour un développement ordinaire.
- Les branches historiques (`arena/*`, `security/dependency-fixes`) sont **conservées**
  jusqu'à vérification de leur contenu et de leur utilité. Aucune suppression sans
  décision explicite du propriétaire.

## 2. Convention `[skip netlify]` — règle corrigée

Contexte : le commit squash `cc43bb3` (2026-11-14) n'a pas été publié par Netlify
parce que son message (titre + corps de la PR) contenait `[skip netlify]` 6 fois,
hérité de la liste de messages de commits citée dans le corps de la PR. Netlify
applique le marqueur à **tout** le message du commit (titre et corps), pas seulement
au titre.

Règles définitives :

1. Le marqueur (`[skip netlify]`, `[netlify skip]`, `[ci skip]`) est un outil de
   **développement** : il permet de ne pas déclencher de build pour un état intermédiaire.
   Le mécanisme est **conservé** (utilité : commits d'état intermédiaire sur les
   branches de session, économie de builds).
2. Il n'apparaît **jamais** dans :
   - le **titre** d'une PR destinée à être livrée en production ;
   - le **corps** d'une PR de production — y compris en citation de messages de commits ;
   - tout message de commit qui sera squasé dans une livraison vers `main`.
3. Il peut librement apparaître dans les commits des branches de travail
   (aperçus, états intermédiaires, corrections hors livraison).
4. Chaque livraison est vérifiée avant fusion (§5, point 5). Commande de vérification :

```bash
# Aucun marqueur de skip dans les messages de commits de la future PR
git log main..develop --format='%h %s%n%b' \
  | grep -inE 'skip[ _]netlify|netlify[ _]skip|skip[ _]ci|ci[ _]skip' \
  || echo "OK: aucun marqueur de skip"
# + lecture humaine du titre et du corps de la PR avant le merge.
```

Note : le dépôt n'a pas GitHub Actions (indisponible), donc cette vérification est
**manuelle et obligatoire** ; elle fait partie du rapport de livraison.

## 3. Développement (règles Arena)

- Tout nouveau développement part de `develop` : la session Arena est basée sur
  `develop` (ou un commit descendant de `develop`).
- Les commits de développement sont sauvegardés sur `develop` par PR depuis la branche
  de session (merge validé après tests).
- Avant toute fusion vers `develop` : `npx tsc -b` (0 erreur), `npx vitest run`
  (tout vert), `npm run build` (OK), `npm run check:edge-imports` (conforme).
- Si une session Arena ne peut pas baser son travail sur `develop`, elle s'arrête et
  le signale — elle ne crée pas silencieusement une autre branche permanente.

## 4. Netlify (configuration à conserver, à vérifier depuis le dashboard)

- Repository : `ibrahimdiango514/SaaS-UGC`
- Production branch : `main`
- Auto publishing : **activé** sur `main`
- Branch deploys / deploy previews : **aperçus uniquement** — ne jamais les prendre
  pour la production (URLs d'aperçu distinctes de `vyora-ugc.netlify.app`).
- Après chaque livraison : vérifier que le commit publié est celui attendu et que le
  site fonctionne (marqueurs de version, Business Grow, Studio).

## 5. Procédure obligatoire avant chaque livraison (`develop` → `main`)

1. `develop` contient les travaux attendus : `git log main..develop --oneline` (revu).
2. Tests et build passent (batterie complète du point 3).
3. Comparaison `develop` vs `main` : `git diff main...develop --stat` (récapitulatif
   joint au rapport de livraison).
4. Migrations et artefacts Supabase concernés : listés, état en production vérifié
   (application manuelle dans l'ordre, **jamais de rejeu** des migrations déjà appliquées).
5. **Vérification skip-netlify** : commande §2.4 + lecture du titre/corps de la PR
   (aucun marqueur, aucune citation de commit portant un marqueur).
6. Ouverture de la PR `develop` → `main` : titre propre, corps **neutre** (résumé
   fonctionnel ; jamais de liste brute de messages de commits).
7. **Attente de l'autorisation explicite du propriétaire** avant toute fusion
   (aucune fusion automatique, aucune fusion sans validation).

Après fusion :

- Vérifier que Netlify a publié le commit attendu (dashboard des déploiements ou
  fetch de la page avec les marqueurs de version).
- Vérifier que le site fonctionne (Business Grow v3, Studio, sondes).
- Reporter les preuves (SHA publié, marqueurs observés) dans le fil de la session.

## 6. Couplage Supabase avec le déploiement

- Migrations : appliquées manuellement (connecteur/dashboard) dans l'ordre, jamais
  rejouées ; les versions appliquées sont listées dans chaque rapport de livraison.
- Artefacts Edge (`_edge_function_artifact`, ex. `business-grow`) : le bundle est
  épinglé par SHA-256 + longueur dans le loader court. Tout changement de bundle exige
  la régénération de l'artefact (`scripts/build-business-grow-artifact.mjs`) et la
  mise à jour du loader **avant** la publication du frontend qui l'utilise.
- Fonctions Edge legacy / Reelora : jamais redéployées aveuglément, hors périmètre
  explicite d'une mission.

## 7. Points à maintenir manuellement (hors capacité de l'agent Arena)

- Protections de branches (détail des règles) : GitHub Settings → Branches. Le token
  agent est sans portée admin (API 403) — aucune règle n'a été modifiée par l'agent.
- Configuration Netlify (production branch, auto-publish, previews) : pas de token
  NETLIFY dans le sandbox — vérification par le propriétaire dans le dashboard.
- Création initiale de `develop` : réalisée par le propriétaire (commande §8), la
  session Arena étant verrouillée sur sa propre branche de travail.

## 8. Commandes de référence

```bash
# Créer develop depuis le commit canonique de main (une seule fois, propriétaire)
git push origin cc43bb370996df60714c25727bd5cc441645a64e:refs/heads/develop

# État des branches canoniques
git fetch origin && git rev-parse origin/main origin/develop

# Bundle Business Grow canonique dans main
git show origin/main:supabase/functions/business-grow.edge.js | sha256sum
# attendu : 020890b52a66883dcc74ef22b8034d9bddf8a0bcaf94f7b18093ed86cfd15303

# Vérification skip-netlify avant livraison
git log main..develop --format='%h %s%n%b' \
  | grep -inE 'skip[ _]netlify|netlify[ _]skip|skip[ _]ci|ci[ _]skip' \
  || echo "OK: aucun marqueur de skip"
```

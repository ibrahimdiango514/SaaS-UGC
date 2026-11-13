# Business Grow Phase 3 — préparation de livraison en préproduction

État au 13 novembre 2026 (UTC). Ce document prépare une livraison ; il **n'autorise aucun déploiement**, et ne constitue ni une sauvegarde ni une preuve de tests réels en préproduction. Aucun merge dans `main` n'est prévu. Voir aussi [le périmètre Phase 3](business-grow-phase3-agent.md).

## 1. Inventaire constaté en lecture seule

| Opération | État | Preuve ou limite |
| --- | --- | --- |
| Inventaire Supabase | **EFFECTUÉ ET VÉRIFIÉ** | Le compte connecté ne voit qu'un projet : `xbuuhfwobrafcbgtdgjx`, actif, connu comme production. La liste de ses branches ne contient que `main` par défaut. Une préproduction extérieure aux ressources visibles n'est pas exclue, mais n'a pas été identifiée. |
| Historique des migrations de production | **EFFECTUÉ ET VÉRIFIÉ** | `business_grow_integration_requests` est enregistré sous `20261113042319`. La migration locale `20261114120000_business_agent_workspace.sql` n'apparaît pas dans l'historique retourné. L'historique ne garantit pas l'absence d'éventuelles modifications manuelles ; contrôler également le schéma de la cible choisie. |
| Edge de production, métadonnées | **EFFECTUÉ ET VÉRIFIÉ** | `business-grow` est `ACTIVE`, version **22**, `verify_jwt=true`. Le bundle v22 précédemment vérifié a pour SHA-256 `908af379b0eebc8ea89f35d1f912c38bfa59b7ef309ef86118af2f988b417952`. Ce n'est pas la Phase 3. |
| Préproduction Supabase, frontend et journaux | **BLOQUÉ** | Aucune cible de préproduction n'est visible via le connecteur. Aucun accès d'administration Netlify n'est disponible ici pour vérifier ses sites, builds, variables, secrets ou journaux. Les métadonnées GitHub ne montrent pas de workflow ni de déploiement GitHub pour ce dépôt, ce qui ne prouve pas l'absence de builds Netlify. |
| Prévention d'un build de branche accidentel | **PRÉPARÉ** | `netlify.toml` annule les builds de la branche Phase 3 et de l'ancienne branche protégée ; le commit de livraison doit aussi comporter `[skip netlify]`. Netlify indique que le prochain commit sans ce marqueur peut déployer les changements précédemment sautés [1](https://www.netlify.com/knowledge-base/how-to-deploy-a-site-to-netlify/). `tests/business-grow-deployment-guard.test.ts` vérifie localement la commande. La configuration effective du fournisseur reste à confirmer : ce n'est pas une preuve d'absence de déploiement chez Netlify. |
| Ancien serveur d'aperçu local | **EFFECTUÉ ET VÉRIFIÉ** | Le serveur Vite hérité, dont le proxy pouvait reprendre la cible de production par défaut, a été arrêté. Cela ne modifie ni le frontend hébergé ni les données distantes. |
| Sauvegarde de préproduction et restauration | **BLOQUÉ** | Pas de base de préproduction identifiée, pas de sauvegarde créée ni de restauration vérifiée. Ne pas assimiler le banc PostgreSQL jetable à une sauvegarde. |
| Migration, Edge et frontend Phase 3 en préproduction | **NON EFFECTUÉ** | Aucun environnement approprié, aucune sauvegarde et barrière RLS non satisfaite. Aucun composant Phase 3 n'a été déployé isolément ou en production. |
| Tests métier réels, E2E et logs de préproduction | **BLOQUÉ** | Aucun compte ni aucune donnée de test réelle de préproduction disponibles. Les tests locaux utilisent des données synthétiques et les audits navigateur des transports simulés. |

## 2. Arrêt obligatoire : propriétaires des fonctions et RLS

**BLOQUÉ — ne pas appliquer la migration ni publier l'Edge ou le frontend tant que ce point n'est pas corrigé et validé.**

L'inspection en lecture seule des catalogues de production constate que `postgres` a `rolbypassrls=true` ; `bg_owner` et `bg_edge` n'ont pas ce privilège et sont `NOLOGIN`. Les fonctions existantes `bg_create_conversation`, `bg_get_memory`, `bg_submit_user_message`, `bg_get_workspace_context` et `bg_list_messages` sont notamment `SECURITY DEFINER`, propriétaires `postgres`. Un tel appel s'exécute avec les droits du propriétaire : `FORCE ROW LEVEL SECURITY` ne contraint pas un rôle `BYPASSRLS`. Les vérifications de `user_id` et de workspace dans les fonctions restent utiles, mais **ne démontrent pas une isolation imposée par RLS**.

La migration Phase 3 remplace des fonctions existantes — `CREATE OR REPLACE` conserve leur propriétaire — et les nouvelles fonctions prennent le propriétaire du rôle qui applique la migration. Dans le banc local qui reproduit une application par `postgres`, **5/5 tables Phase 3 ont RLS activée et forcée, mais 18/18 fonctions critiques inspectées sont `SECURITY DEFINER` détenues par un rôle `BYPASSRLS`**. La barrière reproductible `npm run audit:business-rls` retourne actuellement un code non nul. Elle ne lit aucune donnée d'utilisateur et utilise un répertoire local neuf ; elle n'est pas une preuve de conformité d'une préproduction.

Ne pas se contenter de changer le propriétaire : les politiques locales `bg_owner` sont permissives pour ce rôle, et les politiques `saas_ugc` constatées en production ciblent `authenticated`. Un changement superficiel pourrait casser les vérifications ou conserver une portée trop large. La correction doit être conçue et revue de bout en bout : rôle d'exécution sans superutilisateur ni `BYPASSRLS`, propriétaires et chaîne d'appels, politiques effectivement restrictives, identité utilisateur vérifiée, droits des tables et séquences, rôles hérités, verrous et cascades. Tester ensuite avec des sessions réelles et les politiques activées, sans `service_role`, sans `postgres` comme identité applicative et sans désactiver RLS. Ne pas modifier les politiques de production pour faire passer le test.

Le service actuel accepte `BUSINESS_GROW_DATABASE_URL` ou, en repli, `SUPABASE_DB_URL`. Avant tout déploiement de préproduction, attester le rôle effectif de connexion et toute la chaîne `SECURITY DEFINER` ; une connexion privilégiée par défaut n'est pas une preuve de moindre privilège. La correction des propriétaires/politiques et sa validation sont **NON EFFECTUÉES**.

## 3. Prérequis de l'environnement isolé

1. Identifier une préproduction existante, réservée aux tests, **distincte de `xbuuhfwobrafcbgtdgjx`** : référence, hôte DB, Auth, Storage, fonctions Edge, espace frontend et propriétaire opérationnel. Une simple entreprise de test dans la base de production ne suffit pas. Ne pas créer un nouveau projet produit pour contourner ce blocage.
2. Prouver que la base, Auth, les stockages, les fonctions, les comptes, les journaux et les secrets sont séparés de la production ; utiliser exclusivement des données synthétiques. Les clés fournisseur et le budget de test doivent être dédiés, avec dépenses et appels externes explicitement autorisés. Ne jamais demander, afficher ou versionner de valeurs secrètes. Sans fournisseur de test autorisé, le test réel de réponse IA reste bloqué.
3. Le dépôt contient des valeurs par défaut de production dans `src/lib/public-config.ts`, `src/lib/supabase.ts` et `.env.example`. Les relais `netlify/edge-functions/business-grow.js` et `netlify/functions/business-grow.mjs` ciblent **en dur la production**. Pour la préproduction, configurer explicitement l'URL et la clé **publique** du bon projet et l'URL du bon frontend ; vérifier la destination et le JWT effectivement utilisés au navigateur. Le client Phase 3 n'utilise plus les relais canoniques pour un autre projet, y compris sur un domaine personnalisé, mais ces routes restent accessibles directement : les désactiver ou les remplacer par un relais vérifié et fixé à la préproduction avant ouverture. Contrôler toutes les routes réseau de l'application, et bloquer au niveau réseau tout accès de l'environnement de test aux services de production. **Ne pas confondre la présence de la chaîne de l'URL par défaut dans un bundle avec une preuve de son utilisation effective.**
4. Recenser et neutraliser, dans l'environnement isolé uniquement, les cron, webhooks, paiements et rappels sortants qui pourraient joindre des systèmes réels. Certaines migrations historiques contiennent des URL de fonctions de production en dur ; ne pas rejouer tout l'historique sans revue. Ne pas toucher aux paiements réels ou à SasPay. Vérifier les origines CORS, les redirections Auth et l'absence de clés secrètes dans les variables `VITE_` et les assets ; les clés IA restent exclusivement côté serveur.
5. Vérifier aussi le moteur central `vyora-ai` : Business Grow peut l'appeler côté serveur via l'URL Supabase et un jeton service, puis se rabattre sur un adaptateur fournisseur direct. Le moteur central a lui-même des replis de configuration fournisseur. Ses versions, URL, identité et **toutes** ses clés doivent être propres à la préproduction ; aucun appel interne ne doit aboutir à la production. Ne jamais utiliser le jeton service comme preuve que RLS protège un accès aux données.
6. Disposer de journaux Edge/frontend accessibles et expurgés, d'un canal de maintenance qui bloque également les accès directs à l'Edge, d'un moyen de drainer les requêtes en vol et d'un responsable capable d'arrêter l'opération. Un bandeau frontend ne suffit pas. La protection Netlify de cette branche doit rester active jusqu'à la mise en place d'une cible de build isolée et vérifiée.

## 4. Sauvegarde et restauration à préparer sur la seule cible isolée

- **Avant toute migration**, vérifier les capacités effectives de sauvegarde/PITR du plan de préproduction et les droits de l'opérateur. Prendre un point de restauration ou un export complet cohérent, chiffré et stocké hors du dépôt avec accès et rétention limités. Enregistrer référence de l'environnement, date UTC, version PostgreSQL, état des migrations et empreinte SHA-256 de l'export. Ne jamais placer d'identifiants ni de valeurs de secrets dans le dépôt, les commandes visibles ou les preuves.
- Inspecter l'inventaire de l'archive et son empreinte, puis restaurer dans une **base de test vide et isolée** sans écraser une base existante. Comparer les objets, migrations, contraintes, fonctions, politiques, données synthétiques et séquences, ainsi que les résultats des accès autorisés/refusés. Conserver la preuve de restauration et la durée mesurée. Une vérification de fichier seul n'est pas une preuve de restauration.
- Un export PostgreSQL seul ne couvre pas nécessairement les rôles globaux, secrets serveur, configuration Auth, versions d'Edge, frontend ou objets Storage. Inventorier et prévoir séparément leur restauration par les moyens approuvés de la plateforme, sans révéler les secrets. Confirmer les limites propres à l'environnement et à son plan avant d'accepter la sauvegarde.
- Vérifier en lecture seule les migrations et le schéma de préproduction, notamment la migration d'intégrations déjà appliquée et les prérequis Business/UGC. La migration Phase 3 modifie des contraintes et cascades ; vérifier la compatibilité exacte avec la cible. Une table absente de l'historique ne signifie pas automatiquement qu'elle est absente du schéma.

**Statut actuel : BLOQUÉ.** Aucun export, point PITR ni essai de restauration réel de préproduction n'a été réalisé.

## 5. Ordre de bascule ultérieure, conditionnel

Toutes les conditions précédentes, y compris la correction RLS et un essai de restauration réussi, sont des prérequis. En maintenance effective, sur la seule préproduction identifiée et avec comptes de test :

1. Confirmer le commit immuable, les empreintes, le rôle de migration et la sauvegarde ; comparer l'historique et le schéma. Appliquer transactionnellement uniquement la migration revue nécessaire. Vérifier marqueur `business-workspace-v3`, accès, RLS effectives, propriétaires, ACL, contraintes, index, cascades et conservation des données synthétiques.
2. Publier le bundle Edge issu du même commit et son `loader.ts`, avec `verify_jwt=true`, secrets **de préproduction** et rôle DB minimal vérifié. Contrôler version servie, SHA et comportement authentifié ; `status` seul ne prouve pas la disponibilité du protocole v3. Le bundle Phase 3 actuellement préparé en local est `bbac580fcb25541e5caab85a8f72bd32586a78f24b8e2fd400150475978ae221` ; il n'est pas une version Edge déployée. Une correction future du service peut changer cette empreinte.
3. Publier le frontend construit depuis le même commit, uniquement sur l'hôte isolé, après avoir désactivé les relais vers la production. Vérifier la version effectivement servie, les destinations réseau et l'absence de secrets. Empêcher les anciens onglets/clients d'opérer ; rouvrir le trafic uniquement après les tests ci-dessous.

L'ancien Edge v22 ne sait pas traiter le protocole `v3.`. Après migration, son ancienne RPC d'envoi refuse **tous** les messages avant appel fournisseur. Le frontend Phase 3 ne doit pas se rabattre sur une action non préfixée. Ne pas utiliser `scripts/deploy-edge-functions.sh` globalement, ni déployer un composant séparément en accès public.

## 6. Matrice de tests réels à exécuter en préproduction

Tous les scénarios ci-dessous sont **BLOQUÉS**, non exécutés à ce jour. Utiliser uniquement des comptes et données synthétiques ; préserver des preuves expurgées (commit/SHA, requête sans JWT, résultat, date, erreurs et ID de test). Ne supprimer aucun élément préexistant. Les comptes de test créés pour ces essais ne peuvent être supprimés qu'après conservation des preuves et vérification de leur provenance.

| Domaine | Scénarios et résultats attendus |
| --- | --- |
| Agent et historique | Créer une conversation, envoyer et recevoir une réponse d'un fournisseur de test séparé, vérifier le contexte autorisé et l'historique ; tester indisponibilité, quota et erreur sans rejouer une mutation au résultat incertain. |
| Intelligence / diagnostics | Saisir des factures, stocks et leads de test ; vérifier les preuves, périodes, recommandations, limites et rapports contre les valeurs saisies ; vérifier les cas vides, invalides et consentement CRM révoqué. |
| Actions | Préparer une proposition sans écriture, vérifier l'aperçu, refuser puis approuver explicitement ; tester source modifiée, doubles clics, idempotence, limite et interruption partielle. Aucun envoi externe. |
| Isolation et RLS | Deux entreprises distinctes, deux comptes distincts et un compte autorisé dans les deux : tenter lectures et mutations croisées de conversations, mémoire, diagnostics, rapports, recommandations, tâches et intégrations avec de vrais JWT. Tester viewer, retrait de membre et accès non autorisé. Examiner les politiques effectives et les propriétaires ; ne pas contourner RLS. |
| Intégrations | Demande/annulation distinctes par entreprise ; vérifier qu'une déconnexion locale n'est pas présentée comme une révocation fournisseur et qu'aucun OAuth ou appel externe n'est effectué. |
| Sales Automation | Vérifier aperçu, confirmation, absence d'écriture avant accord, déduplication, règle/source modifiée, capacité concurrente, troncature et résultat partiel ou inconnu. |
| Compatibilité et restauration | Tester ancien frontend, bundle v22 exact, nouveau protocole avant/après migration et rollback isolé. Confirmer le blocage de l'ancien envoi et l'absence de mélange de données. Restaurer la sauvegarde sur une base vide isolée et vérifier chat et isolation avec les versions compatibles. |
| Technique / observabilité | Tests automatisés, typecheck, build, migration et sécurité ; E2E authentifié depuis le frontend réellement servi ; vérification des journaux Edge et erreurs navigateur, CORS, JWT et absence de secrets. |

## 7. Procédure de retour arrière proposée

**PRÉPARÉE, NON TESTÉE EN PRÉPRODUCTION.** Maintenir la maintenance, arrêter de nouvelles écritures et drainer les requêtes. Préférer une correction compatible Phase 3. Si restauration nécessaire, utiliser uniquement la sauvegarde pré-migration dont la restauration a été démontrée, en évaluant les écritures postérieures et la perte potentielle. Restaurer d'abord dans une base vide isolée, vérifier rôles/RLS/données synthétiques et aligner Edge/frontend avec le schéma restauré. Ne pas écraser de données existantes sans procédure approuvée ; ne pas appliquer manuellement un inverse non testé. Redéployer v22 seul n'est **pas** un rollback fonctionnel : la migration laisse son ancien chat bloqué. La compatibilité locale simulée ne prouve pas une restauration distante.

## 8. Vérifications locales

```bash
npm run typecheck
npm test -- --reporter=dot
npm run build
node scripts/build-business-grow-artifact.mjs --check
npm run check:edge-imports
git diff --check
# Dépendances locales préexistantes : npm ci --prefix supabase/tests/saspay
npm run audit:business-rls  # actuellement BLOQUÉ, code de sortie non nul
```

| Contrôle | État | Résultat local |
| --- | --- | --- |
| Vitest, typecheck et build | **EFFECTUÉ ET VÉRIFIÉ** | 71 fichiers, **1 083 tests** ; typecheck et build réussis. Deux avertissements Vitest préexistants de hoisting subsistent dans `tests/business-provider-staleness.test.tsx`. |
| Artefact Edge et imports | **EFFECTUÉ ET VÉRIFIÉ** | Bundle local Phase 3 SHA-256 `bbac580fcb25541e5caab85a8f72bd32586a78f24b8e2fd400150475978ae221` ; chargeur et imports conformes aux scripts locaux. Cet artefact n'est pas déployé en préproduction. |
| Recherche ciblée de secrets frontend | **EFFECTUÉ ET VÉRIFIÉ** | 66 fichiers JavaScript du build local examinés : aucun motif de clés sensibles ou JWT `service_role` trouvé. C'est une recherche par motifs, **pas** une preuve exhaustive ni une vérification des secrets d'un hébergeur. Les clés et appels de fournisseurs examinés sont côté Edge. |
| Parcours Chromium simulé | **EFFECTUÉ ET VÉRIFIÉ** | Serveur temporaire pointant vers un hôte factice `.invalid`, requêtes externes neutralisées ; rapports, proposition/approbation et Sales Automation parcourus en desktop et mobile sans erreur navigateur. Ce n'est pas un E2E de préproduction. Le serveur a été arrêté. |
| Barrière propriétaires RLS | **BLOQUÉ** | `audit:business-rls` retourne **1** : 18 fonctions critiques ont un propriétaire `BYPASSRLS` dans le banc synthétique ; voir § 2. |
| Bancs fonctionnels PostgreSQL/compatibilité | **BLOQUÉ** | Les résultats antérieurs étaient positifs mais utilisaient le rôle propriétaire contournant RLS ; ils n'ont pas été rejoués sous cette contrainte. |

Les anciens bancs `run.mjs` et `compat.mjs` utilisaient un socle partiel et des adaptateurs locaux ; leurs résultats antérieurs ne valident ni le schéma réel de préproduction ni l'exigence RLS ci-dessus. **Ne pas les rejouer en l'état pour valider la livraison** : ils exécutent des fonctions dont le propriétaire contourne RLS dans leur base synthétique. Les adapter à l'architecture corrigée et à des rôles non privilégiés avant de les réexécuter. `audit:business-rls` crée un répertoire PostgreSQL neuf, installe le schéma sans données utilisateur et inspecte les catalogues ; il signale explicitement le blocage. Aucun de ces tests ne remplace les essais réels, la sauvegarde ou la restauration.

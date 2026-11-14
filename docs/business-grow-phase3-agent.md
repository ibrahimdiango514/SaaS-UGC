# Business Grow — Phase 3 : agent par entreprise

État au 13 novembre 2026 (UTC) : **implémentation et vérifications locales uniquement**. La migration Phase 3, le nouvel Edge et le nouveau frontend ne sont pas publiés. Ce document n'est pas une autorisation de déployer.

**Livraison BLOQUÉE :** des fonctions historiques `SECURITY DEFINER` sont détenues par `postgres`, rôle `BYPASSRLS`, et le banc local reproduit ce problème pour les fonctions critiques Phase 3. RLS activée et forcée ne suffit pas dans ce cas. Il faut revoir l'architecture des rôles et politiques, puis la tester réellement sur une préproduction isolée. Inventaire, preuves, prérequis et plan de restauration : [préparation de préproduction](business-grow-phase3-preproduction.md).

## Périmètre

- L'agent et les modules utilisent le couple **utilisateur + entreprise**. Deux membres d'une même entreprise ne partagent pas automatiquement leurs fiches ni leur mémoire. Les propriétaires et membres autorisés peuvent lire leur propre périmètre ; les mutations des fiches, intégrations et mémoire exigent un rôle owner/admin/editor. Le chat utilise les droits de lecture de l'entreprise.
- Les données historiques personnelles (`workspace_id IS NULL`) ne sont ni affectées automatiquement à une entreprise, ni incluses dans son prompt. L'import de mémoire historique dans une entreprise exige un consentement actif et une confirmation explicite. Il copie les données ; il ne supprime pas la mémoire historique.
- L'application utilise actuellement l'entreprise choisie au bootstrap, ou la première entreprise disponible si celle du bootstrap n'est pas trouvée. **Il n'y a pas de sélecteur d'entreprise dans cette interface.**
- Six diagnostics déterministes — santé, commercial, financier, clients, récupération et opérations — lisent les données disponibles, indiquent les limites et ne constituent pas une réponse du fournisseur IA. Jusqu'à 500 fiches sont lues par catégorie ; le rapport affiche au plus 40 recommandations et précise le total. Jusqu'à 100 rapports peuvent être conservés par compte et entreprise, puis consultés, téléchargés en JSON ou supprimés.
- Une proposition de tâche issue d'un diagnostic n'écrit rien avant approbation. Sa confirmation vérifie transactionnellement le périmètre, les droits, l'état et l'empreinte de la source ; la répétition de la même décision retourne le résultat déjà enregistré. Aucune action externe n'est envoyée.
- **Sales Automation** relit règles et sources avant de présenter jusqu'à 25 tâches, selon la capacité restante de 500 fiches dans Operations Manager. Après confirmation, chaque création vérifie transactionnellement que la règle, la source, l'éligibilité et le jour UTC de l'aperçu n'ont pas changé. Les créations sont séquentielles : un arrêt peut laisser un lot partiel, signalé dans l'interface. Une réponse perdue laisse le résultat de la dernière tâche inconnu ; vérifier Operations Manager avant de recalculer. Il n'y a pas de rejeu automatique de mutation.
- Une demande d'intégration reste une demande locale : elle ne réalise ni OAuth ni synchronisation avec Facebook, Instagram, YouTube, TikTok, Shopify ou WooCommerce. La déconnexion retire l'association locale mais **ne révoque pas l'accès chez le fournisseur** et ne prétend pas supprimer un éventuel secret Vault.
- La mémoire, les descriptions d'entreprise, les produits, le texte saisi et les champs Growth peuvent contenir des données personnelles. Après consentement et selon l'action demandée, certaines peuvent être transmises au fournisseur IA ; les diagnostics utilisent une projection bornée et n'envoient pas les notes, coordonnées ou messages des fiches comme instructions. Relire le contenu avant envoi.
- La révocation efface la mémoire active du périmètre, mais des copies peuvent subsister dans les rapports enregistrés, conversations, tâches ou fichiers téléchargés. Elle ne rappelle pas les données déjà transmises à un fournisseur ni n'annule de façon garantie une requête déjà préparée ou en vol. Supprimer les copies séparément si nécessaire ; les fichiers déjà téléchargés sont hors du contrôle du service.
- La migration modifie la suppression d'entreprise : ses conversations, fiches, intégrations et données Phase 3 sont supprimées en cascade plutôt que transférées vers le périmètre personnel. Cet effet nécessite une sauvegarde et une validation opérationnelle avant publication.

## Compatibilité et interruption de service

Le frontend Phase 3 préfixe les opérations d'entreprise par `v3.`. L'Edge récent exige le marqueur SQL `business-workspace-v3` et les droits de l'utilisateur. `status` seul n'est qu'un test de connectivité : il ne valide ni ce protocole ni la migration. Une mutation au résultat inconnu n'est jamais rejouée automatiquement vers un autre transport ou vers le périmètre personnel.

| Frontend / Edge / base | Comportement observé localement |
| --- | --- |
| Ancien frontend, v22, base historique | Fonctionnement historique ; les conversations et la mémoire ne sont pas isolées selon le contrat Phase 3. |
| Frontend Phase 3, v22, avec ou sans migration | Les actions `v3.` sont rejetées par le **bundle v22 exact** avec `UNKNOWN_ACTION` ; le client affiche une mise à niveau requise, sans réessayer l'action non préfixée. |
| Frontend Phase 3, Edge récent, base historique | `status` peut répondre 200 mais les opérations `v3.` répondent 503 `AGENT_UNAVAILABLE` tant que le marqueur SQL manque, sans effet métier. |
| Ancien frontend, Edge récent, base Phase 3 | Les appels non préfixés de mémoire, modules et intégrations ciblent le périmètre personnel ; les listes historiques de conversations peuvent regrouper plusieurs entreprises accessibles. Une demande d'intégration envoyant un workspace est refusée avec mise à niveau requise. **Ce mélange ne constitue pas une UI isolée**. |
| Ancien frontend, v22, base Phase 3 (retour arrière Edge seul) | Les appels `v3.` restent inconnus. Les anciennes listes demeurent personnelles ou globales selon leur RPC. Tous les envois de messages v22 sont bloqués par la base avant appel fournisseur ; les approbations d'entreprise non atomiques et demandes d'intégration d'entreprise historiques sont également refusées. v22 masque ces refus en erreur générique 500. Le chat ancien n'est donc pas restauré. |
| Frontend et Edge Phase 3, base Phase 3 | Le protocole scoped et les contrôles de périmètre sont disponibles ; cette combinaison a été testée localement, pas encore sur le projet distant. |

Le blocage des messages v22 est volontaire : cet Edge prépare le prompt à partir de la mémoire personnelle avant de soumettre un message. Même pour une conversation personnelle, son corps HTTP peut contenir une entreprise, information absente de l'ancienne signature SQL. La base ne peut donc pas distinguer sûrement les usages et refuse toutes les anciennes soumissions après migration. Le nouveau service utilise une RPC distincte contrôlée.

**Ne pas laisser d'anciens onglets utiliser Business pendant la bascule ni après un retour arrière Edge seul.** Une fenêtre de maintenance doit empêcher également les accès directs à l'Edge et attendre la fin des requêtes en vol ; un simple bandeau frontend ne suffit pas. Aucun mécanisme de maintenance complet n'est fourni par cette modification. Ne pas interrompre les services Studio ni les paiements SasPay pour ce changement.

## Préparation d'une publication ultérieure

À réaliser seulement après accord et validation sur un environnement de préproduction représentatif :

1. Préparer et tester une sauvegarde/restauration compatible avec le reste du projet, inventorier les données historiques et prévoir une fenêtre de maintenance Business effective. Vérifier le schéma, les droits, les migrations déjà appliquées et les requêtes en vol. La migration locale est `supabase/migrations/20261114120000_business_agent_workspace.sql` ; ne pas rejouer à l'aveugle les migrations historiques de ce dépôt.
2. Sur une copie représentative, exécuter les deux bancs locaux ci-dessous, puis tester la migration et son retour arrière sur le vrai schéma Supabase, avec données et comptes de test non sensibles. Les stubs PostgreSQL locaux ne reproduisent pas toute la production.
3. En maintenance, appliquer la migration **transactionnellement**, puis vérifier le marqueur, les privilèges, les contraintes, les cascades et la présence des données attendues. Ne pas attribuer automatiquement les lignes personnelles aux entreprises.
4. Générer les artefacts, les contrôler et publier le bundle vérifié dans `public._edge_function_artifact` après publication d'un commit source immuable. Déployer uniquement `supabase/functions/business-grow/loader.ts` pour le canal hébergé : `bootstrap.ts` est trop long pour ce canal. Conserver l'artefact et le chargeur précédents. Les détails du stockage et du SHA figurent dans `docs/incident-business-grow-prod-20261112.md` ; ne pas lancer globalement `scripts/deploy-edge-functions.sh`.
5. Vérifier le nouvel Edge avec une session de test : marqueur et appels `v3.`, deux entreprises, retrait de membre, mémoire consentie/révoquée, rapports, proposition/approbation, Sales Automation et intégrations locales. Vérifier aussi les erreurs, CORS et l'absence d'actions externes inattendues. Nettoyer uniquement les données de test explicitement créées.
6. Publier le frontend, forcer son actualisation et vérifier depuis un navigateur réel que les anciens clients ne peuvent plus agir avant d'ouvrir le trafic Business. Documenter la version frontend et Edge réellement servie.

**Retour arrière :** conserver la maintenance. Redéployer seulement le chargeur v22 ne restaure pas l'ancien comportement de la base ni le chat ; le frontend Phase 3 refusera v22. Cette migration n'a pas de script inverse validé : ses remplacements de fonctions, contraintes et cascades ne doivent pas être annulés à la main en production. Préférer une correction compatible Phase 3 ; sinon préparer et tester explicitement une migration compensatoire ou une restauration, en évaluant la perte éventuelle des écritures postérieures et l'impact sur les autres services. La simulation locale ne prouve pas une restauration distante.

## Vérifications reproductibles

```bash
npm ci
npm run typecheck
npm test -- --reporter=dot
npm run build
node scripts/build-business-grow-artifact.mjs --check
npm run check:edge-imports
git diff --check
# Dépendances locales préexistantes : npm ci --prefix supabase/tests/saspay
npm run audit:business-rls  # actuellement BLOQUÉ
```

Les bancs PostgreSQL historiques utilisent les dépendances de `supabase/tests/saspay`, sur une base jetable locale PostgreSQL 17 ; ils ne lancent pas les tests SasPay et ne contactent pas les services distants. Avant la découverte du problème RLS, `run.mjs` testait deux installations, dont une avec anciennes fiches et migration rejouée, ainsi que des créations concurrentes. `compat.mjs` exécutait le bundle courant et la fixture v22 exacte (`908af379…`), avec Auth et transport SQL simulés. Ces bancs exécutaient toutefois des fonctions détenues par un rôle `BYPASSRLS` : **ne pas les utiliser pour démontrer la conformité RLS et les adapter avant de les rejouer**. Ils ne testent ni la passerelle Supabase réelle ni un fournisseur externe.

Les tests d'interface couvrent notamment les doubles clics, le changement d'entreprise, les aperçus potentiellement tronqués et l'interruption d'un lot. Un audit Chromium desktop et mobile antérieur a parcouru rapports, confirmation de tâche et aperçu Sales Automation avec des données et mutations **simulées**, sans erreur navigateur ni débordement horizontal mesuré. La barrière `audit:business-rls` est actuellement en échec et bloque toute livraison ; les derniers résultats détaillés et les prérequis figurent dans le document de préproduction.

## État distant constaté en lecture seule

Le 13 novembre 2026, le projet `xbuuhfwobrafcbgtdgjx` était actif sur PostgreSQL 17.6. La fonction `business-grow` était **v22 ACTIVE**, `verify_jwt=true`, avec le chargeur pointant sur le bundle SHA-256 `908af379b0eebc8ea89f35d1f912c38bfa59b7ef309ef86118af2f988b417952` (43 683 caractères). La ligne correspondante existe dans le magasin d'artefacts.

Les tables de modules et de rapports ainsi que le marqueur et la RPC de soumission scoped Phase 3 étaient absents. L'intégration historique est enregistrée sous la migration distante `20261113042319`. Le bundle Phase 3 local à cette vérification a le SHA-256 `bbac580fcb25541e5caab85a8f72bd32586a78f24b8e2fd400150475978ae221` (75 940 caractères) ; il n'apparaissait pas dans le magasin distant. Ces constats ne prouvent pas que l'état restera inchangé : les reprendre immédiatement avant toute publication.

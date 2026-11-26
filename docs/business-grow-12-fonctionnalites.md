# Business Grow — 12 fonctionnalités à forte valeur

**Statut :** audit fait, construction en cours. Aucun connecteur (WhatsApp, Meta,
Google) n'est développé ni supposé : tout repose sur la saisie, l'import
CSV/Excel, les liens, l'e-mail et les rappels internes.

## Phase 0 — tableau d'audit

État constaté dans le dépôt (lecture de `src/business/`, `supabase/migrations`,
`supabase/functions/business-grow/`, `tests/`).

| # | Fonctionnalité | État actuel | Preuve dans le dépôt | Décision |
|---|---|---|---|---|
| 1 | Litiges et chargebacks | **partielle** | `ReceivableDispute` + statuts + risque dans `finance/model.ts`, modale dans `FinanceWorkspace` ; aucun échéancier, aucune collecte de preuves, aucun brouillon de réponse | Compléter |
| 2 | Encaissement et relances | **partielle** | Créances, paiements, promesses, relances (`CollectionReminder`), modèles `RECOVERY_TEMPLATES`, encours par ancienneté | Compléter (prochaine relance lisible, statut par créance) |
| 3 | Prévision de trésorerie | **absente** | `cash/model.ts` calcule le réalisé (mensuel, catégories, dépenses inhabituelles) ; `detectUnusualExpenses`. Aucune projection | Construire |
| 4 | Devis, factures, contrats | **partielle** | Devis/commandes/factures, totaux, devises par document, `printableDocument` (HTML, `lang="fr"`), conversion devis→facture | Compléter (lien partageable, statut « vu », langue du document) |
| 5 | Rentabilité et fuites | **partielle** | `catalog.model.cost`, `detectUnusualExpenses`, `recurrence` des dépenses ; aucun calcul de marge par produit | Compléter |
| 6 | Prospects en pilote automatique | **partielle** | CRM contacts/opportunités, score et priorité (`crm/model.ts`), `nextAction`/`nextActionAt`, relances ; pas de formulaire de capture | Compléter |
| 7 | Réponses et messages préparés | **existe (partiel)** | `RECOVERY_TEMPLATES` (6 modèles, canaux, variables) ; limité au recouvrement | Améliorer (situations hors recouvrement, copie/lien préparé) |
| 8 | Briefing quotidien | **absente** | Aucun agrégateur « 3 priorités » ; `AgentReports` produit des rapports à la demande | Construire — **fait dans cette PR** |
| 9 | Automatisations sans code | **partielle** | `automation/model.ts` (déclencheurs, actions, signaux, exécutions proposées/confirmées) ; pas de conversion phrase → règle, pas de test à blanc | Compléter |
| 10 | Échéances et conformité | **absente** | Rien. Seule trace : catégorie de dépense « Impôts et taxes » | Construire (rappels paramétrables, jamais du conseil) |
| 11 | Veille marché et concurrence | **partielle et non exposée** | `growth/model.ts` définit `GrowthCompetitor`/`GrowthSignal` et des lecteurs de mémoire ; **aucune interface ne les affiche et aucune écriture n'existe** (`growthRecordCounts` n'est appelé nulle part) | Compléter et exposer |
| 12 | Du chiffre à la vidéo | **partielle** | Outil `handoff_ugc_brief` déclaré et validé dans `business-grow/intelligence.ts` (niveau « validation requise »), règle de devis du Studio | Compléter (déclencheur depuis une donnée Grow) |

### Socle de l'agent

| Élément | État actuel | Décision |
|---|---|---|
| Lecture des données par espace | **existe** | `bg_can_workspace`, `module_records` scopé `workspace_id`, `useRecords` |
| Outils avec schéma validé | **partielle** | 5 outils déclarés, non schématisés, majoritairement des propositions | Construire le registre — **fait dans cette PR** |
| Trois niveaux d'autonomie | **partielle** | `risk_level` figé par outil et `pending_approval` par défaut ; pas de niveau par action configurable | Construire — **fait dans cette PR** |
| Journal consultable et annulable | **partielle** | `tool_executions` (statuts, avant/après implicite) mais non exposé comme journal métier | Construire — **fait dans cette PR** |
| Contenu externe = donnée | **partielle** | Consigne écrite dans le prompt (`intelligence.ts`), **aucun test** | Construire + tests — **fait dans cette PR** |

## Découpage en PR

| PR | Contenu |
|---|---|
| 1 (celle-ci) | Socle : niveaux d'autonomie, registre d'outils, journal, séparation donnée/instruction, briefing quotidien, tests d'injection |
| 2 — argent | Litiges (dossier, échéances, preuves existantes, brouillon), relances progressives, prévision de trésorerie 4/8/12 semaines |
| 3 — clients | Devis/factures (lien partageable, statut vu, langue), rentabilité par produit, prospects (score, prochaine action, capture) |
| 4 — pilotage | Automatisations en une phrase + test à blanc, échéances et conformité, veille concurrence, du chiffre à la vidéo |

## Suite explicitement non faite

- Saisie par photo ou par voix : non disponible aujourd'hui, non inventée.
- Connecteurs de messagerie : hors périmètre (vérifications en attente).

---

## État livré — mise à jour

### Fonctionnalités réellement construites ou complétées

| # | Ce qui a été livré | Où | Branché dans l'interface ? |
|---|---|---|---|
| 1 | Dossier de litige : montant, devise, échéance, alerte, inventaire de preuves, brouillon de réponse | `finance/litiges.ts` | **Non** — module testé, écran à brancher |
| 3 | Prévision de trésorerie 4/8/12 semaines, actions chiffrées en cas de trou | `cash/prevision.ts` | **Oui** — écran Trésorerie |
| 5 | Marge réelle par produit, ventes à perte, doublons d'abonnement, couverture du coût | `catalog/rentabilite.ts` | **Non** — module testé, écran à brancher |
| 6 | Prochaine action obligatoire, classement des prospects, capture validée, message à copier | `crm/pilote.ts` | **Non** — module testé, écran à brancher |
| 8 | Briefing : 3 priorités maximum, tri déterministe | `agent/socle/briefing.ts` | **Non** — module testé, écran à brancher |
| 9 | Phrase → règle structurée, test à blanc sur données réelles | `automation/phrase.ts` | **Oui** — formulaire Automatisations |
| Socle | Autonomie fermée par défaut, 9 outils à schéma fermé, journal annulable, contenu externe = donnée | `agent/socle/` | **Non** — briques prêtes |

### Fonctionnalités non commencées (à dire clairement)

| # | Reste à faire |
|---|---|
| 2 | Relances progressives : l'existant (modèles, promesses, statuts) est complet ; manquent la prochaine relance planifiée visible et le statut par créance en tête de liste |
| 4 | Lien partageable, statut « vu », langue du document |
| 7 | Modèles hors recouvrement (situations commerciales, SAV) |
| 10 | Échéances et conformité : rien n'existe |
| 11 | Veille concurrence : modèle présent, aucune interface, aucune écriture |
| 12 | Déclencheur « du chiffre à la vidéo » depuis une donnée Grow |

### Suite explicitement non faite

- **Saisie par photo ou par voix** : non disponible dans le produit aujourd'hui, non inventée.
- **Connecteurs WhatsApp / Meta / Google** : hors périmètre (vérifications en attente).
- **Test sur Android physique** : aucun appareil ni émulateur disponible dans cet environnement. Les tests responsive automatisés ne remplacent pas un test matériel — je ne prétends donc pas l'avoir fait.
- **Migrations** : aucune ajoutée. Tout repose sur `saas_business.module_records`, déjà en place, avec RLS et isolation par espace.

### Garde-fous vérifiés

- Aucune donnée de démonstration en production : les tests utilisent des données simulées, jamais le produit.
- Aucune fonctionnalité retirée.
- Aucun secret ajouté.
- Les gardes Netlify (`netlify.toml`, `netlify.site.conf`, `scripts/`) n'ont pas été touchées.

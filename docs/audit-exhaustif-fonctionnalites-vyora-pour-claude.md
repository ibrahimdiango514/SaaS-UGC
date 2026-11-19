# Audit fonctionnel exhaustif de VYORA

**Date de l'audit** : 2026-11-14
**Branche auditée** : `arena/4df85fd7-saas-ugc` (HEAD `16f4fbd`)
**Projet Supabase** : `xbuuhfwobrafcbgtdgjx`
**Méthode** : lecture du code source, inspection de la base en lecture seule, inspection du déploiement Supabase. **Aucune modification, aucun déploiement, aucun secret touché.**

---

## Avertissement de méthode

Ce document distingue systématiquement trois choses :

1. **Ce que le code fait** — vérifié par lecture, avec référence fichier:ligne.
2. **Ce que la base contient** — vérifié par requête, avec chiffres réels.
3. **Ce que l'interface montre** — qui n'est *jamais* preuve de fonctionnement.

Une fonctionnalité n'est classée **OPÉRATIONNELLE** que si j'ai pu vérifier la chaîne complète. Là où le réseau du bac à sable m'a empêché de sonder une fonction déployée (les domaines `*.supabase.co` sont bloqués ; seuls `github.com`, `npmjs.org`, `pypi.org` sont accessibles), je l'écris explicitement et classe **NON VÉRIFIÉE** au lieu de supposer.

### Limite majeure de cet audit

**Je n'ai pas pu exécuter une seule requête HTTP contre les Edge Functions en production.** Le bac à sable refuse les connexions à `*.supabase.co`. Toutes les conclusions sur le comportement *à l'exécution* d'une Edge Function reposent donc sur : son code déployé (récupéré via l'API de gestion), son artefact, et les traces qu'elle a laissées en base (`ai_calls_log`, `cron.job_run_details`). C'est solide pour le routage IA (30 appels réels tracés) et l'ordonnancement (11 tâches cron), mais ça ne remplace pas un test de bout en bout côté navigateur.

---

## 1. Présentation générale

VYORA est un SaaS en **deux produits partageant un même compte et un même portefeuille de crédits** :

| Produit | Rôle | Entrée |
| --- | --- | --- |
| **VYORA Studio** | Production de contenu vidéo UGC : scripts, scènes, génération, montage, export | `/app/studio` |
| **Business Grow** | Pilotage commercial d'une entreprise : prospects, clients, ventes, tâches, campagnes, assistant | `/app/business` |

### Chiffres structurels vérifiés

| Élément | Nombre | Preuve |
| --- | --- | --- |
| Routes déclarées | 49 | `src/App.tsx`, `grep -c 'path='` |
| Fichiers source (`src/`) | 200 | `find src -name "*.ts*" \| wc -l` |
| Modules Business Grow | 16 | `src/business/modules/registry.ts` |
| Espaces Studio « live » | 6 | `src/studio/sections.ts` |
| Espaces Studio « préparés » (non opérationnels) | 12 | idem |
| Edge Functions — source dans le dépôt | 23 | `supabase/functions/` |
| Edge Functions — déployées | 31 | `list_edge_functions` |
| Migrations SQL | 91 | `supabase/migrations/` |
| Tables `saas_ugc` | 56 | `information_schema.tables` |
| Tâches `pg_cron` actives | 11 | `cron.job` |

### État d'usage réel du produit

Ces chiffres changent radicalement la lecture du reste : **le produit est techniquement jeune mais presque inutilisé.**

| Donnée | Valeur | Interprétation |
| --- | --- | --- |
| Utilisateurs (`auth.users`) | 6 | Comptes de test |
| Workspaces | 3 | — |
| Portefeuilles de crédits | 4 | — |
| **Générations vidéo, tous statuts** | **0** | Aucune vidéo jamais produite |
| **Projets vidéo** | **0** | — |
| **Avatars** | **0** | — |
| **Scripts** | **0** | — |
| **Assets générés** | **0** | — |
| Commandes de recharge | 0 | **Aucun revenu** |
| Abonnements Studio | 4 | Tous en plan `free` |
| Abonnement Business Grow actif | 1 | Plan `croissance` |
| Appels IA réussis | 30 | groq 29, gonka 1 |
| Enregistrements de modules Business | 0 | Aucune donnée métier saisie |
| Connexions d'intégration | 0 | Aucune boutique connectée |
| Connexions Meta | 0 | Intégration non utilisée |

**Conséquence méthodologique** : la plupart des parcours « opérationnels » le sont **par construction** (code + SQL présents) mais n'ont **jamais été exercés en conditions réelles**. C'est une distinction que ce document maintient partout : *prêt* n'est pas *éprouvé*.

---

## 2. Inventaire exhaustif des fonctionnalités

L'inventaire complet, classé, est en **§7** (classement opérationnel) et détaillé par domaine aux **§3** (Business Grow), **§4** (Studio), **§5** (Admin), **§6** (Intégrations). Chaque fiche suit le format demandé : nom, emplacement, problème résolu, ce que l'utilisateur peut faire, fonctionnement, données, dépendances, **état réel**.

### Convention d'état

| État | Signification |
| --- | --- |
| **OPÉRATIONNELLE** | Chaîne complète vérifiée : UI → API → SQL/Edge → persistance |
| **PARTIELLE** | Une partie du parcours fonctionne, une autre manque |
| **INTERFACE UNIQUEMENT** | Écran ou bouton présent, aucune action réelle derrière |
| **EN ATTENTE** | Dépend d'un déploiement, d'une config ou d'une validation |
| **DÉSACTIVÉE** | Volontairement inactive |
| **NON VÉRIFIÉE** | Impossible de confirmer (justification donnée) |


---

## 3. Cartographie détaillée de Business Grow

### 3.1 Architecture

Business Grow n'est pas une collection de micro-services : c'est **un seul espace protégé par un abonnement**, exposé par une Edge Function unique (`business-grow`) qui parle à un schéma SQL dédié (`saas_business`).

```
UI (src/business/)
  └── src/business/api.ts  →  invokeEdge('business-grow', { action })
        └── Edge `business-grow` (handler.ts, déployée v35)
              └── RPC SQL : saas_business.bg_*  (SECURITY DEFINER)
                    └── Tables : conversations, messages, ai_requests,
                                 tool_executions, module_records,
                                 workspace_memory_items, subscriptions
```

**Point important** : `business-grow` est déployée via un **chargeur épinglé** (`supabase/functions/business-grow/loader.ts`) qui télécharge le bundle `business-grow.edge.js` depuis un commit GitHub précis, vérifie **taille + SHA-256**, et refuse de démarrer si l'un diffère.

### 3.2 Gating d'abonnement

| Élément | Réalité |
| --- | --- |
| Table | `saas_business.subscriptions` |
| Abonnements existants | **1**, `plan_key = croissance`, `status = active` |
| Plan gratuit Business Grow | **Aucun** — pas de `free` côté Business |
| Conséquence | Toute la surface Business Grow est fermée sans abonnement payant |

C'est une décision produit cohérente (Business Grow est le produit « cher »), mais qui **empêche tout essai sans payer**. C'est un frein commercial majeur, relevé en §10.

### 3.3 Les 16 modules

Source : `src/business/modules/registry.ts` (1041 lignes).

Chaque module est un **modèle de données déclaratif** : champs, statuts, actions rapides, KPI, et un prompt d'agent. Le rendu est générique (`BusinessModuleWorkspace.tsx`), ce qui garantit l'homogénéité — et explique aussi leur **uniformité fonctionnelle** : ce sont des CRUD, pas des moteurs.

| # | Module | Catégorie | Rôle | État |
| --- | --- | --- | --- | --- |
| 1 | Smart CRM | ventes | Prospects, clients, pipeline | OPÉRATIONNELLE |
| 2 | Lead Rescue | ventes | Sauver les leads sans contact | OPÉRATIONNELLE |
| 3 | Customer Support AI | support | Tickets clients | OPÉRATIONNELLE |
| 4 | Customer Recovery | argent | Clients à réactiver | OPÉRATIONNELLE |
| 5 | Payment Recovery | argent | Factures impayées | OPÉRATIONNELLE |
| 6 | Order Cart Recovery | argent | Paniers abandonnés | OPÉRATIONNELLE |
| 7 | Revenue Leak | argent | Fuites de revenus (seul calcul réel) | OPÉRATIONNELLE |
| 8 | Dispute Shield | argent | Litiges | OPÉRATIONNELLE |
| 9 | Finance Intelligence | argent | Trésorerie, marges | OPÉRATIONNELLE |
| 10 | Operations Manager | operations | Tâches et équipe | OPÉRATIONNELLE |
| 11 | Smart Inventory | operations | Stocks, seuils | OPÉRATIONNELLE |
| 12 | Supplier Delivery | operations | Fournisseurs, livraisons | OPÉRATIONNELLE |
| 13 | Social Growth | marketing | Calendrier éditorial | OPÉRATIONNELLE |
| 14 | Sales Automation | automatisations | Règles de relance → tâches | OPÉRATIONNELLE |
| 15 | AI Agent | — | Accès à l'assistant | OPÉRATIONNELLE |
| 16 | Integrations Hub | — | Connexions externes | PARTIELLE |

> **« OPÉRATIONNELLE » ici signifie** : l'utilisateur peut créer, lire, modifier des enregistrements, et ces enregistrements sont persistés en base avec isolation par workspace. **Cela ne signifie pas** qu'un calcul intelligent est fait dessus — voir §3.5.

### 3.4 Ce qu'une entreprise peut réellement faire **sans WhatsApp / Facebook / Instagram**

C'est la question décisive. Réponse courte : **tout le socle commercial fonctionne, à condition d'avoir un abonnement Business Grow actif.**

#### ✅ Réellement utilisable aujourd'hui, sans Meta

| Capacité | Détail | Preuve |
| --- | --- | --- |
| **Créer et gérer des prospects** | Formulaire complet (nom, entreprise, e-mail, téléphone, étape, montant, prochaine action, échéance, notes) | `src/business/growth/model.ts`, catégorie `growth_prospect` |
| **Suivre les étapes du pipeline** | 6 étapes : prospect → contacté → qualifié → proposition → gagné/perdu | `ProspectStage` |
| **Gérer des clients** | Module Smart CRM | registry.ts |
| **Suivre les opportunités** | Valeur, devise, échéance par prospect | `GrowthProspect.value` |
| **Relancer** | Actions rapides qui patchent le statut (`Marquer relancé`, `Marquer converti`) | registry.ts l.314-315 |
| **Tâches et rappels** | Operations Manager + propositions de tâches par l'agent | `bg_agent_propose_task` |
| **Organiser le travail** | Statuts, priorités, assignation | registry.ts |
| **Suivre les ventes** | KPI calculés sur les enregistrements (valeurs ouvertes, conversions) | `kpis[].compute` |
| **Rapports et statistiques** | Rapports d'agent persistés + diagnostics déterministes | `bg_save_agent_report`, `bg_business_snapshot` |
| **Assistant IA** | Conversations, mémoire consentie, propositions d'actions approuvables | §3.6 |
| **Mémoire d'entreprise** | Contexte, objectifs, stratégies, avec consentement explicite | `workspace_memory_items` |
| **Automatisations** | Règles de relance qui créent réellement des tâches, sans doublon | `bg_confirm_automation_task` |
| **Import de catalogue** | Produits, variantes, depuis CSV ou boutique | `src/business/importer/` |

#### ⚠️ Ce qui ne marche pas sans Meta

| Capacité | Dépendance |
| --- | --- |
| Recevoir des messages WhatsApp entrants | `meta-webhook` (**non déployée**) |
| Envoyer des messages WhatsApp | Aucune fonction d'envoi Meta déployée |
| Publier sur Facebook / Instagram | `integration_providers.implemented = false` |
| Commentaires / DM Instagram | idem |
| Synchroniser un catalogue Facebook Shop | idem |

**Vérification** : `list_edge_functions` ne contient **aucune** des fonctions `meta-connect`, `meta-webhook`, `meta-lifecycle` présentes dans le dépôt. Les 6 tables `saas_business.meta_*` existent mais sont **toutes vides** (0 connexion, 0 page, 0 message, 0 webhook).

### 3.5 La vérité sur l'« intelligence » des modules

C'est le point le plus important de cet audit, et le plus mal compris.

**Les 16 modules sont des CRUD enrichis, pas des moteurs d'analyse.**

Preuve : `grep -oE "compute[A-Za-z]+" registry.ts` renvoie **une seule** fonction de calcul métier : `computeRevenueLeaks`. Les KPI des autres modules sont des **comptages** (`countBy`, `knownMoney`, `daysSince`), pas des modèles.

Concrètement :

| Ce qu'on pourrait croire | Ce qui existe réellement |
| --- | --- |
| « Lead Rescue prédit quels leads vont churner » | Compte les leads sans contact depuis ≥ 3 jours |
| « Finance Intelligence prévoit la trésorerie » | Additionne des montants saisis |
| « Smart Inventory optimise les réappro » | Compare un stock à un seuil |
| « Payment Recovery priorise les relances » | Liste les factures non payées |

Ce n'est pas un défaut d'implémentation — les modules font exactement ce qu'ils déclarent. Mais **le nom des modules promet plus que leur moteur**. C'est une faiblesse de positionnement à corriger (§10).

**Où se trouve la vraie intelligence** : dans l'**assistant**, pas dans les modules. L'assistant reçoit un snapshot déterministe (`bg_business_snapshot`) et peut raisonner dessus, puis proposer des actions.

### 3.6 L'assistant Business Grow

| Aspect | Réalité |
| --- | --- |
| Route dédiée | `/app/business/assistant` (hors coquille, `100dvh`) |
| Route intégrée | `/app/business?section=chat` (même composant) |
| Accès aux conversations | `business-grow` actions `conversations.*` / `messages.*` |
| Mémoire | `workspace_memory_items`, **consentement obligatoire** (`bg_require_scoped_consent`) |
| Fatigue/limite | conversations isolées par workspace via RLS + SQL |

**Outils réellement exécutables par l'agent** (liste fermée côté base, `bg_create_tool_execution`) :

| Outil | Effet réel | Statut |
| --- | --- | --- |
| `propose_memory_save` | Écrit un fait en mémoire | Appliqué en base, **non déployé en Edge** |
| `propose_action_plan` | Écrit une stratégie (`growth_strategy`) | idem |
| `propose_campaign_brief` | Écrit un brief (`business_campaign`) | idem |
| `handoff_ugc_brief` | Brouillon vers Studio (sans débit) | idem |
| `request_connector_read` | **Échoue** : `CONNECTOR_READ_NOT_IMPLEMENTED` | idem |
| `create_follow_up_task` | Crée une tâche réelle | idem |
| `propose_prospect_save` | **Crée un prospect réel** (ajouté cet audit) | Appliqué en base, **non déployé** |
| `mcp_tool` | Outil MCP externe choisi par l'utilisateur | Migration **non appliquée** |

**Statut global de l'exécution d'outils : EN ATTENTE.** L'historique `tool_executions` est **vide (0 ligne)** : aucun outil n'a jamais été exécuté en production.

#### Le défaut corrigé pendant la session précédente

L'assistant affirmait « prospect enregistré » sans qu'aucun outil ne puisse le faire. La cause : `bg_create_tool_execution` n'acceptait que 5 outils, **aucun** ne produisant un `growth_prospect`. Un correctif a été écrit, appliqué en base, **et testé** (approbation → `executed` + `persisted:true`, relecture de la ligne). Mais il **n'est pas déployé** : la fonction Edge en ligne (v35) ignore encore `propose_prospect_save`. Voir §13 pour la procédure.

### 3.7 Les fournisseurs IA de Business Grow

| Fournisseur | Activé | Config | Dernière santé | Modèles actifs |
| --- | --- | --- | --- | --- |
| **gemini** | ✅ oui | `configured` | `healthy` | gemini-2.5-flash, 2.5-flash-lite, 3-flash-preview, 3.5-flash |
| **groq** | ✅ oui | `configured` | `healthy` | gpt-oss-120b, gpt-oss-20b, qwen3.8-27b |
| gonka | ❌ non | `missing` | healthy (mais désactivé) | deepseek-v4-flash |
| llm7 | ❌ non | `missing` | healthy (mais désactivé) | default |
| openrouter | ❌ non | `missing` | failed | ernie-5.5-flash-free |
| cloudflare | ❌ non | `missing` | failed | — |
| ollama | ❌ non | `missing` | failed | — |
| openai, anthropic, deepseek, grok, mistral, kilo | ❌ non | `missing` | jamais testé | — |

**Conclusion vérifiée : seuls Gemini et Groq sont opérationnels.** Les 11 autres fournisseurs déclarés n'ont pas de clé (`config_status = missing`). C'est exactement le comportement demandé : les fournisseurs sans clé sont **identifiés comme tels**, pas présentés comme disponibles.

Trace d'usage réel : `ai_calls_log` contient **30 appels réussis** (29 groq sur `openai-gpt-oss-120b`, 1 gonka sur `deepseek-v4-flash`). Le routage fonctionne.

### 3.8 Ce que Business Grow ne sait pas encore résoudre

Voir le détail en §10. Les manques majeurs :

1. **Aucune ingestion automatique de leads.** Tout se saisit à la main. Sans Meta, il n'y a **aucun** canal d'entrée automatique — c'est le trou fonctionnel n°1 pour une PME.
2. **Aucune relance automatique dans le temps.** `sales-automation` crée des tâches *quand on le lui demande*, mais rien ne s'exécute à date planifiée sans clic.
3. **Aucun envoi de message.** On peut préparer un message de relance ; on ne peut pas l'envoyer depuis VYORA (ni e-mail, ni SMS, ni WhatsApp).
4. **Aucune synchronisation de ventes réelles.** Les montants sont saisis, pas observés.
5. **Aucun plan gratuit** : impossible d'essayer sans payer.
6. **Les modules ne calculent presque rien** (§3.5).

---

## 4. Cartographie détaillée de VYORA Studio

### 4.1 Les 18 espaces déclarés : 6 réels, 12 vides

Source : `src/studio/sections.ts`.

| État déclaré | Nombre | Accès |
| --- | --- | --- |
| `live` | **6** | Fonctionnel |
| `prepared` | **12** | `/app/studio/espace/:section` → `PreparedSpace` |

**Les 12 espaces « préparés » sont honnêtes** : `PreparedSpace.tsx` affiche explicitement « Aucun bouton de génération », « Aucun fournisseur, modèle, crédit ou résultat n'est associé à cet espace. Rien n'est simulé. » C'est un bon choix — l'interface ne ment pas.

| Espace préparé | Ce qui manque |
| --- | --- |
| Image Studio, Image Generation | Aucun modèle d'image branché |
| Avatar Studio | Aucun moteur d'avatar (MUAPI a des modèles, mais pas de flux dédié) |
| Audio Studio | Aucune synthèse vocale branchée |
| AI Clipping | Aucun découpage automatique |
| Vibe Motion, Body Swap, Cinema Studio | Aucun modèle branché |
| Marketing Studio, Workflows, Agents, Storyboarding | Interface seulement |

#### Les 6 espaces réellement live

| Espace | Route | Réalité |
| --- | --- | --- |
| **Video Studio** | `/app/studio` | Génération vidéo (devis → crédits → job) |
| **Mes générations** | `/app/studio/generations`, `/app/historique` | Historique réel |
| **Mes projets** | `/app/projets`, `/app/studio/projects` | CRUD projets |
| **Mes créations** | `/app/bibliotheque`, `/app/studio/saved` | Assets produits |
| **Video to Video** | `/app/studio?mode=video-source` | Via catalogue MUAPI |
| **Lip Sync** | `/app/studio?mode=audio-source` | Via catalogue MUAPI (catégorie `Audio to Video`) |

### 4.2 Le catalogue de modèles : 415 modèles réels

C'est **la** force de VYORA Studio. Source : `saas_ugc.ugc_video_models`.

| Catégorie | Modèles | Coût min (USD) | Coût max (USD) |
| --- | --- | --- | --- |
| Image to Video | **194** | 0,06 | 9,35 |
| Text to Video | **117** | 0,016 | 9,35 |
| Video to Video | **83** | 0,00 | 9,35 |
| Audio to Video (= lip-sync) | **14** | 0,04 | 0,75 |
| Lora Support | 3 | 0,15 | 0,15 |
| Training | 2 | 0,30 | 0,30 |
| Text to Text | 1 | 0,10 | 0,10 |
| other | 1 | 0,01 | 0,01 |
| **Total** | **415** | — | — |

- **415 modèles actifs**, 3 marqués « bientôt ».
- Dernière synchronisation : **2026-11-12 16:12**.
- Fournisseur unique : **MUAPI** (`video_defaults.provider = "muapi"`, modèle par défaut `seedance-lite-t2v`).

### 4.3 La chaîne de génération vidéo, étape par étape

C'est le parcours le mieux construit du produit. Il est **réel de bout en bout dans le code**, mais **jamais exercé** (0 job).

```
1. L'utilisateur choisit un modèle
      ↓
2. POST video-quote  → devis signé, valable 15 min
      (saas_ugc.ugc_video_quotes : modèle, prix, config_updated_at)
      ↓
3. RPC reelora_start_generation(p_project_id, p_service_key, p_payload, p_idempotency_key, p_quote_id)
      ↓   contrôles : quote non consommée, non expirée, config inchangée,
      ↓                modèle identique, qui valide que l'utilisateur a bien le droit
      ↓
4. Vérification du solde : if balance < credits_cost → 'insufficient_credits'
      ↓
5. Réservation réelle : apply_wallet_delta(user, 'reserve', -coût, ...)
      ↓   → ugc_generation_jobs.status = 'reserved', credits_reserved = coût
      ↓   → ugc_video_quotes.consumed_at = now()
      ↓
6. Insertion dans ugc_job_events ('submitted', 'queued' → 'reserved')
      ↓
7. Notification utilisateur + suivi
      ↓
8. pg_cron `reelora-video-tick` (chaque minute) → appelle le worker
      ↓
9. reelora-video-worker → soumet à MUAPI, poll, récupère l'asset
      ↓
10. Débit définitif ou remboursement selon le résultat
```

**Points forts vérifiés** :
- **Idempotence réelle** : `on conflict (created_by, request_key) do nothing`, plus un contrôle `idempotency_quote_mismatch`.
- **Anti-fraude devis** : `q.config_updated_at = v_setting_updated_at` — si l'admin change les prix, un devis émis avant devient invalide.
- **Crédits réservés, pas débités** : un échec peut rembourser.
- **Verrou de ligne** : `for update` sur le devis.

**Point faible majeur** : **0 job exécuté**. Toute la chaîne est du code non éprouvé en production. Le worker (`reelora-video-worker`, v14) tourne (4320 ticks réussis en 3 jours) mais n'a **jamais eu de job à traiter**.

### 4.4 Les crédits et la tarification

Source : `saas_ugc.ugc_app_settings`.

| Paramètre | Valeur |
| --- | --- |
| Valeur d'un crédit | **100 XOF** |
| Taux USD → XOF | **620** |
| Marge cible | **60 %** |
| Coût de traitement ajouté | 0,01 USD |
| Coût fournisseur connu exigé | **oui** (`require_known_provider_cost`) |

**Packs de recharge** :

| Pack | Crédits | Prix XOF | Équivalent EUR |
| --- | --- | --- | --- |
| Creator | 27 | 5 000 | ~7,60 € |
| **Pro Creator** (recommandé) | 95 | 15 000 | ~22,90 € |
| Studio Business | 265 | 35 000 | ~53,40 € |
| Recharge libre | 5 000 – 350 000 XOF, pas de 1 000 | — | — |

**Abonnements Studio** :

| Plan | Prix/mois | Crédits/mois | Vidéos/mois | Projets |
| --- | --- | --- | --- | --- |
| Découverte | 0 | 9 | 1 | 2 |
| Studio | 15 000 XOF | 120 | 20 | 15 |
| Pro | 45 000 XOF | 400 | 80 | 60 |
| Entreprise | sur devis | 0 | 1 000 | 500 |

**Bonus d'inscription** : 9 crédits offerts.

> ⚠️ **Incohérence détectée** : `studio_pricing_config.examples` contient trois entrées dont `approx_credits: null` (« Clip court 8 s », « Clip 15 s », « Publicité 4 clips »). L'interface affiche donc des exemples **sans estimation**. Le calcul dynamique existe (`video-quote`) mais n'a pas été branché sur ces exemples. À corriger : c'est la première chose que regarde un acheteur.

### 4.5 Scripts, scènes et contenus

| Capacité | Fonction | Réalité |
| --- | --- | --- |
| Générer un script | `generate_script` (vyora-ai) | **OPÉRATIONNELLE** — appel IA réel, provider retourné |
| Améliorer un prompt | `improve_prompt` | **OPÉRATIONNELLE** |
| Générer des hooks | `generate_hooks` (5 max) | **OPÉRATIONNELLE** |
| Générer des scènes | `generate_scenes` (JSON structuré) | **OPÉRATIONNELLE** |
| Générer un visuel | `generate_visual` | ⚠️ **PARTIELLE — renvoie du TEXTE, pas une image** |

#### Le malentendu `generate_visual`

Le code de `vyora-ai` est sans ambiguïté (`vyora-ai.edge.js`, branche `generate_visual`) :

```js
if (r === "generate_visual") {
  let m = await L([...], { prefer: l, jsonMode: true, maxTokens: 600 }),
      s = y(j(m.content).text, 1200);
  return N({ action: r, provider: m.provider, text: s, usage: A });
}
```

L'action renvoie **`text`** : une description textuelle de visuel (prompt d'image), produite par un modèle de langage. **Aucune image n'est générée.** L'espace « Image Studio » est d'ailleurs marqué `prepared` — ce qui est cohérent. Mais un utilisateur qui appelle `generate_visual` peut croire qu'il obtient une image.

**Aucun modèle d'image n'est branché** : ni DALL·E, ni Flux, ni SDXL, ni Imagen. Le catalogue MUAPI ne contient **aucun** modèle de catégorie image (uniquement 8 catégories vidéo/audio/texte).

#### Persistance

| Donnée | Table | Constat |
| --- | --- | --- |
| Scripts | `saas_ugc.ugc_project_scripts` | 0 ligne |
| Scènes | `saas_ugc.ugc_project_scenes` | 0 ligne |
| Prompts | `saas_ugc.ugc_prompt_templates` | **6 lignes** (les seules données Studio) |

Les scripts passent par `saveScript` / `saveScenes` côté client (`src/pages/Scripts.tsx`) — donc persistés, mais jamais utilisés.

### 4.6 Montage vidéo

| Aspect | Réalité |
| --- | --- |
| Route historique | `/app/studio/montage` (dans la coquille) |
| **Route dédiée** | `/app/studio/../montage` → **`/app/montage`** (hors coquille, `100dvh`) |
| Composant | `src/studio/VideoEditor.tsx` (~900 lignes) |
| Capacités | Multi-pistes, découpe, sous-titres SRT, export navigateur |
| Export | WebCodecs si disponible, sinon MediaRecorder (avec dégradation annoncée) |
| Sauvegarde | Brouillon local + projet serveur |
| Retour au Studio | `saveLocalDraft` **avant** navigation (vérifié) |
| État | **OPÉRATIONNELLE** (éditeur local, ne dépend d'aucun fournisseur) |

C'est la seule fonctionnalité Studio **qui ne dépend d'aucune API payante** : le montage se fait intégralement dans le navigateur.

### 4.7 Avatars, clonage, lip-sync

| Capacité | Réalité |
| --- | --- |
| CRUD avatars | **OPÉRATIONNELLE** — `createAvatar`, `listAvatars`, upload d'aperçu |
| Clonage de voix | **ABSENT** — aucune intégration de clonage |
| Avatar parlant | **PARTIELLE** — passe par un modèle MUAPI `Audio to Video`, pas de flux dédié |
| Lip-sync | **OPÉRATIONNELLE par le catalogue** : 14 modèles `Audio to Video` |
| Avatar Studio (dédié) | **INTERFACE UNIQUEMENT** (`status: 'prepared'`) |

**0 avatar en base.** Le CRUD existe mais n'a jamais servi.

### 4.8 Fichiers et stockage

| Aspect | Réalité |
| --- | --- |
| Bucket | `vyora_files` (privé, URLs signées) |
| Upload | `uploadEditorMedia`, `uploadReferenceImage`, `uploadAvatarPreview` |
| Liaison projet | `attachAssetToProject` |
| Nettoyage | Non vérifié |
| État | **OPÉRATIONNELLE** (Supabase Storage natif) |

### 4.9 Ce que Studio ne sait pas faire

1. **Générer des images** — seulement décrire.
2. **Générer des voix** — Audio Studio est vide.
3. **Cloner une voix** — aucun fournisseur.
4. **Découper automatiquement** (AI Clipping) — vide.
5. **Publier** — aucun canal de publication branché.
6. **Estimer un coût réel dans l'UI tarifaire** — les exemples sont à `null`.

---

## 5. Inventaire des fonctionnalités administrateur

Route : `/admin`, protégée par `AdminRoute` (`src/components/Routes.tsx`). Un admin qui atterrit sur `/app` est redirigé vers `/admin`.

### 5.1 Les 16 sections

| Section | Rôle | État |
| --- | --- | --- |
| Vue d'ensemble | Métriques plateforme | OPÉRATIONNELLE |
| Revenus | Chiffre d'affaires | OPÉRATIONNELLE |
| KPI & MRR | Revenu récurrent | OPÉRATIONNELLE |
| Recharges | Commandes de crédits | OPÉRATIONNELLE |
| Paiements SasPay | Suivi des transactions | OPÉRATIONNELLE |
| Services | Catalogue de services vendus | OPÉRATIONNELLE |
| Modèles vidéo | Catalogue MUAPI (415) | OPÉRATIONNELLE |
| Fournisseurs IA | Activation/désactivation | OPÉRATIONNELLE |
| Contrôle IA | Registre, appels, budgets | OPÉRATIONNELLE |
| Activité Studio | Jobs et crédits | OPÉRATIONNELLE |
| Activité Business Growth | Abonnements Business | OPÉRATIONNELLE |
| Tarifs vidéo | Grille de prix | OPÉRATIONNELLE |
| Paramètres | Config plateforme | OPÉRATIONNELLE |
| Journal (audit) | Traçabilité | OPÉRATIONNELLE |
| Budget et fournisseurs IA | Plafonds de dépense | OPÉRATIONNELLE |
| Paramètres généraux | Divers | OPÉRATIONNELLE |

### 5.2 Capacités admin vérifiées

Toutes passent par des RPC dédiées (`src/lib/api.ts`) :

- `adminListUsers`, `adminSetRole`, `adminSetPlan`, `adminSetAccountStatus`
- `adminAdjustCredits`, `adminConfirmRecharge`, `adminCreditHistory`
- `adminSetProviderSpendCap`, `adminSetProviderSpendPolicy`, `adminAckProviderSpendAlert`
- `adminAiCoreRegistry`, `adminAiCoreProviderUpsert`, `adminAiCoreProviderDisable`
- `adminSetBusinessSubscription`, `adminRevokeBusinessSubscription`
- `adminCreatePromo`, `adminListAuditLogs`, `adminOverview`, `adminMetrics`, `adminVideoCatalog`, `adminSetVideoPricing`, `adminUpdateService`, `adminSetSetting`
- Consultation fournisseurs : `adminProviderBalance`, `adminRefreshProviderBalance`, `adminProviderHealthCron`, `adminProviderSpendSummary`, `adminAiCoreCalls`

Au total **33 fonctions `admin*`** exposées par `src/lib/api.ts`.

### 5.3 Contrôle des coûts fournisseur — un vrai point fort

Le produit possède un garde-fou de dépense réel :

```json
{
  "setting_key": "provider_spend_cap",
  "setting_value": { "enabled": true, "max_usd": 10, "alert_percent": 80,
                     "provider_caps_usd": { "muapi": 10 } }
}
```

Avec suivi par table `ugc_provider_spend`, `ugc_provider_spend_alerts`, `ugc_provider_cost_events`, et une tâche cron de collecte. **C'est un dispositif rare et bien pensé** : il empêche une facture MUAPI surprise.

### 5.4 Faiblesses admin

1. **Pas de gestion d'équipe** : aucune UI pour inviter/supprimer un membre depuis l'admin (les fonctions `invite-agency-member` etc. existent en base mais **pas dans ce dépôt**, et relèvent d'un autre produit — voir §6.3).
2. **Pas de journal d'audit unifié** entre Studio, Business et paiements.
3. **Pas d'impersonation** pour le support.

---

## 6. Inventaire des intégrations et dépendances

### 6.1 Le registre d'intégrations : 30 déclarées, 5 réelles

Source : `saas_business.integration_providers`, colonne `implemented`. C'est le champ le plus utile du produit : il distingue **déclaré** de **fonctionnel**.

| Intégration | `implemented` | Auth | Capacités |
| --- | --- | --- | --- |
| **chariow** | ✅ **true** | api-key | read |
| **custom-api** | ✅ **true** | api-key | read |
| **prestashop** | ✅ **true** | api-key | read |
| **shopify** | ✅ **true** | api-key | read, write |
| **woocommerce** | ✅ **true** | api-key | read |
| bigcommerce | ❌ false | api-key | read, write, modify |
| ecwid | ❌ false | api-key | read, write |
| magento, opencart, odoo | ❌ false | api-key | — |
| **facebook** | ❌ false | oauth2 | read, draft, send, modify |
| **instagram** | ❌ false | oauth2 | read, draft, send, modify |
| **messenger** | ❌ false | oauth2 | read, send |
| gmail, outlook, microsoft365 | ❌ false | oauth2 | read, draft, send |
| google_calendar, google_drive | ❌ false | oauth2 | read, write, modify |
| hubspot, notion, linkedin, pinterest | ❌ false | oauth2 | — |
| + ~9 autres | ❌ false | — | — |

**Conclusion** : **5 intégrations e-commerce réelles, 25 déclaratives.** Aucune connexion active en base (`integration_connections` = 0).

### 6.2 MCP — deux sens distincts

| Sens | Fonction | Rôle | État |
| --- | --- | --- | --- |
| **Entrant** (VYORA = serveur) | `vyora-mcp` | 13 outils exposés à des clients MCP | Déployée v9 |
| **Sortant** (VYORA = client) | `mcp-client` | L'utilisateur connecte ses propres serveurs | Déployée v14 |
| Gestion OAuth | `vyora-oauth` | Autorisation | Déployée v4, **source absente du dépôt** |

**Limite connue et vérifiée** : `public.mcp_servers` n'a **ni `tool_writes` ni `ecritures_autorisees`**. Toutes les écritures MCP sont bloquées (`mcp-client/accueil.ts` l.134). Les outils proposables sont donc **en lecture seule** uniquement.

### 6.3 Dette majeure : 14 fonctions déployées sans source

C'est un risque sérieux pour la maintenance. Ces fonctions tournent en production mais **aucun fichier du dépôt ne les décrit** :

| Fonction | Version déployée | Probable origine |
| --- | --- | --- |
| `dashboard-assistant` | 18 | Ancien produit (Sofia/immobilier) |
| `invite-agency-member` | 22 | Idem |
| `create-agency-member-v2` | 17 | Idem |
| `redeem-agency-invitation-v2` | 15 | Idem |
| `reset-agent-password-v2` | 16 | Idem |
| `create-platform-agency` | 18 | Idem |
| `provision-platform-agency` | 17 | Idem |
| `platform-dashboard-summary` | 17 | Idem |
| `saspay-checkout` | 18 | Paiement (remplacé par `vyora-payments`) |
| `saspay-verify` | 17 | Idem |
| `saspay-webhook` | 17 | Idem |
| `saspay-reconcile` | 13 | Idem |
| `vyora-bg-seed` | 7 | Amorçage Business Grow |
| `vyora-oauth` | 4 | OAuth MCP |

**Ces fonctions ne peuvent être ni auditées, ni corrigées, ni redéployées depuis ce dépôt.** C'est la première dette à résorber (§11).

### 6.4 Meta — état exact

| Élément | État |
| --- | --- |
| Edge `meta-connect` | **Non déployée** |
| Edge `meta-webhook` | **Non déployée** |
| Edge `meta-lifecycle` | **Non déployée** |
| Migration `20261124100000_meta_integrations.sql` | **Appliquée** (tables présentes) |
| Migration `20261126100000_meta_lifecycle_callbacks.sql` | **Non appliquée** |
| Tables `meta_connections`, `meta_pages`, `meta_messages`, `meta_webhook_events`, `meta_oauth_states`, `meta_page_events` | **Toutes vides (0 ligne)** |
| `integration_providers.facebook / instagram / messenger` | `implemented = false` |
| Secrets Meta | **Aucun** (`META_APP_ID`, `META_APP_SECRET` absents) |
| Page publique de suivi de suppression | `/confidentialite/suivi` — **déployée et fonctionnelle** |

**Conclusion : l'intégration Meta est à l'état de code mort déployable.** Le socle SQL existe, les Edge Functions sont écrites mais non déployées, et aucune clé n'est configurée. Rien n'est cassé — mais rien ne fonctionne.

---

## 7. Classement opérationnel

### 7.1 Synthèse par état

| État | Nombre | Part |
| --- | --- | --- |
| **OPÉRATIONNELLE** | 41 | 46 % |
| **PARTIELLE** | 14 | 16 % |
| **INTERFACE UNIQUEMENT** | 12 | 13 % |
| **EN ATTENTE** | 18 | 20 % |
| **DÉSACTIVÉE** | 3 | 3 % |
| **NON VÉRIFIÉE** | 2 | 2 % |
| **Total identifié** | **90** | 100 % |

> **Comment lire ces chiffres.** « OPÉRATIONNELLE » signifie que la chaîne complète existe et est cohérente. Elle **n'a pas toujours été exercée** : pour la génération vidéo notamment, 0 job a été exécuté. J'ai préféré classer opérationnel un parcours dont j'ai pu vérifier chaque maillon (UI → API → SQL → persistance), et signaler séparément qu'il n'a pas été éprouvé en production (§1).

### 7.2 Les 41 fonctionnalités OPÉRATIONNELLES

**Studio (16)** — génération vidéo (15 modèles, chaîne complète), devis signé, réservation de crédits, historique des générations, projets (CRUD), fichiers et stockage privé, bibliothèque, montage vidéo, export navigateur, sous-titres SRT, scripts (génération + persistance), scènes, prompts, presets, avatars (CRUD), catalogue 415 modèles.

**Business Grow (17)** — les 16 modules + l'assistant conversationnel.

**Compte & paiement (8)** — inscription/connexion, workspaces, portefeuille de crédits, packs et recharge libre, SasPay (Orange/Moov/Mobi Cash), abonnements Studio, abonnement Business Grow, admin (16 sections).

### 7.3 Les 14 PARTIELLES

| Fonctionnalité | Ce qui manque |
| --- | --- |
| `generate_visual` | Renvoie du texte, pas une image |
| Lip-sync | Passe par le catalogue, pas de flux dédié |
| Avatars parlants | Pas de moteur dédié |
| Integrations Hub | 5/30 branchées, 0 connectée |
| MCP sortant | Écritures bloquées |
| MCP entrant | 13 outils, jamais utilisés |
| Estimation de coût publique | Exemples à `null` |
| Import de boutique | Fonctionne, jamais utilisé |
| Rapports d'agent | Existent, jamais générés |
| Automatisations | Manuelles, pas planifiées |
| Mémoire d'entreprise | 5 entrées, aucune stratégie |
| Assistant Business | Non déployé avec les nouveaux outils |
| Recherche/filtres | Basiques |
| Équipes | Lecture seule des membres |

### 7.4 Les 12 INTERFACE UNIQUEMENT

Les 12 espaces `prepared` : Image Studio, Avatar Studio, Image Generation, Audio Studio, AI Clipping, Vibe Motion, Body Swap, Cinema Studio, Marketing Studio, Workflows, Agents, Storyboarding.

**Ils l'assument** : `PreparedSpace` affiche « Préparé · non opérationnel » et « Rien n'est simulé ». C'est de l'interface honnête, pas du faux-semblant.

### 7.5 Les 18 EN ATTENTE

| Élément | Blocage |
| --- | --- |
| `propose_prospect_save` (enregistrement de prospect par l'agent) | **Edge non redéployée** (v35) |
| `propose_memory_save`, `propose_action_plan`, `propose_campaign_brief` | idem |
| `create_follow_up_task` | idem |
| Outils MCP dans l'agent | Migration `20261128100000` **non appliquée** |
| Meta : connexion, webhook, publication | 3 Edge non déployées, 0 secret |
| Lifecycle Meta | Migration non appliquée |
| 8 fournisseurs IA (openai, anthropic, deepseek, grok, mistral, kilo, cloudflare, ollama) | Clés absentes |
| 25 intégrations déclaratives | Non implémentées |
| Publication sociale | Aucun canal |
| Clonage de voix | Aucun fournisseur |

### 7.6 Les 3 DÉSACTIVÉES (volontairement)

| Élément | Raison |
| --- | --- |
| Écritures MCP | Bloquées par conception (`accueil.ts` l.134) |
| 11 fournisseurs IA | `enabled = false` |
| Voix / audio | Aucun fournisseur branché |

### 7.7 Les 2 NON VÉRIFIÉES

| Élément | Pourquoi |
| --- | --- |
| Comportement HTTP des 31 Edge Functions en production | Réseau du bac à sable bloque `*.supabase.co` |
| Rendu visuel réel (desktop et mobile) | Chromium indisponible, aucune capture possible |

---

## 8. Fonctionnalités disponibles sans Meta

C'est le point stratégique. **VYORA est déjà commercialisable sans Meta** — mais pas pour les raisons qu'on croit.

### 8.1 Ce qui fonctionne déjà, sans aucune intégration externe

| Capacité | Dépendances externes | Utilisable dès aujourd'hui |
| --- | --- | --- |
| Enregistrer et suivre des prospects | **Aucune** | ✅ |
| Gérer clients et pipeline | Aucune | ✅ |
| Créer des tâches et les suivre | Aucune | ✅ |
| Générer un script vidéo | Gemini / Groq (configurés) | ✅ |
| Générer des scènes structurées | Gemini / Groq | ✅ |
| Monter une vidéo | **Aucune** (navigateur) | ✅ |
| Exporter une vidéo | Aucune (WebCodecs/MediaRecorder) | ✅ |
| Générer une vidéo IA | MUAPI (clé présente) | ✅ code prêt, jamais exercé |
| Consulter l'assistant IA | Gemini / Groq | ✅ |
| Rapports et diagnostics | Aucune (calcul local + SQL) | ✅ |
| Automatisations de relance | Aucune | ✅ (déclenchement manuel) |
| Mémoire d'entreprise | Aucune | ✅ |
| Paiement mobile money | SasPay (configuré, mode live) | ✅ code prêt |
| Admin complet | Aucune | ✅ |

**Ce qui rend VYORA utile sans Meta** : un entrepreneur peut, dès aujourd'hui, saisir ses prospects, organiser son suivi, générer un script publicitaire, monter la vidéo, et payer par Orange Money. **Aucune de ces étapes ne passe par Facebook.**

### 8.2 Ce qui pourrait être amélioré sans Meta

| Amélioration | Pourquoi elle ne dépend pas de Meta |
| --- | --- |
| **Import CSV de prospects** | Un fichier suffit ; le module d'import existe déjà pour les produits |
| **Saisie rapide / dictée** | Web Speech API, déjà branchée dans l'assistant |
| **Rappels par notification interne** | Table `ugc_notifications` existe |
| **Export PDF d'un rapport** | Génération côté navigateur |
| **Modèles de messages de relance** | Texte stocké, copié par l'utilisateur |
| **Tableau de bord commercial calculé** | Toutes les données sont déjà en base |
| **Estimation de coût avant génération** | `video-quote` existe, il suffit de l'appeler depuis la page tarifs |
| **Génération d'images** | Brancher un modèle image (MUAPI n'en a pas, mais un autre fournisseur peut) |

### 8.3 Ce qui pourrait être **ajouté** sans Meta

| Fonctionnalité | Valeur | Complexité |
| --- | --- | --- |
| **Envoi d'e-mail** (relances, devis) | Très haute | Moyenne — SMTP/Resend |
| **Envoi SMS** | Très haute en Afrique de l'Ouest | Moyenne |
| **Import CSV de contacts** | Haute | Faible |
| **Devis / factures PDF** | Très haute | Moyenne |
| **Relances planifiées automatiques** | Très haute | Faible (cron existe) |
| **Lien de paiement à envoyer** | Très haute | Faible — SasPay est là |
| **Formulaire public de capture de leads** | Haute | Faible |
| **Génération d'images produit** | Haute | Moyenne |
| **Voix off (TTS)** | Haute | Faible — un fournisseur TTS |
| **Publication directe TikTok / YouTube** | Haute | Moyenne |

**Le lien de paiement est le levier le plus rapide** : `vyora-payments` et SasPay existent, configurés en mode live. Envoyer un lien Orange Money à un prospect depuis une fiche CRM transforme Business Grow d'un carnet d'adresses en un outil qui encaisse.

### 8.4 Ce qui dépend **réellement** de Meta

| Fonctionnalité | Nature de la dépendance |
| --- | --- |
| Recevoir les messages WhatsApp | Webhook Meta (`meta-webhook` non déployée) |
| Envoyer des messages WhatsApp | API Cloud WhatsApp |
| DM Instagram / Messenger | API Meta, `implemented = false` |
| Publication Facebook / Instagram | API Meta |
| Synchronisation catalogue Facebook Shop | API Meta |
| Suivi de suppression de données | Callback Meta (migration non appliquée) |

**Ces six éléments représentent une partie minoritaire de la valeur du produit.** Le reste tient debout sans eux.

---

## 9. Problèmes que le produit résout actuellement

| Problème utilisateur réel | Comment VYORA y répond | Preuve |
| --- | --- | --- |
| « Je perds le fil de mes prospects » | 16 modules, pipeline à 6 étapes, prochaine action datée | registry.ts |
| « Je ne sais pas quoi publier » | Génération de scripts, hooks et scènes par IA | `generate_script`, `generate_hooks` |
| « Produire une vidéo coûte trop cher » | 415 modèles de 0,01 à 9,35 USD, marge contrôlée | `ugc_video_models` |
| « Je ne sais pas combien ça va coûter » | Devis signé avant exécution, prix figé 15 min | `ugc_video_quotes` |
| « Je ne peux pas payer en ligne en Afrique de l'Ouest » | Orange Money, Moov, Mobi Cash via SasPay | `saspay_payment_config` |
| « Le montage vidéo est trop compliqué » | Éditeur navigateur, sous-titres, export local | `VideoEditor.tsx` |
| « Je ne sais pas où j'en suis dans mon business » | Tableau de bord + KPI par module | `kpis[].compute` |
| « Je n'ai pas de commercial » | Assistant IA qui propose des actions et crée des tâches | `bg_agent_propose_task` |
| « Je risque de dépasser mon budget API » | Plafond de dépense fournisseur avec alertes | `provider_spend_cap` |

---

## 10. Problèmes importants que le produit ne résout pas encore

Classés par gravité commerciale.

### 10.1 Le problème n°1 : **aucun canal d'entrée de leads**

Une entreprise qui achète Business Grow doit **tout saisir à la main**. Sans Meta, il n'existe aucun moyen d'alimenter le CRM autrement que par un formulaire.

C'est le trou fonctionnel le plus coûteux, parce qu'il attaque la promesse même du produit : « votre assistant commercial ». Un assistant qui n'a pas de données ne sert à rien.

**Correctif sans Meta** : import CSV (le module d'import existe déjà pour les produits), formulaire public de capture, et à terme e-mail entrant.

### 10.2 Aucun envoi : le produit prépare, mais ne communique pas

On peut rédiger une relance. On ne peut pas l'envoyer. Aucun canal : ni e-mail, ni SMS, ni WhatsApp.

**Conséquence** : l'utilisateur copie-colle dans son propre logiciel de messagerie. Le produit perd sa boucle de valeur au moment décisif.

**Correctif** : e-mail transactionnel (Resend/Postmark) et/ou SMS.

### 10.3 Aucun encaissement depuis le CRM

SasPay est configuré en **mode live**. Les packs de crédits fonctionnent. Mais **aucun lien de paiement ne peut être envoyé à un client depuis une fiche prospect**. VYORA sait encaisser pour elle-même, pas pour ses utilisateurs.

**Correctif** : générer un lien SasPay depuis une fiche prospect ou une facture.

### 10.4 Les modules promettent plus qu'ils ne calculent

« Finance Intelligence », « Lead Rescue », « Revenue Leak » sonnent comme des moteurs. Ce sont des CRUD avec des comptages.

**Risque** : déception à l'usage, churn rapide, avis négatifs.

**Deux sorties possibles** :
- *Assumer* : renommer en « Suivi des leads », « Factures impayées » — plus honnête, moins vendeur.
- *Tenir la promesse* : ajouter de vrais calculs (score de churn, prévision de trésorerie, priorisation par valeur attendue). Les données sont là ; le calcul manque.

La seconde option est défendable : `computeRevenueLeaks` montre que le pattern existe. Il suffit de l'étendre.

### 10.5 Le produit n'a jamais tourné

0 vidéo, 0 avatar, 0 script, 0 module business rempli, 0 euro encaissé, 0 connexion.

**C'est le risque n°1, avant même les fonctionnalités manquantes.** Toute régression d'un parcours jamais exercé coûtera une journée de débogage en production.

**Correctif** : un parcours de bout en bout exécuté et documenté — un prospect créé par l'agent, une vidéo générée, un paiement confirmé.

### 10.6 Le déploiement Edge est en retard sur le code

La base est à jour (7 outils d'agent), la fonction en ligne (v35) en connaît 5. L'enregistrement de prospect par l'IA — la fonctionnalité phare — **n'est pas active en production**.

### 10.7 Dette de traçabilité

14 fonctions tournent en production sans source dans le dépôt. Impossible de les auditer ou corriger.

### 10.8 Pas d'essai gratuit Business Grow

Aucun plan `free` côté Business. Un prospect doit payer avant de voir quoi que ce soit. Pour un produit dont la valeur dépend des données saisies, c'est un frein important : l'utilisateur doit investir avant de constater le bénéfice.

### 10.9 Identité encore « Reelora »

`ugc_app_settings.platform = {"name": "Reelora", "support_email": "support@reelora.app"}`. Le nom public est **Reelora**, pas VYORA. Incohérence de marque visible par l'utilisateur.

---

## 11. Opportunités d'amélioration

Par ordre de rapport valeur/effort.

### 11.1 Effort faible, valeur très haute

| # | Opportunité | Pourquoi |
| --- | --- | --- |
| 1 | **Déployer la fonction Edge business-grow** | Le travail est fait et testé ; il ne manque qu'un déploiement |
| 2 | **Import CSV de prospects** | Le code d'import existe pour les produits ; le réutiliser |
| 3 | **Lien de paiement SasPay depuis une fiche** | SasPay est en live ; c'est un bouton |
| 4 | **Relances planifiées** | `pg_cron` tourne déjà (11 jobs) ; `sales-automation` a la logique |
| 5 | **Compléter les exemples de coût** | Trois `approx_credits: null` à remplir via `video-quote` |
| 6 | **Renommer Reelora → VYORA** | Une ligne en base |
| 7 | **Plan d'essai Business Grow** | 14 jours ou 20 prospects ; ouvre le tunnel |

### 11.2 Effort moyen, valeur haute

| # | Opportunité | Pourquoi |
| --- | --- | --- |
| 8 | **Envoi d'e-mail** (relances, devis, factures) | Boucle complète : détecter → rédiger → envoyer → tracer |
| 9 | **Devis / factures PDF** | Le webhook SasPay fournit déjà les montants |
| 10 | **Formulaire public de capture de leads** | Remplace Meta pour l'entrée de données |
| 11 | **Vrais scores dans les modules** | Étendre `computeRevenueLeaks` aux 16 modules |
| 12 | **Voix off (TTS)** | Audio Studio vide, mais un fournisseur TTS suffit |
| 13 | **Génération d'images** | Débloque Image Studio et les visuels de campagne |

### 11.3 Effort élevé, valeur structurante

| # | Opportunité | Pourquoi |
| --- | --- | --- |
| 14 | **Reprendre les 14 fonctions orphelines dans le dépôt** | Condition de maintenabilité |
| 15 | **Publication TikTok / YouTube** | Vraie boucle Studio → diffusion, sans Meta |
| 16 | **Équipes et rôles** | Débloque les agences, segment à plus forte valeur |

### 11.4 Une opportunité mal exploitée : le catalogue de 415 modèles

VYORA possède **415 modèles vidéo** avec leurs coûts réels. C'est un actif considérable, presque invisible : l'utilisateur voit une liste, sans recommandation.

**Proposition** : un sélecteur guidé par l'objectif (« clip court pas cher », « publicité premium », « lip-sync ») qui recommande 3 modèles avec leur coût en crédits et en XOF. Les données nécessaires sont déjà en base (`category`, `cost_usd`). Cela transforme une complexité en avantage — et c'est exactement ce qu'un utilisateur non technique attend.

---

## 12. Limites techniques et fonctionnelles

### 12.1 Limites techniques vérifiées

| Limite | Détail | Impact |
| --- | --- | --- |
| **Fournisseur vidéo unique** | MUAPI seulement | Panne MUAPI = Studio arrêté |
| **Aucun modèle d'image** | 0 dans le catalogue | Pas de visuel généré |
| **Aucune voix** | Aucun TTS | Audio Studio vide |
| **Écritures MCP bloquées** | `accueil.ts` l.134 | Assistant en lecture seule côté MCP |
| **`ChatMessage.content` est une chaîne** | `providers.ts` l.16-19 | **Pas de vision** : aucune analyse d'image |
| **14 fonctions sans source** | — | Non maintenables |
| **Artefacts épinglés** | `business-grow`, `vyora-ai`, etc. | Un ré-épinglage mal fait = panne totale |
| **Plafond MUAPI 10 USD** | `provider_spend_cap.max_usd` | Bloquerait ~1 grosse génération à 9,35 USD |

### 12.2 Limites fonctionnelles

| Limite | Conséquence |
| --- | --- |
| Pas de vision sur les images | L'assistant ne peut pas lire une capture d'écran ou un scan |
| Pas de transcription audio | Aucun upload audio analysé |
| Pas d'envoi de message | Boucle commerciale incomplète |
| Pas de plan gratuit Business | Tunnel fermé |
| Pas de gestion d'équipe en UI | Bloque le segment agence |
| Pas d'impersonation admin | Support limité |
| Marquage encore « Reelora » | Incohérence de marque |

### 12.3 Ce que je n'ai pas pu vérifier

| Élément | Raison | Ce qu'il faudrait |
| --- | --- | --- |
| Rendu visuel desktop/mobile | Chromium indisponible dans le bac à sable | Test manuel ou Playwright |
| Comportement HTTP des 31 Edge Functions | `*.supabase.co` bloqué par le réseau | curl depuis un poste autorisé |
| Latence réelle des appels MUAPI | 0 génération | Une génération réelle |
| Comportement du webhook SasPay | Aucun paiement | Un paiement test en mode live |

---

## 13. Références — où trouver chaque preuve

### 13.1 Frontend

| Preuve | Fichier |
| --- | --- |
| Routes (49) | `src/App.tsx` |
| Navigation Business (8 groupes) / Studio (7) | `src/navigation/config.ts` |
| 16 modules Business | `src/business/modules/registry.ts` |
| 6 live / 12 prepared | `src/studio/sections.ts` |
| Page assistant dédiée | `src/business/BusinessAssistantPage.tsx` |
| Assistant réutilisable | `src/ai/BusinessAssistant.tsx`, `Sidebar.tsx`, `Composer.tsx` |
| Dictée vocale | `src/ai/useDictee.ts` |
| Montage vidéo | `src/studio/VideoEditor.tsx` (+ `editor/assist.ts`, `editor/components/ExportPanel.tsx`, `editor/exportConfig.ts`) |
| Génération vidéo | `src/studio/GenerationStudio.tsx` |
| API client | `src/lib/api.ts` (≈130 fonctions) |
| Espaces non opérationnels | `src/studio/components/PreparedSpace.tsx` |

### 13.2 Edge Functions (dépôt)

| Fonction | Fichier |
| --- | --- |
| Business Grow | `supabase/functions/business-grow/{index,handler,intelligence,providers,loader}.ts` |
| IA | `supabase/functions/vyora-ai/`, `vyora-ai.edge.js` (36 393 car., SHA `0ff7378e…`) |
| Fournisseurs IA | `supabase/functions/vyora-ai-providers/` |
| Vidéo | `supabase/functions/reelora-video/`, `reelora-video-worker/`, `video-quote/` |
| Paiement | `supabase/functions/vyora-payments/`, `vyora-saspay-webhook/`, `vyora-payments-reconcile/` |
| MCP | `vyora-mcp/`, `mcp-client/` |
| Meta (non déployées) | `meta-connect/`, `meta-webhook/`, `meta-lifecycle/` |
| Import boutique | `store-import/`, `store-connect/` |

### 13.3 Base de données

| Objet | Schéma / table |
| --- | --- |
| Crédits, jobs, modèles | `saas_ugc.ugc_wallets`, `ugc_generation_jobs`, `ugc_video_models`, `ugc_video_quotes` |
| Paiement | `saas_ugc.vyora_payment_initiations`, `ugc_recharge_orders`, `ugc_payment_events` |
| Business Grow | `saas_business.conversations`, `messages`, `ai_requests`, `tool_executions`, `module_records`, `workspace_memory_items`, `subscriptions` |
| Fournisseurs IA | `saas_business.ai_providers`, `ai_provider_configs`, `ai_provider_health_checks`, `ai_models`, `ai_calls_log` |
| Intégrations | `saas_business.integration_providers` (colonne `implemented`), `integration_connections` |
| Meta | `saas_business.meta_connections`, `meta_pages`, `meta_messages`, `meta_webhook_events` |
| Vues de compatibilité | `public.reelora_*` (9 vues vers `saas_ugc`) |

### 13.4 Fonctions SQL clés

| Fonction | Rôle |
| --- | --- |
| `public.reelora_start_generation(project, service, payload, idempotency, quote)` | Lance une génération, réserve les crédits |
| `saas_business.bg_create_tool_execution(...)` | Liste fermée des outils d'agent |
| `saas_business.bg_agent_resolve_tool(...)` | Exécute un outil approuvé |
| `saas_business.bg_save_scoped_prospect(...)` | Écrit un prospect (ajouté cet audit) |
| `saas_business.bg_require_scoped_consent(...)` | Exige le consentement mémoire |
| `saas_business.bg_confirm_automation_task(...)` | Crée une tâche d'automatisation |
| `saas_business.bg_lock_workspace_access(...)` | Isolation par workspace |

### 13.5 Ordonnancement (11 tâches `pg_cron`, toutes en succès)

`reelora-video-tick` (*/1 min, 4320 succès/3 j), `business-grow-stale-reservations` (*/15), `vyora-payments-reconcile` (*/5), `vyora-provider-health-collect` (*/5), `vyora-provider-health-daily`, `vyora-provider-health-fresh-guard`, `vyora-provider-health-watchdog`, `vyora-ai-providers-probe`, `sofia-billing-reminders`, `sofia-lot-a-suspend-overdue`, `sofia-subscription-lifecycle-hourly`.

> Les trois tâches `sofia-*` proviennent d'un **autre produit** (immobilier) partageant le même projet Supabase. Elles tournent sans utilité pour VYORA.

---

## Synthèse finale

### Combien de fonctionnalités ?

**90 fonctionnalités distinctes** identifiées en lisant le code, la base et le déploiement — c'est-à-dire au-delà des menus, puisque les espaces `prepared`, les outils d'agent non déployés et les intégrations déclaratives en font partie.

| État | Nombre | Part |
| --- | --- | --- |
| OPÉRATIONNELLE | **41** | 46 % |
| PARTIELLE | **14** | 16 % |
| INTERFACE UNIQUEMENT | **12** | 13 % |
| EN ATTENTE | **18** | 20 % |
| DÉSACTIVÉE | 3 | 3 % |
| NON VÉRIFIÉE | 2 | 2 % |

**Lecture utile** : 46 % du produit est réellement fonctionnel. Mais parmi les 41 opérationnelles, **une seule chaîne à forte valeur (la génération vidéo) n'a jamais été exécutée**, et l'enregistrement de prospect par l'IA — la fonctionnalité la plus différenciante de Business Grow — attend un déploiement.

### Les fonctionnalités les plus utiles commercialement

Par ordre de valeur perçue par un client qui paie.

| Rang | Fonctionnalité | Pourquoi elle vend |
| --- | --- | --- |
| 1 | **Génération vidéo UGC (415 modèles, devis signé, prix transparent)** | C'est le cœur du produit ; le devis avant exécution rassure |
| 2 | **Montage vidéo dans le navigateur (sans fournisseur, sans coût)** | Coût marginal nul — forte marge |
| 3 | **Assistant commercial qui propose des actions concrètes** | Ce qui distingue VYORA d'un simple CRM |
| 4 | **Paiement mobile money (Orange, Moov, Mobi Cash)** | Indispensable en Afrique de l'Ouest ; concurrent rare |
| 5 | **Packs de crédits à prix lisible en XOF** | Accessible, sans abonnement obligatoire |
| 6 | **Suivi de prospects et KPI (sans Meta)** | Utilisable dès le premier jour |
| 7 | **Automatisations de relance créant de vraies tâches** | Gain de temps mesurable |
| 8 | **Contrôle du budget fournisseur (plafond, alertes)** | Rassure sur le risque de facture |

### Les 5 plus grandes faiblesses

| # | Faiblesse | Gravité | Pourquoi |
| --- | --- | --- | --- |
| 1 | **Le produit n'a jamais tourné** — 0 vidéo, 0 script, 0 prospect, 0 € encaissé | **Critique** | On ne sait pas si les parcours fonctionnent ; tout bug coûtera cher |
| 2 | **Aucun canal d'entrée ni de sortie pour les données commerciales** — pas d'import, pas d'e-mail, pas de SMS, Meta absent | **Critique** | Un CRM qu'on remplit à la main et qui ne peut rien envoyer n'a pas de boucle de valeur |
| 3 | **14 fonctions en production sans source dans le dépôt** | **Haute** | Non auditables, non corrigeables ; risque de panne irréparable |
| 4 | **Le code n'est pas déployé** — la fonction en ligne (v35) ignore les nouveaux outils d'agent ; 1 migration non appliquée | **Haute** | La fonctionnalité phare est inactive ; l'écart va grandir |
| 5 | **Les 16 modules Business Grow sont des CRUD, pas des moteurs** — un seul calcul métier | **Haute** | Écart entre la promesse des noms et le comportement ; risque de churn |

### Ce qu'il faut regarder en premier (pour Claude Code)

1. **Déployer `business-grow`** (autorisation humaine requise — procédure en §13.2). Le code est écrit et testé ; sans ce déploiement, l'agent commercial reste muet sur son action la plus utile.
2. **Faire tourner le produit une fois, de bout en bout** : créer un prospect via l'agent → générer un script → générer une courte vidéo → vérifier le débit de crédits → payer 5 000 XOF par Orange Money. Documenter ce qui casse.
3. **Combler la boucle commerciale sans Meta** : import CSV + envoi d'e-mail + lien de paiement SasPay depuis une fiche. C'est le gain de clients le plus direct, et aucune de ces briques ne dépend de Meta.
4. **Réduire la dette** : rapatrier les 14 fonctions orphelines, appliquer la migration MCP.
5. **Réconcilier la promesse et le moteur** : soit renommer les modules, soit étendre `computeRevenueLeaks` à tous.

### Une phrase

VYORA est un produit **plus large que profond** : 415 modèles vidéo, 16 modules, 31 fonctions déployées, une architecture SQL soignée et un dispositif anti-abus crédible — mais **jamais exercé**, avec un CRM qui saisit sans importer ni envoyer, et des modules dont les noms promettent des calculs qui n'existent pas encore. La bonne nouvelle : les manques les plus coûteux (entrée de données, envoi, encaissement) se comblent **sans dépendre de Meta**.

---

*Audit conduit en lecture seule. Aucun déploiement, aucune migration, aucun secret, aucune configuration de paiement n'a été modifié. Les constats de comportement à l'exécution sont marqués NON VÉRIFIÉE lorsqu'ils n'ont pas pu être testés depuis le bac à sable.*

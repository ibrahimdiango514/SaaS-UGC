# VYORA — Dossier de réception des fournisseurs IA

> **Statut : documentation uniquement.** Aucune intégration technique n'a démarré.
> L'intégration ne commencera qu'à la phrase d'autorisation explicite
> **« COMMENCE L'INTÉGRATION DES FOURNISSEURS IA. »**
>
> Dernière mise à jour : 2026-11-14.

---

## 1. Règle de conduite

| Règle | Application |
|---|---|
| **Aucune liste figée** | Le code ne nomme aucun fournisseur. Un fournisseur ajouté au registre central est servi sans modification de code. |
| **Aucun fournisseur fictif** | Rien n'est pré-enregistré « au cas où ». Une fiche existe seulement pour un fournisseur réellement transmis. |
| **Aucune intégration avant l'autorisation** | Même avec des informations complètes : réception, examen, documentation. Pas de clé, pas d'appel réseau, pas de sonde, pas de ligne de registre activée. |
| **Aucun secret dans ces fichiers** | Une clé reçue n'est **jamais** recopiée ici, ni dans un journal, ni dans un rapport. Seuls les **noms** de variables sont mentionnés. |
| **Dépôt des secrets par le développeur** | Les clés sont déposées par le développeur VYORA dans les Edge Function Secrets, puis vérifiées par leur **nom** uniquement. |
| **Canal de transmission assumé** | Décision du propriétaire (2026-11-14) : les clés sont transmises dans le chat Arena, dont il est le seul utilisateur. Elles ne sont **jamais** recopiées dans un fichier, un commit, un log ou le frontend, et ne sont pas réaffichées après dépôt. Aucune régénération systématique n'est prévue. |
| **Aucune invention** | Un tarif, une limite ou un identifiant de modèle absent de la documentation officielle est noté « non publié » ou « à confirmer ». Jamais une valeur plausible. |
| **Mistral reporté** | Offre payante : aucune démarche sur Mistral pour l'instant. |

---

## 2. Procédure de réception (par fournisseur)

Pour chaque fournisseur reçu, une fiche est créée dans ce dossier
(`fiche-<fournisseur>.md`) et suit toujours la même trame :

1. **Identification** — nom, éditeur, date de réception, source de l'information.
2. **Accès** — moyens d'accès *annoncés*, nom des variables de secret à prévoir.
3. **Documentation** — site officiel, pages consultées, date de consultation.
4. **Caractéristiques** — protocole, URL de base, authentification, régions.
5. **Modèles annoncés** — identifiants exacts tels que publiés, contexte, limites.
6. **Capacités annoncées** — ce que le fournisseur déclare savoir faire.
7. **Tarification** — prix publiés, unité, devise, ou « non publié ».
8. **Informations manquantes** — ce qu'il faut demander avant toute intégration.
9. **État de préparation** — `reçu` → `documenté` → `prêt (en attente d'autorisation)`.

---

## 3. Registre des fiches

| Fournisseur | Fiche | État | Remarque |
|---|---|---|---|
| _aucune fiche pour l'instant_ | — | — | Aucun fournisseur n'a encore été transmis après la consigne du 2026-11-14. |
| Mistral | _non ouverte_ | **reporté** | Nécessite une offre payante. Aucune démarche. |

> Les fiches des fournisseurs déjà présents dans le produit (Groq, Gemini, et les
> lignes de registre antérieures, inactives) sont documentées dans
> [`../moteur-ia-fournisseurs.md`](../moteur-ia-fournisseurs.md) : ce dossier-ci
> ne reçoit que les **nouveaux** fournisseurs transmis.

---

## 4. Inventaire tenu à jour

Le tableau §3 est la **source de vérité de la collecte**. Il est mis à jour à
chaque réception, avec : nom du fournisseur, fichier de fiche, date de réception,
état (`reçu` → `documenté` → `prêt`), et informations manquantes. Aucune ligne
n'est supprimée : un fournisseur reçu reste inventorié, même s'il n'est pas
intégré.

## 5. Où atterrit un fournisseur, le jour de l'autorisation

Pour information — **rien de ceci n'est exécuté aujourd'hui** :

1. Une ligne dans `saas_business.ai_providers` (via `public.vyora_ai_admin_provider_upsert`) :
   `provider_key`, `display_name`, `adapter_kind`, `default_base_url`, `models_url`,
   `api_key_env`, `account_id_env`, `is_aggregator`. Le fournisseur naît
   `enabled = false` / `unverified`.
2. Un secret Edge portant la clé (jamais dans Git, jamais dans une migration).
3. Une sonde réelle (`providers.verify`) qui, seule, peut le rendre `available`.
4. Ses modèles déclarés, chacun restant `unverified` jusqu'à preuve réelle.

5. Le dépôt de la clé dans les Edge Function Secrets est fait **par le
   développeur**, pas par le propriétaire du produit.

Aucune de ces étapes n'est déclenchée par ce document.

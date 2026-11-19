# Ce qui sera modifié en production — et rien d'autre

> Document à lire **avant** d'autoriser quoi que ce soit. Il énumère chaque écriture en
> production, son effet exact, et son moyen de retour arrière. Tout ce qui n'y figure pas ne sera
> pas touché.

Projet Supabase : `xbuuhfwobrafcbgtdgjx` · App Meta : VYORA · Auteur des opérations : moi, sur
votre autorisation.

---

## 1. Déjà en production — aucune action à faire

| Objet | État | Qui l'a fait |
| --- | --- | --- |
| Migration `20261124100000_meta_integrations` | **Appliquée** | Séance précédente |
| 6 tables `saas_business.meta_*` | **Créées**, RLS forcée, **vides** | idem |
| 21 fonctions SQL `saas_business.meta_*` | **Créées** | idem |
| Frontend Netlify (`/app/connect`, fiche Meta) | **Déployé** | Fusion de la PR #30 dans `develop` |

Ces objets sont **inertes** tant qu'aucune Edge Function ne les appelle : aucune écriture n'a lieu,
aucun accès n'est ouvert. On peut les laisser en place indéfiniment sans risque.

---

## 2. Ce que le déploiement ajoute — quatre écritures, pas une de plus

| # | Action | Effet précis | Réversible ? |
| --- | --- | --- | --- |
| 1 | Créer `meta-connect` | Nouvelle URL `…/functions/v1/meta-connect`. Renvoie 503 tant que son artefact ne se charge pas. | Oui : `delete_edge_function` |
| 2 | Créer `meta-webhook` | Nouvelle URL `…/functions/v1/meta-webhook`. Refuse tout POST sans HMAC valide. | Oui |
| 3 | `verify_jwt = false` sur les deux | La passerelle les laisse passer. La sécurité est **dans** les fonctions (HMAC ; JWT vérifié par appel à GoTrue). | Oui |
| 4 | Secrets (voir §3) | Variables d'environnement lues par les deux fonctions. | Oui : suppression |

### Ce qui n'est PAS modifié

- **Aucune** des 31 Edge Functions existantes.
- **Aucune** migration, **aucune** table existante, **aucune** RLS.
- **Aucun** secret existant (les 27 en place restent intacts).
- **Aucun** réglage Netlify, **aucun** domaine, **aucun** DNS.
- **Aucune** tarification, **aucun** flux de paiement (`vyora-payments`, SasPay : intacts).
- **Aucun** code e-commerce (`store-import`, `store-connect`, `business-grow` : intacts).

---

## 3. Les secrets — huit, dont cinq vraiment nécessaires au premier test

Les valeurs sont saisies **par vous**, dans **Supabase → Project Settings → Edge Functions →
Secrets**. Elles ne passent jamais par le chat.

| Secret | Nécessaire au 1er test ? | Sans lui |
| --- | --- | --- |
| `META_APP_ID` | **Oui** | `META_NOT_CONFIGURED`, fiches inactives |
| `META_APP_SECRET` | **Oui** | échec de l'échange OAuth et des signatures |
| `META_WEBHOOK_VERIFY_TOKEN` | **Oui** | webhook en 503, aucun message reçu |
| `META_FACEBOOK_CONFIG_ID` | **Oui** (Page) | `META_CONFIG_ID_MISSING` sur la fiche Facebook |
| `META_WHATSAPP_CONFIG_ID` | Non (test avec numéro Meta) ; **Oui** pour l'Embedded Signup réel | fiche WhatsApp inactivable par ES |
| `META_MESSENGER_CONFIG_ID` | Non | fiche Messenger en configuration manquante |
| `META_INSTAGRAM_CONFIG_ID` | Non | fiche Instagram en configuration manquante |
| `VYORA_APP_URL` | Non (valeur par défaut dans le code) | retours OAuth vers l'URL par défaut |

Vous pouvez donc commencer avec **cinq secrets**, obtenir les preuves A1/A2/B1/B2, puis compléter.

---

## 4. Ordre imposé, et pourquoi

1. **Artefacts committés** (fait : `99ec782`) — le chargeur télécharge depuis GitHub à ce commit.
2. **Commit poussé sur GitHub** (fait) — un commit local rendrait la fonction indisponible en 503.
3. **Secrets posés** — créer les fonctions avant les secrets les laisse en configuration incomplète
   jusqu'au redémarrage suivant.
4. **Contrôles à blanc** : `bash scripts/deploy-meta-functions.sh` — n'écrit rien.
5. **Déploiement** : `bash scripts/deploy-meta-functions.sh --apply`.
6. **Vérification** : `npm run meta:readiness` → 3/3.
7. **Configuration Meta** : webhooks, `webhook_subscribe` par produit.

L'étape 2 est celle que le test automatique surveille : `tests/store-import-artifact.test.ts`
vérifie que l'artefact existe **au commit épinglé** et que son SHA-256 correspond. Un commit non
poussé fait échouer ce test avant toute mise en production.

---

## 5. Retour arrière

```bash
# Supprimer les deux fonctions (aucune donnée n'est perdue : les tables Meta restent).
# Via le tableau de bord : Edge Functions → meta-connect / meta-webhook → Delete.
```

| Action de retour | Effet |
| --- | --- |
| Supprimer `meta-connect` / `meta-webhook` | Les URLs disparaissent ; les tables restent, vides ou avec les connexions déjà établies |
| Retirer un secret | La fonction correspondante repasse en « configuration manquante » |
| Supprimer les tables Meta | Possible, mais **destructif** : à n'envisager qu'après suppression des fonctions |

Aucune de ces actions ne touche les données e-commerce, la facturation ou les autres intégrations.

---

## 6. Le risque que je dois nommer

**Le projet Supabase est partagé : il n'y a pas de préproduction isolée.** Déployer `meta-*`
ajoute deux fonctions joignables publiquement en production dès la seconde suivant le
déploiement. Elles ne sont pas « inoffensives » :

- `meta-connect` lit la base et Vault **pour le compte authentifié**. Sans JWT valide elle répond
  401, mais une faille dans `getUserId` exposerait des connexions.
- `meta-webhook` écrit en base sur présentation d'une signature valide. Une signature forgée
  n'écrit rien, mais la validation doit être juste — c'est ce que couvrent 30 tests unitaires,
  **qui n'remplacent pas un test réel contre Meta**.

C'est pourquoi l'étape 6 (`npm run meta:readiness`) est bloquante : elle vérifie que les fonctions
sont bien fermées (401 sans JWT, 403 sur faux jeton) **avant** que vous ne fassiez quoi que ce soit
côté Meta.

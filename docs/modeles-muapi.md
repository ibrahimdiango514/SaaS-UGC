# Rapport réel — modèles vidéo & tarifs MuAPI

**Rapport généré le 11 novembre 2026 (UTC).** Toutes les valeurs ci-dessous proviennent
d’appels réellement exécutés côté serveur (fonction Edge `reelora-video`), avec la clé MuAPI
stockée en secret Supabase. Aucun tarif n’a été saisi ni estimé à la main.

| Élément | Valeur vérifiée |
| --- | --- |
| Fournisseur | MuAPI (`https://api.muapi.ai`) |
| Endpoints appelés | `GET /api/v1/models` (public), `GET /api/v1/models` (authentifié), `GET /api/v1/account/balance`, `GET /api/v1/keys` |
| Dernier appel catalogue authentifié | **2026-11-11T19:22:37.095Z** |
| Clé MuAPI | configurée **et validée** (catalogue authentifié disponible, solde lisible) |
| Source retenue | `muapi_authenticated` (catalogue complet renvoyé avec la clé) |
| Dernière synchronisation base VYORA | **2026-11-11T16:29:41.391Z** |
| Devise d’origine | **USD** (100 % des lignes) |
| Équivalent USDT | affiché systématiquement à côté du prix d’origine |

> **Convention de conversion explicitée** : `1 USD = 1 USDT` est une **convention de calcul
> interne VYORA**, pas un taux de marché. Le prix d’origine en USD reste la référence ; la
> colonne USDT n’est qu’une lecture de cette même valeur.

---

## 1. Volumétrie

| Indicateur | Valeur |
| --- | --- |
| Modèles vidéo détectés dans le catalogue MuAPI | **415** |
| Modèles sélectionnables dans VYORA (base) | **412** |
| Modèles annoncés « bientôt disponibles » | **3** |
| Modèles désactivés | **0** |
| Modèles actifs selon la classification serveur en direct | **236** |
| Modèles indisponibles selon la classification serveur en direct | **179** |

Les deux lectures ne se contredisent pas : les 412 lignes de la base sont techniquement
activées côté VYORA, mais la classification en direct retire de la sélection les modèles dont
l’entrée n’est pas raccordée à l’interface (champs d’entrée non gérés) ou dont le tarif n’a pas
pu être vérifié. **Aucune de ces exclusions n’est masquée** : le motif est affiché par modèle
dans l’administration.

Répartition des motifs (classification en direct) : `active` 236 · `unsupported` (entrée non
raccordée) et `unverified` (tarif/accès non vérifié) pour le reste · `coming_soon` 3.

---

## 2. Catégories

| Catégorie | Modèles | Sélectionnables | Tarif min (USD) | Tarif moyen (USD) | Tarif max (USD) | Tarification dynamique |
| --- | --- | --- | --- | --- | --- | --- |
| Image to Video | 194 | 192 | 0,060 | 1,443 | 9,350 | 192 |
| Text to Video | 117 | 116 | 0,016 | 1,103 | 9,350 | 116 |
| Video to Video | 83 | 83 | 0,000 | 1,535 | 9,350 | 83 |
| Audio to Video | 14 | 14 | 0,040 | 0,269 | 0,750 | 14 |
| Lora Support | 3 | 3 | 0,150 | 0,150 | 0,150 | 3 |
| Training | 2 | 2 | 0,300 | 0,300 | 0,300 | 2 |
| Text to Text | 1 | 1 | 0,100 | 0,100 | 0,100 | 1 |
| other | 1 | 1 | 0,010 | 0,010 | 0,010 | 1 |

Les montants USDT correspondants sont identiques (convention 1:1, voir l’encadré ci-dessus).

---

## 3. Distribution des tarifs (USD d’origine)

| Tranche | Modèles |
| --- | --- |
| < 0,10 USD | 26 |
| 0,10 – 0,50 USD | 150 |
| 0,50 – 1,00 USD | 118 |
| 1,00 – 3,00 USD | 75 |
| ≥ 3,00 USD | 46 |

Synthèse : minimum **0,000 USD**, médiane **0,600 USD**, moyenne **1,304 USD**,
maximum **9,350 USD**.

**Tarifs à vérifier** : 1 modèle est renvoyé avec un tarif nul (`add-video-watermark`,
0,0000 USD) — affiché comme tel et marqué dans l’administration, aucune valeur n’a été
inventée pour le remplacer. Aucun modèle ne présente de tarif absent (null).

---

## 4. Unités de facturation et paramètres qui influencent le prix

| Signal tarifaire | Modèles concernés |
| --- | --- |
| Tarification dynamique (`dynamic_pricing = true`) | **412 / 415** |
| Paramètre de durée (`duration`, `duration_seconds`, `num_frames`) | 337 |
| Paramètre de résolution / qualité | 219 |
| Paramètre de ratio d’image (`aspect_ratio`) | 254 |
| Paramètre `fps` exposé | 0 |
| Paramètre de lot (`batch_size`, `num_outputs`) | 0 |

Conséquence pratique : pour la quasi-totalité des modèles, le prix affiché ici est le **tarif de
base** ; le montant exact d’une génération dépend de la durée et de la résolution demandées.
C’est pourquoi VYORA conserve un **devis calculé côté serveur** avant toute génération
(fonction `video-quote`) et refuse d’afficher un prix quand le fournisseur ne le confirme pas
(« devis indisponible »).

---

## 5. Modèles les moins chers (vérifiés)

| Identifiant technique | Nom commercial | Catégorie | USD | USDT |
| --- | --- | --- | --- | --- |
| add-video-watermark | Add Video Watermark | Video to Video | 0,0000 | 0,0000 |
| mmaudio-v2-video-to-video | Mmaudio V2 Video To Video | Video to Video | 0,0100 | 0,0100 |
| video-background-remover | Video Background Remover | Video to Video | 0,0100 | 0,0100 |
| youtube-download | Youtube Download | other | 0,0100 | 0,0100 |
| wan2.2-5b-fast-t2v | Wan2.2 5b Fast T2v | Text to Video | 0,0160 | 0,0160 |
| remix-video | Remix Video | Video to Video | 0,0250 | 0,0250 |
| seedance-2-watermark-remover | Seedance 2 Watermark Remover | Video to Video | 0,0250 | 0,0250 |
| ai-video-upscaler | Ai Video Upscaler | Video to Video | 0,0300 | 0,0300 |
| creatify-lipsync | Creatify Lipsync | Audio to Video | 0,0400 | 0,0400 |
| latent-sync | Latent Sync | Audio to Video | 0,0400 | 0,0400 |
| sync-lipsync | Sync Lipsync | Audio to Video | 0,0400 | 0,0400 |
| veed-lipsync | Veed Lipsync | Audio to Video | 0,0400 | 0,0400 |

## 6. Modèles les plus chers (vérifiés)

| Identifiant technique | Nom commercial | Catégorie | USD | USDT |
| --- | --- | --- | --- | --- |
| seedance-2.5-intl-first-last-frame-4k | Seedance 2.5 Intl First Last Frame 4k | Image to Video | 9,3500 | 9,3500 |
| seedance-2.5-intl-image-to-video-4k | Seedance 2.5 Intl Image To Video 4k | Image to Video | 9,3500 | 9,3500 |
| seedance-2.5-intl-omni-reference-4k | Seedance 2.5 Intl Omni Reference 4k | Image to Video | 9,3500 | 9,3500 |
| seedance-2.5-intl-text-to-video-4k | Seedance 2.5 Intl Text To Video 4k | Text to Video | 9,3500 | 9,3500 |
| seedance-2.5-intl-video-edit-4k | Seedance 2.5 Intl Video Edit 4k | Video to Video | 9,3500 | 9,3500 |
| seedance-2.5-intl-video-extend-4k | Seedance 2.5 Intl Video Extend 4k | Video to Video | 9,3500 | 9,3500 |
| seedance-2.5-spicy-first-last-frame-4k | Seedance 2.5 Spicy First Last Frame 4k | Image to Video | 9,3500 | 9,3500 |
| seedance-2.5-spicy-image-to-video-4k | Seedance 2.5 Spicy Image To Video 4k | Image to Video | 9,3500 | 9,3500 |
| seedance-2.5-spicy-omni-reference-4k | Seedance 2.5 Spicy Omni Reference 4k | Image to Video | 9,3500 | 9,3500 |
| seedance-2.5-spicy-text-to-video-4k | Seedance 2.5 Spicy Text To Video 4k | Text to Video | 9,3500 | 9,3500 |

---

## 7. Devis réellement vérifiés (aucune génération, aucun débit)

Ces devis ont été obtenus par appels serveur réels sur `POST /api/v1/models/{name}/estimate-cost` :

| Modèle | Paramètres | Montant confirmé |
| --- | --- | --- |
| `f24bd427-9445-42dc-af9a-3723bf79fffd` (aussi via le slug `kling-4.0-text-to-video`) | valeurs par défaut | **0,785 USD** |
| `video-effects` (`3158cdf0-b5d1-4f97-871a-dbfb08f6b259`) | valeurs par défaut | **0,30 USD** |
| `seedance-2-omni-reference-480p` | valeurs par défaut | **1,44 USD** |
| `kling` | 1080p / 10 s | **2,35 USD** |
| `wan2.2-5bfast` | valeurs par défaut | **non vérifiable** — le fournisseur répond `PROVIDER_BAD_RESPONSE` : VYORA affiche « devis indisponible » au lieu d’un prix inventé |

---

## 8. Où consulter la table complète

La table exhaustive (415 lignes : identifiant technique, nom commercial, catégorie, tarif USD,
équivalent USDT, devise source, tarification dynamique, stratégie tarifaire, statut VYORA,
accès compte, champs requis, date de synchronisation) est disponible dans
**Administration → Modèles vidéo**, avec :

- recherche plein texte, filtres par catégorie et par statut ;
- bouton **Rafraîchir** qui interroge réellement MuAPI ;
- export **CSV** (`vyora-modeles-AAAA-MM-JJ.csv`) prêt à servir de base à la grille de crédits.

## 9. Ce qui n’a pas été modifié

Le système de crédits et d’abonnements reste **inchangé** : aucune formule, aucun prix de
crédit, aucun barème n’a été modifié par ce rapport. La table de tarifs ci-dessus servira de
base à la discussion sur la tarification VYORA.

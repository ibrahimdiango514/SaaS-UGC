# Fiche fournisseur — LLM7.io

> **Statut : `documenté`** — reçu le 2026-11-14, clé déposée le 2026-11-14.
> **Aucune intégration, aucune activation, aucun appel réseau.**
> Ce fichier ne contient **aucune clé**, seulement des **noms de variables**.

---

## 1. Identification

| Champ | Valeur |
|---|---|
| Nom commercial | **LLM7.io** |
| Éditeur / opérateur | LLM7 |
| Nature | **Passerelle multi-modèles** (texte, images, vidéos) avec offre gratuite limitée et offre Pro |
| Reçu le | 2026-11-14 |
| Source de la transmission | Chat Arena (propriétaire du produit) |
| Fiche rédigée le | 2026-11-14, d'après `docs.llm7.io` |

## 2. Accès

| Élément | Valeur |
|---|---|
| Variable de secret (déposée) | `BUSINESS_GROW_LLM7_API_KEY` |
| Présence vérifiée | Oui — par **nom** uniquement |
| Rotation | aucune rotation systématique prévue |

Variables prévues le jour de l'intégration : `BUSINESS_GROW_LLM7_API_KEY`,
`BUSINESS_GROW_LLM7_MODEL`, `BUSINESS_GROW_LLM7_BASE_URL`,
`BUSINESS_GROW_LLM7_MODELS_URL`.

## 3. Documentation consultée

| Page | Contenu retenu |
|---|---|
| `docs.llm7.io/llms.txt` | index de la documentation |
| `docs.llm7.io/limits` | quotas Free / Pro |
| `docs.llm7.io/guides/models.md` | sélecteurs de modèles, catalogue live |

Consultées le 2026-11-14.

## 4. Caractéristiques

| Champ | Valeur |
|---|---|
| Protocole | **HTTP REST, compatible OpenAI** |
| URL de base | `https://api.llm7.io/v1` |
| Authentification | `Authorization: Bearer <clé>` |
| Endpoints documentés | `POST /chat/completions`, `POST /images/generations` (annoncé), génération vidéo (annoncée), `GET /models` |
| Sélecteurs de modèle | `default` / `fast` / `pro`, **ou** un identifiant précis du catalogue live |
| Régions / résidence | **non publié** |

## 5. Modèles annoncés

- Catalogue **non figé**, exposé en direct par `GET /v1/models` (identifiant, prix,
  fenêtre de contexte, capacités).
- Sélecteurs logiques documentés : `default`, `fast`, `pro`.
- Un modèle d'image est cité dans la documentation consultée : `gpt-image-2`
  (à confirmer sur le catalogue live au moment de l'intégration).
- **Aucun identifiant de modèle n'est recopié ici comme liste de référence** : le
  registre lira le catalogue.

## 6. Capacités annoncées

| Capacité | État |
|---|---|
| Chat / complétion texte | Oui |
| Streaming | Oui (compatible OpenAI) |
| Génération d'images | Oui — endpoint annoncé |
| Génération de vidéos | Annoncée par la documentation |
| Embeddings | **à confirmer** |
| Outils / function calling | **à confirmer** selon modèle |
| Sorties structurées | **à confirmer** selon modèle |
| Multimodal en entrée | **à confirmer** selon modèle |

## 7. Tarification et quotas

| Offre | Prix | Limites de débit |
|---|---|---|
| **Free** | 0 $ | **1 req/s**, **60 req/min**, **250 req/h**, **100 000 jetons / 24 h** |
| **Pro** | **12 $ / mois** | **25 req/s**, **1 500 req/min**, **15 000 req/h** |

- Les prix par modèle sont exposés par `GET /v1/models`.
- Le plafond de **100 000 jetons / 24 h** en offre gratuite est le facteur limitant
  pour un moteur IA multi-utilisateurs → l'offre Pro est le scénario réaliste.
- Politique de facturation des images / vidéos : **non publiée** dans les pages
  consultées.

## 8. Informations manquantes / points à confirmer

1. Offre réellement souscrite sur la clé transmise (Free ou Pro) — **non vérifiable
   sans appel réseau**, donc à confirmer le jour de l'intégration.
2. Tarification des images et des vidéos.
3. Support des embeddings, des outils et des sorties structurées par modèle.
4. Régions / résidence des données : non publié.
5. Conditions d'usage (le contenu généré doit-il être vérifié par un juge ?) : hors
   périmètre pour l'instant.

## 9. État de préparation

- [x] reçu
- [x] clé déposée et vérifiée **par nom**
- [x] documenté
- [ ] prêt — **en attente de la phrase d'autorisation**

**Passerelle pressentie** : `adapter_kind = openai`, `is_aggregator = true`.
Rien n'est écrit dans le registre actif à ce stade.

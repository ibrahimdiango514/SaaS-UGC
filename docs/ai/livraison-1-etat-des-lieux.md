# VYORA AI — état des lieux avant livraison 1

Vérifications faites avant tout développement, conformément à la Partie A.

## 1. Branches et commits

| Élément | État vérifié |
|---|---|
| Branche de travail du dépôt | `arena/vyora-connect-scope` (celle de #12) |
| `2139ffd` (correction #10) | **présent** |
| `6bdf12d` (tests #10) | **présent** |
| `3b34f93` (verrou #12) | **présent** |
| `fe4722f` (procédure de fusion) | **présent** |
| Branche `arena/bfcedd89-saas-ugc` | existe localement et sur l'origine, PR #8 ouverte |

**Dépendances entre PR**

| PR | Base | Contenu |
|---|---|---|
| #9 | `develop` | serveur MCP, catalogue, page `/app/mcp` |
| #10 | `arena/vyora-mcp-core` (**empilée sur #9**) | socle OAuth + MCP |
| #12 | `develop` | Connect, OAuth, verrou d'artefacts |

#10 ne peut pas être fusionnée avant #9 : sa base est la branche de #9.

**La répétition de fusion n'a pas été appliquée aux branches réelles.** C'était
volontaire : elle a servi à établir la procédure, pas à modifier les PR.

## 2. Ce qui existe déjà et qui change le plan

La Livraison 1 ne part pas de rien. L'audit a révélé une infrastructure de chat
**déjà déployée en production** :

| Brique | État réel |
|---|---|
| `saas_business.conversations` / `messages` | tables existantes, RLS par utilisateur |
| `bg_create_conversation`, `bg_list_conversations`, `bg_list_messages` | **fonctions déployées** |
| `bg_rename_conversation`, `bg_delete_conversation` | **déployées** |
| `bg_submit_user_message` | **déployée** |
| `messages.send` (client) | câble l'IA via `vyora-ai` (`action: complete`) |
| Relais Netlify `/api/business-grow` | **same-origin, sans secret** |
| `vyora-ai` `action: complete` | accepte un historique `system/user/assistant` complet |

**Conséquence** : la Livraison 1 peut être un **vrai chat persisté** — pas une
maquette. Les conversations survivent au rechargement et sont retrouvées par
utilisateur.

## 3. Ce qui n'existe pas

| Élément | Réalité | Décision pour la Livraison 1 |
|---|---|---|
| **Streaming** | `vyora-ai` répond en une fois, pas de SSE | affichage progressif **réel** (texte dévoilé au fil de la réception) — pas un faux flux réseau |
| **Recherche vocale** | aucune API de transcription | bouton **absent**, pas de bouton mort |
| **Réponse audio** | `speechSynthesis` du navigateur disponible | implémenté, avec mention que c'est la voix du navigateur |
| **Pièces jointes** | bucket `ugc-assets` exige un `workspace_id` UUID où l'utilisateur peut éditer | implémenté, **dépend d'un workspace** ; message explicite sinon |
| **Mode analyse** | pas de modèle dédié | implémenté comme **instruction de raisonnement** envoyée à `vyora-ai`, pas comme moteur séparé |

Aucun de ces points n'est simulé. Chacun est soit implémenté réellement, soit
absent, soit affiché avec son prérequis.

## 4. Contrainte Netlify — à lire avant la livraison

**Ce que j'ai vérifié :**

- `netlify.toml` existe, publié sur `dist`, `npm ci && npm run build`
- un site Netlify est bien connecté : `vyora-ugc.netlify.app`
- les Deploy Previews par PR fonctionnent déjà (`deploy-preview-6--vyora-ugc.netlify.app`)
- **aucun jeton d'authentification Netlify** n'est disponible dans mon
  environnement d'exécution
- le CLI Netlify s'installe mais n'est pas authentifié

**Conséquence, dite franchement :** je ne peux pas déclencher ni créer un
déploiement Netlify moi-même. Je ne peux pas non plus inventer une URL.

**Ce que je vais faire à la place :**

1. faire le build localement et vérifier qu'il passe ;
2. pousser sur une branche dédiée (distincte de #12) ;
3. interroger l'API GitHub après le push pour lire l'URL de preview Netlify
   **réellement produite**, si le site est connecté à cette branche ;
4. si aucune URL n'apparaît, vous le dire et fournir la configuration minimale
   exacte à activer — sans prétendre qu'un preview existe.

Un point de sécurité à signaler : `netlify.toml` déclare
`Permissions-Policy: microphone=()`, ce qui **bloque le microphone**. C'est
correct tant qu'aucune fonction vocale n'existe. Si vous voulez la dictée
vocale plus tard, il faudra ouvrir cette permission explicitement — je ne le
ferai pas sans votre accord, car c'est un élargissement de surface.

## 5. Identité visuelle prévue

Le design system VYORA existe déjà et je le réutilise plutôt que d'en créer un
second :

- fond `#070b12`, panneaux `#0e141d`, bordures `rgba(148,163,184,0.13)`
- accent cyan `#06b6d4` → `#0891b2`, accent secondaire violet `#a78bfa`
- titres en `Space Grotesk`, texte en `DM Sans`
- primitives existantes : `Button`, `Card`, `Modal`, `Badge`, `EmptyState`,
  `Skeleton`, `Tabs`, `Banner`

L'interface reprendra le principe d'organisation de la capture (sidebar +
zone centrale) avec une identité VYORA propre : dégradés cyan/violet discrets,
panneaux translucides, micro-animations `riseIn` et `fadeUp` déjà définies.

## 6. Plan de la Livraison 1

**Branche** : `arena/vyora-ai-interface`, créée depuis `origin/develop`.
Aucune modification de #8, #9, #10, #11, #12.

**Fichiers prévus**

| Fichier | Rôle |
|---|---|
| `src/ai/api.ts` | lecture/écriture des conversations via `business-grow` |
| `src/ai/types.ts` | types de conversation et message |
| `src/ai/useConversations.ts` | état, recherche, création, renommage, suppression |
| `src/ai/Composer.tsx` | zone de saisie : pièces jointes, analyse, envoi, voix |
| `src/ai/MessageList.tsx` | historique, rendu markdown, copie, audio |
| `src/pages/Assistant.tsx` | page `/app/ai` : sidebar + conversation |
| `src/components/AiSidebar.tsx` | sidebar repliable, recherche, historique |
| `src/navigation/config.ts` | +1 entrée de navigation |
| `src/App.tsx` | +1 route |
| `tests/ai-interface.test.tsx` | tests de l'interface |

**Périmètre assumé de la Livraison 1** : interface, conversations, historique,
recherche, pièces jointes, audio, responsive. **Pas** le catalogue
d'intégrations, qui est la Livraison 2.

---

## Verdict de la Partie A

Rien ne bloque la Livraison 1. Deux points à garder en tête :

1. la Livraison 1 sera un **vrai chat**, grâce au socle déjà déployé ;
2. **le preview Netlify dépend d'un déploiement que je ne peux pas déclencher**
   — je fournirai l'URL réelle si elle apparaît, et la configuration exacte
   sinon.

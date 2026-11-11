# Contrats IA ↔ Plateforme VYORA (collaboration sans conflit)

Ce document définit les **frontières d’ownership** et les **contrats TypeScript stables** permettant de faire évoluer en parallèle :
- **La plateforme générale VYORA dans VS Code** (`Dashboard`, `Projects`, `GenerationStudio`, `Editor`, `Settings`, `Subscription`, `PreparedSpace`, connecteurs externes, `saas_ugc`)
- **Le moteur IA & Business Intelligence Business Grow** (`supabase/functions/business-grow/`, `src/business/`, `saas_business`, fournisseurs, routage, modèles, mémoire métier, outils assistés)

---

## 1. Frontières de fichiers & zones d’ownership

| Domaine | Chemins propriétaires du moteur IA (Arena) | Chemins plateforme générale (VS Code) |
|---|---|---|
| **Contrats partagés** | `src/contracts/business-grow.ts` *(interface publique versionnée)* | Consommation en lecture/import uniquement |
| **Pont d’exécution** | `src/business/bridge.ts`, `src/business/index.ts` | Appels via `businessGrowBridge` |
| **UI & API Business Grow** | `src/business/**` | Lien vers `/app/business` avec `buildBusinessGrowLocationState(...)` |
| **Edge Function Business IA** | `supabase/functions/business-grow/**` | Aucune modification directe |
| **Base de données** | `saas_business.*` (`supabase/migrations/*business_grow*`) | `saas_ugc.*` (`projects`, `brands`, `products`, `ugc_*`) |
| **Studio UGC & Pages** | Consommation typée du handoff dans `GenerationStudio.tsx` | `src/pages/**`, `src/studio/**`, `src/components/**`, `src/integrations/**` |

> **Règle d’or anti-conflit** : VS Code ne doit jamais importer `src/business/BusinessGrowWorkspace.tsx` ni `src/business/api.ts` directement. Tous les points de contact passent par `src/contracts/business-grow.ts` et `src/business/index.ts` (`businessGrowBridge`).

---

## 2. Contrats disponibles dans `src/contracts/business-grow.ts`

### A. Ouvrir Business Grow avec un contexte plateforme (`BusinessGrowEntryIntent`)

Permet d’ajouter des boutons *"Analyser avec Business Grow"* ou *"Préparer une campagne IA"* depuis `Dashboard`, `ProjectDetail`, `Settings` ou `PreparedSpace` :

```tsx
import { Link } from 'react-router-dom';
import { buildBusinessGrowLocationState } from '../contracts/business-grow';

<Link
  to="/app/business"
  state={buildBusinessGrowLocationState({
    section: 'chat',
    roleKey: 'marketing_campaign',
    projectId: project.id,
    projectTitle: project.title,
    initialDraft: `Propose une campagne UGC et 3 hooks pour le projet « ${project.title} ».`,
    sourceRoute: `/app/projets/${project.id}`,
  })}
>
  Analyser avec Business Grow
</Link>
```

Business Grow lit automatiquement `parseBusinessGrowEntryIntent(location.state)`, ouvre la section demandée, sélectionne le rôle métier et pré-remplit le champ de saisie.

### B. Lire l’état IA & quota isolé (`BusinessGrowStatusPort`)

Pour afficher l’état des fournisseurs IA ou le quota `saas_business` dans `Dashboard` ou `Settings` sans jamais mélanger avec `saas_ugc` :

```ts
import { businessGrowBridge } from '../business';

const snapshot = await businessGrowBridge.getSnapshot();
// snapshot.availableProviderCount
// snapshot.quota?.studioUgcUntouched === true
```

### C. Exécuter une tâche IA centralisée depuis un espace VYORA (`BusinessAiEnginePort`)

Pour alimenter les futurs espaces préparés (`Marketing Studio`, `Scripts IA`, `Storyboarding`, `Agents`, `Workflows`) via l’AI Director central :

```ts
import { businessGrowBridge } from '../business';

const result = await businessGrowBridge.executeTask({
  roleKey: 'content_strategy',
  workspaceId,
  prompt: 'Rédige 3 angles d’accroche pour...',
  idempotencyKey: crypto.randomUUID(),
  routing: { selectionMode: 'auto', allowFallback: true },
});
```

### D. Transfert Business Grow → Studio UGC sans débit (`BusinessGrowUgcHandoffBrief`)

Quand l’utilisateur clique sur **"Ouvrir dans Studio UGC (sans débit)"**, Business Grow génère un state `ugcBrief` versionné (`reelora-ugc-handoff-v1`, `consumesStudioCredits: false`).  
`GenerationStudio.tsx` l’extrait via `extractUgcHandoffBriefFromLocationState(location.state)` et le convertit via `formatUgcPromptFromBrief(brief)`, tout en appliquant `preferredRatio` et `suggestedSector` sans débiter un seul crédit `saas_ugc`.

### E. Pont Connecteurs Externes (`BusinessConnectorReadBridge`)

Toute future intégration (`facebook`, `instagram`, `youtube`, `tiktok`, `shopify`, `woocommerce` définies dans `src/integrations/contracts.ts`) ne doit jamais stocker ni lire de secrets OAuth dans le navigateur :
- Le backend connecteur vérifie le token côté serveur,
- Le moteur d’outils Business Grow expose uniquement `request_connector_read` (lecture seule ou approbation humaine pour toute écriture/publication externe).

---

## 3. Règles strictes d’isolation & de sécurité

1. **Zéro couplage financier `saas_business` ↔ `saas_ugc`** : Business Grow possède son propre quota (`saas_business.ai_quota_*`) et ne lit/débite jamais `saas_ugc.ugc_wallets` ni `saas_ugc.ugc_credit_ledger` (vérifié automatiquement par `tests/business-grow-boundaries.test.ts`).
2. **Approbation humaine obligatoire** : Aucun outil Business Grow (`propose_memory_save`, `propose_action_plan`, `propose_campaign_brief`, `handoff_ugc_brief`, `request_connector_read`) ne s’exécute automatiquement sans validation explicite `approved` par l’utilisateur.
3. **Confidentialité mémoire** : `saas_business.business_memory_items` exige un consentement actif (`consent = true`) et une suppression complète sur révocation ou demande d’effacement RGPD (`bg_prepare_account_erasure`).
4. **Tests de non-régression** : Avant tout merge, exécuter :
   - `npm run typecheck`
   - `npm test`
   - `npm run build`

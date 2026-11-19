# Business Grow — l'agent enregistre réellement un prospect

Projet Supabase : `xbuuhfwobrafcbgtdgjx` — fonction Edge `business-grow`
(`6e29e1f3-a9e1-4258-a399-460ed2576d07`).

## 1. Le défaut

L'assistant répondait « prospect enregistré » alors que rien n'était écrit.

La cause n'était pas un bug de persistance : **aucun outil** ne permettait à
l'agent de créer un prospect. La liste fermée de `bg_create_tool_execution`
comptait cinq entrées — `propose_memory_save`, `propose_action_plan`,
`propose_campaign_brief`, `handoff_ugc_brief`, `request_connector_read` — et
aucune ne produit un `growth_prospect`.

Un modèle sans outil disponible ne peut que répondre « c'est noté ». L'utilisateur
découvre le mensonge en cherchant la donnée.

## 2. Le correctif

Migration `20261129100000_business_grow_prospect_tool.sql` :

1. **`propose_prospect_save`** entre dans la liste fermée. Il reste soumis à
   approbation humaine (`pending_approval`), comme les autres écritures.
2. **`bg_save_scoped_prospect`** écrit le prospect dans
   `saas_business.workspace_memory_items`, catégorie `growth_prospect` — le même
   endroit que le formulaire manuel, donc l'agent et l'interface voient les
   mêmes lignes. Aucune table nouvelle, aucun second système.
3. **Relecture de persistance** : la fonction relit la ligne qu'elle vient
   d'écrire. Si la relecture ne trouve rien, elle lève ; l'exécution passe en
   `failed` et l'utilisateur voit un échec honnête.

`bg_agent_resolve_tool` et `bg_create_tool_execution` sont recopiées à
l'identique, à la seule branche ajoutée. La parité est vérifiée mécaniquement.

## 3. Ce qui est vérifié en base réelle

| Cas | Résultat |
| --- | --- |
| Approbation d'un prospect complet | `executed`, `persisted: true`, ligne relue |
| Double approbation | `executed`, **un seul** prospect créé |
| Refus explicite | `rejected`, **aucune** écriture |
| Outil inconnu (`delete_everything`) | `invalid tool proposal` |
| Nom vide | `prospect name required` |
| Étape inventée (`en-negociation-avancee`) | repli sur `prospect` |
| Montant « environ 5000 » | ignoré, prospect **conservé** |
| Montant négatif | ignoré |
| Date invalide (`vendredi prochain`) | ignorée, jamais devinée |
| Devise `xof` | normalisée en `XOF` |
| Alias français (`nom`, `entreprise`, `etape`) | acceptés |
| Écriture dans le workspace d'autrui | `workspace access denied` |
| Entrée ou espace `NULL` | `invalid prospect input` |

La révocation du consentement n'a pas pu être testée en écriture directe : un
trigger protège `workspace_memory_consent_events`, ce qui est le comportement
attendu. `bg_require_scoped_consent` est appelé avant toute écriture.

## 4. Côté modèle

`intelligence.ts` :

- `propose_prospect_save` ajouté à `BusinessToolName`, avec le niveau de risque
  `write_requires_approval` ;
- normalisation des arguments (alias français, étapes accentuées, devise,
  montants invalides, repli sur le résumé quand le nom manque) ;
- prompt système mis à jour, avec la liste des clés attendues.

`tests/prospect-tool.test.ts` (13 tests) couvre cette chaîne.

## 5. Ce qui reste à faire : le déploiement

**Le correctif n'est PAS actif en production.** L'état vérifié le 2026-11-14 :

| Élément | État |
| --- | --- |
| Base de données | ✅ à jour (fonctions appliquées, testées) |
| Code source + artefact | ✅ commité, bundle à jour, parité vérifiée |
| Fonction Edge déployée | ❌ **version 35**, épinglée sur `25385118…` (88 235 car.) |

Tant que la fonction n'est pas redéployée, l'assistant en ligne **ignore
silencieusement** `propose_prospect_save` : le bundle déployé ne le connaît pas,
l'extraction l'écarte, et aucune proposition d'enregistrement n'est faite. Il
n'affirme donc plus à tort avoir enregistré — mais il ne peut toujours pas le
faire.

L'ancien bundle reste **cohérent** : il attend 88 235 caractères et GitHub en
sert exactement 88 235. Il n'y a donc pas de panne, seulement une fonctionnalité
absente.

### Procédure

```bash
# 1. S'assurer que la branche est poussée et que le commit épinglé est sur GitHub.
git rev-parse HEAD   # doit correspondre au COMMIT de loader.ts

# 2. Vérifier la parité octet pour octet avant de déployer.
BG_PIN_COMMIT=67b655d63d83b6253da56a95345d71a48cee7433 \
  node scripts/build-business-grow-artifact.mjs --check

# 3. Déployer — APRÈS autorisation explicite (cf. scripts/deploy-edge-functions.sh).
supabase functions deploy business-grow --project-ref xbuuhfwobrafcbgtdgjx
```

Le déploiement touche une fonction **partagée** par le projet, non isolée par
branche ni par preview. Il demande donc une décision explicite, pas une
exécution automatique.

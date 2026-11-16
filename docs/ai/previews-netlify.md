# Previews Netlify — constat et configuration requise

**Dernière vérification : commit `4f643e7`** (Livraisons 1 et 2), branche
`arena/bfcedd89-saas-ugc`, PR #8.

## Constat

| Commit | Branche | Statut GitHub | Check-runs | Deploy Preview |
|---|---|---|---|---|
| `4f643e7` | `arena/bfcedd89-saas-ugc` | `pending` | **0** | aucun |
| `a7818cc` | `arena/vyora-ai-interface` | `pending` | **0** | aucun |
| `6f0decd` | `develop` | `pending` | **0** | aucun |
| `cc43bb3` | `main` | `pending` | **0** | aucun |

Aucun commit de ce dépôt, sur aucune branche, ne porte de statut ni de
check-run Netlify. `statusCheckRollup` est vide sur les PR #8, #12 et #13.

**Conclusion : l'intégration GitHub ↔ Netlify ne produit aucun événement.**
Ce n'est pas un problème de branche ni de configuration de build : Netlify
n'est pas relié au dépôt, ou les Deploy Previews sont désactivés au niveau du
site. Tant que cela n'est pas corrigé, aucun commit ne peut produire d'URL de
preview, quel que soit le nombre de push.

## Ce que je ne fais pas

- Je ne fabrique **aucune URL**. `deploy-preview-<n>--<site>.netlify.app` est
  le schéma habituel, pas une preuve : sans `target_url` renvoyé par l'API
  GitHub, l'affirmer serait inventer.
- Je ne considère pas l'URL de production comme un preview du commit.
- Je ne modifie pas le site de production pour contourner l'absence de preview.

Depuis le bac à sable, `app.netlify.com` et les domaines `*.netlify.app`
répondent `000` (hors des hôtes autorisés). La seule voie d'observation est
l'API GitHub — et elle est vide.

## Configuration minimale à activer (côté tableau de bord Netlify)

1. **Relier le dépôt** : Site configuration → Build & deploy → Continuous
   deployment → lier `ibrahimdiango514/SaaS-UGC`.
2. **Activer les Deploy Previews** : Deploys → Deploy Previews → « Any pull
   request » (ou « All branches »). C'est cette case, désactivée, qui explique
   l'absence totale d'événement.
3. **Vérifier la branche de production** : `main` (les PR ciblent `develop` ;
   les previews ne dépendent pas de ce réglage, mais le déploiement de
   production, si).
4. **Build** : `npm ci && npm run build`, répertoire de publication `dist`.
   Le projet est un SPA : la redirection `/* → /index.html 200` est
   nécessaire pour que `/app/connect` fonctionne en accès direct.
5. **Variables** : aucune n'est requise pour le build — l'URL et la clé
   publique Supabase sont déjà dans le code. **Ne pas ajouter de clé de
   service** : elle serait exposée au navigateur.

## Accès nécessaire

Je n'ai aucun jeton Netlify et aucun accès au tableau de bord. Pour que je
puisse vérifier un preview moi-même, il faut soit :

- activer l'intégration (elle publiera alors un statut GitHub que je peux
  lire via `gh api`), soit
- fournir un moyen d'observation côté GitHub — c'est la seule voie autorisée
  depuis cet environnement.

## Vérification locale de substitution (déjà faite)

Faute de preview, le build de production a été servi localement et vérifié :

- `/app/connect` → HTTP 200 ; chunk `CatalogPage-C4SoN8EM.js` (31,8 kB)
  contenant « Connectez vos outils », « Boutiques en ligne », « Validation
  externe requise », « Configuration requise » ;
- `/app/ai` → HTTP 200 ; chunk `Assistant-Djqy74EA.js` (30,4 kB) contenant
  « Nouveau chat » et « Navigation de l'assistant » ;
- aucune occurrence de « Crédits Studio UGC » dans ces deux chunks, ce qui
  confirme que l'ancienne coquille Studio n'est plus rendue.

Cela prouve que le code livré fonctionne, **pas** qu'un preview existe.

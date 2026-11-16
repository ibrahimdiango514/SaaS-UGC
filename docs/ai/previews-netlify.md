# Previews Netlify — diagnostic et configuration requise

Ce document explique, preuves à l'appui, pourquoi aucun Deploy Preview n'a pu
être fourni, et ce qu'il faut activer pour que cela fonctionne.

## Ce qui est établi

| Vérification | Résultat |
|---|---|
| `netlify.toml` présent, cible `dist`, commande `npm ci && npm run build` | oui |
| Site Netlify relié au dépôt (`vyora-ugc.netlify.app`) | oui, il a servi `deploy-preview-6--vyora-ugc.netlify.app` |
| Branche `arena/vyora-ai-interface` exclue par la règle `ignore` | **non**, elle n'est pas filtrée |
| Statut Netlify sur les commits | **aucun**, sur toute branche |
| Statut Netlify sur les PR #12 et #13 | **aucun** (`statusCheckRollup` vide) |
| Hôtes accessibles depuis l'environnement d'exécution | github.com, codeload, api.github.com, npm, pypi, files.pythonhosted |
| `app.netlify.com` joignable | **non** (code 000) |
| Jeton Netlify dans l'environnement | **absent** |
| Chrome/Puppeteer téléchargeable | **non** (ECONNRESET vers googlechromelabs.github.io) |

## Diagnostic

**Le site Netlify existe et a déjà produit des previews** (preuve : le domaine
`deploy-preview-6--vyora-ugc.netlify.app` cité dans la documentation du dépôt).
Mais **aucun commit récent ne porte de statut Netlify**, et aucune PR n'en
porte non plus — y compris la PR #12, ouverte depuis plusieurs jours.

Conclusion : l'intégration GitHub ↔ Netlify n'est plus active, ou la
publication des statuts est désactivée. Sans cela, un push sur une branche ne
déclenche aucun build.

**Point important** : la branche `arena/vyora-ai-interface` n'avait **aucune
PR** jusqu'au commit `91952e7`. Or les Deploy Previews Netlify sont liés aux
pull requests : sans PR, il n'y a rien à prévisualiser, même avec
l'intégration active. La PR #13 a été ouverte pour lever ce point.

## Configuration minimale à activer (côté Netlify)

Ces actions ne peuvent pas être faites depuis l'environnement d'exécution : il
faut un accès au tableau de bord Netlify.

1. **Reconnecter le dépôt**
   Site configuration → Build & deploy → Continuous deployment →
   Repository → *Link repository* → `ibrahimdiango514/SaaS-UGC`.
   Si le dépôt est déjà lié, vérifier que l'installation GitHub de Netlify a
   toujours accès au dépôt (une révocation d'accès coupe les builds sans
   message).

2. **Activer les Deploy Previews**
   Site configuration → Build & deploy → Deploy previews →
   *Any pull request against your production branch* (ou *All branches*).

3. **Vérifier la branche de production**
   Elle doit être `main` ou `develop` selon votre choix. Si elle est
   `develop`, les PR vers `develop` déclenchent des previews ; si elle est
   `main`, il faut choisir *All branches*.

4. **Vérifier la règle `ignore`**
   `netlify.toml` exclut déjà `arena/323bad30-saas-ugc` et
   `arena/ada94e4c-saas-ugc`. Aucune autre branche n'est filtrée : les
   branches de ce chantier se construiront normalement.

5. **Vérifier les variables d'environnement du site**
   Le frontend n'en a pas besoin : `src/lib/supabase.ts` et
   `public-config.ts` contiennent l'URL Supabase et la clé **publique** en
   dur. Un preview se connecte donc à la vraie base sans configuration.
   Ne pas ajouter de clé de service dans les variables du site.

## Après activation

L'URL suivra le modèle :

```
https://deploy-preview-<numéro-de-PR>--vyora-ugc.netlify.app
```

Pour la PR #13 (branche `arena/vyora-ai-interface`), ce sera
`deploy-preview-13--vyora-ugc.netlify.app`.

**Je n'écris pas cette URL comme si elle existait.** Elle ne sera valide
qu'une fois le build déclenché. Je vérifie après coup via l'API GitHub
(`/commits/<sha>/status`), qui expose l'URL réelle dans `target_url`.

## Alternative pendant l'attente

Un build de production est servi localement dans l'environnement de travail
(`vite preview`), sur un port exposé en aperçu. Ce n'est pas Netlify, mais
c'est **le même `dist/`** et **la même base Supabase** : la preuve visuelle y
est aussi valable.

## Ce que je ne peux pas faire

- créer un déploiement sans jeton ni accès réseau à Netlify ;
- produire une capture d'écran (Chrome non téléchargeable) ;
- vérifier moi-même une URL `*.netlify.app` depuis cet environnement.

Ces trois limites sont des contraintes d'environnement, pas des choix. Elles
sont énoncées pour que vous sachiez exactement ce qui a été vérifié et ce qui
ne l'a pas été.

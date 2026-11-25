# Smoke test après publication — SORAHNEX

> À exécuter **après** un déploiement autorisé sur le nouveau site. Ne consomme
> aucun crédit Netlify : ce sont des requêtes applicatives, pas des builds.
>
> Remplacer `<SITE>` par l'origine du nouveau site. Cocher chaque case ; noter le
> résultat réel, pas l'intention.

---

## 1. Le site répond et sert bien le bon code

- [ ] `https://<SITE>/` → HTTP 200, titre `SORAHNEX`, identité SORAHNEX visible.
- [ ] Le cachet de version affiché correspond au commit de `main` déployé.
- [ ] `view-source` ne contient **aucune** clé `sb_secret_` ni `service_role`.
- [ ] Le bundle charge sans erreur dans la console du navigateur.
- [ ] Le badge Netlify est présent en pied de page (facultatif).

## 2. Routage SPA

- [ ] `/connexion`, `/inscription`, `/app` répondent 200 après rechargement
      (pas de 404 : la règle `/*` → `/index.html` fonctionne).
- [ ] Une URL inconnue (`/nimportequoi`) affiche la page 404 de l'application,
      pas celle de Netlify.

## 3. Authentification — le parcours complet

- [ ] **Inscription** : créer un compte avec une adresse réelle.
      → l'e-mail de confirmation arrive.
- [ ] Le lien de confirmation mène bien à `https://<SITE>/auth/callback`
      (**pas** à l'ancien domaine : c'est le défaut corrigé).
- [ ] Après confirmation, la session est active et redirige vers `/app`.
- [ ] **Déconnexion** → retour à l'écran de connexion.
- [ ] Reconnexion avec le même compte → succès.
- [ ] **Session persistante** : recharger l'onglet, la session tient.
- [ ] **Mot de passe oublié** depuis `<SITE>` → l'e-mail arrive, le lien ouvre
      l'écran « Nouveau mot de passe » sur `<SITE>`, la mise à jour fonctionne et
      l'ancien mot de passe ne fonctionne plus.
- [ ] Accès direct à `/app/...` **sans** session → redirection vers `/connexion`,
      puis retour à la page demandée après connexion.
- [ ] Accès administrateur refusé à un compte non administrateur.

## 4. Backend — Grow

- [ ] L'onglet Grow se charge (aucune erreur réseau dans la console).
- [ ] `status` répond : les fournisseurs s'affichent avec leur état réel.
- [ ] **Créer un prospect** (CRM) → il apparaît après rechargement (donc **persisté**).
- [ ] Modifier ce prospect → la modification persiste.
- [ ] Créer une tâche, une activité, une dépense en caisse → persistées.
- [ ] Supprimer l'enregistrement de test → il disparaît après rechargement.
- [ ] Conversations : créer, renommer, supprimer.
- [ ] Mémoire : la page répond (consentement, profil).
- [ ] `quotas` : la réponse est cohérente et **le message d'erreur éventuel ne
      parle plus de « génération »**.
- [ ] Import & Connect : sans abonnement, le refus affiché est
      « réservé aux abonnés Grow » (pas une erreur technique).
- [ ] Affichage mobile (360 px) : navigation, tableaux et formulaires utilisables.

## 5. Backend — Studio

- [ ] Le catalogue des modèles se charge.
- [ ] `studio-runtime › quotas` répond ; si `SUBSCRIPTION_REQUIRED`, le message
      est compréhensible et ne mentionne pas de nouvelle tentative de génération.
- [ ] Avec un compte abonné : devis affiché **avant** toute génération (aucun
      coût fournisseur non annoncé).
- [ ] Génération d'image test : le job démarre, se termine, le crédit est débité
      **une seule fois**.
- [ ] Un job en échec **rembourse** le crédit réservé.
- [ ] Historique : le job apparaît avec son état réel.
- [ ] Téléchargement du résultat : le fichier s'ouvre (URL signée valide).
- [ ] Aucun chiffre fantôme : pas de « crédits restants » inventé.

## 6. Backend — MCP et intégrations

- [ ] La page des serveurs MCP se charge.
- [ ] `gestion/lister` répond sans erreur 401 pour un utilisateur connecté.
- [ ] Les connecteurs sociaux affichent « indisponible » si aucune clé n'est
      déclarée — c'est l'état attendu, pas une régression.
- [ ] Chariow / Shopify / WooCommerce : la page de connexion affiche les
      prérequis réels ; aucune promesse d'écriture (Chariow est en lecture seule).

## 7. CORS et domaines

- [ ] Console du navigateur : **aucune** erreur `blocked by CORS policy`.
      Si erreur : la nouvelle origine manque dans `*_ALLOWED_ORIGINS` (§5.2 de la
      checklist) — ou les secrets Edge n'ont pas été redéployés.
- [ ] Aucune requête du navigateur vers `*.supabase.co` ne renvoie 403.
- [ ] Les liens internes n'utilisent plus l'ancien domaine.

## 8. Sécurité

- [ ] `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` présents
      (en-têtes de `netlify.toml`).
- [ ] `/assets/*` servi avec `cache-control: immutable` ; `index.html` en `no-cache`.
- [ ] Un appel direct à `/api/business-grow` **sans** jeton est refusé (401).
- [ ] Un utilisateur A ne peut pas lire les données d'un utilisateur B
      (tester avec deux comptes).

## 9. Après le test

- [ ] **Retirer** `SORAHNEX_DEPLOY_AUTHORIZED` et `SORAHNEX_DEPLOY_AUTHORIZED_NAME`
      du site (le verrou se réarme).
- [ ] Vérifier qu'un déclenchement suivant est bien **annulé** par la garde.
- [ ] Supprimer les comptes de test créés.
- [ ] Consigner les écarts dans `docs/bascule-nouveau-netlify.md` §5 si un retour
      arrière est nécessaire.

---

## En cas d'échec — décision rapide

| Symptôme | Cause la plus probable | Action |
| --- | --- | --- |
| Build jamais lancé | Garde : `netlify.site.conf` ou variables | Lire le journal du build, il nomme la condition manquante |
| Écran blanc, console 401/403 sur les fonctions | CORS / origine absente | Ajouter l'origine aux `*_ALLOWED_ORIGINS`, redéployer les fonctions |
| Liens e-mail vers l'ancien domaine | `site_url` / `uri_allow_list` | Corriger Supabase Auth (§5.1), **sans** perdre les entrées existantes |
| Grow répond mais l'assistant ne génère pas | Aucun `BUSINESS_GROW_*_API_KEY` | Décision : configurer un fournisseur (consomme du quota) |
| `quotas` en 409 | Migrations lot16/17 non appliquées | Décision explicite ; ne pas appliquer sans sauvegarde (checklist §8) |
| Données non enregistrées | Session expirée ou RLS | Vérifier la session, puis les politiques de la table concernée |

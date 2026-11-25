# Audit de la configuration Auth — relevé le 25 novembre 2026

Relevé direct de la configuration du projet `xbuuhfwobrafcbgtdgjx`, pas une
reconstitution. Ce document liste ce qui est correct, ce qui est fragile, et ce
qu'il faudra changer au moment de la bascule vers le nouveau site Netlify.

---

## 1. Ce qui fonctionne

| Réglage | Valeur | Verdict |
|---|---|---|
| `site_url` | `https://vyora-saas-ugc.netlify.app` | ✅ pointe sur le site réellement servi |
| Inscription e-mail | activée | ✅ |
| Connexion par téléphone | désactivée | ✅ cohérent (aucun fournisseur SMS) |
| Templates e-mail | utilisent `{{ .ConfirmationURL }}` | ✅ le lien suit `site_url`, donc rien à réécrire à la bascule |
| Rotation des jetons de rafraîchissement | activée | ✅ |
| `uri_allow_list` | inclut `/**` pour le site courant et les prévisualisations | ✅ les prévisualisations Netlify fonctionnent |

Les cinq parcours d'authentification reposent donc sur des mécanismes corrects :
inscription, connexion, déconnexion, récupération du mot de passe, et retour par
`/auth/callback` (le composant `AuthCallback` gère `type=recovery` et `next`).

## 2. Deux fragilités réelles, à trancher avant l'ouverture publique

### 2.1 Aucun SMTP personnalisé, et une limite de 2 e-mails par heure

`smpt_host` est vide : le projet utilise le service d'e-mail intégré de Supabase.
Deux conséquences mesurées dans la configuration :

- `rate_limit_email_sent = 2` — **au troisième « mot de passe oublié » dans
  l'heure, l'envoi est refusé**. Ce n'est pas une hypothèse : c'est la valeur
  configurée. Le service intégré est prévu pour les essais, pas pour des clients.
- Le service intégré n'a aucune garantie de délivrabilité (souvent filtré en
  indésirable), et Supabase documente qu'il n'est pas destiné à la production.

**Ce que cela signifie concrètement** : aujourd'hui, `mailer_autoconfirm = true`
(voir §2.2) fait qu'aucun e-mail de confirmation n'est envoyé — le problème reste
donc invisible. Mais dès qu'un utilisateur clique sur « mot de passe oublié », il
dépend de ce service. Le premier mois, deux personnes par heure peuvent
réinitialiser leur mot de passe ; la troisième voit un échec.

**Correction recommandée, non appliquée** (elle demande des identifiants SMTP que
je n'ai pas) : configurer un fournisseur SMTP (Resend, Brevo, Postmark, ou une
boîte professionnelle) dans Supabase → Authentication → Emails → SMTP Settings,
puis relever `rate_limit_email_sent`. À défaut, l'alternative est de désactiver
proprement la récupération par e-mail et d'assumer une réinitialisation
administrative — mais il faut le choisir, pas le subir.

### 2.2 `mailer_autoconfirm = true` : les adresses ne sont jamais vérifiées

Toute inscription est immédiatement active, avec n'importe quelle adresse, même
inventée. C'est un choix défendable pour un lancement (aucune friction, aucun
e-mail à délivrer), mais il a trois effets à assumer :

1. **Aucune preuve de possession de l'adresse** : un compte peut être créé avec
   l'e-mail d'un tiers.
2. **Aucune récupération de mot de passe possible** pour une adresse inexistante —
   d'où l'importance du point §2.1 si tu passes un jour à `autoconfirm = false`.
3. **Le lien magique et la confirmation deviennent inutiles** : les templates
   existent mais ne servent pas.

Ma recommandation : garder `true` pour le lancement, et passer à `false` **en même
temps** que la configuration SMTP. Faire l'inverse casse les inscriptions.

### 2.3 Longueur minimale du mot de passe : 6 caractères

`password_min_length = 6`, sans exigence de caractère. C'est faible pour un compte
qui donne accès à des crédits payants. Passer à 8 ou 10 est un changement d'une
ligne, sans migration — mais cela n'invalide pas les mots de passe existants, donc
c'est sans risque. Non appliqué : c'est une décision produit.

## 3. À faire au moment de la bascule, dans cet ordre

1. **`uri_allow_list` : remplacer la liste entière.** L'API écrase la valeur, elle
   n'ajoute pas. Si l'on n'envoie que la nouvelle adresse, les prévisualisations et
   l'ancien site cessent de fonctionner pour l'authentification. La liste doit
   contenir, au minimum pendant la transition :
   - `https://<NOUVEAU_SITE>/**` et `https://<NOUVEAU_SITE>`
   - `https://deploy-preview-*--<NOUVEAU_SITE>/**`
   - l'ancien site, tant qu'il répond
   - `http://localhost:5173/**` pour le développement local
2. **`site_url`** = nouvelle adresse. C'est ce qui détermine où arrivent les liens
   de confirmation et de réinitialisation.
3. **Conserver les 22 entrées actuelles dans un fichier** avant remplacement :
   la liste contient des domaines historiques (Lovable, `sbc-ai-agency-dashbord`,
   `saas-ugc-growth`) dont certains servent peut-être encore. Ne rien supprimer
   sans vérifier.

La procédure exacte, avec la commande de sauvegarde, est dans
`docs/NETLIFY_DEPLOYMENT_CHECKLIST.md` étape 7.

## 4. Ce qui n'existe pas et n'a donc pas à être configuré

- **Aucun fournisseur OAuth activé** (Google, GitHub, Facebook, Apple… tous à
  `false`). Les « connecteurs OAuth » du produit sont un mécanisme **sortant**
  (le produit se connecte à des services tiers pour l'utilisateur), stocké dans les
  tables `oauth_accounts` / `oauth_audit_log` — ce n'est pas l'authentification des
  utilisateurs. Ne pas confondre les deux lors de la bascule : rien à faire côté
  fournisseurs d'identité.
- **Pas de SAML**, pas de MFA téléphone, pas de passkey.

## 5. Rappel de méthode

Chaque affirmation ci-dessus vient de la configuration lue, jamais d'une
supposition. Les points marqués « non appliqué » sont des décisions qui
t'appartiennent : modifier l'authentification d'un service en production sans
autorisation serait exactement le genre d'action qu'il faut éviter pendant le gel.

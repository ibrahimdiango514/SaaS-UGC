# Increment 11 — paramètres structurés et listes de médias exécutables

## Corrections effectives
- Le même validateur frontend/Edge accepte des objets et tableaux imbriqués bornés (5 niveaux, 100 propriétés, 256 éléments). Types, champs requis, choix et limites sont vérifiés récursivement ; propriétés inconnues/prototypes et contraintes inconnues restent refusés.
- Choix MuAPI `{label,value}` : seul `value` est transmis. `typing:true` autorise la saisie personnalisée documentée ; cela ne devient jamais une règle pour les enums stricts.
- Les formulaires génèrent les sous-champs et lignes structurées (dialogues, keyframes, etc.), avec import privé imbriqué. Les valeurs null par défaut sont omises, pas envoyées comme texte `null`.
- Les défauts déclarés sont appliqués côté serveur seulement s'ils respectent leur schéma. Le devis mémorise exactement les paramètres estimés pour la soumission.
- Validation complète avant consultation/signature Storage ; aucun média distant arbitraire n'est envoyé au fournisseur. Les médias imbriqués suivent les contrôles d'appartenance/espace/format/taille existants.
- Nouvel adaptateur `muapi_output_media_list_v1` pour une unique propriété explicitement typée tableau d'URI, même avec métadonnées annexes. Aucun nom de champ n'est deviné. Les résultats ambigus, non HTTPS ou non liés à la tâche restent refusés. Le parseur et les snapshots historiques restent compatibles.
- Migration additive `20261120053000` accepte les rapports v2/v3 et le protocole supplémentaire. Changer le protocole, son champ de résultat ou la version d'adaptateur invalide les attestations/configurations actives.
- Studio : les références non opérationnelles ne sont plus des fiches de génération cliquables. Elles restent consultables dans le catalogue admin, sans supprimer les références historiques.

## Validation et restrictions
Suite complète locale : 3222 tests / 199 fichiers verts, puis un test supplémentaire Studio vert. Typechecks frontend/Edge, imports et build verts. Un premier passage avait signalé une promesse asynchrone tardive dans le test historique integrations-rendu ; aucune assertion MuAPI n'était en échec ; second passage complet sans erreur. Les nouveaux tests de devis/Storage/fournisseur sont simulés et n'attestent PAS une exécution réelle.

Le correctif ne prétend pas résoudre les contrats absents/incohérents (notamment texte déclaré comme média), les actions de publication sociale, les quotas audio/3D/entraînement, ni les incompatibilités de fichiers. Il ne remplace pas la validation des contraintes en prose et des accès modèle.

## Entrées externes encore nécessaires
- Secret existant `MUAPI_API_KEY`, dans Supabase Edge Secrets du principal : accès au catalogue constaté, mais ne prouve pas les droits d'exécution individuels. Aucun secret supplémentaire n'est requis pour ce lot ; ne jamais envoyer sa valeur dans le chat.
- Pour chaque modèle à ouvrir : prix client VYORA en crédits, coût plafond USD, abonnements autorisés ; saisie admin sécurisée existante. Aucun prix arbitraire n'est créé.
- Attestation d'une vraie exécution et preuve d'accès modèle : autorisation financière distincte requise avant tout appel facturable. Aucun test de génération lancé ici.
- Contrat MuAPI officiel corrigé ou exemple officiel fiable pour les endpoints contradictoires et sorties ambiguës ; ne pas inventer ces contrats.

La clôture complète n'est pas acquise et aucun autre fournisseur ne doit être annoncé activé avant la clôture MuAPI. Les preuves après publication sont consignées dans la PR.

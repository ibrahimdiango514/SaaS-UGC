# Devis fournisseur VYORA Studio (MyAPI / MuAPI)

Objectif : afficher un devis en USD, calculé côté serveur à partir des tarifs réels du fournisseur,
avant tout lancement de génération. Aucun prix inventé, aucune valeur de repli.

## Contrat

Edge Function `reelora-video` (nom technique conservé), actions :

- `quote` (alias `provider-quote`)
  Entrée : `model_id`, paramètres de génération (durée, résolution, quantité, prompt…).
  Sortie : `{ model_id, model_available, model_status, model_reason, quote }`.

`quote` ne crédite, ne débite et ne lance aucune génération.

```ts
type ProviderQuote = {
  available: boolean;
  cost_usd: number | null;
  currency: string | null;          // USD uniquement
  source: 'provider_estimate' | 'catalog_tariff' | 'none';
  error_code: string | null;
  error_message: string | null;
  checked_at: string;
  catalog_synced_at: string | null;
  stale_catalog: boolean;           // tarif catalogue > 36 h
  pricing_basis: Record<string, string | number | boolean>;
  billing_units: string[];          // duration, resolution, quantity, generation…
  estimate_endpoint_available: boolean;
};
```

Codes : `MODEL_NOT_FOUND`, `MODEL_UNAVAILABLE`, `PROVIDER_KEY_MISSING`,
`ESTIMATE_ENDPOINT_MISSING`, `ESTIMATE_ENDPOINT_INVALID`, `PROMPT_REQUIRED`,
`PROVIDER_AUTH_FAILED`, `PROVIDER_RATE_LIMITED`, `PROVIDER_UNAVAILABLE`, `PROVIDER_TIMEOUT`,
`PROVIDER_BAD_RESPONSE`, `PROVIDER_PRICE_MISSING`, `CURRENCY_UNSUPPORTED`, `PRICE_NOT_POSITIVE`,
`CATALOG_TARIFF_MISSING`.

## Règles de tarification

- Modèle à tarification dynamique (`dynamic_pricing`) : seule la réponse `estimate-cost` du fournisseur
  fait foi. Si elle est absente ou en erreur → devis indisponible, jamais de conversion d’un tarif fixe.
- Modèle à tarif fixe : `ugc_video_models.cost_usd` (synchronisé depuis la fiche modèle MyAPI). Au-delà de
  36 h sans synchronisation, `stale_catalog = true` et l’interface demande de revérifier.
- Devise non USD ou montant ≤ 0 → indisponible (`CURRENCY_UNSUPPORTED`, `PRICE_NOT_POSITIVE`).
- La configuration de tarification interne (`video_pricing_config`) n’est pas sollicitée : le devis reste
  disponible même si l’administration n’a pas activé de marge.

## Interface

`src/studio/components/ProviderQuotePanel.tsx` affiche :

- **devis vérifié** : montant USD exact (jusqu’à 4 décimales), base tarifaire lisible, avertissement si
  catalogue ancien ;
- **devis indisponible** : code d’erreur et message réel, aucun montant ;
- **chargement / erreur réseau** : états distincts, bouton de recalcul désactivé pendant le chargement.

Le code technique de tarification n’est jamais affiché.

## Service déployé (`video-quote`)

L'Edge Function autonome `video-quote` est déployée (version 3, statut ACTIVE, `verify_jwt: true`).
Elle expose le même contrat que `quote` et n'a besoin d'aucun import relatif. Le Studio l'appelle en
priorité ; il retombe sur `reelora-video` (action `quote`) si le service dédié est indisponible.

Vérifications réelles effectuées en production (MuAPI interrogé, aucun crédit débité, aucun job créé) :

| Modèle | Paramètres | Résultat |
| --- | --- | --- |
| `kling-4.0-text-to-video` | prompt, 720p, 5 s | 0,785 USD (`provider_estimate`) |
| `kling-4.0-text-to-video` | prompt, 1080p, 10 s | 2,35 USD (`provider_estimate`) |
| `seedance-2-omni-reference-480p` | prompt | 1,44 USD (`provider_estimate`) |
| `video-effects` | prompt | 0,30 USD (`provider_estimate`) |
| sans jeton | — | 401 `UNAUTHORIZED_NO_AUTH_HEADER` |

Un modèle non couvert par les entrées gérées renvoie `MODEL_UNAVAILABLE` avec la raison exacte ; un
modèle refusé par le fournisseur renvoie `PROVIDER_BAD_RESPONSE` sans prix inventé.

## Déploiement requis

Le devis fournisseur dépend de l’Edge Function `reelora-video`. Après modification, elle doit être
redéployée (secret `MUAPI_API_KEY` déjà utilisé pour `estimate-cost`). Tant que le déploiement n’est pas
fait, le Studio reçoit l’ancien contrat et affiche honnêtement « devis non renvoyé par le serveur » —
aucun prix n’est inventé côté client.

## Tests

- `tests/video-quote.test.ts` : 16 cas (modèle absent, indisponible, tarif dynamique, tarif fixe,
  catalogue périmé, erreurs fournisseur, devise non supportée).
- `tests/muapi.test.ts` : contrat Edge (action `quote`, absence de crédit/débit, non-exposition du modèle brut).
- `tests/provider-quote-ui.test.tsx` : états UI, format USD, recalcul, absence de fuite technique.

// VYORA Connect — registre des fournisseurs et vues dérivées.
//
// Ces tests portent sur les règles qui décident de ce que l'utilisateur voit.
// Ils ne nécessitent ni DOM ni réseau : c'est volontaire, une règle d'affichage
// fausse (« bouton actif alors que rien n'est configuré ») est un mensonge,
// quelle que soit la qualité du rendu.
import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  PROVIDERS,
  STATUS_LABELS,
  auditActionLabel,
  buildProviderCard,
  canConnect,
  capabilityLabel,
  capabilityRisk,
  groupProviders,
  isActiveAccount,
  providerById,
  providerName,
  statusOf,
  toAccountView,
  toAuditView,
  usableAccounts,
} from '../src/integrations/providers';

const relative = (value: string | null | undefined) => (value ? `rel:${value}` : '—');
const absolute = (value: string | null | undefined) => (value ? `abs:${value}` : '—');

describe('registre des fournisseurs', () => {
  it('couvre exactement les huit fournisseurs demandés', () => {
    const ids = PROVIDERS.map((provider) => provider.id);
    expect(ids).toEqual([
      'gmail', 'google_drive', 'google_calendar',
      'instagram', 'facebook', 'tiktok', 'youtube', 'whatsapp_business',
    ]);
  });

  it('ne déclare implémentés que les trois fournisseurs Google', () => {
    const implemented = PROVIDERS.filter((provider) => provider.implemented).map((p) => p.id);
    expect(implemented).toEqual(['gmail', 'google_drive', 'google_calendar']);
  });

  it('un fournisseur implémenté a une clé de fournisseur, les autres non', () => {
    for (const provider of PROVIDERS) {
      if (provider.implemented) {
        expect(provider.providerKey).not.toBeNull();
        expect(provider.capabilities.length).toBeGreaterThan(0);
      } else {
        expect(provider.providerKey).toBeNull();
        // Aucune capacité n'est proposée si aucun code ne peut l'honorer.
        expect(provider.capabilities).toHaveLength(0);
      }
    }
  });

  it('chaque fournisseur non disponible explique POURQUOI', () => {
    for (const provider of PROVIDERS) {
      if (!provider.implemented) {
        expect(provider.blocker, `${provider.id} sans explication`).toBeTruthy();
        expect(provider.blocker!.length).toBeGreaterThan(20);
      }
    }
  });

  it('ne demande jamais de secret pour un fournisseur non implémenté', () => {
    for (const provider of PROVIDERS) {
      if (!provider.implemented) {
        expect(provider.requiredSecrets).toHaveLength(0);
      }
    }
  });

  it('les trois fournisseurs Google exigent les deux mêmes secrets', () => {
    const google = PROVIDERS.filter((p) => p.group === 'google');
    expect(google).toHaveLength(3);
    for (const provider of google) {
      expect(provider.requiredSecrets).toEqual(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']);
    }
  });

  it('ne contient aucune valeur de secret, seulement des noms', () => {
    const serialized = JSON.stringify(PROVIDERS);
    // Un nom de variable est en MAJUSCULES_AVEC_UNDERSCORES ; une valeur
    // ressemblerait à un identifiant opaque. On vérifie l'absence de motifs.
    expect(serialized).not.toMatch(/[0-9a-zA-Z_-]{32,}/);
    expect(serialized).not.toContain('client_secret');
  });

  it('retrouve un fournisseur par identifiant, et rien pour un inconnu', () => {
    expect(providerById('gmail')?.name).toBe('Gmail');
    expect(providerById('myspace')).toBeUndefined();
    // Un fournisseur inconnu garde un nom lisible plutôt qu'un vide.
    expect(providerName('myspace')).toBe('myspace');
  });
});

describe('capacités', () => {
  it('les quatre capacités sont exactement celles de la contrainte SQL', () => {
    expect(CAPABILITIES.map((c) => c.id)).toEqual(['read', 'draft', 'send', 'modify']);
  });

  it('l’envoi est la seule capacité à risque élevé', () => {
    expect(CAPABILITIES.filter((c) => c.risk === 'high').map((c) => c.id)).toEqual(['send']);
  });

  it('chaque capacité porte un libellé utilisateur et une description', () => {
    for (const capability of CAPABILITIES) {
      expect(capability.label.length).toBeGreaterThan(0);
      expect(capability.description.length).toBeGreaterThan(20);
    }
  });

  it('Gmail propose les quatre, Drive et Calendar seulement lecture et modification', () => {
    expect(providerById('gmail')!.capabilities).toEqual(['read', 'draft', 'send', 'modify']);
    expect(providerById('google_drive')!.capabilities).toEqual(['read', 'modify']);
    expect(providerById('google_calendar')!.capabilities).toEqual(['read', 'modify']);
  });

  it('ne propose jamais « envoyer » pour un fournisseur qui ne l’implémente pas', () => {
    for (const provider of PROVIDERS) {
      if (provider.id !== 'gmail') {
        expect(provider.capabilities).not.toContain('send');
      }
    }
  });

  it('traduit une capacité inconnue sans lever', () => {
    expect(capabilityLabel('read')).toBe('Lire');
    expect(capabilityLabel('administrateur')).toBe('administrateur');
    expect(capabilityRisk('inconnue')).toBe('low');
  });
});

describe('état d’un fournisseur', () => {
  const gmail = providerById('gmail')!;
  const instagram = providerById('instagram')!;

  it('un fournisseur implémenté sans identifiants est « configuration requise »', () => {
    expect(statusOf(gmail, false)).toBe('needs_setup');
    expect(STATUS_LABELS.needs_setup).toBe('Configuration requise');
  });

  it('un fournisseur implémenté avec identifiants est « disponible »', () => {
    expect(statusOf(gmail, true)).toBe('ready');
    expect(STATUS_LABELS.ready).toBe('Disponible');
  });

  it('un fournisseur non implémenté reste bloqué MÊME si des identifiants existaient', () => {
    // C'est le point central : pas de code = pas de connexion possible, quoi
    // qu'annonce la configuration serveur.
    expect(statusOf(instagram, true)).toBe('awaiting_review');
    expect(statusOf(instagram, false)).toBe('awaiting_review');
  });

  it('seul l’état « disponible » autorise un bouton Connecter', () => {
    expect(canConnect('ready')).toBe(true);
    expect(canConnect('needs_setup')).toBe(false);
    expect(canConnect('awaiting_review')).toBe(false);
    expect(canConnect('unavailable')).toBe(false);
  });

  it('la carte expose la raison exacte, pas un message générique', () => {
    const card = buildProviderCard(gmail, false);
    expect(card.actionable).toBe(false);
    expect(card.reason).toContain('Identifiants OAuth Google');
  });

  it('une carte disponible rappelle l’usage réel prévu', () => {
    const card = buildProviderCard(gmail, true);
    expect(card.actionable).toBe(true);
    expect(card.reason).toBe(gmail.purpose);
  });

  it('un fournisseur non implémenté n’est jamais actionnable', () => {
    for (const provider of PROVIDERS.filter((p) => !p.implemented)) {
      expect(buildProviderCard(provider, true).actionable).toBe(false);
    }
  });
});

describe('groupement pour l’affichage', () => {
  const cards = PROVIDERS.map((provider) => buildProviderCard(provider, false));

  it('produit trois sections dans un ordre stable', () => {
    const sections = groupProviders(cards);
    expect(sections.map((section) => section.group)).toEqual(['google', 'social', 'messaging']);
    expect(sections[0].label).toBe('Google Workspace');
  });

  it('répartit les huit fournisseurs sans en perdre', () => {
    const total = groupProviders(cards).reduce((sum, section) => sum + section.items.length, 0);
    expect(total).toBe(8);
  });

  it('omet une section vide plutôt que d’afficher un titre seul', () => {
    const withoutMessaging = cards.filter((card) => card.provider.group !== 'messaging');
    expect(groupProviders(withoutMessaging).map((s) => s.group)).toEqual(['google', 'social']);
  });
});

describe('vue des comptes connectés', () => {
  const raw = {
    id: 'acct-1',
    provider: 'gmail',
    display_name: 'Camille',
    email: 'camille@exemple.com',
    capabilities: ['read', 'draft'],
    status: 'connected' as const,
    last_verified_at: '2026-11-14T10:00:00.000Z',
    last_error: null,
    created_at: '2026-11-01T09:00:00.000Z',
  };

  it('traduit les champs techniques en libellés utilisateur', () => {
    const view = toAccountView(raw, relative, absolute);
    expect(view.providerName).toBe('Gmail');
    expect(view.statusLabel).toBe('Connecté');
    expect(view.lastVerifiedLabel).toBe('rel:2026-11-14T10:00:00.000Z');
    expect(view.createdLabel).toBe('abs:2026-11-01T09:00:00.000Z');
  });

  it('n’expose QUE les capacités réellement accordées', () => {
    const view = toAccountView({ ...raw, capabilities: ['read'] }, relative, absolute);
    expect(view.capabilities).toEqual(['read']);
    expect(view.capabilities).not.toContain('send');
  });

  it('signale un compte en erreur avec son message', () => {
    const view = toAccountView(
      { ...raw, status: 'error', last_error: 'refresh_refuse' },
      relative,
      absolute,
    );
    expect(view.statusLabel).toBe('Erreur');
    expect(view.lastError).toBe('refresh_refuse');
  });

  it('un fournisseur inconnu de la base s’affiche quand même', () => {
    const view = toAccountView({ ...raw, provider: 'linkedin' }, relative, absolute);
    expect(view.providerName).toBe('linkedin');
  });

  it('distingue les comptes actifs des comptes morts', () => {
    expect(isActiveAccount({ status: 'connected' })).toBe(true);
    expect(isActiveAccount({ status: 'expired' })).toBe(true);
    expect(isActiveAccount({ status: 'revoked' })).toBe(false);
    expect(isActiveAccount({ status: 'pending' })).toBe(false);
  });

  it('ne retient comme utilisables QUE les comptes connectés', () => {
    const accounts = [
      { id: 'a', status: 'connected' },
      { id: 'b', status: 'expired' },
      { id: 'c', status: 'revoked' },
    ];
    expect(usableAccounts(accounts).map((a) => a.id)).toEqual(['a']);
  });
});

describe('vue du journal', () => {
  const base = {
    id: 1,
    provider: 'gmail',
    capability: null,
    detail: null,
    created_at: '2026-11-14T10:00:00.000Z',
  };

  it('traduit chaque action en libellé lisible', () => {
    expect(auditActionLabel('connect_success').label).toBe('Compte connecté');
    expect(auditActionLabel('revoke').label).toBe('Compte déconnecté');
    expect(auditActionLabel('token_refresh_failure').label).toBe('Renouvellement échoué');
  });

  it('une action inconnue reste lisible plutôt que brute', () => {
    expect(auditActionLabel('nouvelle_action').label).toBe('nouvelle action');
  });

  it('un refus est TOUJOURS signalé en rouge, même si l’action est neutre', () => {
    const view = toAuditView({ ...base, action: 'read', outcome: 'denied' }, relative);
    expect(view.tone).toBe('danger');
  });

  it('une erreur est signalée en rouge', () => {
    const view = toAuditView({ ...base, action: 'token_refresh', outcome: 'error' }, relative);
    expect(view.tone).toBe('danger');
  });

  it('un succès reste vert', () => {
    const view = toAuditView({ ...base, action: 'connect_success', outcome: 'ok' }, relative);
    expect(view.tone).toBe('success');
    expect(view.providerName).toBe('Gmail');
  });

  it('traduit la capacité concernée', () => {
    const view = toAuditView({ ...base, action: 'denied', outcome: 'denied', capability: 'send' }, relative);
    expect(view.capabilityLabel).toBe('Envoyer');
  });
});

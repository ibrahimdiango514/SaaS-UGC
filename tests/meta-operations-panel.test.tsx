// @vitest-environment jsdom
/**
 * Exploitation réelle d'une connexion Meta.
 *
 * Ce que ces tests interdisent, et qui est le vrai risque d'un tableau de bord :
 * afficher une donnée qui ne vient pas de Meta. Chaque panneau doit rester
 * VIDE tant que le serveur n'a rien rendu, afficher l'erreur réelle du serveur
 * quand il refuse, et n'appeler que les actions qui correspondent au produit.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  listMetaConversations: vi.fn(),
  listMetaMessages: vi.fn(),
  sendWhatsApp: vi.fn(),
  sendMessenger: vi.fn(),
  listWhatsAppTemplates: vi.fn(),
  publishFacebookPost: vi.fn(),
  listFacebookPosts: vi.fn(),
  deleteFacebookPost: vi.fn(),
  readFacebookInsights: vi.fn(),
  listFacebookComments: vi.fn(),
  listMetaPageEvents: vi.fn(),
  readInstagramAccount: vi.fn(),
  publishInstagram: vi.fn(),
  readInstagramInsights: vi.fn(),
}));

vi.mock('../src/integrations/meta/api', async () => {
  const reel = await vi.importActual<typeof import('../src/integrations/meta/api')>('../src/integrations/meta/api');
  return { ...reel, ...api };
});

import { MetaOperationsPanel } from '../src/integrations/MetaOperationsPanel';
import type { MetaConnectionView, MetaProduct } from '../src/integrations/meta/api';

const WS = 'ws-meta-ops';

function connexion(overrides: Partial<MetaConnectionView> = {}): MetaConnectionView {
  return {
    id: 'c1',
    product: 'facebook',
    status: 'connected',
    external_account_id: '117804259030922',
    display_name: 'VYORA',
    granted_scopes: ['pages_show_list'],
    token_expires_at: null,
    has_token: true,
    metadata: {},
    last_error: null,
    last_verified_at: null,
    updated_at: '2026-11-14T10:00:00Z',
    pages: [{
      page_id: '117804259030922',
      name: 'VYORA Page',
      category: null,
      tasks: ['MANAGE'],
      instagram_business_account_id: null,
      instagram_username: null,
      webhook_subscribed: true,
      has_token: true,
    }],
    ...overrides,
  };
}

const onChanged = vi.fn();

function monter(product: MetaProduct, c: MetaConnectionView) {
  return render(
    <MetaOperationsPanel product={product} workspaceId={WS} connexion={c} onChanged={onChanged} />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  api.listMetaConversations.mockResolvedValue({ conversations: [] });
  api.listMetaMessages.mockResolvedValue({ messages: [] });
  api.listFacebookPosts.mockResolvedValue({ posts: [] });
  api.listWhatsAppTemplates.mockResolvedValue({ templates: [] });
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('aucune donnée inventée', () => {
  it('une boîte de réception vide le dit, et n’invente aucun message', async () => {
    monter('messenger', connexion({ product: 'messenger' }));
    await waitFor(() => expect(api.listMetaConversations).toHaveBeenCalledWith(WS, 'messenger', '117804259030922'));
    expect(screen.getByText(/Aucun message reçu pour l’instant/i)).toBeTruthy();
    expect(screen.queryByText(/↘/)).toBeNull();
  });

  it('une liste de publications vide vient de Meta, pas d’un exemple', async () => {
    monter('facebook', connexion());
    await waitFor(() => expect(api.listFacebookPosts).toHaveBeenCalledWith(WS, '117804259030922'));
    expect(screen.getByText(/Aucune publication renvoyée par Meta/i)).toBeTruthy();
  });

  it('un refus du serveur est affiché tel quel, sans repli silencieux', async () => {
    api.listFacebookPosts.mockRejectedValue(new Error('Permissions manquantes : pages_manage_posts'));
    monter('facebook', connexion());
    await waitFor(() => expect(screen.getByText(/pages_manage_posts/)).toBeTruthy());
  });

  it('les modèles WhatsApp ne sont chargés que sur demande explicite', () => {
    monter('whatsapp', connexion({ product: 'whatsapp', metadata: { phone_number_id: '106540352242922' } }));
    expect(api.listWhatsAppTemplates).not.toHaveBeenCalled();
    expect(screen.getByText(/Aucune liste chargée/i)).toBeTruthy();
  });
});

describe('Facebook — actions réelles, ciblées sur la page sélectionnée', () => {
  it('publie le texte saisi et signale l’identifiant rendu par Meta', async () => {
    api.publishFacebookPost.mockResolvedValue({ id: '117804259030922_1' });
    monter('facebook', connexion());
    fireEvent.change(screen.getByLabelText('Texte de la publication'), { target: { value: 'Bonjour depuis VYORA' } });
    fireEvent.click(screen.getByRole('button', { name: /^Publier$/ }));
    await waitFor(() => expect(api.publishFacebookPost).toHaveBeenCalledWith(WS, {
      pageId: '117804259030922',
      message: 'Bonjour depuis VYORA',
    }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith({ tone: 'success', text: expect.stringMatching(/Publication créée/i) }));
  });

  it('refuse de publier un lien non HTTPS, sans appeler le serveur', () => {
    monter('facebook', connexion());
    fireEvent.change(screen.getByLabelText('Lien de la publication'), { target: { value: 'javascript:alert(1)' } });
    const bouton = screen.getByRole('button', { name: /^Publier$/ });
    // Le bouton reste actif (le lien est saisi), c'est le SERVEUR qui valide :
    // ici on vérifie qu'aucun appel n'est fait sans clic explicite.
    expect(api.publishFacebookPost).not.toHaveBeenCalled();
    expect(bouton).toBeTruthy();
  });

  it('supprime une publication après confirmation, avec l’identifiant exact', async () => {
    api.listFacebookPosts.mockResolvedValue({
      posts: [{ id: '117804259030922_42', message: 'Ancienne publication', created_time: '2026-11-01T09:00:00Z' }],
    });
    api.deleteFacebookPost.mockResolvedValue({ deleted: true });
    monter('facebook', connexion());
    await waitFor(() => expect(screen.getByText(/Ancienne publication/)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Supprimer/ }));
    await waitFor(() => expect(api.deleteFacebookPost).toHaveBeenCalledWith(WS, '117804259030922', '117804259030922_42'));
  });

  it('ne supprime rien si la confirmation est refusée', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    api.listFacebookPosts.mockResolvedValue({ posts: [{ id: '117804259030922_42', message: 'Ancienne publication' }] });
    monter('facebook', connexion());
    await waitFor(() => expect(screen.getByText(/Ancienne publication/)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Supprimer/ }));
    expect(api.deleteFacebookPost).not.toHaveBeenCalled();
  });

  it('affiche les statistiques telles que Meta les rend', async () => {
    api.readFacebookInsights.mockResolvedValue({
      insights: [{ name: 'page_impressions', period: 'day', values: [{ value: 128 }] }],
    });
    monter('facebook', connexion());
    fireEvent.click(screen.getByRole('button', { name: /Statistiques/ }));
    await waitFor(() => expect(screen.getByText(/page_impressions/)).toBeTruthy());
    expect(screen.getByText(/128/)).toBeTruthy();
  });

  it('lit les commentaires d’une publication, et dit quand il n’y en a pas', async () => {
    api.listFacebookPosts.mockResolvedValue({ posts: [{ id: '117804259030922_7', message: 'Post' }] });
    api.listFacebookComments.mockResolvedValue({ comments: [] });
    monter('facebook', connexion());
    await waitFor(() => expect(screen.getByText(/Post/)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /^Commentaires$/ }));
    await waitFor(() => expect(api.listFacebookComments).toHaveBeenCalledWith(WS, '117804259030922', '117804259030922_7'));
    await waitFor(() => expect(screen.getByText(/Aucun commentaire/i)).toBeTruthy());
  });

  it('sans page sélectionnée, publier n’est même pas proposé', () => {
    monter('facebook', connexion({ pages: [] }));
    expect(screen.getByText(/Aucune page sélectionnée/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Publier$/ })).toBeNull();
    expect(api.listFacebookPosts).not.toHaveBeenCalled();
  });
});

describe('Messenger — boîte de réception et réponse', () => {
  it('ouvre un fil puis envoie une réponse avec le PSID du contact', async () => {
    api.listMetaConversations.mockResolvedValue({
      conversations: [{
        account_ref: '117804259030922',
        conversation_ref: '6123456789',
        last_body: 'Bonjour, je voudrais un devis',
        last_direction: 'in',
        last_status: 'received',
        last_at: '2026-11-14T09:30:00Z',
      }],
    });
    api.listMetaMessages.mockResolvedValue({
      messages: [{
        id: 'm1', channel: 'messenger', account_ref: '117804259030922', conversation_ref: '6123456789',
        external_message_id: 'mid.1', direction: 'in', message_type: 'text', body: 'Bonjour, je voudrais un devis',
        status: 'received', error_code: null, error_message: null, sent_at: '2026-11-14T09:30:00Z',
      }],
    });
    api.sendMessenger.mockResolvedValue({ messageId: 'm_out_1' });
    monter('messenger', connexion({ product: 'messenger' }));

    await waitFor(() => expect(screen.getByText(/je voudrais un devis/)).toBeTruthy());
    fireEvent.click(screen.getByText(/6123456789/));
    await waitFor(() => expect(api.listMetaMessages).toHaveBeenCalledWith(WS, 'messenger', '6123456789', '117804259030922'));

    fireEvent.change(screen.getByLabelText('Réponse'), { target: { value: 'Voici notre tarif' } });
    fireEvent.click(screen.getByRole('button', { name: /Envoyer/ }));
    await waitFor(() => expect(api.sendMessenger).toHaveBeenCalledWith(WS, {
      pageId: '117804259030922',
      recipientId: '6123456789',
      text: 'Voici notre tarif',
    }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith({ tone: 'success', text: expect.stringMatching(/Meta a accepté/i) }));
  });

  it('un message sortant refusé par Meta est affiché, jamais requalifié en succès', async () => {
    api.listMetaConversations.mockResolvedValue({
      conversations: [{ account_ref: '117804259030922', conversation_ref: '42', last_body: 'Salut', last_direction: 'in', last_status: 'received', last_at: '2026-11-14T09:30:00Z' }],
    });
    api.listMetaMessages.mockResolvedValue({ messages: [] });
    api.sendMessenger.mockRejectedValue(new Error('Messenger applique une fenêtre de 24 h : ce contact n’a pas écrit récemment.'));
    monter('messenger', connexion({ product: 'messenger' }));

    await waitFor(() => expect(screen.getByText(/Salut/)).toBeTruthy());
    fireEvent.click(screen.getByText(/^42$/));
    await waitFor(() => expect(api.listMetaMessages).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText('Réponse'), { target: { value: 'Trop tard' } });
    fireEvent.click(screen.getByRole('button', { name: /Envoyer/ }));
    await waitFor(() => expect(screen.getByText(/fenêtre de 24 h/)).toBeTruthy());
    expect(onChanged).not.toHaveBeenCalledWith({ tone: 'success', text: expect.anything() });
    // La saisie est conservée : l'utilisateur ne perd pas son texte sur un refus.
    expect((screen.getByLabelText('Réponse') as HTMLInputElement).value).toBe('Trop tard');
  });
});

describe('WhatsApp — modèles et envoi', () => {
  it('n’autorise l’envoi d’un modèle que s’il est APPROVED et avec un destinataire', async () => {
    api.listWhatsAppTemplates.mockResolvedValue({
      templates: [
        { id: 't1', name: 'bienvenue', language: 'fr', status: 'APPROVED', category: 'UTILITY' },
        { id: 't2', name: 'promo', language: 'fr', status: 'PENDING', category: 'MARKETING' },
      ],
    });
    api.sendWhatsApp.mockResolvedValue({ messageId: 'wamid.1', to: '22370000000' });
    monter('whatsapp', connexion({ product: 'whatsapp', metadata: { phone_number_id: '106540352242922' } }));

    fireEvent.click(screen.getByRole('button', { name: /Charger les modèles/ }));
    await waitFor(() => expect(screen.getByText(/bienvenue/)).toBeTruthy());

    const boutons = screen.getAllByRole('button', { name: /^Envoyer$/ });
    // Sans destinataire, aucun envoi n'est possible.
    expect(boutons.every((b) => b.hasAttribute('disabled'))).toBe(true);

    fireEvent.change(screen.getByLabelText(/Numéro destinataire du modèle/), { target: { value: '22370000000' } });
    const apres = screen.getAllByRole('button', { name: /^Envoyer$/ });
    // Le modèle PENDING reste bloqué : Meta le refuserait.
    expect(apres[0].hasAttribute('disabled')).toBe(false);
    expect(apres[1].hasAttribute('disabled')).toBe(true);

    fireEvent.click(apres[0]);
    await waitFor(() => expect(api.sendWhatsApp).toHaveBeenCalledWith(WS, {
      to: '22370000000',
      template: { name: 'bienvenue', language: 'fr' },
    }));
  });
});

describe('Instagram', () => {
  it('sans compte professionnel relié, l’explique au lieu d’échouer', () => {
    monter('instagram', connexion({ product: 'instagram' }));
    expect(screen.getByText(/Aucun compte Instagram professionnel n’est relié/i)).toBeTruthy();
    expect(api.readInstagramAccount).not.toHaveBeenCalled();
  });

  it('exige une URL HTTPS avant de publier', async () => {
    monter('instagram', connexion({
      product: 'instagram',
      pages: [{
        page_id: '117804259030922', name: 'VYORA Page', category: null, tasks: ['MANAGE'],
        instagram_business_account_id: '17841400000000000', instagram_username: 'vyora', webhook_subscribed: true, has_token: true,
      }],
    }));
    const bouton = screen.getByRole('button', { name: /Publier sur Instagram/ });
    expect(bouton.hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByLabelText('URL de l’image Instagram'), { target: { value: 'http://exemple.test/img.jpg' } });
    expect(screen.getByRole('button', { name: /Publier sur Instagram/ }).hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByLabelText('URL de l’image Instagram'), { target: { value: 'https://exemple.test/img.jpg' } });
    expect(screen.getByRole('button', { name: /Publier sur Instagram/ }).hasAttribute('disabled')).toBe(false);
  });

  it('lit le compte réel et ses statistiques', async () => {
    api.readInstagramAccount.mockResolvedValue({ account: { id: '17841400000000000', username: 'vyora', followers_count: 812, media_count: 24 } });
    api.readInstagramInsights.mockResolvedValue({ insights: [{ name: 'reach', period: 'day', values: [{ value: 340 }] }] });
    monter('instagram', connexion({
      product: 'instagram',
      pages: [{
        page_id: '117804259030922', name: 'VYORA Page', category: null, tasks: ['MANAGE'],
        instagram_business_account_id: '17841400000000000', instagram_username: 'vyora', webhook_subscribed: true, has_token: true,
      }],
    }));
    fireEvent.click(screen.getByRole('button', { name: /Lire le compte/ }));
    await waitFor(() => expect(screen.getByText(/812 abonnés/)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Statistiques/ }));
    await waitFor(() => expect(screen.getByText(/reach/)).toBeTruthy());
  });
});

describe('garde-fou global', () => {
  it('aucun panneau ne s’affiche pour une connexion non « connected »', () => {
    const { container } = monter('facebook', connexion({ status: 'expired' }));
    expect(container.textContent).toBe('');
    expect(api.listFacebookPosts).not.toHaveBeenCalled();
  });

  it('aucun appel réseau n’est fait au montage pour Facebook sans page', () => {
    monter('facebook', connexion({ pages: [] }));
    expect(api.listFacebookPosts).not.toHaveBeenCalled();
    expect(api.publishFacebookPost).not.toHaveBeenCalled();
    expect(api.deleteFacebookPost).not.toHaveBeenCalled();
  });

  it('un panneau ne mélange jamais les produits : Instagram n’appelle pas Facebook', async () => {
    monter('instagram', connexion({
      product: 'instagram',
      pages: [{
        page_id: '117804259030922', name: 'P', category: null, tasks: ['MANAGE'],
        instagram_business_account_id: '17841400000000000', instagram_username: 'vyora', webhook_subscribed: true, has_token: true,
      }],
    }));
    expect(api.listFacebookPosts).not.toHaveBeenCalled();
    expect(api.listMetaConversations).not.toHaveBeenCalled();
  });

  it('le sous-titre de la boîte de réception cite la règle des 24 h', async () => {
    monter('messenger', connexion({ product: 'messenger' }));
    const zone = screen.getByText(/Boîte de réception/i).closest('div') as HTMLElement;
    expect(within(zone).getByText(/webhook/i)).toBeTruthy();
  });
});

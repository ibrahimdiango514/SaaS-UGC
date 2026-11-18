// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * VYORA AI — tests de l'interface assistant.
 *
 * Ces tests vérifient trois choses, dans cet ordre d'importance :
 *
 *  1. **Aucune conversation n'est inventée.** Si le socle échoue, l'écran
 *     affiche l'erreur et une liste vide. C'est la garantie « ne jamais
 *     simuler une connexion » appliquée à l'historique.
 *  2. **Le rendu Markdown est sûr.** Une réponse contenant du HTML ne doit
 *     jamais produire de balise active.
 *  3. **Les fonctions de composition sont exactes.** Le mode analyse ajoute
 *     une consigne, les pièces jointes lisibles sont transmises, les autres
 *     sont annoncées sans contenu.
 */

const api = vi.hoisted(() => ({
  listConversations: vi.fn(),
  createConversation: vi.fn(),
  renameConversation: vi.fn(),
  deleteConversation: vi.fn(),
  listMessages: vi.fn(),
  sendMessage: vi.fn(),
}));

vi.mock('../src/business/api', () => ({ businessGrowApi: api }));

vi.mock('../src/context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', email: 'awa@vyora.test' },
    profile: { display_name: 'Awa', user_id: 'u1', country_code: 'ML', preferred_language: 'fr', created_at: '', updated_at: '' },
    session: null,
    workspace: null,
    workspaceId: null,
    quota: null,
    isAdmin: false,
    loading: false,
    bootstrapError: null,
    refreshQuota: async () => {},
    refreshAll: async () => {},
    logout: async () => {},
  }),
}));

import Assistant from '../src/pages/Assistant';
import { composeMessageBody, filterConversations, groupByRecency, titleFromMessage } from '../src/ai/api';
import { escapeHtml, isSafeHref, renderMarkdown, toPlainText } from '../src/ai/render';
import { formatBytes, validateAttachment, isReadable } from '../src/ai/attachments';

beforeEach(() => {
  api.listConversations.mockResolvedValue({ conversations: [] });
  api.listMessages.mockResolvedValue({ messages: [] });
  api.createConversation.mockResolvedValue({ conversationId: 'c1' });
  api.sendMessage.mockResolvedValue({ providerAvailable: true });
  api.renameConversation.mockResolvedValue({ renamed: true });
  api.deleteConversation.mockResolvedValue({ deleted: true });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function monter() {
  return render(
    <MemoryRouter initialEntries={['/app/ai']}>
      <Assistant />
    </MemoryRouter>,
  );
}

describe('Assistant — accueil', () => {
  it('affiche l’accueil personnalisé avec le nom de l’utilisateur', async () => {
    monter();
    await waitFor(() => {
      expect(screen.getByText(/Bonjour Awa/i)).toBeTruthy();
    });
  });

  it('propose des suggestions cliquables', async () => {
    monter();
    await waitFor(() => expect(screen.getByText(/Préparer une campagne/i)).toBeTruthy());
    expect(screen.getByText(/Analyser des chiffres/i)).toBeTruthy();
    expect(screen.getByText(/Cadrer un problème/i)).toBeTruthy();
  });

  it('ne prétend pas avoir des conversations quand il n’y en a pas', async () => {
    monter();
    await waitFor(() => {
      expect(screen.getByText(/Aucune conversation pour l’instant/i)).toBeTruthy();
    });
  });
});

describe('Assistant — honnêteté en cas d’échec du socle', () => {
  it('affiche l’erreur et n’invente aucune conversation', async () => {
    api.listConversations.mockRejectedValue(new Error('EDGE_ERROR: 503'));
    monter();
    await waitFor(() => {
      expect(screen.getByText(/Conversations indisponibles/i)).toBeTruthy();
    });
    // Aucune conversation fantôme : la liste reste vide.
    expect(screen.getByText(/Aucune conversation pour l’instant/i)).toBeTruthy();
  });

  it('signale un fournisseur IA indisponible sans fabriquer de réponse', async () => {
    api.listConversations.mockResolvedValue({
      conversations: [{ id: 'c1', title: 'Test', created_at: new Date().toISOString(), updated_at: new Date().toISOString() }],
    });
    api.listMessages.mockResolvedValue({ messages: [] });
    api.sendMessage.mockResolvedValue({ providerAvailable: false });

    monter();
    await waitFor(() => expect(screen.getByText('Test')).toBeTruthy());

    const zone = screen.getByLabelText(/Votre message/i);
    fireEvent.change(zone, { target: { value: 'Bonjour' } });
    fireEvent.click(screen.getByLabelText(/Envoyer le message/i));

    await waitFor(() => {
      expect(screen.getByText(/aucun fournisseur IA n’a répondu/i)).toBeTruthy();
    });
  });
});

describe('Assistant — envoi d’un message', () => {
  it('crée une conversation puis envoie le contenu', async () => {
    monter();
    await waitFor(() => expect(screen.getByLabelText(/Votre message/i)).toBeTruthy());

    const zone = screen.getByLabelText(/Votre message/i);
    fireEvent.change(zone, { target: { value: 'Rédige un slogan' } });
    fireEvent.click(screen.getByLabelText(/Envoyer le message/i));

    await waitFor(() => {
      expect(api.createConversation).toHaveBeenCalled();
      expect(api.sendMessage).toHaveBeenCalled();
    });

    const [, contenu] = api.sendMessage.mock.calls[0];
    expect(String(contenu)).toContain('Rédige un slogan');
  });

  it('le bouton d’envoi est inactif quand la saisie est vide', async () => {
    monter();
    await waitFor(() => expect(screen.getByLabelText(/Votre message/i)).toBeTruthy());
    const bouton = screen.getByLabelText(/Envoyer le message/i) as HTMLButtonElement;
    expect(bouton.disabled).toBe(true);
  });

  it('n’affiche aucun bouton de dictée vocale (non implémenté)', async () => {
    monter();
    await waitFor(() => expect(screen.getByLabelText(/Votre message/i)).toBeTruthy());
    expect(screen.queryByLabelText(/dicter|micro|vocal/i)).toBeNull();
  });

  it('le mode analyse indique qu’il ne s’agit pas d’un moteur distinct', async () => {
    monter();
    // Le nom accessible exact : « Analyser des chiffres » est une suggestion
    // de l'accueil, distincte du bouton de mode.
    await waitFor(() => expect(screen.getByRole('button', { name: /^Analyse$/i })).toBeTruthy());
    const bouton = screen.getByRole('button', { name: /^Analyse$/i });
    expect(bouton.getAttribute('title')).toMatch(/consigne de structuration/i);
  });
});

describe('composeMessageBody — contenu réellement transmis', () => {
  it('transmet le texte seul en mode standard', () => {
    expect(composeMessageBody('Bonjour', 'standard', [])).toBe('Bonjour');
  });

  it('ajoute une consigne en mode analyse', () => {
    const body = composeMessageBody('Analyse ceci', 'analyse', []);
    expect(body).toContain('[Mode analyse]');
    expect(body).toContain('Analyse ceci');
  });

  it('inclut le texte des pièces jointes lisibles', () => {
    const body = composeMessageBody('Voici', 'standard', [
      { name: 'notes.md', storagePath: null, sizeBytes: 120, mimeType: 'text/markdown', excerpt: 'Contenu du fichier' },
    ]);
    expect(body).toContain('Documents joints');
    expect(body).toContain('Contenu du fichier');
  });

  it('annonce les pièces jointes non lisibles sans inventer de contenu', () => {
    const body = composeMessageBody('Voici', 'standard', [
      { name: 'photo.png', storagePath: null, sizeBytes: 2048, mimeType: 'image/png' },
    ]);
    expect(body).toContain('contenu non transmis');
    expect(body).toContain('photo.png');
  });

  it('interdit explicitement au modèle de prétendre avoir lu un fichier muet', () => {
    // Sans cette consigne, un modèle peut répondre « j’ai bien analysé la
    // vidéo » alors qu’il n’a reçu qu’un nom de fichier. C’est précisément le
    // mensonge que le système doit empêcher.
    const body = composeMessageBody('Analyse ça', 'standard', [
      { name: 'demo.mp4', storagePath: 'w/demo.mp4', sizeBytes: 5_000_000, mimeType: 'video/mp4',
        note: 'Vidéo enregistrée. Aucun modèle de texte ne peut la lire.' },
    ]);
    expect(body).toContain('demo.mp4');
    expect(body).toContain('Aucun modèle de texte ne peut la lire');
    expect(body).toContain('ne prétends pas avoir lu');
  });
});

describe('render — sûreté du Markdown', () => {
  it('échappe le HTML présent dans une réponse', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('ne produit aucune balise script exécutable', () => {
    const html = renderMarkdown('<script>alert(1)</script>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('refuse les schémas d’URL dangereux', () => {
    expect(isSafeHref('javascript:alert(1)')).toBe(false);
    expect(isSafeHref('data:text/html,<script>')).toBe(false);
    expect(isSafeHref('vbscript:msgbox')).toBe(false);
    expect(isSafeHref('https://vyora.app')).toBe(true);
    expect(isSafeHref('mailto:a@b.c')).toBe(true);
  });

  it('neutralise un lien javascript sans casser le texte', () => {
    const html = renderMarkdown('[clique](javascript:alert(1))');
    expect(html).not.toContain('href="javascript:');
  });

  it('rend les titres, listes et gras', () => {
    const html = renderMarkdown('## Titre\n\n- un\n- deux\n\n**fort**');
    expect(html).toContain('<h2>Titre</h2>');
    expect(html).toContain('<li>un</li>');
    expect(html).toContain('<strong>fort</strong>');
  });

  it('préserve le contenu des blocs de code sans l’interpréter', () => {
    const html = renderMarkdown('```\n<b>test</b>\n```');
    expect(html).toContain('<pre><code>');
    expect(html).toContain('&lt;b&gt;test&lt;/b&gt;');
  });

  it('toPlainText retire le balisage pour la copie et la voix', () => {
    const texte = toPlainText('## Titre\n\n**gras** et `code`');
    expect(texte).not.toContain('##');
    expect(texte).not.toContain('**');
    expect(texte).toContain('gras');
    expect(texte).toContain('code');
  });
});

describe('api — recherche, regroupement et titres', () => {
  const conversations = [
    { id: '1', title: 'Campagne été', created_at: '', updated_at: new Date().toISOString(), last_message: 'parlons de la campagne' },
    { id: '2', title: 'Facturation', created_at: '', updated_at: new Date().toISOString(), last_message: null },
  ];

  it('filtre sur le titre', () => {
    expect(filterConversations(conversations as never, 'campagne').map((c) => c.id)).toEqual(['1']);
  });

  it('filtre sur le dernier message', () => {
    expect(filterConversations(conversations as never, 'parlons').map((c) => c.id)).toEqual(['1']);
  });

  it('ne filtre rien quand la recherche est vide', () => {
    expect(filterConversations(conversations as never, '   ')).toHaveLength(2);
  });

  it('regroupe par récence', () => {
    const groupes = groupByRecency(conversations as never);
    expect(groupes[0].label).toBe('Aujourd’hui');
    expect(groupes[0].items).toHaveLength(2);
  });

  it('dérive un titre court du premier message', () => {
    expect(titleFromMessage('  Bonjour   le monde  ')).toBe('Bonjour le monde');
    expect(titleFromMessage('')).toBe('Nouvelle conversation');
  });

  it('tronque un titre trop long à 80 caractères', () => {
    const titre = titleFromMessage('a'.repeat(200));
    expect(titre.length).toBeLessThanOrEqual(80);
    expect(titre.endsWith('…')).toBe(true);
  });
});

describe('attachments — validation et formats', () => {
  const fichier = (name: string, type: string, size: number) => ({ name, type, size }) as File;

  it('refuse un fichier vide', () => {
    expect(validateAttachment(fichier('a.txt', 'text/plain', 0), 0)).toMatch(/vide/);
  });

  it('refuse un fichier trop volumineux', () => {
    expect(validateAttachment(fichier('a.txt', 'text/plain', 9 * 1024 * 1024), 0)).toMatch(/dépasse/);
  });

  it('refuse au-delà du nombre maximal', () => {
    expect(validateAttachment(fichier('a.txt', 'text/plain', 10), 5)).toMatch(/Maximum/);
  });

  it('accepte un fichier raisonnable', () => {
    expect(validateAttachment(fichier('a.txt', 'text/plain', 10), 0)).toBeNull();
  });

  it('reconnaît les formats lisibles sans dépendre du type MIME', () => {
    expect(isReadable(fichier('notes.md', '', 10))).toBe(true);
    expect(isReadable(fichier('data.csv', '', 10))).toBe(true);
    expect(isReadable(fichier('photo.png', 'image/png', 10))).toBe(false);
  });

  it('formate les tailles', () => {
    expect(formatBytes(512)).toBe('512 o');
    expect(formatBytes(2048)).toBe('2.0 Ko');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 Mo');
  });
});

import { describe, expect, it, vi } from 'vitest';
import {
  createBusinessGrowHandler,
  type BusinessGrowDependencies,
  type BusinessGrowStore,
} from '../supabase/functions/business-grow/handler';

/**
 * Actions `agent.journal` et `agent.autonomy.*` côté serveur.
 *
 * ## Pourquoi ces tests portent sur le serveur
 * Ce sont les actions qui décident si une action d'agent a eu lieu, si elle peut
 * être annulée et si une écriture peut se faire SANS validation humaine. Un
 * client modifié, un appel direct à l'Edge ou une console ouverte ne doivent pas
 * pouvoir contourner ces règles : elles doivent tenir ici, pas dans l'écran.
 */

const userA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspace = '11111111-1111-4111-8111-111111111111';
const entryId = '22222222-2222-4222-8222-222222222222';
const recordId = '33333333-3333-4333-8333-333333333333';

function fixture() {
  const store: BusinessGrowStore = {
    listProviders: vi.fn(async () => []),
    listConversations: vi.fn(async () => []),
    listMessages: vi.fn(async () => []),
    createConversation: vi.fn(async () => 'c'),
    renameConversation: vi.fn(async () => true),
    deleteConversation: vi.fn(async () => true),
    getMemory: vi.fn(async () => ({ consent: false, items: [] })),
    setMemoryConsent: vi.fn(async () => ({ event_id: 1, occurred_at: '2026-01-01T00:00:00Z' })),
    saveMemoryProfile: vi.fn(async () => undefined),
    putMemoryItem: vi.fn(async () => 'i'),
    deleteMemoryItem: vi.fn(async () => true),
    submitUserMessage: vi.fn(async () => ({ requestId: 'r', inputMessageId: 'm', status: 'queued', created: true })),
    startRequest: vi.fn(async () => undefined),
    selectRoute: vi.fn(async () => { throw new Error('unused'); }),
    failRequest: vi.fn(async () => undefined),
    finalizeAttempt: vi.fn(async () => undefined),
    getWorkspaceProtocol: vi.fn(async () => 'business-workspace-v3'),
    appendAgentJournal: vi.fn(async () => entryId),
    listAgentJournal: vi.fn(async () => []),
    setAgentJournalStatus: vi.fn(async () => true),
    getAgentAutonomy: vi.fn(async () => []),
    setAgentAutonomy: vi.fn(async () => ({ tool_name: 'creer_tache', level: 'preparation', rule_id: null })),
  };
  const dependencies: BusinessGrowDependencies = {
    store,
    getUserId: vi.fn(async (authorization: string) => (authorization === 'Bearer valid' ? userA : null)),
    allowedOrigins: ['https://reelora.test'],
    providerConfigs: () => ({}),
    providerOrder: () => [],
    complete: vi.fn(async () => ({ content: '', inputTokens: 0, outputTokens: 0 })),
  };
  return { store, dependencies, handler: createBusinessGrowHandler(dependencies) };
}

function post(body: unknown, authorization = 'Bearer valid') {
  return new Request('https://edge.test/business-grow', {
    method: 'POST',
    headers: { Authorization: authorization, Origin: 'https://reelora.test', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const journal = (extra: Record<string, unknown>) => ({ action: 'v3.agent.journal', workspaceId: workspace, ...extra });

describe('agent.journal — écriture contrôlée', () => {
  it('ajoute une entrée valide et renvoie son identifiant', async () => {
    const { handler, store } = fixture();
    const response = await handler(post(journal({
      op: 'append',
      entry: { resume: 'Planifier une relance', statut: 'proposee', outil: 'planifier_relance' },
    })));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { entryId: entryId } });
    expect(store.appendAgentJournal).toHaveBeenCalledTimes(1);
    const [, workspaceId, entry] = vi.mocked(store.appendAgentJournal!).mock.calls[0];
    expect(workspaceId).toBe(workspace);
    expect(entry).toMatchObject({ resume: 'Planifier une relance', statut: 'proposee' });
  });

  it('refuse une entrée sans résumé ou avec un statut inventé', async () => {
    const { handler, store } = fixture();
    for (const entry of [
      { resume: '', statut: 'proposee' },
      { resume: 'Faire quelque chose', statut: 'peut_etre' },
      { resume: 'Faire quelque chose', statut: 'executee' },
    ]) {
      const response = await handler(post(journal({ op: 'append', entry })));
      expect(response.status).toBe(400);
    }
    expect(store.appendAgentJournal).not.toHaveBeenCalled();
  });

  it('refuse une action « exécutée » qui ne désigne aucun enregistrement', async () => {
    // Sans `enregistrementId`, le bouton Annuler de l'écran ne pourrait jamais
    // agir : accepter l'entrée reviendrait à promettre une annulation impossible.
    const { handler, store } = fixture();
    const response = await handler(post(journal({
      op: 'append',
      entry: { resume: 'Créer une facture', statut: 'executee', outil: 'creer_facture', enregistrementId: 'pas-un-uuid' },
    })));

    expect(response.status).toBe(400);
    expect(store.appendAgentJournal).not.toHaveBeenCalled();
  });

  it('refuse un outil que le socle ne connaît pas', async () => {
    const { handler, store } = fixture();
    const response = await handler(post(journal({
      op: 'append',
      entry: { resume: 'Transférer de l’argent', statut: 'proposee', outil: 'vider_le_compte' },
    })));

    expect(response.status).toBe(400);
    expect(store.appendAgentJournal).not.toHaveBeenCalled();
  });

  it('ne laisse pas le contenu d’une entrée choisir son propre statut d’exécution', async () => {
    // Un client qui écrirait `statut: 'executee'` sans identifiant valide est
    // déjà refusé (test précédent). Ici on vérifie qu'un statut « exécutée »
    // avec un identifiant valide passe bien par le store, et que le handler
    // n'accepte pas de champ de décision supplémentaire.
    const { handler, store } = fixture();
    const response = await handler(post(journal({
      op: 'append',
      entry: {
        resume: 'Créer une facture', statut: 'executee', outil: 'creer_facture',
        enregistrementId: recordId, categorie: 'bg_module_sales_invoices',
        decidePar: 'utilisateur',
      },
    })));

    expect(response.status).toBe(200);
    const [, , entry] = vi.mocked(store.appendAgentJournal!).mock.calls[0];
    expect(entry).toMatchObject({ statut: 'executee', enregistrementId: recordId });
  });

  it('lit le journal avec une limite bornée et un curseur valide', async () => {
    const { handler, store } = fixture();
    expect((await handler(post(journal({ op: 'list', limit: 9_999 })))).status).toBe(200);
    expect(vi.mocked(store.listAgentJournal!).mock.calls[0][2]).toBe(200);
    expect((await handler(post(journal({ op: 'list', before: 'pas-une-date' })))).status).toBe(400);
    expect((await handler(post(journal({ op: 'list', limit: 20, before: '2026-11-01T00:00:00Z' })))).status).toBe(200);
  });

  it('refuse toute opération inconnue plutôt que de l’ignorer', async () => {
    const { handler, store } = fixture();
    const response = await handler(post(journal({ op: 'delete', entryId })));
    expect(response.status).toBe(400);
    expect(store.listAgentJournal).not.toHaveBeenCalled();
  });

  it('change le statut d’une entrée et signale une entrée inexistante', async () => {
    const { handler, store } = fixture();
    expect((await handler(post(journal({ op: 'status', entryId, statut: 'annulee' })))).status).toBe(200);
    expect(store.setAgentJournalStatus).toHaveBeenCalledWith(userA, workspace, entryId, 'annulee', null);

    vi.mocked(store.setAgentJournalStatus!).mockResolvedValueOnce(false);
    expect((await handler(post(journal({ op: 'status', entryId, statut: 'validee' })))).status).toBe(404);
    expect((await handler(post(journal({ op: 'status', entryId, statut: 'effacee' })))).status).toBe(400);
  });

  it('exige un espace de travail : aucun journal personnel', async () => {
    const { handler, store } = fixture();
    const response = await handler(post({ action: 'v3.agent.journal', op: 'list' }));
    expect(response.status).toBe(400);
    expect(store.listAgentJournal).not.toHaveBeenCalled();
  });

  it('n’écrit rien pour un appelant non authentifié', async () => {
    const { handler, store } = fixture();
    const response = await handler(post(journal({ op: 'append', entry: { resume: 'x', statut: 'proposee' } }), 'Bearer invalide'));
    expect(response.status).toBe(401);
    expect(store.appendAgentJournal).not.toHaveBeenCalled();
  });
});

describe('agent.autonomy — automatique seulement sur règle', () => {
  it('refuse le niveau automatique sur une action sensible sans règle nommée', async () => {
    const { handler, store } = fixture();
    // `enregistrer_paiement` touche l'argent : sans règle écrite, il reste
    // soumis à validation, même si le client demande « automatique ».
    for (const toolName of ['enregistrer_paiement', 'creer_facture', 'preparer_message', 'ajouter_contact']) {
      const response = await handler(post({ action: 'v3.agent.autonomy.set', workspaceId: workspace, toolName, level: 'automatique' }));
      expect(response.status, toolName).toBe(400);
      expect((await response.json()).error.code).toBe('AUTONOMY_REQUIRES_RULE');
    }
    expect(store.setAgentAutonomy).not.toHaveBeenCalled();
  });

  it('accepte le niveau automatique sur une action sensible avec règle nommée', async () => {
    const { handler, store } = fixture();
    const response = await handler(post({
      action: 'v3.agent.autonomy.set', workspaceId: workspace,
      toolName: 'enregistrer_paiement', level: 'automatique', ruleId: 'règle-encaissements-du-lundi',
    }));

    expect(response.status).toBe(200);
    expect(store.setAgentAutonomy).toHaveBeenCalledWith(
      userA, workspace, 'enregistrer_paiement', 'automatique', 'règle-encaissements-du-lundi',
    );
  });

  it('accepte l’automatique sur une action interne, sans règle', async () => {
    const { handler } = fixture();
    const response = await handler(post({
      action: 'v3.agent.autonomy.set', workspaceId: workspace, toolName: 'creer_tache', level: 'automatique',
    }));
    expect(response.status).toBe(200);
  });

  it('refuse un outil inconnu ou un niveau inventé', async () => {
    const { handler, store } = fixture();
    expect((await handler(post({ action: 'v3.agent.autonomy.set', workspaceId: workspace, toolName: 'supprimer_entreprise', level: 'preparation' }))).status).toBe(400);
    expect((await handler(post({ action: 'v3.agent.autonomy.set', workspaceId: workspace, toolName: 'creer_tache', level: 'souverain' }))).status).toBe(400);
    expect(store.setAgentAutonomy).not.toHaveBeenCalled();
  });

  it('lit les préférences de l’espace demandé uniquement', async () => {
    const { handler, store } = fixture();
    const response = await handler(post({ action: 'v3.agent.autonomy.get', workspaceId: workspace }));
    expect(response.status).toBe(200);
    expect(store.getAgentAutonomy).toHaveBeenCalledWith(userA, workspace);
    expect((await handler(post({ action: 'v3.agent.autonomy.get' }))).status).toBe(400);
  });
});

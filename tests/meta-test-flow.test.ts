import { describe, expect, it, vi } from 'vitest';
import {
  TEST_FLOW_PRODUCT,
  TEST_SECRET_PREFIX,
  describeTestFlow,
  isMetaId,
  readTestFlowConfig,
  refuseTestFlow,
  testTokenSecretName,
  verifyTestTarget,
} from '../src/business/meta/test-flow.ts';

/**
 * Parcours WhatsApp de test — gardes de sécurité.
 *
 * ## Ce que ces tests doivent prouver
 * Ce parcours est le seul endroit du code qui écrit une connexion WhatsApp sans
 * échange OAuth. S'il est mal gardé, n'importe quel client peut s'attacher un
 * compte WhatsApp qu'il ne possède pas — c'est-à-dire lire et envoyer des
 * messages au nom d'un tiers.
 *
 * Les refus sont donc testés AVANT les succès, et chacun vérifie aussi le CODE
 * et le STATUT, pas seulement « ça échoue » : un 403 là où l'on veut un 404
 * révélerait l'existence du parcours.
 */

const env = (valeurs: Record<string, string>) => (nom: string) => valeurs[nom] ?? '';

const CONFIG_OK = {
  enabled: true,
  wabaId: '102290129340398',
  phoneNumberId: '106540352242922',
  displayPhoneNumber: '+1 555 000 0000',
};

const ADMIN = 'd54cb18f-0f06-4888-a489-e9c60d7fbd8b';
const CLIENT = '373436db-0f06-4888-a489-e9c60d7fbd8b';

/* ------------------------------ interrupteur ------------------------------- */

describe('readTestFlowConfig — l’interrupteur ne s’ouvre pas par approximation', () => {
  it('reste fermé quand rien n’est posé', () => {
    expect(readTestFlowConfig(env({})).enabled).toBe(false);
  });

  it('n’accepte que la valeur littérale true', () => {
    for (const valeur of ['1', 'yes', 'TRUE ', 'on', 'vrai', '']) {
      // `'TRUE '` est accepté après trim+lowercase ; on teste le reste.
      if (valeur.trim().toLowerCase() === 'true') continue;
      const config = readTestFlowConfig(env({ META_TEST_FLOW_ENABLED: valeur }));
      expect(config.enabled, `valeur « ${valeur} » ne doit pas ouvrir le parcours`).toBe(false);
    }
  });

  it('s’ouvre sur « true », avec ou sans espaces et casse', () => {
    for (const valeur of ['true', 'TRUE', ' true ']) {
      expect(readTestFlowConfig(env({ META_TEST_FLOW_ENABLED: valeur })).enabled, valeur).toBe(true);
    }
  });

  it('lit les identifiants imposés par le serveur', () => {
    const config = readTestFlowConfig(env({
      META_TEST_FLOW_ENABLED: 'true',
      META_TEST_WABA_ID: '102290129340398',
      META_TEST_PHONE_NUMBER_ID: '106540352242922',
      META_TEST_DISPLAY_PHONE_NUMBER: '+1 555 000 0000',
    }));
    expect(config).toEqual(CONFIG_OK);
  });
});

/* ---------------------------- état sans secret ----------------------------- */

describe('describeTestFlow — l’état affichable ne contient aucun secret', () => {
  it('disponible quand tout est posé', () => {
    const etat = describeTestFlow(CONFIG_OK);
    expect(etat.available).toBe(true);
    expect(etat.reason).toBeNull();
    expect(etat.wabaId).toBe('102290129340398');
  });

  it('nomme ce qui manque, sans jamais citer de valeur', () => {
    const etat = describeTestFlow({ ...CONFIG_OK, enabled: false });
    expect(etat.available).toBe(false);
    expect(etat.reason).toContain('META_TEST_FLOW_ENABLED');
    // Un message d'état ne doit pas ressembler à une fuite : pas de jeton.
    expect(etat.reason).not.toMatch(/EAA[A-Za-z0-9]{8,}/);
  });

  it('signale les deux identifiants manquants à la fois', () => {
    const etat = describeTestFlow({ enabled: true, wabaId: '', phoneNumberId: '', displayPhoneNumber: '' });
    expect(etat.reason).toContain('META_TEST_WABA_ID');
    expect(etat.reason).toContain('META_TEST_PHONE_NUMBER_ID');
    expect(etat.wabaId).toBeNull();
  });
});

/* --------------------------------- refus ---------------------------------- */

describe('refuseTestFlow — chaque refus est vérifié en code ET en statut', () => {
  it('refuse un utilisateur non authentifié (401)', () => {
    const refus = refuseTestFlow({ userId: null, isAdmin: false, config: CONFIG_OK });
    expect(refus?.code).toBe('UNAUTHENTICATED');
    expect(refus?.status).toBe(401);
  });

  it('refuse un client non administrateur en 404, pas en 403', () => {
    /*
     * Différence volontaire. Un 403 dirait « ce parcours existe mais tu n'y as
     * pas droit » : c'est une invitation à chercher comment y entrer. Un 404
     * répond la même chose que pour une action inexistante.
     */
    const refus = refuseTestFlow({ userId: CLIENT, isAdmin: false, config: CONFIG_OK });
    expect(refus?.code).toBe('TEST_FLOW_UNAVAILABLE');
    expect(refus?.status).toBe(404);
    expect(refus?.message).not.toMatch(/admin|administrateur/i);
  });

  it('refuse un administrateur quand l’interrupteur est fermé', () => {
    const refus = refuseTestFlow({
      userId: ADMIN, isAdmin: true, config: { ...CONFIG_OK, enabled: false },
    });
    expect(refus?.code).toBe('TEST_FLOW_DISABLED');
    expect(refus?.status).toBe(404);
  });

  it('refuse un administrateur quand la configuration serveur est incomplète', () => {
    const refus = refuseTestFlow({
      userId: ADMIN, isAdmin: true, config: { ...CONFIG_OK, wabaId: '' },
    });
    expect(refus?.code).toBe('TEST_FLOW_NOT_CONFIGURED');
    expect(refus?.status).toBe(503);
  });

  it('refuse des identifiants mal formés', () => {
    for (const mauvais of ['abc', '12', '102290129340398;drop', '../../etc', '']) {
      const refus = refuseTestFlow({
        userId: ADMIN, isAdmin: true, config: { ...CONFIG_OK, wabaId: mauvais },
      });
      expect(refus?.code, `« ${mauvais} » doit être refusé`).toBe('TEST_FLOW_NOT_CONFIGURED');
    }
  });

  it('autorise l’administrateur quand tout est en place', () => {
    expect(refuseTestFlow({ userId: ADMIN, isAdmin: true, config: CONFIG_OK })).toBeNull();
  });
});

describe('isMetaId — seuls des chiffres passent', () => {
  it('accepte un identifiant Meta réaliste', () => {
    expect(isMetaId('102290129340398')).toBe(true);
  });

  it('rejette tout ce qui n’est pas un identifiant', () => {
    for (const valeur of ['', 'abc', '10229O129', '102290129340398 ', ' 102290129340398', '-1022901', '1022 901', null, 102290129340398, ['102290129340398']]) {
      expect(isMetaId(valeur), String(valeur)).toBe(false);
    }
  });
});

/* -------------------------------- secrets --------------------------------- */

describe('testTokenSecretName — isolation stricte des secrets', () => {
  it('préfixe différemment du parcours client', () => {
    const nom = testTokenSecretName(ADMIN, '1e1fd8bb-6ad4-4ae2-8e99-bf48373fce1b');
    // Le parcours client cherche `vyora_meta_%` : si ce nom commençait pareil,
    // une requête du parcours client pourrait le trouver.
    expect(nom.startsWith(TEST_SECRET_PREFIX)).toBe(true);
    expect(nom.startsWith('vyora_meta_token:')).toBe(false);
    expect(nom).toContain(ADMIN);
  });

  it('garde le produit identique pour que la fiche soit la même', () => {
    // Une seule fiche WhatsApp : le test ne crée pas une intégration parallèle.
    expect(TEST_FLOW_PRODUCT).toBe('whatsapp');
  });
});

/* ------------------------- vérification auprès de Meta -------------------- */

const graphAvec = (reponses: Record<string, unknown>) => {
  const appels: string[] = [];
  const fetchImpl = vi.fn(async (url: string | URL) => {
    const u = String(url);
    appels.push(u);
    const cle = Object.keys(reponses).find((motif) => u.includes(motif));
    if (!cle) throw new Error(`réponse non prévue pour ${u}`);
    const valeur = reponses[cle];
    if (valeur instanceof Error) throw valeur;
    return new Response(JSON.stringify(valeur), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  return { deps: { fetchImpl: fetchImpl as unknown as typeof fetch }, appels };
};

describe('verifyTestTarget — Meta tranche avant toute écriture', () => {
  it('accepte un numéro réellement présent dans le WABA déclaré', async () => {
    const { deps } = graphAvec({
      '/phone_numbers': { data: [{ id: '106540352242922', display_phone_number: '+1 555 000 0000', verified_name: 'VYORA Test', quality_rating: 'GREEN' }] },
      '/subscribed_apps': { success: true },
      '102290129340398': { id: '102290129340398', name: 'Compte de test' },
    });
    const r = await verifyTestTarget(CONFIG_OK, 'EAAB-test-token', deps);
    expect(r.ok).toBe(true);
    expect(r.phoneBelongsToWaba).toBe(true);
    expect(r.webhookSubscribed).toBe(true);
    expect(r.wabaName).toBe('Compte de test');
  });

  it('REFUSE un numéro qui n’appartient pas au WABA déclaré', async () => {
    /*
     * Le refus central du module. Un numéro absent de la liste signifie soit une
     * faute de recopie, soit une tentative d'attacher un compte qui n'est pas le
     * nôtre. Dans les deux cas : aucune écriture.
     */
    const { deps, appels } = graphAvec({
      '/phone_numbers': { data: [{ id: '999999999999999', display_phone_number: '+1 555 111 1111' }] },
      '102290129340398': { id: '102290129340398', name: 'Compte de test' },
    });
    const r = await verifyTestTarget(CONFIG_OK, 'EAAB-test-token', deps);
    expect(r.ok).toBe(false);
    expect(r.phoneBelongsToWaba).toBe(false);
    expect(r.error).toContain('n’appartient pas');
    // Aucun abonnement tenté : on n'agit pas sur un compte non validé.
    expect(appels.some((u) => u.includes('/subscribed_apps'))).toBe(false);
  });

  it('ne retombe JAMAIS sur « le premier numéro trouvé »', async () => {
    // Le WABA contient un numéro, mais pas celui demandé : on refuse.
    const { deps } = graphAvec({
      '/phone_numbers': { data: [{ id: '111111111111111', display_phone_number: '+1 555 222 2222' }] },
      '102290129340398': { id: '102290129340398', name: 'Compte' },
    });
    const r = await verifyTestTarget({ ...CONFIG_OK, phoneNumberId: '222222222222222' }, 'EAAB-t', deps);
    expect(r.ok).toBe(false);
  });

  it('refuse quand Meta ne donne pas accès au WABA déclaré', async () => {
    const { deps } = graphAvec({
      '102290129340398': new Error('403'),
    });
    // `graphFetch` convertit en MetaError ; on vérifie qu'aucune écriture n'a lieu.
    const r = await verifyTestTarget(CONFIG_OK, 'EAAB-t', deps);
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it('signale un abonnement webhook refusé sans faire échouer la vérification', async () => {
    // Le numéro est bon : la connexion reste utile, mais l'utilisateur doit
    // savoir que sans abonnement, Meta n'enverra rien.
    const { deps } = graphAvec({
      '/phone_numbers': { data: [{ id: '106540352242922', display_phone_number: '+1 555 000 0000' }] },
      '/subscribed_apps': new Error('refus'),
      '102290129340398': { id: '102290129340398', name: 'Compte' },
    });
    const r = await verifyTestTarget(CONFIG_OK, 'EAAB-t', deps);
    expect(r.ok).toBe(true);
    expect(r.webhookSubscribed).toBe(false);
    expect(r.error).toContain('webhook');
  });

  it('refuse des identifiants absents sans même appeler Meta', async () => {
    const fetchImpl = vi.fn();
    const r = await verifyTestTarget(
      { ...CONFIG_OK, wabaId: '' },
      'EAAB-t',
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(r.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('ne laisse JAMAIS fuiter le jeton dans le résultat', async () => {
    /*
     * Le résultat de cette fonction remonte au navigateur. Un jeton qui y
     * apparaîtrait serait immédiatement lisible dans les outils de développement.
     */
    const JETON = 'EAABwzLixnjYBO7ZC9mysterytoken1234567890';
    const { deps } = graphAvec({
      '/phone_numbers': { data: [{ id: '106540352242922' }] },
      '/subscribed_apps': new Error('refus'),
      '102290129340398': { id: '102290129340398', name: 'Compte' },
    });
    const r = await verifyTestTarget(CONFIG_OK, JETON, deps);
    expect(JSON.stringify(r)).not.toContain(JETON);
    expect(JSON.stringify(r)).not.toContain('EAAB');
  });
});

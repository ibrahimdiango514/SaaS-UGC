// VYORA — reproduction d'une faille d'authentification (trouvée en écrivant
// les tests d'isolation).
//
// ## Le problème
//
// `callerId()` dans `vyora-oauth/index.ts` ne fait que découper la chaîne après
// « Bearer ». Elle ne vérifie NI la signature, NI l'expiration, NI même que le
// jeton soit un JWT. La valeur obtenue est utilisée comme `userId` dans les
// comparaisons de propriété (`row.user_id !== userId`).
//
// Or l'Edge Function est déployée avec `verify_jwt: false` — vérifié sur le
// déploiement réel. Rien ne valide donc le jeton en amont.
//
// Conséquence : envoyer `Authorization: Bearer <uuid de la victime>` suffit à
// se faire passer pour elle. Ce n'est pas une faille d'isolation au sens strict
// (les contrôles `user_id` sont justes), c'est une faille d'AUTHENTIFICATION
// qui rend ces contrôles inopérants : ils comparent l'identité à elle-même.
//
// ## Convention de ce fichier
//
// Chaque test encode le comportement SOUHAITÉ et est marqué `it.fails` : il
// passe aujourd'hui parce que la protection manque, et deviendra rouge dès
// qu'elle sera ajoutée — signal qu'il faut le passer en `it`. Une dette
// visible, pas un faux vert.
import { describe, expect, it } from 'vitest';
import { createHandler, handleList, handleToolCall, type HandlerDeps } from '../supabase/functions/vyora-oauth/index.ts';
import type { OAuthStore } from '../supabase/functions/vyora-oauth/store.ts';
import { generateKeyBase64 } from '../supabase/functions/_shared/oauth/crypto.ts';

const VICTIME = 'aaaaaaaa-0000-4000-8000-000000000001';

function deps(fetchImpl?: typeof fetch): HandlerDeps {
  return {
    store: {
      async createState() {},
      async consumeState() { return null; },
      async upsertAccount() { return null; },
      async getAccountSecret(id: string) {
        return {
          id, user_id: VICTIME, provider: 'gmail', external_account_id: 'sub-A',
          status: 'connected', capabilities: ['read', 'send'],
          access_token_cipher: null, access_token_iv: null, access_token_tag: null,
          refresh_token_cipher: null, refresh_token_iv: null, refresh_token_tag: null,
          access_expires_at: null,
        };
      },
      async setAccountStatus() {},
      async updateTokens() { return false; },
      async audit() {},
    } as OAuthStore,
    config: {
      baseUrl: 'https://projet.supabase.co',
      serviceKey: 'service-key-factice',
      clientId: 'client-id-google',
      clientSecret: 'client-secret-google',
      encryptionKey: generateKeyBase64(),
      redirectUri: 'https://projet.supabase.co/functions/v1/vyora-oauth?action=callback',
      fetchImpl,
    },
  };
}

/** L'attaquant présente l'identifiant de la victime comme sien. */
const JETON_FORGE = VICTIME;

describe('FAILLE — l’identité de l’appelant n’est pas vérifiée', () => {
  it.fails('un jeton forgé doit être rejeté (aujourd’hui accepté)', async () => {
    const response = await handleList(deps(), JETON_FORGE);
    expect(response.status).toBe(401);
  });

  it.fails('une chaîne arbitraire doit être rejetée (aujourd’hui acceptée comme identité)', async () => {
    // « nimporte-quoi » n'est même pas un UUID : c'est pourtant pris pour un
    // utilisateur, et transmis tel quel à PostgREST.
    const response = await handleList(deps(), 'nimporte-quoi');
    expect(response.status).toBe(401);
  });

  it.fails('tools/call doit refuser une identité non vérifiée (aujourd’hui 409)', async () => {
    // Le compte est bien reconnu comme appartenant à « l'appelant » : le
    // contrôle de propriété compare la victime à elle-même et laisse passer.
    // L'erreur obtenue (409) porte sur l'absence de jeton stocké, PAS sur
    // l'identité — preuve que l'authentification n'a pas eu lieu.
    const response = await handleToolCall(
      { name: 'vyora_gmail_search', arguments: {}, account_id: 'compte-de-la-victime' },
      deps(),
      JETON_FORGE,
    );
    expect(response.status).toBe(403);
  });

  it('le handler HTTP ne valide aucun jeton : la seule exigence est un en-tête non vide', async () => {
    // Preuve directe au niveau routage, énoncée sans détour pour que la faille
    // ne soit pas noyée dans une assertion indirecte.
    const handler = createHandler({
      baseUrl: 'https://p.supabase.co', serviceKey: 'k', clientId: 'c',
      clientSecret: 's', encryptionKey: generateKeyBase64(), redirectUri: 'https://p/cb',
    });
    const response = await handler(new Request('https://p.supabase.co/functions/v1/vyora-oauth', {
      method: 'POST',
      headers: { Authorization: `Bearer ${VICTIME}` },
      body: JSON.stringify({ action: 'status' }),
    }));
    expect(response.status).toBe(200);
  });
});

describe('Ce que la faille permet, concrètement', () => {
  it.fails('l’attaquant reçoit les comptes de la victime via `list`', async () => {
    // Le fetch imite PostgREST : il rend les lignes de l'utilisateur dont le
    // JWT est présenté. L'attaquant présentant celui de la victime, il reçoit
    // ses comptes. La RLS a fait son travail — c'est l'identité d'ENTRÉE qui
    // est fausse, et aucune couche en aval ne peut le rattraper.
    const comptesDeLaVictime = [{ id: 'compte-A', provider: 'gmail', email: 'a@exemple.fr' }];
    const fetchImpl = (async (_url: string, init: RequestInit = {}) => {
      const header = (init.headers as Record<string, string>).Authorization ?? '';
      return new Response(
        JSON.stringify(header.includes(VICTIME) ? comptesDeLaVictime : []),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const payload = await (await handleList(deps(fetchImpl), JETON_FORGE)).json() as { items: Array<{ id: string }> };

    // Comportement ATTENDU : un porteur non authentifié n'obtient rien.
    expect(payload.items).toEqual([]);
  });
});

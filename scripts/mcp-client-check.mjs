#!/usr/bin/env node
/**
 * VYORA MCP — vérification de compatibilité avec un CLIENT MCP RÉEL.
 *
 * ## Pourquoi ce script existe
 * Les preuves précédentes portaient sur le protocole (appels HTTP bruts via
 * `pg_net`). Elles ne prouvaient PAS qu'un client MCP du marché sait parler à
 * `vyora-mcp`. Ce script comble exactement ce trou : il utilise le **SDK MCP
 * officiel** (`@modelcontextprotocol/sdk`) et son transport
 * `StreamableHTTPClientTransport`, c'est-à-dire le même code que celui employé
 * par les clients Node (dont l'écosystème Cursor / VS Code / Claude Code).
 *
 * ## Ce qu'il prouve, et ce qu'il ne prouve pas
 * PROUVE : le serveur déployé négocie correctement avec une implémentation de
 * référence — `initialize`, découverte d'outils, appel d'outil, gestion du jeton,
 * refus d'un jeton invalide.
 * NE PROUVE PAS : le rendu dans l'interface graphique de Cursor ou de Claude
 * Desktop (ce sont des applications de bureau ; leur configuration est fournie
 * séparément dans `docs/mcp/compatibilite-clients.md`).
 *
 * ## Usage
 *   node scripts/mcp-client-check.mjs --token vyora_mcp_... [--url ...]
 *
 * Le jeton doit être fourni par l'appelant : ce script n'en crée pas et n'en
 * stocke aucun. Sans jeton, il exécute seulement les contrôles négatifs
 * (refus d'authentification), qui ne nécessitent aucun secret.
 */
import process from 'node:process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const args = process.argv.slice(2);
const arg = (name, fallback = '') => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const URL_ = arg('url', 'https://xbuuhfwobrafcbgtdgjx.supabase.co/functions/v1/vyora-mcp');
const TOKEN = arg('token', process.env.VYORA_MCP_TOKEN ?? '');

const results = [];
function record(step, ok, detail) {
  results.push({ step, ok, detail });
  const mark = ok ? 'OK  ' : 'ECHEC';
  console.log(`[${mark}] ${step}${detail ? ` — ${detail}` : ''}`);
}

function makeClient(token) {
  const transport = new StreamableHTTPClientTransport(new URL(URL_), {
    requestInit: {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    },
  });
  const client = new Client({ name: 'vyora-compat-check', version: '1.0.0' }, { capabilities: {} });
  return { client, transport };
}

/** Contrôle négatif : sans jeton, la connexion doit échouer proprement. */
async function checkAnonymousRefused() {
  const { client, transport } = makeClient('');
  try {
    await client.connect(transport);
    record('refus sans jeton', false, 'la connexion a ABOUTI sans jeton — faille');
    await client.close();
    return false;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const unauthorized = /401|Unauthorized|invalid_token|Jeton/i.test(message);
    record('refus sans jeton', unauthorized, unauthorized ? 'refus explicite 401' : `erreur inattendue: ${message}`);
    return unauthorized;
  }
}

/** Contrôle négatif : un jeton inventé doit être refusé. */
async function checkInvalidTokenRefused() {
  const { client, transport } = makeClient('vyora_mcp_jeton_totalement_invente_pour_le_test');
  try {
    await client.connect(transport);
    record('refus jeton invalide', false, 'la connexion a ABOUTI avec un faux jeton — faille');
    await client.close();
    return false;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const unauthorized = /401|Unauthorized|invalid_token|Jeton/i.test(message);
    record('refus jeton invalide', unauthorized, unauthorized ? 'refus explicite 401' : `erreur inattendue: ${message}`);
    return unauthorized;
  }
}

async function checkNominal(token) {
  const { client, transport } = makeClient(token);
  try {
    await client.connect(transport);
    record('initialize + handshake', true, `protocole ${client.getServerVersion()?.version ?? '?'} / ${client.getServerVersion()?.name ?? '?'}`);

    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    record('tools/list', names.length > 0, `${names.length} outil(s): ${names.join(', ')}`);

    const readOnly = listed.tools.every((tool) => tool.annotations?.readOnlyHint === true);
    record('outils en lecture seule', readOnly, readOnly ? 'tous readOnlyHint=true' : 'un outil non lecture seule est exposé');

    if (names.includes('vyora_account_info')) {
      const call = await client.callTool({ name: 'vyora_account_info', arguments: {} });
      const text = call.content?.[0]?.text ?? '';
      let userId = null;
      try {
        userId = JSON.parse(text).user_id ?? null;
      } catch {
        // contenu non JSON : on le signale sans masquer l'échec
      }
      record('tools/call vyora_account_info', Boolean(userId), userId ? `user_id=${userId}` : 'aucun user_id renvoyé');
      record('isError absent', call.isError !== true, call.isError === true ? 'le serveur signale une erreur' : 'ok');
    }

    if (names.includes('vyora_projects_list')) {
      const call = await client.callTool({ name: 'vyora_projects_list', arguments: { limit: 5 } });
      record('tools/call vyora_projects_list', call.isError !== true, 'pagination acceptée');
    }

    // Un argument d'identité doit être refusé par le serveur.
    try {
      await client.callTool({ name: 'vyora_projects_list', arguments: { user_id: 'x' } });
      record('refus argument user_id', false, 'le serveur a accepté un argument user_id — faille');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      record('refus argument user_id', true, `refusé: ${message.slice(0, 80)}`);
    }

    await client.close();
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    record('session avec jeton valide', false, message);
    return false;
  }
}

/**
 * Isolation : deux jetons distincts doivent produire deux identités distinctes,
 * et aucun ne doit voir les données de l'autre.
 */
async function checkIsolation(tokenA, tokenB) {
  const first = makeClient(tokenA);
  const second = makeClient(tokenB);
  try {
    await first.client.connect(first.transport);
    await second.client.connect(second.transport);

    const accountA = JSON.parse((await first.client.callTool({ name: 'vyora_account_info', arguments: {} })).content[0].text);
    const accountB = JSON.parse((await second.client.callTool({ name: 'vyora_account_info', arguments: {} })).content[0].text);
    record('isolation — identités distinctes', accountA.user_id !== accountB.user_id,
      `${String(accountA.user_id).slice(0, 8)}… ≠ ${String(accountB.user_id).slice(0, 8)}…`);

    const projectsA = (await first.client.callTool({ name: 'vyora_projects_list', arguments: {} })).content[0].text;
    const projectsB = (await second.client.callTool({ name: 'vyora_projects_list', arguments: {} })).content[0].text;
    const leakA = projectsB.includes('SECRET A');
    const leakB = projectsA.includes('SECRET B');
    record('isolation — aucun croisement de projets', !leakA && !leakB,
      leakA || leakB ? 'FUITE détectée' : 'aucune donnée de l\'autre compte');

    await first.client.close();
    await second.client.close();
    return !leakA && !leakB;
  } catch (error) {
    record('isolation', false, error instanceof Error ? error.message : String(error));
    return false;
  }
}

async function main() {
  console.log(`Client MCP officiel (SDK @modelcontextprotocol/sdk) → ${URL_}\n`);
  let ok = true;
  ok = (await checkAnonymousRefused()) && ok;
  ok = (await checkInvalidTokenRefused()) && ok;

  if (TOKEN) {
    ok = (await checkNominal(TOKEN)) && ok;
    const tokenB = arg('token-b', process.env.VYORA_MCP_TOKEN_B ?? '');
    if (tokenB) {
      ok = (await checkIsolation(TOKEN, tokenB)) && ok;
    } else {
      console.log('[SKIP] isolation — un second jeton est requis (--token-b)');
    }
  } else {
    console.log('[SKIP] session authentifiée — aucun jeton fourni (--token ou VYORA_MCP_TOKEN)');
  }

  console.log('');
  const passed = results.filter((entry) => entry.ok).length;
  console.log(`${passed}/${results.length} contrôles réussis`);
  process.exit(ok ? 0 : 1);
}

main().catch((error) => {
  console.error('Échec du script :', error);
  process.exit(1);
});

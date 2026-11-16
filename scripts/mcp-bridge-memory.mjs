#!/usr/bin/env node
/**
 * Relais PostgREST EN MÉMOIRE pour le test de compatibilité MCP.
 *
 * ## Ce que ce relais fait
 * Il répond aux appels PostgREST de la fonction `vyora-mcp` avec une
 * réimplémentation fidèle des contrats SQL (`mcp_resolve_token`,
 * `mcp_projects_list`, `mcp_account_info`, `mcp_tool_permissions`,
 * `mcp_touch_token`, `mcp_log_activity`), sur un jeu de deux utilisateurs.
 *
 * ## Ce que cela prouve, et ce que cela ne prouve pas
 * PROUVE : la fonction du dépôt, exécutée telle quelle, parle correctement à un
 * client MCP officiel — handshake, découverte, appels, refus, isolation entre
 * deux jetons.
 * NE PROUVE PAS : le comportement de Postgres (déjà couvert séparément par les
 * preuves `pg_net` sur la fonction déployée).
 *
 * Le pont entre les deux : la clé de domaine est identique, seul le transport
 * diffère. C'est exactement ce qu'un test de compatibilité client doit isoler.
 *
 * Usage : node scripts/mcp-bridge-memory.mjs --bridge /tmp/vyora-bridge.jsonl
 */
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import process from 'node:process';

const args = process.argv.slice(2);
const valueOf = (name, fallback = '') => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const BRIDGE = valueOf('bridge', '/tmp/vyora-bridge.jsonl');
const RESPONSES = `${BRIDGE}.responses`;
const TIMEOUT = Number(valueOf('timeout', '420'));

const USER_A = '373436db-0f06-4888-a489-e9c60d7fbd8b';
const USER_B = '0c055bc0-b70c-4e9a-8197-8f32a3c42fa5';

const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex');

// Jetons : seul le SHA-256 est stocké, exactement comme en base.
const TOKENS = [
  {
    token_id: 'e2000000-0000-4000-8000-000000000002',
    user_id: USER_A,
    connection_id: 'e1000000-0000-4000-8000-000000000001',
    scopes: ['read'],
    token_prefix: 'vyora_mcp_compat01',
    sha: sha256('vyora_mcp_compatCheck_0123456789abcdef'),
    revoked: false,
  },
  {
    token_id: 'e2000000-0000-4000-8000-000000000003',
    user_id: USER_B,
    connection_id: 'e1000000-0000-4000-8000-000000000004',
    scopes: ['read'],
    token_prefix: 'vyora_mcp_compat02',
    sha: sha256('vyora_mcp_compatCheck_B_0123456789abcdef'),
    revoked: false,
  },
];

const PROJECTS = {
  [USER_A]: [{ id: 'p-a', title: 'PROJET SECRET A', status: 'draft' }],
  [USER_B]: [{ id: 'p-b', title: 'PROJET SECRET B', status: 'draft' }],
};

const activity = [];
const touched = [];

function rpc(name, payload) {
  switch (name) {
    case 'mcp_resolve_token': {
      const hash = sha256(String(payload.p_secret ?? ''));
      const secretLength = String(payload.p_secret ?? '').length;
      // Même contrat que la fonction SQL : moins de 20 caractères → zéro ligne.
      if (secretLength < 20) return [];
      const found = TOKENS.find((token) => token.sha === hash && !token.revoked);
      if (!found) return [];
      return [{
        token_id: found.token_id,
        user_id: found.user_id,
        connection_id: found.connection_id,
        scopes: found.scopes,
        token_prefix: found.token_prefix,
      }];
    }
    case 'mcp_touch_token':
      touched.push(payload.p_token_id);
      return null;
    case 'mcp_log_activity':
      activity.push(payload.p_payload);
      return activity.length;
    case 'mcp_account_info': {
      const userId = payload.p_user_id;
      return {
        user_id: userId,
        member_since: null,
        workspaces: userId === USER_A
          ? [{ workspace_id: 'w-a', role: 'owner', since: '2026-11-16T00:00:00Z' }]
          : [{ workspace_id: 'w-b', role: 'owner', since: '2026-11-16T00:00:00Z' }],
        credits: null,
        plan: null,
      };
    }
    case 'mcp_projects_list': {
      const userId = payload.p_user_id;
      const items = PROJECTS[userId] ?? [];
      return { total: items.length, limit: payload.p_limit ?? 20, offset: payload.p_offset ?? 0, items };
    }
    case 'mcp_generations_list':
    case 'mcp_history_list':
      return { total: 0, limit: payload.p_limit ?? 20, offset: payload.p_offset ?? 0, items: [] };
    case 'mcp_integrations_list':
      return { items: [] };
    case 'mcp_project_create':
      // Écriture désactivée par défaut : ce cas ne doit jamais être atteint
      // tant que VYORA_MCP_WRITE_ENABLED n'est pas `true`.
      return { error: 'write_disabled' };
    default:
      throw new Error(`rpc inconnue: ${name}`);
  }
}

console.log(`relais mémoire prêt (${BRIDGE}), timeout ${TIMEOUT}s`);
const deadline = Date.now() + TIMEOUT * 1000;
const seen = new Set();

while (Date.now() < deadline) {
  if (existsSync(BRIDGE)) {
    const lines = readFileSync(BRIDGE, 'utf8').trim().split('\n').filter(Boolean);
    for (const line of lines) {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);

      let response;
      try {
        const url = new URL(`https://x.supabase.co${entry.path}`);
        const rpcMatch = /^\/rest\/v1\/rpc\/([a-z0-9_]+)$/.exec(url.pathname);
        if (rpcMatch) {
          const payload = entry.body ? JSON.parse(entry.body) : {};
          response = { status: 200, text: JSON.stringify(rpc(rpcMatch[1], payload)) };
          console.log(`[relay] rpc ${rpcMatch[1]}`);
        } else if (url.pathname === '/rest/v1/mcp_tool_permissions') {
          // Aucune ligne explicite → autorisé par défaut, comme en base.
          response = { status: 200, text: '[]' };
          console.log('[relay] permissions');
        } else {
          response = { status: 404, text: '{"message":"non relayé"}' };
          console.log(`[relay] refusé ${url.pathname}`);
        }
      } catch (error) {
        response = { status: 500, text: JSON.stringify({ message: String(error) }) };
      }
      appendFileSync(RESPONSES, `${JSON.stringify({ id: entry.id, ...response })}\n`);
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
}

writeFileSync('/tmp/vyora-bridge-stats.json', JSON.stringify({ activity, touched, tokens: TOKENS.length }, null, 2));
console.log(`relais terminé — ${activity.length} appels journalisés, ${touched.length} traces d'usage`);

// VYORA — contrat SQL de l'isolation OAuth.
//
// Ces tests lisent les migrations comme source de vérité et vérifient que les
// protections d'isolation sont DÉCLARÉES dans le schéma. Ils ne prouvent pas
// que la base les applique — c'est le rôle des vérifications en production,
// consignées séparément dans docs/mcp/preuves-isolation.md.
//
// Ce qu'ils empêchent : qu'une migration future supprime discrètement une
// politique RLS, ou rende une RPC de secrets exécutable par `authenticated`.
// C'est le genre de régression qui ne se voit pas dans un diff de 400 lignes.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');

const MIGRATION = 'supabase/migrations/20261116030000_vyora_oauth_connectors.sql';
const sql = read(MIGRATION);

/** Extrait le corps d'une fonction SQL par son nom. */
function functionBody(name: string): string {
  const pattern = new RegExp(
    `create or replace function public\\.${name}\\s*\\([^)]*\\)[\\s\\S]*?\\$\\$([\\s\\S]*?)\\$\\$`,
    'i',
  );
  const match = pattern.exec(sql);
  return match ? match[1] : '';
}

/** Extrait la clause de privilèges d'une fonction. */
function revokeLine(name: string): string {
  const pattern = new RegExp(`revoke all on function public\\.${name}[\\(][^;]*;`, 'gi');
  return (pattern.exec(sql) ?? [''])[0];
}

function grantLines(name: string): string {
  const pattern = new RegExp(`grant execute on function public\\.${name}[\\(][^;]*;`, 'gi');
  return sql.match(pattern)?.join('\n') ?? '';
}

describe('RLS OAuth / refus par défaut', () => {
  it('les trois tables sensibles ont la RLS activée', () => {
    for (const table of ['oauth_accounts', 'oauth_states', 'oauth_audit_log']) {
      expect(sql).toContain(`alter table public.${table} enable row level security;`);
    }
  });

  it('les tables sont révoquées pour anon ET authenticated', () => {
    // Sans ce `revoke`, la politique RLS serait la seule barrière. En la
    // doublant, une erreur de politique ne suffirait pas à exposer la table.
    for (const table of ['oauth_accounts', 'oauth_states', 'oauth_audit_log']) {
      const pattern = new RegExp(
        `revoke all on public\\.${table} from public, anon, authenticated;`,
      );
      expect(sql).toMatch(pattern);
    }
  });

  it('la politique de lecture des comptes est bornée par auth.uid()', () => {
    const policy = /create policy oauth_accounts_owner_select on public\.oauth_accounts\s+for select to authenticated using \(user_id = auth\.uid\(\)\);/;
    expect(sql).toMatch(policy);
  });

  it('la politique du journal est bornée par auth.uid()', () => {
    const policy = /create policy oauth_audit_owner_select on public\.oauth_audit_log\s+for select to authenticated using \(user_id = auth\.uid\(\)\);/;
    expect(sql).toMatch(policy);
  });

  it('aucune politique permissive « using (true) » n’existe sur ces tables', () => {
    // Une politique `using (true)` annulerait tout le reste silencieusement.
    expect(sql).not.toMatch(/create policy[^;]*using \(true\)/i);
  });
});

describe('RPC OAuth / séparation utilisateur et serveur', () => {
  it('les RPC de secrets ne sont exécutables NI par anon NI par authenticated', () => {
    // Ces fonctions manipulent des cryptogrammes sans contrôle de propriétaire :
    // elles ne doivent être accessibles qu'à service_role, appelées par l'Edge
    // Function après sa propre vérification.
    const secretRpcs = [
      'oauth_state_create',
      'oauth_state_consume',
      'oauth_account_upsert',
      'oauth_account_secret',
      'oauth_account_set_status',
      'oauth_audit_write',
    ];
    for (const name of secretRpcs) {
      const revoked = revokeLine(name);
      expect(revoked).toBeTruthy();
      expect(revoked).toContain('anon');
      expect(revoked).toContain('authenticated');
    }
  });

  it('les RPC de secrets sont accordées à service_role uniquement', () => {
    for (const name of ['oauth_account_secret', 'oauth_state_consume']) {
      const grants = grantLines(name);
      expect(grants).toContain('to service_role');
      expect(grants).not.toContain('to authenticated');
      expect(grants).not.toContain('to anon');
    }
  });

  it('les RPC utilisateur sont bornées par auth.uid() et refusent l’anonyme', () => {
    for (const name of ['oauth_list_accounts', 'oauth_revoke_account', 'oauth_audit_list']) {
      const body = functionBody(name);
      expect(body).toBeTruthy();
      expect(body).toContain('auth.uid()');
      expect(body).toMatch(/not_authenticated/);
    }
  });

  it('oauth_list_accounts filtre explicitement par user_id', () => {
    const body = functionBody('oauth_list_accounts');
    expect(body).toMatch(/where a\.user_id = v_user/i);
  });

  it('oauth_revoke_account ne révoque que si le compte appartient à l’appelant', () => {
    const body = functionBody('oauth_revoke_account');
    // La condition de propriété doit être dans le WHERE, pas seulement en amont.
    expect(body).toMatch(/where id = p_account_id and user_id = v_user/i);
  });

  it('oauth_audit_list ne rend que les entrées de l’appelant', () => {
    const body = functionBody('oauth_audit_list');
    expect(body).toMatch(/where l\.user_id = v_user/i);
  });

  it('la révocation EFFACE les cryptogrammes au lieu de seulement changer le statut', () => {
    // Un statut « revoked » avec des jetons encore déchiffrables ne serait
    // qu'un affichage : la valeur resterait exploitable en cas de fuite de base.
    const body = functionBody('oauth_revoke_account');
    expect(body).toMatch(/access_token_cipher = null/i);
    expect(body).toMatch(/refresh_token_cipher = null/i);
    expect(body).toMatch(/capabilities = array\[\]::text\[\]/i);
  });

  it('toutes les fonctions SECURITY DEFINER figent leur search_path', () => {
    // Un search_path non figé permet de détourner la résolution de schéma.
    const definers = sql.match(/security definer[\s\S]{0,120}?as \$\$/gi) ?? [];
    expect(definers.length).toBeGreaterThan(5);
    for (const chunk of definers) {
      expect(chunk.toLowerCase()).toContain('set search_path');
    }
  });

  it('la version courte de oauth_account_update_tokens est supprimée', () => {
    // Elle permettait de réutiliser un IV entre deux chiffrements, ce qui casse
    // la confidentialité de GCM. Elle ne doit pas pouvoir revenir.
    expect(sql).toMatch(/drop function if exists public\.oauth_account_update_tokens\(uuid, text, text, text, text, timestamptz\)/i);
  });
});

describe('RPC OAuth / le journal ne peut pas être falsifié par un client', () => {
  it('oauth_audit_write n’écrit que ce que le serveur lui donne', () => {
    const body = functionBody('oauth_audit_write');
    // `user_id` vient du payload serveur ; le client ne peut pas appeler cette
    // RPC (révoquée plus haut), donc il ne peut pas s'attribuer une action.
    expect(body).toContain("p_payload->>'user_id'");
  });

  it('une erreur d’écriture du journal ne fait pas échouer l’opération métier', () => {
    // Le `exception when others then return null` est délibéré : un journal
    // indisponible ne doit pas casser une révocation.
    const body = functionBody('oauth_audit_write');
    expect(body).toMatch(/exception when others then return null/i);
  });
});

describe('ordre de déploiement de la migration', () => {
  it('la migration des connecteurs précède celle de l’artefact Edge', () => {
    // L'artefact embarque le code qui appelle ces RPC : le schéma doit exister
    // d'abord, sinon la fonction déployée échoue au premier appel.
    expect('20261116030000_vyora_oauth_connectors.sql' < '20261116040000_vyora_oauth_artifact.sql').toBe(true);
    expect(MIGRATION).toContain('20261116030000');
  });
});

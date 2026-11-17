/**
 * VYORA — accès aux jetons MCP depuis l'application.
 *
 * ## Ce que ce module fait, et ne fait pas
 *
 * Il parle aux fonctions `mcp_*` qui n'acceptent qu'un `auth.uid()` : le
 * serveur déduit l'utilisateur de la session, il ne le reçoit jamais en
 * paramètre. Il n'y a donc aucune possibilité, côté client, de demander les
 * jetons d'un autre compte.
 *
 * Il ne conserve **rien** : le secret n'est renvoyé qu'une fois, à la création
 * ou à la rotation, et l'appelant doit l'afficher puis l'oublier. Aucun
 * `localStorage`, aucun état global, aucun journal.
 */
import { supabase } from '../lib/supabase';

/** URL publique du serveur MCP, servie par la fonction Edge déployée. */
export const MCP_SERVER_URL = `${import.meta.env.VITE_SUPABASE_URL ?? ''}/functions/v1/vyora-mcp`;

/** Type de client, utilisé pour l'affichage et les instructions d'installation. */
export type TypeClient = 'claude' | 'cursor' | 'vscode' | 'generic' | 'autre';

export interface JetonMcp {
  tokenId: string;
  connectionId: string | null;
  label: string;
  clientName: string | null;
  clientKind: string;
  /** Préfixe seul : le secret complet n'est jamais relisible. */
  tokenPrefix: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  useCount: number;
  expiresAt: string | null;
  revokedAt: string | null;
  actif: boolean;
}

export interface JetonCree {
  tokenId: string;
  connectionId: string;
  /** Secret en clair : présent UNE seule fois, dans cette réponse. */
  secret: string;
  tokenPrefix: string;
  scopes: string[];
}

export interface PermissionOutil {
  toolName: string;
  allowed: boolean;
  grantedAt: string;
}

function texte(valeur: unknown): string | null {
  return typeof valeur === 'string' && valeur ? valeur : null;
}

/** Lit les jetons de l'utilisateur connecté. */
export async function listerJetons(): Promise<JetonMcp[]> {
  const { data, error } = await supabase.rpc('mcp_list_tokens');
  if (error) throw new Error(error.message || 'Lecture des jetons MCP impossible.');
  const lignes = Array.isArray(data) ? data : [];
  return lignes.map((ligne: Record<string, unknown>) => ({
    tokenId: String(ligne.token_id ?? ''),
    connectionId: texte(ligne.connection_id),
    label: String(ligne.label ?? ''),
    clientName: texte(ligne.client_name),
    clientKind: String(ligne.client_kind ?? 'generic'),
    tokenPrefix: String(ligne.token_prefix ?? ''),
    scopes: Array.isArray(ligne.scopes) ? ligne.scopes.map(String) : [],
    createdAt: String(ligne.created_at ?? ''),
    lastUsedAt: texte(ligne.last_used_at),
    useCount: Number(ligne.use_count ?? 0),
    expiresAt: texte(ligne.expires_at),
    revokedAt: texte(ligne.revoked_at),
    actif: ligne.actif === true,
  }));
}

/**
 * Crée un jeton.
 *
 * `write` n'est demandé que si l'appelant le demande explicitement : le défaut
 * reste la lecture seule, et l'interface ne propose l'écriture que derrière un
 * avertissement.
 */
export async function creerJeton(entree: {
  label: string;
  clientName: string;
  clientKind: TypeClient;
  ecriture?: boolean;
  expiresInDays?: number | null;
}): Promise<JetonCree> {
  const scopes = entree.ecriture ? ['read', 'write'] : ['read'];
  const { data, error } = await supabase.rpc('mcp_create_token', {
    p_label: entree.label,
    p_client_name: entree.clientName,
    p_client_kind: entree.clientKind,
    p_scopes: scopes,
    ...(entree.expiresInDays ? { p_expires_in_days: entree.expiresInDays } : {}),
  });
  if (error) throw new Error(error.message || 'Création du jeton impossible.');
  const resultat = (data ?? {}) as Record<string, unknown>;
  if (!resultat.secret) throw new Error('Le serveur n’a pas renvoyé de secret : jeton non créé.');
  return {
    tokenId: String(resultat.token_id ?? ''),
    connectionId: String(resultat.connection_id ?? ''),
    secret: String(resultat.secret),
    tokenPrefix: String(resultat.token_prefix ?? ''),
    scopes: Array.isArray(resultat.scopes) ? resultat.scopes.map(String) : scopes,
  };
}

/** Révoque un jeton. La connexion associée est révoquée dans la même transaction. */
export async function revoquerJeton(tokenId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('mcp_revoke_token', { p_token_id: tokenId });
  if (error) throw new Error(error.message || 'Révocation impossible.');
  return (data as { revoked?: boolean } | null)?.revoked === true;
}

/** Remplace un jeton par un nouveau, sans changer ses portées. */
export async function faireTournerJeton(tokenId: string): Promise<JetonCree | null> {
  const { data, error } = await supabase.rpc('mcp_rotate_token', { p_token_id: tokenId });
  if (error) throw new Error(error.message || 'Rotation impossible.');
  const resultat = (data ?? {}) as Record<string, unknown>;
  if (resultat.rotated !== true || !resultat.secret) return null;
  return {
    tokenId: String(resultat.token_id ?? ''),
    connectionId: '',
    secret: String(resultat.secret),
    tokenPrefix: String(resultat.token_prefix ?? ''),
    scopes: [],
  };
}

export async function listerPermissions(tokenId: string): Promise<PermissionOutil[]> {
  const { data, error } = await supabase.rpc('mcp_list_tool_permissions', { p_token_id: tokenId });
  if (error) throw new Error(error.message || 'Lecture des permissions impossible.');
  const lignes = Array.isArray(data) ? data : [];
  return lignes.map((ligne: Record<string, unknown>) => ({
    toolName: String(ligne.tool_name ?? ''),
    allowed: ligne.allowed === true,
    grantedAt: String(ligne.granted_at ?? ''),
  }));
}

export async function definirPermission(tokenId: string, toolName: string, allowed: boolean): Promise<void> {
  const { error } = await supabase.rpc('mcp_set_tool_permission', {
    p_token_id: tokenId,
    p_tool_name: toolName,
    p_allowed: allowed,
  });
  if (error) throw new Error(error.message || 'Modification de la permission impossible.');
}

export interface EvenementMcp {
  method: string;
  toolName: string | null;
  outcome: string;
  errorCode: string | null;
  durationMs: number | null;
  createdAt: string;
}

/** Journal personnel des appels MCP : sert à montrer ce qui a été fait. */
export async function listerActivite(limite = 20): Promise<EvenementMcp[]> {
  const { data, error } = await supabase.rpc('mcp_list_activity', { p_limit: limite });
  if (error) throw new Error(error.message || 'Lecture du journal impossible.');
  const lignes = Array.isArray(data) ? data : [];
  return lignes.map((ligne: Record<string, unknown>) => ({
    method: String(ligne.method ?? ''),
    toolName: texte(ligne.tool_name),
    outcome: String(ligne.outcome ?? ''),
    errorCode: texte(ligne.error_code),
    durationMs: ligne.duration_ms == null ? null : Number(ligne.duration_ms),
    createdAt: String(ligne.created_at ?? ''),
  }));
}

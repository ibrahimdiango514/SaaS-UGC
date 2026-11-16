// VYORA MCP — section premium du dashboard.
//
// Cette page n'affiche QUE des états réels : les jetons viennent de
// `mcp_list_tokens`, le journal de `mcp_list_activity`, et l'URL du serveur est
// celle réellement déployée. Aucune intégration tierce n'est présentée comme
// connectée : `vyora_integrations_list` renvoie ce que la base contient.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity, ClipboardCheck, Copy, KeyRound, Link2, Loader2,
  Plug, RefreshCw, ShieldCheck, Sparkles, Terminal, Trash2, Wrench,
} from 'lucide-react';
import {
  Badge, Banner, Button, Card, CardHeader, ConfirmDialog, EmptyState, ErrorState,
  Input, LoadingState, Modal, PageHeader, Select, Tabs, Toggle,
} from '../components/ui';
import { useToast } from '../context/ToastContext';
import { asAppError } from '../lib/errors';
import { formatDate } from '../lib/format';
import {
  MCP_TOOLS, MCP_WRITE_TOOL, createMcpToken, listMcpActivity, listMcpTokens,
  mcpClientConfig, mcpEndpoint, revokeMcpToken, rotateMcpToken,
  type McpActivityEntry, type McpClientKind, type McpCreatedToken, type McpScope, type McpToken,
} from '../lib/mcp';

const CLIENT_KINDS: { id: McpClientKind; label: string; hint: string }[] = [
  { id: 'claude', label: 'Claude Desktop', hint: 'Claude Desktop et Claude Code' },
  { id: 'cursor', label: 'Cursor', hint: 'Cursor IDE' },
  { id: 'vscode', label: 'VS Code', hint: 'Extension MCP de VS Code' },
  { id: 'generic', label: 'Autre client', hint: 'Tout client MCP compatible HTTP' },
];

const OUTCOME_LABEL: Record<McpActivityEntry['outcome'], string> = {
  ok: 'Succès',
  denied: 'Refusé',
  error: 'Erreur',
  invalid: 'Invalide',
};

function SecretReveal({ created, onClose }: { created: McpCreatedToken; onClose: () => void }) {
  const toast = useToast();
  const [kind, setKind] = useState<McpClientKind>('claude');
  const [acknowledged, setAcknowledged] = useState(false);
  const config = useMemo(() => mcpClientConfig(created.secret, kind), [created.secret, kind]);

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${label} copié`);
    } catch {
      toast.error('Copie impossible : sélectionnez le texte manuellement.');
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Jeton créé — copiez-le maintenant"
      description="Ce secret ne sera plus jamais affiché. VYORA n’en conserve qu’une empreinte SHA-256 : il est impossible de le récupérer."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Fermer</Button>
          <Button onClick={onClose} disabled={!acknowledged}>
            <ClipboardCheck className="h-4 w-4" /> J’ai conservé mon jeton
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Banner tone="warning" title="Un seul affichage">
          Copiez ce jeton dans votre gestionnaire de secrets avant de fermer. Toute perte impose une rotation.
        </Banner>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium text-slate-300">Jeton</span>
            <Button size="sm" variant="ghost" onClick={() => copy(created.secret, 'Jeton')}>
              <Copy className="h-4 w-4" /> Copier
            </Button>
          </div>
          <pre className="overflow-x-auto rounded-xl border border-line bg-black/40 p-3 text-xs text-emerald-200">
            {created.secret}
          </pre>
        </div>

        <div>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-medium text-slate-300">Configuration du client</span>
            <div className="flex gap-1">
              {CLIENT_KINDS.map((client) => (
                <button
                  key={client.id}
                  onClick={() => setKind(client.id)}
                  className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
                    kind === client.id ? 'bg-brand-500/20 text-brand-200' : 'text-slate-400 hover:bg-white/5'
                  }`}
                >
                  {client.label}
                </button>
              ))}
            </div>
          </div>
          <pre className="max-h-56 overflow-auto rounded-xl border border-line bg-black/40 p-3 text-xs text-slate-200">
            {config}
          </pre>
          <Button size="sm" variant="ghost" className="mt-2" onClick={() => copy(config, 'Configuration')}>
            <Copy className="h-4 w-4" /> Copier la configuration
          </Button>
        </div>

        <label className="flex items-start gap-2 text-sm text-slate-300">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(event) => setAcknowledged(event.target.checked)}
            className="mt-1"
          />
          <span>J’ai copié et conservé ce jeton. Je comprends qu’il ne sera plus affiché.</span>
        </label>
      </div>
    </Modal>
  );
}

export default function Mcp() {
  const toast = useToast();
  const [tab, setTab] = useState('overview');
  const [tokens, setTokens] = useState<McpToken[]>([]);
  const [activity, setActivity] = useState<McpActivityEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [created, setCreated] = useState<McpCreatedToken | null>(null);
  const [toRevoke, setToRevoke] = useState<McpToken | null>(null);
  const [toRotate, setToRotate] = useState<McpToken | null>(null);

  const [newLabel, setNewLabel] = useState('');
  const [newClient, setNewClient] = useState<McpClientKind>('claude');
  const [newScopes, setNewScopes] = useState<McpScope[]>(['read']);
  const [newExpiry, setNewExpiry] = useState('30');

  const endpoint = mcpEndpoint();

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [tokenRows, activityRows] = await Promise.all([listMcpTokens(), listMcpActivity(50)]);
      setTokens(tokenRows);
      setActivity(activityRows);
    } catch (caught) {
      setError(asAppError(caught).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const activeTokens = tokens.filter((token) => !token.revoked);

  const create = async () => {
    if (!newLabel.trim()) {
      toast.error('Donnez un nom à ce jeton pour le reconnaître plus tard.');
      return;
    }
    setBusy('create');
    try {
      const result = await createMcpToken({
        label: newLabel,
        clientName: CLIENT_KINDS.find((client) => client.id === newClient)?.label ?? 'Client MCP',
        clientKind: newClient,
        scopes: newScopes,
        expiresInDays: newExpiry === 'never' ? null : Number(newExpiry),
      });
      setCreated(result);
      setNewLabel('');
      setNewScopes(['read']);
      await load();
      setTab('tokens');
    } catch (caught) {
      toast.error(asAppError(caught).message);
    } finally {
      setBusy(null);
    }
  };

  const revoke = async () => {
    if (!toRevoke) return;
    setBusy(toRevoke.id);
    try {
      const done = await revokeMcpToken(toRevoke.id);
      if (done) toast.success('Jeton révoqué. Il est inutilisable immédiatement.');
      else toast.error('Ce jeton n’a pas pu être révoqué.');
      setToRevoke(null);
      await load();
    } catch (caught) {
      toast.error(asAppError(caught).message);
    } finally {
      setBusy(null);
    }
  };

  const rotate = async () => {
    if (!toRotate) return;
    setBusy(toRotate.id);
    try {
      const result = await rotateMcpToken(toRotate.id);
      setToRotate(null);
      setCreated(result);
      await load();
    } catch (caught) {
      toast.error(asAppError(caught).message);
    } finally {
      setBusy(null);
    }
  };

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${label} copié`);
    } catch {
      toast.error('Copie impossible : sélectionnez le texte manuellement.');
    }
  };

  if (loading) return <LoadingState label="Chargement du serveur MCP…" />;
  if (error) return <ErrorState message={error} onRetry={() => void load()} />;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Intelligence connectée"
        title="VYORA MCP"
        description="Reliez Claude, Cursor ou VS Code à votre compte VYORA. Chaque jeton n’accède qu’à vos propres ressources."
        actions={
          <Button variant="ghost" onClick={() => void load()} disabled={loading}>
            <RefreshCw className="h-4 w-4" /> Rafraîchir
          </Button>
        }
      />

      <Tabs
        tabs={[
          { id: 'overview', label: 'Vue d’ensemble', icon: <Sparkles className="h-4 w-4" /> },
          { id: 'tokens', label: 'Jetons', icon: <KeyRound className="h-4 w-4" /> },
          { id: 'tools', label: 'Outils', icon: <Wrench className="h-4 w-4" /> },
          { id: 'activity', label: 'Activité', icon: <Activity className="h-4 w-4" /> },
          { id: 'guide', label: 'Connexion', icon: <Plug className="h-4 w-4" /> },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'overview' && (
        <div className="space-y-6">
          <div className="grid gap-4 md:grid-cols-3">
            <Card className="p-5">
              <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-slate-400">
                <Link2 className="h-4 w-4" /> URL du serveur
              </div>
              <p className="mt-2 break-all font-mono text-xs text-slate-200">{endpoint}</p>
              <Button size="sm" variant="ghost" className="mt-3" onClick={() => void copy(endpoint, 'URL')}>
                <Copy className="h-4 w-4" /> Copier
              </Button>
            </Card>
            <Card className="p-5">
              <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-slate-400">
                <KeyRound className="h-4 w-4" /> Jetons actifs
              </div>
              <p className="mt-3 text-2xl font-semibold text-white">{activeTokens.length}</p>
              <p className="mt-1 text-xs text-slate-400">
                {tokens.length} jeton{tokens.length > 1 ? 's' : ''} au total
              </p>
            </Card>
            <Card className="p-5">
              <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-slate-400">
                <ShieldCheck className="h-4 w-4" /> Transport
              </div>
              <p className="mt-3 text-sm text-white">Streamable HTTP</p>
              <p className="mt-1 text-xs text-slate-400">JSON-RPC 2.0 · réponse JSON directe</p>
            </Card>
          </div>

          <Card>
            <CardHeader
              title="Ce que le serveur expose aujourd’hui"
              description="Cinq outils en lecture seule, strictement limités à vos ressources. Aucun outil d’écriture n’est actif."
            />
            <div className="divide-y divide-line">
              {MCP_TOOLS.map((tool) => (
                <div key={tool.name} className="flex flex-wrap items-start justify-between gap-3 px-5 py-3">
                  <div>
                    <p className="font-mono text-xs text-brand-200">{tool.name}</p>
                    <p className="text-sm text-slate-300">{tool.description}</p>
                  </div>
                  <Badge tone="success">Lecture</Badge>
                </div>
              ))}
            </div>
          </Card>

          <Banner tone="info" title="Isolation vérifiée">
            Chaque appel MCP utilise l’identité du jeton présenté, jamais un identifiant fourni par le client.
            Un jeton ne peut lire que les ressources de son propriétaire.
          </Banner>
        </div>
      )}

      {tab === 'tokens' && (
        <div className="space-y-6">
          <Card>
            <CardHeader
              title="Nouveau jeton"
              description="Le secret n’est affiché qu’une seule fois. VYORA n’en conserve que l’empreinte."
            />
            <div className="grid gap-4 px-5 pb-5 md:grid-cols-2">
              <label className="block text-sm">
                <span className="mb-1 block text-slate-300">Nom du jeton</span>
                <Input
                  value={newLabel}
                  onChange={(event) => setNewLabel(event.target.value)}
                  placeholder="Ex. « Portable bureau »"
                  maxLength={80}
                />
              </label>
              <label className="block text-sm">
                <span className="mb-1 block text-slate-300">Client</span>
                <Select value={newClient} onChange={(event) => setNewClient(event.target.value as McpClientKind)}>
                  {CLIENT_KINDS.map((client) => (
                    <option key={client.id} value={client.id}>{client.hint}</option>
                  ))}
                </Select>
              </label>
              <label className="block text-sm">
                <span className="mb-1 block text-slate-300">Expiration</span>
                <Select value={newExpiry} onChange={(event) => setNewExpiry(event.target.value)}>
                  <option value="7">7 jours</option>
                  <option value="30">30 jours</option>
                  <option value="90">90 jours</option>
                  <option value="365">1 an</option>
                  <option value="never">Sans expiration</option>
                </Select>
              </label>
              <div className="text-sm">
                <span className="mb-1 block text-slate-300">Portées</span>
                <div className="flex flex-col gap-2">
                  <label className="flex items-center gap-2 text-slate-300">
                    <input type="checkbox" checked disabled />
                    <span>Lecture (toujours incluse)</span>
                  </label>
                  <Toggle
                    checked={newScopes.includes('write')}
                    onChange={(next) => setNewScopes(next ? ['read', 'write'] : ['read'])}
                    label="Écriture (indisponible tant que le serveur ne l’active pas)"
                  />
                </div>
              </div>
            </div>
            <div className="border-t border-line px-5 py-4">
              <Button onClick={() => void create()} disabled={busy === 'create'}>
                {busy === 'create' ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
                Générer le jeton
              </Button>
            </div>
          </Card>

          <Card>
            <CardHeader title="Mes jetons" description="Les secrets ne sont jamais réaffichés. Utilisez la rotation en cas de doute." />
            {tokens.length === 0 ? (
              <div className="p-5">
                <EmptyState
                  title="Aucun jeton"
                  description="Créez votre premier jeton pour connecter un client MCP."
                  icon={<KeyRound className="h-6 w-6" />}
                />
              </div>
            ) : (
              <div className="divide-y divide-line">
                {tokens.map((token) => (
                  <div key={token.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-white">{token.label}</span>
                        {token.revoked ? <Badge tone="neutral">Révoqué</Badge> : <Badge tone="success">Actif</Badge>}
                        {token.scopes.includes('write') && <Badge tone="warning">Écriture</Badge>}
                      </div>
                      <p className="mt-1 font-mono text-xs text-slate-400">{token.token_prefix}…</p>
                      <p className="mt-1 text-xs text-slate-500">
                        {token.client_name ?? 'Client MCP'} · créé le {formatDate(token.created_at)}
                        {token.last_used_at ? ` · dernier appel ${formatDate(token.last_used_at)}` : ' · jamais utilisé'}
                        {token.expires_at ? ` · expire le ${formatDate(token.expires_at)}` : ' · sans expiration'}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      {!token.revoked && (
                        <>
                          <Button size="sm" variant="ghost" onClick={() => setToRotate(token)} disabled={busy === token.id}>
                            {busy === token.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                            Rotation
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setToRevoke(token)} disabled={busy === token.id}>
                            <Trash2 className="h-4 w-4" /> Révoquer
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      )}

      {tab === 'tools' && (
        <div className="space-y-6">
          <Card>
            <CardHeader title="Outils disponibles" description="Liste alignée sur le registre du serveur déployé. Aucun outil fantôme." />
            <div className="divide-y divide-line">
              {MCP_TOOLS.map((tool) => (
                <div key={tool.name} className="px-5 py-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-mono text-sm text-brand-200">{tool.name}</p>
                    <Badge tone="success">Lecture seule</Badge>
                  </div>
                  <p className="mt-1 text-sm text-slate-300">{tool.description}</p>
                </div>
              ))}
            </div>
          </Card>

          <Card>
            <CardHeader title="Écriture — désactivée" description="Préparée, non exposée." />
            <div className="px-5 pb-5">
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
                <div>
                  <p className="font-mono text-sm text-amber-200">{MCP_WRITE_TOOL.name}</p>
                  <p className="mt-1 text-sm text-amber-100/80">{MCP_WRITE_TOOL.description}</p>
                </div>
                <Badge tone="warning">Inactif</Badge>
              </div>
              <p className="mt-3 text-xs text-slate-400">
                Cet outil n’est pas annoncé par le serveur : il ne peut donc pas être appelé, même par un jeton
                portant la portée « écriture ». Son activation exige une décision d’exploitation explicite.
              </p>
            </div>
          </Card>

          <Banner tone="info" title="Autorisations par jeton">
            Un outil peut être retiré à un jeton précis sans révoquer le jeton entier. Retirer un outil d’un jeton
            n’affecte aucun autre jeton.
          </Banner>
        </div>
      )}

      {tab === 'activity' && (
        <Card>
          <CardHeader title="Historique des appels" description="50 appels les plus récents. Aucun contenu métier n’est journalisé." />
          {activity.length === 0 ? (
            <div className="p-5">
              <EmptyState
                title="Aucun appel enregistré"
                description="Connectez un client MCP avec l’un de vos jetons pour voir l’activité apparaître."
                icon={<Activity className="h-6 w-6" />}
              />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr className="border-b border-line">
                    <th className="px-5 py-2">Horodatage</th>
                    <th className="px-5 py-2">Méthode</th>
                    <th className="px-5 py-2">Outil</th>
                    <th className="px-5 py-2">Verdict</th>
                    <th className="px-5 py-2">Jeton</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {activity.map((entry) => (
                    <tr key={entry.id}>
                      <td className="whitespace-nowrap px-5 py-2 text-slate-400">{formatDate(entry.created_at)}</td>
                      <td className="px-5 py-2 font-mono text-xs text-slate-300">{entry.method}</td>
                      <td className="px-5 py-2 font-mono text-xs text-slate-400">{entry.tool_name ?? '—'}</td>
                      <td className="px-5 py-2">
                        <Badge tone={entry.outcome === 'ok' ? 'success' : entry.outcome === 'denied' ? 'warning' : 'danger'}>
                          {OUTCOME_LABEL[entry.outcome]}
                        </Badge>
                        {entry.error_code && (
                          <span className="ml-2 font-mono text-[10px] text-slate-500">{entry.error_code}</span>
                        )}
                      </td>
                      <td className="px-5 py-2 font-mono text-xs text-slate-500">{entry.token_prefix ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {tab === 'guide' && (
        <div className="space-y-6">
          <Card>
            <CardHeader title="Connecter un client MCP" description="Trois étapes, aucun secret supplémentaire." />
            <ol className="space-y-4 px-5 pb-5 text-sm text-slate-300">
              <li className="flex gap-3">
                <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-500/20 text-xs font-semibold text-brand-200">1</span>
                <div>
                  <p className="font-medium text-white">Créez un jeton</p>
                  <p>Onglet « Jetons ». Choisissez le client et la durée. Le secret s’affiche une seule fois.</p>
                </div>
              </li>
              <li className="flex gap-3">
                <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-500/20 text-xs font-semibold text-brand-200">2</span>
                <div>
                  <p className="font-medium text-white">Déclarez le serveur dans votre client</p>
                  <p>Copiez la configuration proposée à la création. Elle contient l’URL et l’en-tête d’autorisation.</p>
                  <Button size="sm" variant="ghost" className="mt-2" onClick={() => void copy(endpoint, 'URL')}>
                    <Terminal className="h-4 w-4" /> Copier l’URL seule
                  </Button>
                </div>
              </li>
              <li className="flex gap-3">
                <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-500/20 text-xs font-semibold text-brand-200">3</span>
                <div>
                  <p className="font-medium text-white">Vérifiez dans l’onglet « Activité »</p>
                  <p>Un appel réussi apparaît en « Succès ». S’il n’apparaît pas, la connexion n’a pas abouti.</p>
                </div>
              </li>
            </ol>
          </Card>

          <Card>
            <CardHeader title="URL du serveur" description="Transport Streamable HTTP, réponse JSON directe." />
            <div className="px-5 pb-5">
              <pre className="overflow-x-auto rounded-xl border border-line bg-black/40 p-3 text-xs text-emerald-200">{endpoint}</pre>
              <p className="mt-3 text-xs text-slate-400">
                Cette URL accepte uniquement POST avec un en-tête <code className="text-slate-300">Authorization: Bearer vyora_mcp_…</code>.
                Les requêtes GET sont refusées : aucun flux SSE persistant n’est proposé.
              </p>
            </div>
          </Card>

          <Banner tone="warning" title="Ne partagez jamais un jeton">
            Un jeton donne accès à vos projets, vos générations et votre historique. En cas de doute, faites une
            rotation : l’ancien jeton cesse immédiatement de fonctionner.
          </Banner>
        </div>
      )}

      {created && <SecretReveal created={created} onClose={() => setCreated(null)} />}

      <ConfirmDialog
        open={Boolean(toRevoke)}
        title="Révoquer ce jeton ?"
        message={`« ${toRevoke?.label ?? ''} » cessera immédiatement de fonctionner. Cette action est irréversible.`}
        confirmLabel="Révoquer"
        danger
        loading={busy === toRevoke?.id}
        onConfirm={() => void revoke()}
        onClose={() => setToRevoke(null)}
      />

      <ConfirmDialog
        open={Boolean(toRotate)}
        title="Faire tourner ce jeton ?"
        message={`Un nouveau secret sera créé pour « ${toRotate?.label ?? ''} » et l’ancien sera révoqué immédiatement.`}
        confirmLabel="Faire tourner"
        loading={busy === toRotate?.id}
        onConfirm={() => void rotate()}
        onClose={() => setToRotate(null)}
      />
    </div>
  );
}

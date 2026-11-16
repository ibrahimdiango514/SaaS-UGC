// VYORA Connect — gestion des comptes externes.
//
// ## Ce que cette page garantit
// - Aucun état n'est simulé. Chaque fournisseur affiche son état réel, calculé
//   depuis la réponse de l'Edge Function `vyora-oauth` (action `status`), qui
//   seule lit l'environnement où vivent les secrets.
// - Aucun secret n'entre dans le navigateur. On ne demande jamais
//   `GOOGLE_CLIENT_SECRET` ni aucun jeton : la page ouvre une URL fournie par le
//   serveur et ne voit jamais les jetons qui en reviennent.
// - Aucune permission n'est supposée accordée. Les capacités affichées sur un
//   compte sont celles réellement renvoyées par Google, pas celles demandées.
// - L'isolation est celle de la base : toutes les lectures passent par des RPC
//   bornées par `auth.uid()`. Un utilisateur ne peut pas lister, révoquer ni
//   rafraîchir le compte d'un autre — la page ne le pourrait pas même en
//   forgeant un identifiant.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { History, Link2, RefreshCw, ShieldCheck, Unplug } from 'lucide-react';
import { PageHeader, StatCard, cn } from '../components/ui';
import {
  ConnectError,
  clearPendingAuthorization,
  fetchAuditEvents,
  fetchConnectedAccounts,
  fetchProviderAvailability,
  humanizeConnectError,
  readPendingAuthorization,
  refreshAccount,
  rememberPendingAuthorization,
  revokeAccount,
  startAuthorization,
  type AuditEvent,
  type ConnectedAccount,
  type ProviderAvailability,
} from '../integrations/connect-api';
import {
  buildProviderCard,
  groupProviders,
  providerById,
  toAccountView,
  toAuditView,
  type ConnectedAccountView,
  type OAuthCapability,
  type ProviderCardViewModel,
} from '../integrations/providers';
import {
  CapabilityPicker,
  ConnectedAccountCard,
  ProviderCard,
} from '../integrations/components';
import { formatDate, relativeDate } from '../lib/format';

type LoadState = 'loading' | 'ready' | 'error';

export default function Connect() {
  const [availability, setAvailability] = useState<ProviderAvailability | null>(null);
  const [accounts, setAccounts] = useState<ConnectedAccount[]>([]);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [state, setState] = useState<LoadState>('loading');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Fournisseur en cours de connexion, et permissions choisies.
  const [connecting, setConnecting] = useState<string | null>(null);
  const [selected, setSelected] = useState<OAuthCapability[]>(['read']);
  const [busyAccount, setBusyAccount] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<ConnectedAccountView | null>(null);

  const load = useCallback(async () => {
    setState('loading');
    setError(null);
    try {
      const [config, nextAccounts, nextEvents] = await Promise.all([
        fetchProviderAvailability(),
        fetchConnectedAccounts(),
        fetchAuditEvents(50),
      ]);
      setAvailability(config);
      setAccounts(nextAccounts);
      setEvents(nextEvents);
      setState('ready');
    } catch (cause) {
      setState('error');
      setError(
        cause instanceof ConnectError
          ? cause.message
          : humanizeConnectError(undefined, 'Les intégrations n’ont pas pu être chargées.'),
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Au retour du fournisseur, on signale explicitement ce qui vient de se passer.
  // Le résultat définitif reste celui de la base : on recharge la liste.
  useEffect(() => {
    const pending = readPendingAuthorization();
    if (!pending) return;
    clearPendingAuthorization();
    const name = pending.provider;
    setNotice(
      `Retour de ${name}. Si l’autorisation a été accordée, le compte apparaît ci-dessous ; sinon, aucun accès n’a été enregistré.`,
    );
    void load();
  }, [load]);

  const cards: ProviderCardViewModel[] = useMemo(() => {
    // Tant que la configuration n'est pas connue, on ne promet RIEN : tout est
    // considéré comme non configuré. Un bouton ne s'active jamais par défaut.
    const google = availability?.google === true;
    // `providerById` renvoie `undefined` pour un identifiant inconnu : on
    // filtre plutôt que de lever, pour qu'une entrée retirée du registre ne
    // casse pas toute la page.
    const ids = [
      'gmail', 'google_drive', 'google_calendar',
      'instagram', 'facebook', 'tiktok', 'youtube', 'whatsapp_business',
    ];
    return ids
      .map((id) => providerById(id))
      .filter((provider): provider is NonNullable<typeof provider> => Boolean(provider))
      .map((provider) => buildProviderCard(provider, provider.group === 'google' ? google : false));
  }, [availability]);

  const accountViews = useMemo(
    () => accounts.map((account) => toAccountView(account, relativeDate, formatDate)),
    [accounts],
  );
  const eventViews = useMemo(
    () => events.map((event) => toAuditView(event, relativeDate)),
    [events],
  );

  async function handleConnect(card: ProviderCardViewModel) {
    if (!card.provider.providerKey) return;
    setConnecting(card.provider.id);
    setNotice(null);
    setError(null);
    try {
      const result = await startAuthorization(card.provider.providerKey, selected);
      // Aide-mémoire local uniquement : sert à afficher un message au retour.
      rememberPendingAuthorization({
        provider: card.provider.providerKey,
        capabilities: result.capabilities,
        startedAt: Date.now(),
      });
      window.location.assign(result.authorization_url);
    } catch (cause) {
      setConnecting(null);
      setError(
        cause instanceof ConnectError
          ? cause.message
          : humanizeConnectError(undefined, 'La connexion n’a pas pu démarrer.'),
      );
    }
  }

  async function handleRevoke(account: ConnectedAccountView) {
    setBusyAccount(account.id);
    setError(null);
    try {
      const result = await revokeAccount(account.id);
      setNotice(
        result.remoteRevoked
          ? `${account.providerName} a été déconnecté et l’autorisation a été révoquée chez le fournisseur.`
          : `${account.providerName} a été déconnecté. La révocation côté fournisseur n’a pas été confirmée : l’accès n’est plus utilisable depuis VYORA.`,
      );
      setConfirmRevoke(null);
      await load();
    } catch (cause) {
      setError(
        cause instanceof ConnectError
          ? cause.message
          : humanizeConnectError(undefined, 'La déconnexion a échoué.'),
      );
    } finally {
      setBusyAccount(null);
    }
  }

  async function handleRefresh(account: ConnectedAccountView) {
    setBusyAccount(account.id);
    setError(null);
    try {
      await refreshAccount(account.id);
      setNotice(`L’autorisation de ${account.providerName} a été renouvelée.`);
      await load();
    } catch (cause) {
      setError(
        cause instanceof ConnectError
          ? cause.message
          : humanizeConnectError(undefined, 'Le renouvellement a échoué.'),
      );
    } finally {
      setBusyAccount(null);
    }
  }

  const configuredCount = cards.filter((card) => card.status === 'ready').length;
  const activeCount = accountViews.filter((account) => account.status === 'connected').length;
  const problemCount = eventViews.filter((event) => event.tone === 'danger').length;
  const sections = groupProviders(cards);

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="VYORA Connect"
        title="Comptes et intégrations"
        description="Connectez vos comptes externes avec des permissions précises, révocables à tout moment. VYORA ne lit que ce que vous autorisez explicitement."
        actions={
          <button
            type="button"
            onClick={() => void load()}
            className="inline-flex items-center gap-2 rounded-xl border border-white/15 px-3.5 py-2 text-sm font-semibold text-white transition hover:border-white/30"
          >
            <RefreshCw size={15} className={state === 'loading' ? 'animate-spin' : undefined} />
            Actualiser
          </button>
        }
      />

      {error && (
        <div role="alert" className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
          {error}
        </div>
      )}
      {notice && (
        <div role="status" className="rounded-xl border border-brand-400/30 bg-brand-400/10 px-4 py-3 text-sm text-brand-100">
          {notice}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Fournisseurs disponibles" value={configuredCount} icon={<Link2 size={18} />} tone="cyan" />
        <StatCard label="Comptes connectés" value={activeCount} icon={<ShieldCheck size={18} />} tone="emerald" />
        <StatCard label="Événements en erreur" value={problemCount} icon={<History size={18} />} tone="amber" />
      </div>

      {/* --------------------------- Comptes connectés -------------------- */}
      <section aria-labelledby="comptes-connectes" className="space-y-3">
        <div>
          <h2 id="comptes-connectes" className="text-lg font-semibold text-white">
            Vos comptes connectés
          </h2>
          <p className="mt-1 text-sm text-slate-400">
            Les permissions affichées sont celles que le fournisseur a réellement accordées,
            pas celles qui ont été demandées.
          </p>
        </div>

        {state === 'loading' && accounts.length === 0 ? (
          <div className="rounded-2xl border border-white/10 bg-white/[0.02] px-4 py-8 text-center text-sm text-slate-400">
            Chargement de vos comptes…
          </div>
        ) : accountViews.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-white/10 px-4 py-10 text-center">
            <Unplug className="mx-auto mb-3 text-slate-500" size={24} />
            <p className="text-sm font-medium text-white">Aucun compte connecté</p>
            <p className="mx-auto mt-1 max-w-md text-sm text-slate-400">
              Rien n’est connecté pour l’instant. Choisissez un fournisseur disponible ci-dessous
              pour démarrer une autorisation.
            </p>
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {accountViews.map((account) => (
              <ConnectedAccountCard
                key={account.id}
                account={account}
                busy={busyAccount === account.id}
                onRevoke={() => setConfirmRevoke(account)}
                onRefresh={() => void handleRefresh(account)}
              />
            ))}
          </div>
        )}
      </section>

      {/* ------------------------- Permissions --------------------------- */}
      <section aria-labelledby="permissions" className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
        <h2 id="permissions" className="text-lg font-semibold text-white">
          Permissions pour la prochaine connexion
        </h2>
        <p className="mt-1 mb-4 max-w-2xl text-sm text-slate-400">
          Chaque permission est indépendante : autoriser la rédaction de brouillons ne permet
          jamais l’envoi. Vous pouvez ne cocher que ce dont vous avez besoin.
        </p>
        <div className="max-w-xl">
          <CapabilityPicker
            available={['read', 'draft', 'send', 'modify']}
            selected={selected}
            onChange={setSelected}
            disabled={connecting !== null}
          />
        </div>
        {selected.length === 0 && (
          <p className="mt-3 text-xs text-amber-300">
            Au moins une permission est nécessaire. Sans sélection, la lecture seule sera demandée.
          </p>
        )}
      </section>

      {/* ------------------------- Fournisseurs -------------------------- */}
      {sections.map((section) => (
        <section key={section.group} aria-labelledby={`groupe-${section.group}`} className="space-y-3">
          <h2 id={`groupe-${section.group}`} className="text-lg font-semibold text-white">
            {section.label}
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {section.items.map((card) => (
              <ProviderCard
                key={card.provider.id}
                card={card}
                connecting={connecting === card.provider.id}
                onConnect={() => void handleConnect(card)}
              />
            ))}
          </div>
        </section>
      ))}

      {/* ---------------------------- Journal ---------------------------- */}
      <section aria-labelledby="journal" className="space-y-3">
        <div>
          <h2 id="journal" className="text-lg font-semibold text-white">
            Historique des événements
          </h2>
          <p className="mt-1 text-sm text-slate-400">
            Connexions, renouvellements, déconnexions et refus. Ces traces sont conservées côté
            serveur et ne peuvent pas être modifiées depuis l’interface.
          </p>
        </div>

        {eventViews.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-white/10 px-4 py-8 text-center text-sm text-slate-400">
            Aucun événement enregistré pour l’instant.
          </div>
        ) : (
          <ul className="divide-y divide-white/5 overflow-hidden rounded-2xl border border-white/10 bg-white/[0.02]">
            {eventViews.map((event) => (
              <li key={event.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm">
                <span className="w-40 shrink-0 text-xs text-slate-500">{event.dateLabel}</span>
                <span className="font-medium text-white">{event.actionLabel}</span>
                {event.providerName && <span className="text-slate-400">· {event.providerName}</span>}
                {event.capabilityLabel && <span className="text-slate-500">({event.capabilityLabel})</span>}
                {event.detail && <span className="text-xs text-slate-500">{event.detail}</span>}
                <span
                  className={cn(
                    'ml-auto rounded-md px-2 py-0.5 text-[11px] font-semibold',
                    event.tone === 'danger' && 'bg-rose-500/10 text-rose-300',
                    event.tone === 'warning' && 'bg-amber-500/10 text-amber-300',
                    event.tone === 'success' && 'bg-emerald-500/10 text-emerald-300',
                    event.tone === 'neutral' && 'bg-white/5 text-slate-300',
                  )}
                >
                  {event.tone === 'danger' ? 'erreur' : event.tone === 'warning' ? 'attention' : event.tone === 'success' ? 'réussi' : 'info'}
                </span>
              </li>
            ))}
          </ul>
        )}

        <p className="text-xs text-slate-500">
          Les intégrations connectées seront exposées comme outils MCP dans votre espace
          développeur, une fois les autorisations accordées.{' '}
          <Link to="/app/settings" className="text-brand-300 underline-offset-2 hover:underline">
            Voir les paramètres
          </Link>
          .
        </p>
      </section>

      {/* ----------------------- Confirmation révocation ----------------- */}
      {confirmRevoke && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirmation-titre"
          className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4"
        >
          <div className="w-full max-w-md space-y-4 rounded-2xl border border-white/10 bg-slate-900 p-6">
            <h2 id="confirmation-titre" className="text-lg font-semibold text-white">
              Déconnecter {confirmRevoke.providerName} ?
            </h2>
            <p className="text-sm text-slate-400">
              L’autorisation sera révoquée chez le fournisseur puis les jetons chiffrés seront
              effacés de nos serveurs. VYORA perdra immédiatement l’accès. Vous pourrez reconnecter
              ce compte à tout moment.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmRevoke(null)}
                className="rounded-lg border border-white/15 px-3.5 py-2 text-sm font-semibold text-white transition hover:border-white/30"
              >
                Annuler
              </button>
              <button
                type="button"
                onClick={() => void handleRevoke(confirmRevoke)}
                disabled={busyAccount === confirmRevoke.id}
                className="rounded-lg bg-rose-500 px-3.5 py-2 text-sm font-semibold text-white transition hover:bg-rose-400 disabled:opacity-50"
              >
                {busyAccount === confirmRevoke.id ? 'Déconnexion…' : 'Déconnecter'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

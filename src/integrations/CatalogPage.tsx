import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertCircle, AlertTriangle, ArrowLeft, Check, Clock, ExternalLink, Filter, Plug, RefreshCw,
  Search, ShieldAlert, ShieldCheck, Unplug, X,
} from 'lucide-react';
import {
  CATEGORY_DESCRIPTIONS, CATEGORY_LABELS, CAPABILITY_LABELS, INTEGRATIONS,
  countByCategory, searchIntegrations,
  type CatalogCategory, type IntegrationEntry,
} from './catalog';
import {
  STATUS_LABELS, STATUS_TONE, type ConnectedAccount, type IntegrationStatus,
  accountFor, canConnect, deriveStatus, listAudit, listConnectedAccounts, missingCapabilities,
  revokeConnection, summarize, type AuditEntry,
} from './connections';
import { Badge, Button, Card, cn } from '../components/ui';
import '../ai/assistant.css';

/**
 * VYORA Integrations — catalogue.
 *
 * ## Règle appliquée partout : l'état vient de la base
 *
 * Aucun badge « Connecté » n'est écrit à la main. Tous découlent de
 * `deriveStatus()`, qui lit `oauth_list_accounts()`. Si la lecture échoue,
 * l'écran l'affiche et n'invente aucun état.
 *
 * ## Ce que l'utilisateur peut faire aujourd'hui
 *
 * - parcourir, rechercher et filtrer le catalogue ;
 * - voir les capacités et permissions exigées par chaque fournisseur ;
 * - voir ses comptes réellement connectés (Google, via le socle déployé) ;
 * - révoquer une connexion, avec confirmation et retour du résultat distant.
 *
 * ## Ce qu'il ne peut pas faire encore
 *
 * Connecter un nouveau fournisseur : aucun connecteur n'est écrit (Livraison 3).
 * Les fiches concernées affichent « Configuration requise » ou « Validation
 * externe requise », et le bouton est désactivé avec l'explication.
 */
export default function CatalogPage() {
  const [accounts, setAccounts] = useState<ConnectedAccount[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [erreur, setErreur] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [categorie, setCategorie] = useState<CatalogCategory | 'all'>('all');
  const [selection, setSelection] = useState<IntegrationEntry | null>(null);
  const [confirmation, setConfirmation] = useState<ConnectedAccount | null>(null);
  const [enCours, setEnCours] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const charger = useCallback(async () => {
    setLoading(true);
    try {
      const [comptes, journal] = await Promise.all([listConnectedAccounts(), listAudit(30)]);
      setAccounts(comptes);
      setAudit(journal);
      setErreur(null);
    } catch (e) {
      setAccounts([]);
      setAudit([]);
      setErreur(e instanceof Error ? e.message : 'Lecture des connexions impossible.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void charger();
  }, [charger]);

  const resultats = useMemo(
    () => searchIntegrations(INTEGRATIONS, query, categorie),
    [query, categorie],
  );

  const compte = useMemo(() => summarize(INTEGRATIONS, accounts), [accounts]);
  const parCategorie = useMemo(() => countByCategory(), []);

  const revoquer = async (compteCible: ConnectedAccount) => {
    setEnCours(true);
    try {
      const { remoteRevoked } = await revokeConnection(compteCible.id);
      setMessage(
        remoteRevoked
          ? 'Connexion révoquée chez le fournisseur et dans VYORA.'
          : 'Connexion désactivée dans VYORA. Le fournisseur n’a pas confirmé la révocation distante : révoquez aussi depuis votre compte si nécessaire.',
      );
      setConfirmation(null);
      await charger();
    } catch (e) {
      setMessage(`Révocation impossible : ${e instanceof Error ? e.message : 'erreur inconnue'}`);
    } finally {
      setEnCours(false);
    }
  };

  return (
    <div className="vy-ambient min-h-[100dvh] bg-ink">
      <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
        {/* En-tête */}
        <header className="mb-6">
          <Link
            to="/app/ai"
            className="mb-3 inline-flex items-center gap-1.5 text-xs text-slate-400 transition hover:text-white"
          >
            <ArrowLeft size={13} />
            Retour à l’assistant
          </Link>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-2 rounded-full border border-brand-400/25 bg-brand-500/10 px-3 py-1 text-[0.7rem] text-brand-200">
              <Plug size={13} />
              VYORA Integrations
            </span>
            {!loading && !erreur && (
              <span className="text-[0.7rem] text-slate-500">
                {compte.connected} connectée{compte.connected > 1 ? 's' : ''} · {INTEGRATIONS.length} disponibles au catalogue
              </span>
            )}
          </div>

          <h1 className="font-display text-2xl font-semibold tracking-tight text-white sm:text-3xl">
            Connectez vos outils à VYORA
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-400">
            Chaque fiche indique ce que la connexion permettra réellement, les
            permissions demandées et l’état actuel. Aucun accès n’est simulé :
            un fournisseur sans connecteur affiche son prérequis.
          </p>
        </header>

        {erreur && (
          <div className="mb-5 flex items-start gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3.5 py-3 text-sm text-amber-100">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            <div className="flex-1">
              <p className="font-medium">Impossible de lire vos connexions</p>
              <p className="mt-0.5 text-xs text-amber-200/80">{erreur}</p>
              <p className="mt-1 text-xs text-amber-200/60">
                Les fiches ci-dessous reflètent uniquement le catalogue. Aucun état de connexion n’est affiché.
              </p>
            </div>
            <Button variant="ghost" size="sm" onClick={() => void charger()} icon={<RefreshCw size={14} />}>
              Réessayer
            </Button>
          </div>
        )}

        {message && (
          <div className="mb-5 flex items-start gap-2 rounded-xl border border-brand-400/25 bg-brand-500/10 px-3.5 py-2.5 text-xs text-brand-100">
            <Check size={14} className="mt-0.5 shrink-0" />
            <span className="flex-1">{message}</span>
            <button type="button" onClick={() => setMessage(null)} aria-label="Masquer">
              <X size={13} />
            </button>
          </div>
        )}

        {/* Comptes connectés */}
        {accounts.length > 0 && (
          <section className="mb-7">
            <h2 className="mb-2.5 text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
              Vos connexions actives
            </h2>
            <div className="grid gap-2.5 sm:grid-cols-2">
              {accounts.map((compteActif) => (
                <Card key={compteActif.id} className="flex items-start gap-3 p-3.5">
                  <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-300">
                    <ShieldCheck size={15} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-white">
                      {compteActif.displayName || compteActif.email || compteActif.provider}
                    </p>
                    <p className="truncate text-[0.7rem] text-slate-500">
                      {compteActif.email || compteActif.provider}
                      {compteActif.capabilities.length > 0 && ` · ${compteActif.capabilities.length} permission(s)`}
                    </p>
                  </div>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => setConfirmation(compteActif)}
                    icon={<Unplug size={13} />}
                  >
                    Révoquer
                  </Button>
                </Card>
              ))}
            </div>
          </section>
        )}

        {/* Recherche + filtres */}
        <div className="mb-4 flex flex-col gap-2.5 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Rechercher un outil, une capacité… (ex. stocks, publier, commandes)"
              aria-label="Rechercher une intégration"
              className="w-full rounded-xl border border-line bg-white/[0.04] py-2.5 pl-9 pr-3 text-sm text-white placeholder:text-slate-500 outline-none transition focus:border-brand-400/50 focus:bg-white/[0.06]"
            />
          </div>
          <span className="text-[0.7rem] text-slate-500">
            {resultats.length} résultat{resultats.length > 1 ? 's' : ''}
          </span>
        </div>

        <div className="mb-5 flex flex-wrap gap-1.5">
          <Filtre actif={categorie === 'all'} onClick={() => setCategorie('all')} icon={<Filter size={12} />}>
            Tout ({INTEGRATIONS.length})
          </Filtre>
          {(Object.keys(CATEGORY_LABELS) as CatalogCategory[]).map((cat) => (
            <Filtre
              key={cat}
              actif={categorie === cat}
              onClick={() => setCategorie(cat)}
            >
              <span title={CATEGORY_DESCRIPTIONS[cat]}>{CATEGORY_LABELS[cat]} ({parCategorie[cat]})</span>
            </Filtre>
          ))}
        </div>

        {/* Grille */}
        {loading ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-busy="true">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="h-32 animate-pulse rounded-2xl border border-line bg-white/[0.03]" />
            ))}
          </div>
        ) : resultats.length === 0 ? (
          <div className="rounded-2xl border border-line bg-white/[0.02] px-6 py-10 text-center">
            <p className="text-sm text-slate-400">Aucune intégration ne correspond à cette recherche.</p>
            <Button variant="ghost" size="sm" className="mt-3" onClick={() => { setQuery(''); setCategorie('all'); }}>
              Réinitialiser les filtres
            </Button>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {resultats.map((entry) => (
              <Carte
                key={entry.id}
                entry={entry}
                accounts={accounts}
                onOpen={() => setSelection(entry)}
              />
            ))}
          </div>
        )}

        {/* Journal */}
        {audit.length > 0 && (
          <section className="mt-9">
            <h2 className="mb-2.5 text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
              Journal des actions
            </h2>
            <Card className="divide-y divide-line/60">
              {audit.slice(0, 12).map((ligne) => (
                <div key={ligne.id} className="flex items-center gap-3 px-4 py-2.5 text-xs">
                  <Clock size={12} className="shrink-0 text-slate-600" />
                  <span className="shrink-0 text-slate-500">{formaterDate(ligne.createdAt)}</span>
                  <span className="font-medium text-slate-300">{ligne.action}</span>
                  {ligne.provider && <span className="text-slate-500">· {ligne.provider}</span>}
                  {ligne.detail && <span className="truncate text-slate-600">· {ligne.detail}</span>}
                  <span className="ml-auto shrink-0">
                    <Badge tone={ligne.outcome === 'ok' ? 'success' : 'danger'}>{ligne.outcome}</Badge>
                  </span>
                </div>
              ))}
            </Card>
          </section>
        )}
      </div>

      {/* Fiche détaillée */}
      {selection && (
        <FicheDetail
          entry={selection}
          accounts={accounts}
          onClose={() => setSelection(null)}
          onRevoke={(compteCible) => setConfirmation(compteCible)}
        />
      )}

      {/* Confirmation de révocation */}
      {confirmation && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4 backdrop-blur-sm" role="dialog" aria-modal="true">
          <Card className="w-full max-w-md p-5">
            <h3 className="font-display text-base font-semibold text-white">Révoquer cette connexion ?</h3>
            <p className="mt-2 text-sm leading-relaxed text-slate-400">
              VYORA cessera d’utiliser <strong className="text-slate-200">{confirmation.displayName || confirmation.email || confirmation.provider}</strong>.
              Une tentative de révocation sera faite chez le fournisseur. Vos données déjà importées ne sont pas supprimées.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setConfirmation(null)} disabled={enCours}>
                Annuler
              </Button>
              <Button variant="danger" size="sm" loading={enCours} onClick={() => void revoquer(confirmation)}>
                Révoquer
              </Button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

/* ------------------------------- sous-vues -------------------------------- */

function Filtre({
  actif, onClick, children, icon,
}: { actif: boolean; onClick: () => void; children: React.ReactNode; icon?: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={actif}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition',
        actif
          ? 'border-brand-400/50 bg-brand-500/15 text-brand-100'
          : 'border-line bg-white/[0.03] text-slate-400 hover:border-white/20 hover:text-slate-200',
      )}
    >
      {icon}
      {children}
    </button>
  );
}

function Carte({
  entry, accounts, onOpen,
}: { entry: IntegrationEntry; accounts: ConnectedAccount[]; onOpen: () => void }) {
  const statut = deriveStatus(entry, accounts, entry.engine !== null);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex flex-col rounded-2xl border border-line bg-panel/60 p-4 text-left transition hover:border-brand-400/35 hover:bg-panel/80"
      data-testid={`integration-${entry.id}`}
    >
      <div className="flex items-start gap-2.5">
        <Logo entry={entry} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-white">{entry.name}</p>
          <p className="text-[0.68rem] text-slate-500">{CATEGORY_LABELS[entry.category]}</p>
        </div>
        <Badge tone={STATUS_TONE[statut]}>{STATUS_LABELS[statut]}</Badge>
      </div>
      <p className="mt-2.5 line-clamp-2 text-xs leading-relaxed text-slate-400">{entry.description}</p>
      <div className="mt-2.5 flex flex-wrap gap-1">
        {entry.capabilities.slice(0, 3).map((c) => (
          <span key={c} className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[0.62rem] text-slate-400">
            {CAPABILITY_LABELS[c]}
          </span>
        ))}
        {entry.capabilities.length > 3 && (
          <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[0.62rem] text-slate-500">
            +{entry.capabilities.length - 3}
          </span>
        )}
      </div>
    </button>
  );
}

function Logo({ entry }: { entry: IntegrationEntry }) {
  // Initiales colorées plutôt que des logos tiers : aucune dépendance, aucune
  // image à charger, et aucune ambiguïté sur une marque non autorisée.
  const teinte: Record<CatalogCategory, string> = {
    social: 'from-sky-400/25 to-cyan-500/15 text-sky-200',
    commerce: 'from-emerald-400/25 to-teal-500/15 text-emerald-200',
    productivity: 'from-amber-400/25 to-orange-500/15 text-amber-200',
    business: 'from-violet-400/25 to-fuchsia-500/15 text-violet-200',
  };
  const initiales = entry.name.split(/[\s/]+/).map((m) => m[0]).join('').slice(0, 2).toUpperCase();
  return (
    <span
      className={cn(
        'flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br text-[0.7rem] font-bold',
        teinte[entry.category],
      )}
      aria-hidden="true"
    >
      {initiales}
    </span>
  );
}

function FicheDetail({
  entry, accounts, onClose, onRevoke,
}: {
  entry: IntegrationEntry;
  accounts: ConnectedAccount[];
  onClose: () => void;
  onRevoke: (compte: ConnectedAccount) => void;
}) {
  const statut = deriveStatus(entry, accounts, entry.engine !== null);
  const compte = accountFor(entry, accounts);
  const connectable = canConnect(entry, statut);
  const manquantes = missingCapabilities(entry, compte);

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/70 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label={`Fiche ${entry.name}`}>
      <button type="button" className="flex-1 cursor-default" aria-label="Fermer" onClick={onClose} />
      <div className="vy-scroll h-full w-full max-w-lg overflow-y-auto border-l border-line bg-ink px-5 py-6">
        <div className="mb-4 flex items-start gap-3">
          <button type="button" onClick={onClose} className="btn btn-ghost btn-sm h-9 w-9 p-0" aria-label="Retour">
            <ArrowLeft size={16} />
          </button>
          <Logo entry={entry} />
          <div className="min-w-0 flex-1">
            <h2 className="truncate font-display text-lg font-semibold text-white">{entry.name}</h2>
            <p className="text-[0.7rem] text-slate-500">{CATEGORY_LABELS[entry.category]}</p>
          </div>
          <Badge tone={STATUS_TONE[statut]}>{STATUS_LABELS[statut]}</Badge>
        </div>

        <p className="text-sm leading-relaxed text-slate-300">{entry.description}</p>

        {entry.caveat && (
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            <span>{entry.caveat}</span>
          </div>
        )}

        {/* Compte réel */}
        {compte && (
          <section className="mt-5 rounded-xl border border-emerald-500/25 bg-emerald-500/[0.07] p-3.5">
            <p className="flex items-center gap-1.5 text-xs font-semibold text-emerald-200">
              <ShieldCheck size={13} /> Compte connecté
            </p>
            <p className="mt-1 text-sm text-white">{compte.displayName || compte.email || compte.provider}</p>
            {compte.email && compte.displayName && <p className="text-[0.7rem] text-slate-400">{compte.email}</p>}
            <p className="mt-1 text-[0.7rem] text-slate-400">
              Permissions réellement accordées : {compte.capabilities.length > 0 ? compte.capabilities.join(', ') : 'aucune enregistrée'}
            </p>
            {compte.lastVerifiedAt && (
              <p className="text-[0.68rem] text-slate-500">Vérifié le {formaterDate(compte.lastVerifiedAt)}</p>
            )}
            <Button variant="danger" size="sm" className="mt-2.5" onClick={() => onRevoke(compte)} icon={<Unplug size={13} />}>
              Révoquer l’accès
            </Button>
          </section>
        )}

        {/* Capacités */}
        <section className="mt-5">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
            Ce que la connexion permettra
          </h3>
          <ul className="space-y-1.5">
            {entry.capabilities.map((c) => {
              const manquante = manquantes.includes(c);
              return (
                <li key={c} className="flex items-start gap-2 text-xs text-slate-300">
                  {manquante ? (
                    <AlertCircle size={13} className="mt-0.5 shrink-0 text-amber-400" />
                  ) : (
                    <Check size={13} className="mt-0.5 shrink-0 text-brand-300" />
                  )}
                  <span className={manquante ? 'text-amber-200/90' : undefined}>
                    {CAPABILITY_LABELS[c]}
                    {manquante && <span className="text-amber-400/80"> — non accordée par le compte</span>}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>

        {/* Permissions / modes */}
        <section className="mt-5">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
            Connexion et permissions
          </h3>
          <ul className="space-y-2">
            {entry.auth.map((mode, i) => (
              <li key={`${mode.mode}-${i}`} className="rounded-lg border border-line bg-white/[0.03] px-3 py-2">
                <p className="flex items-center gap-1.5 text-xs font-medium text-slate-200">
                  <ModeIcon mode={mode.mode} />
                  {libelleMode(mode.mode)}
                </p>
                <p className="mt-0.5 text-[0.7rem] leading-relaxed text-slate-400">{mode.label}</p>
                {mode.externalApproval && (
                  <p className="mt-1 flex items-start gap-1 text-[0.68rem] text-amber-300/90">
                    <ShieldAlert size={11} className="mt-0.5 shrink-0" />
                    {mode.externalApproval}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </section>

        {/* Action */}
        <section className="mt-5">
          {connectable ? (
            <ConnectButton entry={entry} />
          ) : (
            <div className="rounded-lg border border-line bg-white/[0.03] px-3.5 py-3 text-xs leading-relaxed text-slate-400">
              {expliquerIndisponibilite(statut, entry)}
            </div>
          )}
        </section>

        {entry.docsUrl && (
          <a
            href={entry.docsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-4 inline-flex items-center gap-1.5 text-xs text-brand-300 underline underline-offset-2"
          >
            Documentation officielle <ExternalLink size={11} />
          </a>
        )}
      </div>
    </div>
  );
}

function ConnectButton({ entry }: { entry: IntegrationEntry }) {
  return (
    <Button
      variant="primary"
      size="sm"
      onClick={() => {
        // Volontairement inactif tant que le moteur (Livraison 3) n'existe pas.
        // Aucune redirection factice vers un fournisseur.
        window.alert(`Le connecteur ${entry.name} sera activé avec le moteur d’intégration (Livraison 3). Aucune connexion n’est simulée.`);
      }}
      icon={<Plug size={14} />}
    >
      Connecter {entry.name}
    </Button>
  );
}

/** Message honnête expliquant pourquoi le bouton n'est pas actif. */
export function expliquerIndisponibilite(statut: IntegrationStatus, entry: IntegrationEntry): string {
  switch (statut) {
    case 'needs_approval':
      return `Ce fournisseur exige une validation de son côté (${entry.auth.find((a) => a.externalApproval)?.externalApproval ?? 'approbation du fournisseur'}). VYORA ne peut pas contourner cette étape : la connexion sera proposée une fois l’approbation obtenue.`;
    case 'needs_config':
      return 'Les identifiants VYORA pour ce fournisseur ne sont pas encore configurés côté serveur. Le moteur d’intégration les ajoutera en Livraison 3.';
    case 'unavailable':
      return 'Aucun mode de connexion légal n’est disponible pour ce fournisseur actuellement.';
    default:
      return 'La connexion n’est pas disponible pour le moment.';
  }
}

function ModeIcon({ mode }: { mode: string }) {
  if (mode === 'oauth2') return <ShieldCheck size={11} className="text-brand-300" />;
  if (mode === 'api-key') return <ShieldAlert size={11} className="text-amber-300" />;
  return <Plug size={11} className="text-slate-400" />;
}

function libelleMode(mode: string): string {
  const libelles: Record<string, string> = {
    oauth2: 'OAuth 2.0',
    'api-key': 'Clé API',
    'app-install': 'Installation d’application',
    'public-catalog': 'Catalogue public',
    'file-import': 'Import de fichier',
    none: 'Aucune connexion',
  };
  return libelles[mode] ?? mode;
}

function formaterDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

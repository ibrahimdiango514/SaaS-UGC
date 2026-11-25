import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertCircle, AlertTriangle, ArrowLeft, ArrowRight, Check, Clock, ExternalLink, Filter, Lock, Plug, RefreshCw,
  Search, ShieldAlert, ShieldCheck, Unplug, X,
} from 'lucide-react';
import {
  CATEGORY_DESCRIPTIONS, CATEGORY_LABELS, CAPABILITY_LABELS, INTEGRATIONS,
  countByCategory, searchIntegrations,
  type CatalogCategory, type IntegrationEntry,
} from './catalog';
import {
  STATUS_LABELS, STATUS_TONE, type ConnectedAccount, type IntegrationStatus,
  accountFor, canCancelRequest, canConnect, canRequestActivation, deriveStatus, listActivationRequests,
  listAudit, listConnectedAccounts, missingCapabilities, normalizeProvider, revokeConnection,
  summarize, toActivationRequests, type AuditEntry,
} from './connections';
import { businessGrowApi, subscriptionRefusalOf, type BusinessIntegrationConnection } from '../business/api';
import { SUBSCRIPTION_PATH, accessGuidance, type ImportAccessReason } from '../business/import-connect/access';
import { useAuth } from '../context/AuthContext';
import { Badge, Button, Card, cn } from '../components/ui';
import { ConnectorConnectForm } from './ConnectorConnectForm';
import { MesBoutiquesConnectees, type BoutiquesAccess } from './MesBoutiquesConnectees';
import { CustomApiConnectForm } from './CustomApiConnectForm';
import { hasConnectFlow } from '../business/importer/connector-requirements';
import '../ai/assistant.css';

/**
 * SORAHNEX Integrations — catalogue.
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
 *//** Refus d'abonnement tel que transporté par `subscriptionRefusalOf`. */
export type SubscriptionRefusal = NonNullable<ReturnType<typeof subscriptionRefusalOf>>;

/**
 * Pourquoi aucun statut de connexion n'est affiché, quand `connections` vaut
 * `null`. Chaque cas a son libellé : « État inconnu » n'est plus un fourre-tout.
 *
 * - `subscription` : le serveur a refusé la lecture faute d'abonnement
 *   Grow actif — rien n'est en panne, l'accès est réservé ;
 * - `workspace`    : aucune entreprise active, la lecture n'a pas été tentée ;
 * - `error`        : la lecture a échoué (réseau, serveur) ;
 * - `loading`      : la première lecture est en cours.
 */
export type EtatIndetermine = {
  kind: 'subscription' | 'workspace' | 'error' | 'loading';
  label: string;
  tone: 'neutral' | 'warning' | 'danger';
};

export function etatIndetermine(args: {
  workspaceId: string | null;
  loadError: string | null;
  subscriptionRefusal: SubscriptionRefusal | null;
}): EtatIndetermine {
  if (args.subscriptionRefusal) return { kind: 'subscription', label: 'Abonnement requis', tone: 'warning' };
  if (!args.workspaceId) return { kind: 'workspace', label: 'Entreprise non résolue', tone: 'neutral' };
  if (args.loadError) return { kind: 'error', label: 'État inconnu', tone: 'danger' };
  return { kind: 'loading', label: 'État inconnu', tone: 'neutral' };
}

/**
 * Contrôleur d'état fourni par l'espace hôte (Grow).
 *
 * Grow possède déjà des compteurs de séquence et un verrou de mutation
 * éprouvés par ses tests : les réimplémenter ici les affaiblirait. Quand ce
 * contrôleur est fourni, il pilote entièrement l'état ; sinon le composant gère
 * le sien (page `/app/connect`).
 */
export interface IntegrationsController {
  connections: BusinessIntegrationConnection[] | null;
  loadError: string | null;
  /**
   * Refus d'abonnement renvoyé par le serveur lors de la lecture
   * (`BUSINESS_GROW_SUBSCRIPTION_REQUIRED`). Distinct d'une panne : l'état
   * n'est pas « inconnu », il est « réservé aux abonnés », et l'écran le dit.
   */
  subscriptionRefusal?: SubscriptionRefusal | null;
  busyKey: string | null;
  notice: { tone: 'success' | 'error'; text: string } | null;
  onRetry: () => void;
  onRequest: (connectorKey: string) => void;
  onCancel: (connectorKey: string) => void;
  onDisconnect: (connectorKey: string) => void;
}

export function IntegrationsCenter({
  workspaceId = null,
  embedded = false,
  controller,
}: {
  /** Entreprise active : les demandes d'activation y sont rattachées. */
  workspaceId?: string | null;
  /**
   * Intégré à Grow : on ne rend pas l'en-tête de page (titre, retour),
   * déjà fournis par l'espace hôte. Le contenu est identique.
   */
  embedded?: boolean;
  controller?: IntegrationsController;
}) {
  const [interneConnections, setInterneConnections] = useState<BusinessIntegrationConnection[] | null>(null);
  const [accounts, setAccounts] = useState<ConnectedAccount[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [interneLoadError, setInterneLoadError] = useState<string | null>(null);
  const [interneRefus, setInterneRefus] = useState<SubscriptionRefusal | null>(null);
  /**
   * Panne de la source OAuth, distincte de celle des demandes d'activation.
   * Les deux sont signalées séparément : une source muette ne doit pas faire
   * passer l'autre pour complète.
   */
  const [oauthError, setOauthError] = useState<string | null>(null);
  const [interneBusyKey, setInterneBusyKey] = useState<string | null>(null);
  const [interneNotice, setInterneNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  /*
   * Le contrôleur, s'il existe, fait autorité. Sinon, l'état local.
   * Un seul chemin de lecture pour le rendu : impossible d'afficher un statut
   * provenant d'une source que l'appelant n'a pas validée.
   */
  const connections = controller ? controller.connections : interneConnections;
  const setConnections = controller ? () => {} : setInterneConnections;
  const loadError = controller ? controller.loadError : interneLoadError;
  const setLoadError = controller ? () => {} : setInterneLoadError;
  const subscriptionRefusal = controller ? (controller.subscriptionRefusal ?? null) : interneRefus;
  const setSubscriptionRefusal = controller ? () => {} : setInterneRefus;
  const busyKey = controller ? controller.busyKey : interneBusyKey;
  const setBusyKey = controller ? () => {} : setInterneBusyKey;
  const notice = controller ? controller.notice : interneNotice;
  const setNotice = controller ? () => {} : setInterneNotice;

  const [query, setQuery] = useState('');
  const [categorie, setCategorie] = useState<CatalogCategory | 'all'>('all');
  const [selection, setSelection] = useState<IntegrationEntry | null>(null);
  const [confirmation, setConfirmation] = useState<ConnectedAccount | null>(null);
  const [enCours, setEnCours] = useState(false);

  /**
   * Lecture des trois sources, entreprise par entreprise.
   *
   * `connections` reste `null` tant que la lecture n'a pas réussi : c'est ce
   * `null` qui désactive toutes les actions et affiche, fiche par fiche, la
   * raison précise (abonnement requis, entreprise non résolue, lecture
   * impossible, chargement — voir `etatIndetermine`). Une lecture échouée ne
   * doit jamais ressembler à une absence de connexion.
   *
   * Les comptes OAuth et le journal sont lus à part : leur panne ne doit pas
   * invalider les demandes d'activation, qui sont une autre source. Mais si la
   * lecture des demandes échoue, aucune fiche n'affirme un statut de connexion.
   */
  const charger = useCallback(async () => {
    if (!workspaceId) {
      setConnections(null);
      setLoadError(null);
    }
    /*
     * 1) Les demandes d'activation d'abord, SEULES. Le serveur refuse cette
     *    lecture sans abonnement Grow actif : c'est la vérification
     *    d'abonnement elle-même. Tant qu'elle n'a pas réussi, aucune autre
     *    source n'est interrogée — ni comptes OAuth, ni journal, ni boutiques
     *    (voir `MesBoutiquesConnectees`). Lancer ces lectures « au cas où »
     *    produisait des requêtes inutiles et des erreurs réseau contradictoires
     *    avec le message « l'état n'est pas lu sans abonnement ».
     */
    let demandes: BusinessIntegrationConnection[];
    try {
      demandes = await listActivationRequests(workspaceId, businessGrowApi);
    } catch (cause) {
      setConnections(null);
      setAccounts([]);
      setAudit([]);
      setOauthError(null);
      // Un refus d'abonnement n'est pas une panne : il est affiché comme tel,
      // avec le motif précis du serveur, et sans message d'erreur générique.
      const refus = subscriptionRefusalOf(cause);
      setSubscriptionRefusal(refus);
      setLoadError(refus ? null : cause instanceof Error ? cause.message : 'Lecture impossible.');
      return;
    }

    setSubscriptionRefusal(null);
    /*
     * Isolation par entreprise : le serveur filtre déjà sur `p_user_id` et
     * `p_workspace_id`, mais une ligne portant un autre `workspace_id` en
     * réponse signalerait un mélange. On refuse alors tout l'état au lieu de
     * l'afficher partiellement — fail-closed.
     */
    const melange = demandes.some((r) => r.workspace_id && workspaceId && r.workspace_id !== workspaceId);
    if (melange) {
      setConnections(null);
      setLoadError('Réponse invalide pour cette entreprise : lecture refusée.');
    } else {
      setConnections(demandes);
      setLoadError(null);
    }

    /*
     * 2) Abonnement vérifié : les autres sources sont lues, à part. Leur panne
     *    ne doit pas invalider les demandes d'activation, qui sont une autre
     *    source — mais aucune ne fait supposer un « Connecté ».
     */
    const [comptesRes, journalRes] = await Promise.allSettled([
      listConnectedAccounts(),
      listAudit(30),
    ]);
    if (comptesRes.status === 'fulfilled') {
      setAccounts(comptesRes.value);
      setOauthError(null);
    } else {
      setAccounts([]);
      setOauthError(
        comptesRes.reason instanceof Error ? comptesRes.reason.message : 'Lecture des connexions impossible.',
      );
    }
    setAudit(journalRes.status === 'fulfilled' ? journalRes.value : []);
  }, [workspaceId]);

  useEffect(() => {
    // Avec un contrôleur, c'est lui qui lit : deux lectures concurrentes
    // pourraient afficher un état plus ancien que celui qu'il vient de valider.
    if (controller) return;
    void charger();
  }, [charger, controller]);

  const resultats = useMemo(
    () => searchIntegrations(INTEGRATIONS, query, categorie),
    [query, categorie],
  );

  const parCategorie = useMemo(() => countByCategory(), []);

  /** Statut d'un fournisseur, ou `null` si l'état n'est pas connu. */
  const statutDe = useCallback(
    (entry: IntegrationEntry): IntegrationStatus | null =>
      connections === null
        ? null
        : deriveStatus(entry, accounts, entry.engine !== null, toActivationRequests(connections)),
    [connections, accounts],
  );

  const compte = useMemo(() => {
    const etats = INTEGRATIONS.map(statutDe).filter((s): s is IntegrationStatus => s !== null);
    return summarize(INTEGRATIONS, accounts, etats);
  }, [statutDe, accounts]);

  const connectionFor = useCallback(
    (entry: IntegrationEntry) =>
      (connections ?? [])
        .filter((c) => normalizeProvider(c.connector_key) === normalizeProvider(entry.id))
        .sort((a, b) => a.updated_at.localeCompare(b.updated_at))
        .at(-1) ?? null,
    [connections],
  );

  /* ----------------------------- mutations ------------------------------ */

  /**
   * Une mutation non confirmée n'est jamais rejouée.
   *
   * Si la réponse se perd, l'état local devient inconnu : on vide `connections`
   * pour forcer une relecture explicite. Réessayer aveuglément pourrait créer
   * un doublon de demande côté serveur.
   */
  const apresMutationIncertaine = (erreur: unknown) => {
    setConnections(null);
    const refus = subscriptionRefusalOf(erreur);
    setSubscriptionRefusal(refus);
    setLoadError(refus ? null : erreur instanceof Error ? erreur.message : 'Réponse perdue.');
    setNotice(refus
      ? { tone: 'error', text: 'Opération refusée : abonnement Grow requis. Rien n’a été enregistré.' }
      : { tone: 'error', text: 'Opération non confirmée. Relisez l’état avant de réessayer.' });
  };

  const demander = async (entry: IntegrationEntry) => {
    if (controller) { controller.onRequest(entry.id); return; }
    if (!workspaceId) {
      setNotice({ tone: 'error', text: 'Aucune entreprise active : la demande ne peut pas être enregistrée.' });
      return;
    }
    const cle = `${entry.id}:request`;
    setBusyKey(cle);
    setNotice(null);
    try {
      await businessGrowApi.requestIntegration(entry.id, workspaceId);
      setNotice({
        tone: 'success',
        text: `Demande enregistrée pour ${entry.name}. Aucun service externe n’a été connecté.`,
      });
      await charger();
    } catch (e) {
      apresMutationIncertaine(e);
    } finally {
      setBusyKey(null);
    }
  };

  const annuler = async (entry: IntegrationEntry) => {
    if (controller) { controller.onCancel(entry.id); return; }
    if (!workspaceId) return;
    setBusyKey(`${entry.id}:cancel`);
    setNotice(null);
    try {
      await businessGrowApi.cancelIntegration(entry.id, workspaceId);
      setNotice({ tone: 'success', text: `Demande annulée pour ${entry.name}.` });
      await charger();
    } catch (e) {
      apresMutationIncertaine(e);
    } finally {
      setBusyKey(null);
    }
  };

  /**
   * Retrait de l'association locale.
   *
   * Ce n'est **pas** une révocation : le serveur ne révoque rien chez le
   * fournisseur (aucun jeton n'est même détenu aujourd'hui). Le libellé et le
   * message le disent, pour que personne ne croie son accès Google fermé.
   */
  const retirerAssociation = async (entry: IntegrationEntry) => {
    if (controller) { controller.onDisconnect(entry.id); return; }
    if (!workspaceId) return;
    setBusyKey(`${entry.id}:disconnect`);
    setNotice(null);
    try {
      await businessGrowApi.disconnectIntegration(entry.id, workspaceId);
      setNotice({
        tone: 'success',
        text: `Association locale retirée pour ${entry.name}. Si une autorisation existe chez le fournisseur, révoquez-la également auprès de celui-ci.`,
      });
      await charger();
    } catch (e) {
      apresMutationIncertaine(e);
    } finally {
      setBusyKey(null);
    }
  };

  /** Révocation d'un compte OAuth réel — la seule qui touche le fournisseur. */
  const revoquer = async (compteCible: ConnectedAccount) => {
    setEnCours(true);
    try {
      const { remoteRevoked } = await revokeConnection(compteCible.id);
      setNotice({
        tone: 'success',
        text: remoteRevoked
          ? 'Connexion révoquée chez le fournisseur et dans SORAHNEX.'
          : 'Connexion désactivée dans SORAHNEX. Le fournisseur n’a pas confirmé la révocation distante : révoquez aussi depuis votre compte si nécessaire.',
      });
      setConfirmation(null);
      await charger();
    } catch (e) {
      setNotice({ tone: 'error', text: `Révocation impossible : ${e instanceof Error ? e.message : 'erreur inconnue'}` });
    } finally {
      setEnCours(false);
    }
  };

  const enCoursGlobal = busyKey !== null || enCours;

  const indetermine = etatIndetermine({ workspaceId, loadError, subscriptionRefusal });
  const guidanceAbonnement = subscriptionRefusal
    ? accessGuidance({
      allowed: false,
      reason: subscriptionRefusal.reason as ImportAccessReason,
      message: subscriptionRefusal.message,
      status: subscriptionRefusal.status,
      planKey: subscriptionRefusal.planKey,
      currentPeriodEnd: subscriptionRefusal.currentPeriodEnd,
      checkedAt: null,
      unknown: false,
    })
    : null;
  /*
   * Accès aux boutiques, déduit de ce que le serveur a RÉPONDU :
   * - la lecture des intégrations a réussi → l'abonnement est actif (le
   *   serveur la refuse sinon) → les boutiques sont lues ;
   * - refus d'abonnement → verrouillé, aucune requête vers `store-connect` ;
   * - lecture en cours ou en échec → aucune requête non plus, et aucune
   *   conclusion.
   */
  const accesBoutiques: BoutiquesAccess = guidanceAbonnement
    ? {
      kind: 'locked',
      title: guidanceAbonnement.title,
      detail: guidanceAbonnement.detail,
      showSubscribe: guidanceAbonnement.showSubscribe,
    }
    : connections !== null
      ? { kind: 'active' }
      : {
        kind: 'pending',
        message: loadError
          ? 'Lecture des intégrations en échec : les boutiques ne sont pas interrogées tant qu’une relecture n’a pas réussi.'
          : undefined,
      };

  return (
    <div className={embedded ? 'bg-transparent' : 'vy-ambient min-h-[100dvh] bg-ink'}>
      <div className={embedded ? 'w-full' : 'mx-auto w-full max-w-6xl px-4 py-8 sm:px-6'}>
        {/* En-tête — fourni par l'espace hôte quand le centre y est intégré */}
        <header className={embedded ? 'mb-5' : 'mb-6'}>
          {!embedded && (
            <>
              <Link
                to="/app/ai"
                className="mb-3 inline-flex items-center gap-1.5 text-xs text-slate-400 transition hover:text-white"
              >
                <ArrowLeft size={13} />
                Retour à l’assistant
              </Link>
            </>
          )}
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-2 rounded-full border border-brand-400/25 bg-brand-500/10 px-3 py-1 text-[0.7rem] text-brand-200">
              <Plug size={13} />
              SORAHNEX Integrations
            </span>
            {connections !== null && (
              <span className="text-[0.7rem] text-slate-500">
                {compte.connected} connectée{compte.connected > 1 ? 's' : ''} · {INTEGRATIONS.length} fournisseurs au catalogue
              </span>
            )}
          </div>

          <h1 className="font-display text-2xl font-semibold tracking-tight text-white sm:text-3xl">
            Connectez vos outils à SORAHNEX
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-400">
            Chaque fiche indique ce que la connexion permettra réellement, les
            permissions demandées et l’état actuel. Aucun accès n’est simulé :
            un fournisseur sans connecteur affiche son prérequis.
          </p>
          {!workspaceId && (
            <p className="mt-2 flex items-start gap-1.5 text-xs text-amber-200/80">
              <AlertTriangle size={12} className="mt-0.5 shrink-0" />
              Aucune entreprise active : le catalogue reste consultable, les demandes d’activation sont désactivées.
            </p>
          )}
        </header>

        {oauthError && (
          <div className="mb-5 flex items-start gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3.5 py-3 text-sm text-amber-100">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            <div className="flex-1">
              <p className="font-medium">Impossible de lire vos connexions</p>
              <p className="mt-0.5 text-xs text-amber-200/80">{oauthError}</p>
              <p className="mt-1 text-xs text-amber-200/60">
                Aucun compte connecté n’est affiché. Aucun « Connecté » n’est supposé à partir de cette source.
              </p>
            </div>
            <Button variant="ghost" size="sm" onClick={() => (controller ? controller.onRetry() : void charger())} icon={<RefreshCw size={14} />}>
              Réessayer
            </Button>
          </div>
        )}

        {subscriptionRefusal && guidanceAbonnement && (
          <div
            role="status"
            data-testid="integrations-subscription-required"
            className={cn(
              'mb-5 flex items-start gap-2.5 rounded-xl border px-3.5 py-3 text-xs',
              guidanceAbonnement.tone === 'danger'
                ? 'border-rose-400/25 bg-rose-400/[0.06] text-rose-100'
                : 'border-violet-300/25 bg-violet-400/[0.06] text-violet-100',
            )}
          >
            <Lock size={15} className="mt-0.5 shrink-0" />
            <div className="flex-1">
              <p className="font-medium">{guidanceAbonnement.title}</p>
              <p className="mt-0.5 opacity-80">{guidanceAbonnement.detail}</p>
              <p className="mt-1 opacity-60">
                Connexions verrouillées : le catalogue reste consultable, mais aucune requête n’est émise vers vos
                boutiques ni vos comptes tant que l’abonnement Grow n’est pas actif. Aucune connexion n’est supposée.
              </p>
              {guidanceAbonnement.showSubscribe && (
                <Link
                  to={SUBSCRIPTION_PATH}
                  className="mt-2 inline-flex items-center gap-1 font-medium underline-offset-2 hover:underline"
                >
                  Voir l’abonnement Grow <ArrowRight size={12} />
                </Link>
              )}
            </div>
            <Button variant="ghost" size="sm" onClick={() => (controller ? controller.onRetry() : void charger())} icon={<RefreshCw size={14} />}>
              Revérifier
            </Button>
          </div>
        )}

        {loadError && (
          <div role="alert" className="mb-5 flex items-start gap-2.5 rounded-xl border border-amber-400/20 bg-amber-400/[0.05] px-3.5 py-3 text-xs text-amber-100">
            <AlertTriangle size={15} className="mt-0.5 shrink-0" />
            <div className="flex-1">
              <p className="font-medium">État des intégrations indisponible</p>
              <p className="mt-0.5 text-amber-200/80">{loadError}</p>
              <p className="mt-1 text-amber-200/60">
                Aucun état de connexion n’est affiché ni supposé.
              </p>
            </div>
            <Button variant="ghost" size="sm" onClick={() => (controller ? controller.onRetry() : void charger())} icon={<RefreshCw size={14} />}>
              Réessayer
            </Button>
          </div>
        )}

        {notice && (
          <div
            role="status"
            className={cn(
              'mb-5 flex items-start gap-2 rounded-xl border px-3.5 py-2.5 text-xs',
              notice.tone === 'success'
                ? 'border-emerald-400/20 bg-emerald-400/[0.06] text-emerald-100'
                : 'border-rose-400/20 bg-rose-400/[0.06] text-rose-100',
            )}
          >
            {notice.tone === 'success' ? <Check size={14} className="mt-0.5 shrink-0" /> : <AlertTriangle size={14} className="mt-0.5 shrink-0" />}
            <span className="flex-1">{notice.text}</span>
            <button type="button" onClick={() => setNotice(null)} aria-label="Masquer le message">
              <X size={13} />
            </button>
          </div>
        )}

        {/* Comptes réellement connectés */}
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

        {/*
         * Vue d'ensemble des boutiques connectées, AVANT le catalogue.
         *
         * L'état d'une connexion vivait dans la fiche de son fournisseur :
         * passé deux connecteurs, savoir laquelle demandait une action
         * supposait d'ouvrir chaque fiche. Ce panneau ne remplace pas les
         * fiches, il évite d'avoir à les parcourir.
         */}
        <div className="mb-5">
          <MesBoutiquesConnectees
            workspaceId={workspaceId}
            access={accesBoutiques}
            onOpenConnector={(cle) => {
              const entry = INTEGRATIONS.find((candidat) => candidat.id === cle);
              if (entry) setSelection(entry);
            }}
          />
        </div>

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
        {connections === null && indetermine.kind === 'loading' ? (
          <p role="status" className="mb-4 text-xs text-slate-400">Chargement des intégrations…</p>
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
                statut={statutDe(entry)}
                indetermine={indetermine}
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

        <div className="mt-6 flex items-start gap-2.5 rounded-xl border border-amber-300/15 bg-amber-400/[0.04] px-3.5 py-3 text-[11px] leading-relaxed text-amber-100/80">
          <ShieldAlert size={14} className="mt-0.5 shrink-0" />
          <p>
            Les connexions et synchronisations fournisseur ne sont pas configurées ici. Une demande
            enregistrée ne signifie pas qu’un service externe est connecté. Aucun secret n’est manipulé
            par le navigateur.
          </p>
        </div>
      </div>

      {/* Fiche détaillée */}
      {selection && (
        <FicheDetail
          entry={selection}
          statut={statutDe(selection)}
          indetermine={indetermine}
          compte={accountFor(selection, accounts)}
          busy={enCoursGlobal}
          connection={connectionFor(selection)}
          onClose={() => setSelection(null)}
          onRevoke={(compteCible) => setConfirmation(compteCible)}
          entrepriseActive={Boolean(workspaceId)}
          workspaceId={workspaceId}
          onChanged={setNotice}
          onRequest={() => void demander(selection)}
          onCancelRequest={() => void annuler(selection)}
          onDisconnect={() => void retirerAssociation(selection)}
          onReload={() => void charger()}
        />
      )}

      {/* Confirmation de révocation */}
      {confirmation && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4 backdrop-blur-sm" role="dialog" aria-modal="true">
          <Card className="w-full max-w-md p-5">
            <h3 className="font-display text-base font-semibold text-white">Révoquer cette connexion ?</h3>
            <p className="mt-2 text-sm leading-relaxed text-slate-400">
              SORAHNEX cessera d’utiliser <strong className="text-slate-200">{confirmation.displayName || confirmation.email || confirmation.provider}</strong>.
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

/**
 * `/app/connect` — même composant, même source de vérité.
 *
 * Ce n'est plus un catalogue parallèle : la page ne fait que fournir
 * l'entreprise active, lue dans le contexte de session, au composant partagé.
 */
export default function CatalogPage() {
  // Sans contexte (page montée hors session), l'entreprise est simplement
  // inconnue : les demandes d'activation sont désactivées avec explication.
  let workspaceId: string | null = null;
  try {
    workspaceId = useAuth().workspaceId ?? null;
  } catch {
    workspaceId = null;
  }
  return <IntegrationsCenter workspaceId={workspaceId} />;
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

/**
 * Carte du catalogue.
 *
 * `statut === null` signifie qu'aucun statut n'a pu être lu : abonnement
 * requis, entreprise non résolue, lecture en échec ou en cours. Le libellé
 * affiché nomme ce cas précis (`indetermine`) plutôt que de retomber sur
 * « Non connecté », qui laisserait croire à une lecture réussie.
 */
function Carte({
  entry, statut, indetermine, onOpen,
}: {
  entry: IntegrationEntry;
  statut: IntegrationStatus | null;
  indetermine: EtatIndetermine;
  onOpen: () => void;
}) {
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
        <Badge tone={statut === null ? indetermine.tone : STATUS_TONE[statut]}>
          {statut === null ? indetermine.label : STATUS_LABELS[statut]}
        </Badge>
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
  entry, statut, indetermine, compte, connection, busy, entrepriseActive, workspaceId, onChanged,
  onClose, onRevoke, onRequest, onCancelRequest, onDisconnect, onReload,
}: {
  entry: IntegrationEntry;
  statut: IntegrationStatus | null;
  indetermine: EtatIndetermine;
  compte: ConnectedAccount | null;
  connection: BusinessIntegrationConnection | null;
  busy: boolean;
  /** Sans entreprise active, une demande ne peut pas être rattachée. */
  entrepriseActive: boolean;
  /** Entreprise active : la connexion à clé d'API y est rattachée. */
  workspaceId: string | null;
  /** Retour d'une connexion/déconnexion, affiché par l'écran hôte. */
  onChanged: (message: { tone: 'success' | 'error'; text: string }) => void;
  onClose: () => void;
  onRevoke: (compte: ConnectedAccount) => void;
  onRequest: () => void;
  onCancelRequest: () => void;
  onDisconnect: () => void;
  /** Relit l'état des connexions après un enregistrement réussi. */
  onReload: () => void;
}) {
  // Tant que l'état est inconnu, aucune action n'est proposée : on ne parie pas
  // sur ce que contient la base.
  const etatConnu = statut !== null;
  // Une demande est toujours scopée à une entreprise : sans elle, le serveur
  // refuserait ou la rattacherait à un contexte indéterminé.
  const demandePossible = etatConnu && entrepriseActive && canRequestActivation(entry, statut);
  const annulationPossible = etatConnu && canCancelRequest(statut);
  // « Connecté » au sens du socle Grow (ligne `connected`) : on peut
  // retirer l'association locale, même si aucun compte OAuth ne la corrobore.
  const associationLocale = etatConnu && connection?.status === 'connected';
  const connectable = etatConnu && canConnect(entry, statut);
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
          <Badge tone={statut === null ? indetermine.tone : STATUS_TONE[statut]}>
            {statut === null ? indetermine.label : STATUS_LABELS[statut]}
          </Badge>
        </div>

        <p className="text-sm leading-relaxed text-slate-300">{entry.description}</p>

        {statut === null && indetermine.kind === 'subscription' && (
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-violet-300/25 bg-violet-400/[0.08] px-3 py-2 text-xs text-violet-100">
            <Lock size={13} className="mt-0.5 shrink-0" />
            <p>
              Réservé aux abonnés Grow actifs : l’état de cette connexion n’est pas lu et aucune
              action n’est proposée tant que l’abonnement n’est pas actif.{' '}
              <Link to={SUBSCRIPTION_PATH} className="font-medium underline underline-offset-2">Voir l’abonnement</Link>
            </p>
          </div>
        )}

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
        <section className="mt-5 space-y-2">
          {!etatConnu ? (
            <div className="rounded-lg border border-amber-400/20 bg-amber-400/[0.05] px-3.5 py-3 text-xs leading-relaxed text-amber-100">
              {indetermine.kind === 'subscription'
                ? 'Abonnement requis : aucune action n’est proposée tant que l’abonnement Grow n’est pas actif.'
                : indetermine.kind === 'workspace'
                  ? 'Aucune entreprise active : aucune action n’est proposée tant que l’entreprise n’est pas résolue.'
                  : indetermine.kind === 'loading'
                    ? 'État inconnu : lecture en cours. Aucune action n’est proposée avant une lecture réussie.'
                    : 'État inconnu : la lecture des intégrations a échoué. Aucune action n’est proposée avant une relecture réussie.'}
            </div>
          ) : (
            <>
              {entry.engine === 'custom-api' ? (
                /*
                 * Parcours propre à ce connecteur : il n'y a pas de clé à
                 * demander mais une description à recueillir. Le composant
                 * générique de clé ne conviendrait pas — et prétendre le
                 * contraire aurait affiché un champ unique ne menant nulle
                 * part.
                 */
                <CustomApiConnectForm
                  workspaceId={workspaceId}
                  onChanged={onChanged}
                  onSaved={onReload}
                />
              ) : hasConnectFlow(entry.id) ? (
                /*
                 * Un seul composant pour tous les connecteurs à clé : ses
                 * champs, son aide et ses limites viennent de
                 * `connector-requirements.ts`, pas de ce fichier. Ajouter une
                 * plateforme ne demande donc plus d'écrire un écran — ni de
                 * modifier celui-ci.
                 *
                 * `hasConnectFlow` est le garde-fou : une fiche dont le
                 * parcours n'est pas livré tombe dans la branche suivante et
                 * n'affiche aucun champ de saisie.
                 */
                <>
                  {/*
                   * Une ligne de connexion peut exister SANS qu'aucune
                   * autorisation n'ait été obtenue (statut
                   * `authorization_missing`). Le formulaire ci-dessous permet
                   * enfin de se connecter pour de vrai ; ce texte empêche de
                   * lire le formulaire comme « c'est déjà branché ».
                   */}
                  {statut === 'authorization_missing' && (
                    <div className="mb-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3.5 py-3 text-xs leading-relaxed text-amber-100">
                      {expliquerIndisponibilite(statut, entry)}
                    </div>
                  )}
                  <ConnectorConnectForm
                    connectorKey={entry.id}
                    workspaceId={workspaceId}
                    connected={statut === 'connected'}
                    onChanged={onChanged}
                  />
                </>
              ) : connectable && entry.engine === 'api-key' ? (
                <ConnectButton entry={entry} />
              ) : (
                /*
                 * L'explication du blocage reste toujours affichée : elle dit
                 * pourquoi le bouton de connexion n'existe pas. La demande
                 * d'activation, quand le serveur l'accepte, s'ajoute en dessous —
                 * c'est une trace réelle, pas une connexion simulée.
                 */
                <div className="rounded-lg border border-line bg-white/[0.03] px-3.5 py-3 text-xs leading-relaxed text-slate-400">
                  {expliquerIndisponibilite(statut, entry)}
                </div>
              )}

              {demandePossible && (
                <div className="rounded-lg border border-brand-400/25 bg-brand-500/[0.08] px-3.5 py-3">
                  <p className="text-xs leading-relaxed text-slate-300">
                    Vous pouvez enregistrer une demande d’activation pour {entry.name}.
                    Elle sera traitée lorsque le connecteur officiel sera implémenté.
                    Aucun service externe n’est connecté par cette action.
                  </p>
                  <Button
                    variant="secondary"
                    size="sm"
                    className="mt-2.5"
                    loading={busy}
                    disabled={busy}
                    onClick={onRequest}
                    icon={<Plug size={13} />}
                  >
                    Demander l’activation
                  </Button>
                </div>
              )}

              {annulationPossible && (
                <div className="rounded-lg border border-amber-500/25 bg-amber-500/[0.08] px-3.5 py-3">
                  <p className="text-xs leading-relaxed text-amber-100">
                    Demande enregistrée. Aucune connexion n’est établie tant que le
                    connecteur officiel n’existe pas.
                  </p>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="mt-2.5"
                    loading={busy}
                    disabled={busy}
                    onClick={onCancelRequest}
                    icon={<X size={13} />}
                  >
                    Annuler la demande
                  </Button>
                </div>
              )}

              {associationLocale && (
                <div className="rounded-lg border border-line bg-white/[0.03] px-3.5 py-3">
                  <p className="text-xs leading-relaxed text-slate-400">
                    Retirer l’association locale détache SORAHNEX de ce fournisseur pour
                    cette entreprise. Aucune révocation n’est effectuée chez le
                    fournisseur.
                  </p>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="mt-2.5"
                    loading={busy}
                    disabled={busy}
                    onClick={onDisconnect}
                    icon={<Unplug size={13} />}
                  >
                    Retirer l’association locale
                  </Button>
                </div>
              )}
            </>
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
  if (statut === 'authorization_missing') {
    return `Une association est enregistrée pour ${entry.name}, mais aucune autorisation n’a été obtenue auprès du fournisseur. Aucune donnée n’est accessible : il manque le consentement officiel, pas un réglage.`;
  }
  if (statut === 'requested') {
    return `Votre demande d’activation pour ${entry.name} est enregistrée. Aucune connexion n’existe encore : le connecteur officiel n’est pas implémenté.`;
  }
  switch (statut) {
    case 'needs_approval':
      return `Ce fournisseur exige une validation de son côté (${entry.auth.find((a) => a.externalApproval)?.externalApproval ?? 'approbation du fournisseur'}). SORAHNEX ne peut pas contourner cette étape : la connexion sera proposée une fois l’approbation obtenue.`;
    case 'needs_config':
      return 'Les identifiants SORAHNEX pour ce fournisseur ne sont pas encore configurés côté serveur. Le moteur d’intégration les ajoutera en Livraison 3.';
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

/**
 * « Mes boutiques connectées » — vue d'ensemble des connexions de l'entreprise.
 *
 * ## Le besoin
 *
 * L'état d'une connexion est aujourd'hui visible dans la fiche de son
 * fournisseur. Passé trois connecteurs, retrouver « laquelle est tombée en
 * erreur hier » demande d'ouvrir chaque fiche. Cette vue répond à trois
 * questions d'un coup d'œil :
 *
 *   1. quelles boutiques sont connectées, et depuis quand ?
 *   2. laquelle demande une action (erreur, droits insuffisants) ?
 *   3. quelles plateformes sont disponibles et ne sont pas encore configurées ?
 *
 * ## Ce que ce panneau ne prétend pas
 *
 * Il ne teste rien lui-même : il lit l'état écrit par `store-connect`, et
 * affiche `hasCredential` tel que le serveur le rapporte. Un statut
 * `connected` sans secret — trace d'une ancienne demande d'activation — est
 * affiché comme une anomalie, jamais comme une connexion saine.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Link2,
  Loader2,
  Plug,
  RefreshCw,
  ShieldAlert,
  XCircle,
} from 'lucide-react';
import { Button, EmptyState } from '../components/ui';
import {
  CONNECTION_STATE_LABELS,
  deriveConnectionState,
  hasConnectFlow,
  requirementsFor,
  type ConnectionState,
} from '../business/importer/connector-requirements';
import { readConnection, type StoreConnectorKey, type StoreConnectionState } from '../business/importer/connect-relay';

export interface ConnectedStore {
  connectorKey: string;
  /** État dérivé, jamais recopié du serveur tel quel. */
  state: ConnectionState;
  /** Détail serveur, quand il a pu être lu. */
  detail: StoreConnectionState | null;
  /** Erreur de LECTURE (réseau, droits) — distincte d'une erreur de connexion. */
  readError?: string;
}

export interface MesBoutiquesProps {
  workspaceId: string | null;
  /** Ouvre la fiche du connecteur (fourni par l'écran hôte). */
  onOpenConnector?: (connectorKey: string) => void;
  /** Callback quand l'utilisateur demande un rafraîchissement manuel. */
  onRefresh?: () => void;
}

/** Connecteurs réellement branchés : la vue ne liste rien d'autre. */
/**
 * Connecteurs dont la connexion est RÉELLEMENT déployée.
 *
 * Cette liste suit `CONNECTOR_REQUIREMENTS` : un connecteur sans formulaire
 * n'apparaît pas ici, sinon le panneau annoncerait une boutique « non
 * configurée » qu'aucun écran ne permet de configurer.
 */
const CONNECTEURS_CONNECTABLES = ['prestashop', 'chariow', 'shopify', 'woocommerce'];

const TONS: Record<ConnectionState, { tone: string; icon: typeof CheckCircle2; label: string }> = {
  connected: { tone: 'text-emerald-300', icon: CheckCircle2, label: 'Connectée' },
  pending: { tone: 'text-sky-300', icon: Clock, label: 'En attente' },
  'not-configured': { tone: 'text-slate-400', icon: Plug, label: 'Non configurée' },
  'auth-error': { tone: 'text-rose-300', icon: XCircle, label: 'Identifiants refusés' },
  'insufficient-scope': { tone: 'text-amber-300', icon: ShieldAlert, label: 'Droits insuffisants' },
  expired: { tone: 'text-amber-300', icon: Clock, label: 'Connexion expirée' },
};

export function MesBoutiquesConnectees({ workspaceId, onOpenConnector }: MesBoutiquesProps) {
  const [etats, setEtats] = useState<Record<string, ConnectedStore> | null>(null);
  const [chargement, setChargement] = useState(false);
  const [erreurGlobale, setErreurGlobale] = useState<string | null>(null);

  const lire = useCallback(async () => {
    if (!workspaceId) {
      setEtats(null);
      return;
    }
    setChargement(true);
    setErreurGlobale(null);
    const resultat: Record<string, ConnectedStore> = {};

    /*
     * Les lectures sont indépendantes : une panne sur un connecteur ne doit
     * pas masquer l'état des autres. On lit donc chacune séparément, et on
     * conserve l'erreur de lecture par connecteur plutôt que de tout annuler.
     */
    await Promise.all(CONNECTEURS_CONNECTABLES.map(async (cle) => {
      try {
        const detail = await readConnection({ workspaceId, connectorKey: cle as StoreConnectorKey });
        resultat[cle] = {
          connectorKey: cle,
          state: deriveConnectionState(detail),
          detail,
        };
      } catch (cause) {
        resultat[cle] = {
          connectorKey: cle,
          // Une lecture ratée n'autorise AUCUNE conclusion sur l'état : ni
          // « connectée », ni « non configurée ».
          state: 'pending',
          detail: null,
          readError: cause instanceof Error ? cause.message : 'Lecture impossible',
        };
      }
    }));

    setEtats(resultat);
    setChargement(false);
  }, [workspaceId]);

  useEffect(() => {
    void lire();
  }, [lire]);

  const lignes = useMemo(() => {
    if (!etats) return [];
    return CONNECTEURS_CONNECTABLES.map((cle) => etats[cle]).filter(Boolean);
  }, [etats]);

  const resume = useMemo(() => {
    const compte = { connectees: 0, aAction: 0, libres: 0 };
    for (const ligne of lignes) {
      if (ligne.state === 'connected') compte.connectees += 1;
      else if (ligne.state === 'auth-error' || ligne.state === 'insufficient-scope' || ligne.state === 'expired') compte.aAction += 1;
      else compte.libres += 1;
    }
    return compte;
  }, [lignes]);

  if (!workspaceId) {
    return (
      <div className="rounded-xl border border-line bg-panel/60 p-4" data-testid="mes-boutiques">
        <p className="text-sm text-slate-400">Sélectionnez une entreprise pour voir ses boutiques connectées.</p>
      </div>
    );
  }

  return (
    <section className="rounded-xl border border-line bg-panel/60 p-4" data-testid="mes-boutiques">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="flex items-center gap-1.5 font-display text-sm font-semibold text-white">
            <Link2 size={14} className="text-brand-300" /> Mes boutiques connectées
          </h3>
          <p className="mt-0.5 text-[0.7rem] text-slate-500">
            {etats === null
              ? 'Lecture en cours…'
              : `${resume.connectees} connectée${resume.connectees > 1 ? 's' : ''} · ${resume.aAction} à corriger · ${resume.libres} non configurée${resume.libres > 1 ? 's' : ''}`}
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void lire()}
          disabled={chargement}
          data-testid="mes-boutiques-refresh"
        >
          {chargement ? <Loader2 size={12} className="mr-1 animate-spin" /> : <RefreshCw size={12} className="mr-1" />}
          Actualiser
        </Button>
      </div>

      {erreurGlobale && (
        <p className="mt-2 flex items-start gap-1.5 text-[0.7rem] text-rose-300">
          <AlertTriangle size={11} className="mt-0.5 shrink-0" /> {erreurGlobale}
        </p>
      )}

      {etats === null && chargement ? (
        <p className="mt-3 flex items-center gap-1.5 text-xs text-slate-500">
          <Loader2 size={12} className="animate-spin" /> Lecture des connexions…
        </p>
      ) : lignes.length === 0 ? (
        <EmptyState
          title="Aucune boutique connectée"
          description="Connectez votre première boutique depuis le catalogue ci-dessous."
          icon={<Plug size={18} />}
        />
      ) : (
        <ul className="mt-3 space-y-2">
          {lignes.map((ligne) => {
            const exigence = requirementsFor(ligne.connectorKey);
            const apparence = TONS[ligne.state];
            const Icone = apparence.icon;
            return (
              <li
                key={ligne.connectorKey}
                className="rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2.5"
                data-testid={`boutique-${ligne.connectorKey}`}
                data-state={ligne.state}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Icone size={13} className={apparence.tone} />
                  <span className="text-xs font-semibold text-white">
                    {exigence?.label ?? ligne.connectorKey}
                  </span>
                  <span className={`text-[0.68rem] ${apparence.tone}`}>
                    {CONNECTION_STATE_LABELS[ligne.state] ?? apparence.label}
                  </span>
                  {onOpenConnector && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="ml-auto"
                      onClick={() => onOpenConnector(ligne.connectorKey)}
                    >
                      {ligne.state === 'connected' ? 'Gérer' : 'Configurer'}
                    </Button>
                  )}
                </div>

                <dl className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[0.66rem] text-slate-400">
                  {ligne.detail?.shopName && <Ligne terme="Boutique" valeur={ligne.detail.shopName} />}
                  {(ligne.detail?.storeUrl || ligne.detail?.endpoint) && (
                    <Ligne terme="Adresse" valeur={ligne.detail.storeUrl ?? ligne.detail.endpoint ?? '—'} />
                  )}
                  {ligne.detail?.totalProducts !== null && ligne.detail?.totalProducts !== undefined && (
                    <Ligne terme="Produits" valeur={String(ligne.detail.totalProducts)} />
                  )}
                  {ligne.detail?.checkedAt && (
                    <Ligne terme="Dernière vérification" valeur={formaterDate(ligne.detail.checkedAt)} />
                  )}
                </dl>

                {ligne.detail?.lastError && ligne.state !== 'connected' && (
                  <p className="mt-1 text-[0.66rem] leading-relaxed text-rose-300/90">
                    {ligne.detail.lastError}
                  </p>
                )}
                {ligne.readError && (
                  <p className="mt-1 text-[0.66rem] leading-relaxed text-amber-300/90">
                    État illisible : {ligne.readError}. Aucune conclusion n’est tirée de cette ligne.
                  </p>
                )}
                {/*
                 * Une ligne `connected` sans secret est une anomalie : elle
                 * vient d'une demande d'activation antérieure à la mise en
                 * place de Vault. L'afficher « connectée » ferait échouer
                 * l'import sans explication.
                 *
                 * La condition porte sur le STATUT SERVEUR, pas sur l'état
                 * dérivé : `deriveConnectionState` transforme déjà ce cas en
                 * `auth-error`, si bien que tester `state === 'connected'` ici
                 * était du code mort — révélé par un test qui ne trouvait
                 * jamais le message.
                 */}
                {ligne.detail?.status === 'connected' && ligne.detail?.connected === false && (
                  <p className="mt-1 text-[0.66rem] text-amber-300">
                    Aucun secret n’est enregistré pour cette connexion : reconnectez la boutique.
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/*
       * Les plateformes sans parcours de connexion sont nommées, mais sans
       * bouton : l'utilisateur doit savoir qu'elles existent et pourquoi elles
       * ne sont pas configurables. Un bouton grisé serait un mensonge de plus.
       */}
      <p className="mt-3 text-[0.66rem] leading-relaxed text-slate-500">
        {CONNECTEURS_CONNECTABLES.filter((cle) => hasConnectFlow(cle)).length} connecteurs sont configurables
        aujourd’hui. Les autres plateformes du catalogue s’importent par fichier (CSV, XLSX, XML), en attendant
        un parcours de connexion vérifié.
      </p>
    </section>
  );
}

function Ligne({ terme, valeur }: { terme: string; valeur: string }) {
  return (
    <div className="flex gap-1">
      <dt className="text-slate-500">{terme}</dt>
      <dd className="max-w-[22rem] truncate text-slate-300">{valeur}</dd>
    </div>
  );
}

function formaterDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
}

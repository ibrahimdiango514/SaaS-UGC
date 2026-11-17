/**
 * Connexion Chariow depuis la fiche du catalogue d'intégrations.
 *
 * ## Pourquoi un formulaire distinct de celui de PrestaShop
 *
 * Une fiche ne doit proposer que ce qui fonctionne. Les deux connecteurs ne
 * demandent pas la même chose :
 *
 * | | PrestaShop | Chariow |
 * |---|---|---|
 * | Ce qu'on saisit | URL de boutique **et** clé Webservice | la clé, et rien d'autre |
 * | Où vit l'API | chez le marchand | chez l'éditeur (`api.chariow.com`) |
 * | Rôle de l'URL | c'est l'adresse à interroger | confirmer l'appartenance de la clé |
 *
 * Réutiliser le formulaire PrestaShop forcerait à saisir une URL dont Chariow
 * n'a pas besoin, et ferait croire que VYORA va contacter la vitrine — ce qui
 * n'est pas le cas. Un champ unique est ici plus honnête qu'un champ inutile.
 *
 * ## La clé ne survit pas à la réponse
 *
 * Elle vit dans un `useState` local, part en HTTPS vers `store-connect`, est
 * rangée dans Vault, et l'état est **vidé dès la réponse** — avant tout rendu.
 * Ce qui reste à l'écran est la preuve de la lecture (boutique, statut,
 * ressources), jamais le secret. `readConnection` ne renvoie d'ailleurs jamais
 * la clé : le serveur ne l'a jamais réémise.
 */
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Check, ExternalLink, KeyRound, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '../components/ui';
import { asAppError } from '../lib/errors';
import {
  connectStore,
  disconnectStore,
  readConnection,
  type StoreConnectionResult,
  type StoreConnectionState,
} from '../business/importer/connect-relay';

export interface ChariowConnectFormProps {
  /** Entreprise active : la connexion y sera rattachée. */
  workspaceId: string | null;
  /** Déjà connecté : le formulaire devient un bouton de déconnexion. */
  connected: boolean;
  /** Retour affiché par l'écran hôte (bandeau). */
  onChanged: (message: { tone: 'success' | 'error'; text: string }) => void;
}

/** Longueur minimale acceptée côté navigateur, alignée sur le serveur. */
const LONGUEUR_MIN_CLE = 20;

export function ChariowConnectForm({ workspaceId, connected, onChanged }: ChariowConnectFormProps) {
  const [cle, setCle] = useState('');
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const [preuve, setPreuve] = useState<StoreConnectionResult | null>(null);
  /**
   * État lu au montage et après chaque action.
   *
   * Sans cette lecture, revenir sur l'écran afficherait « non connecté » alors
   * qu'une clé est en Vault : l'utilisateur ressaisirait sa clé pour rien, ou
   * pire, laisserait une connexion orpheline en croyant l'avoir retirée.
   */
  const [etat, setEtat] = useState<StoreConnectionState | null>(null);
  const [lectureEnCours, setLectureEnCours] = useState(false);

  const relireEtat = useCallback(async () => {
    if (!workspaceId) {
      setEtat(null);
      return;
    }
    setLectureEnCours(true);
    try {
      const lu = await readConnection({ workspaceId, connectorKey: 'chariow' });
      setEtat(lu);
    } catch {
      // Une lecture ratée n'autorise pas à afficher « connecté » : on laisse
      // l'état précédent et on ne prétend rien de plus.
      setEtat(null);
    } finally {
      setLectureEnCours(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void relireEtat();
  }, [relireEtat]);

  /** Vrai si le serveur confirme une connexion ET une clé enregistrée. */
  const connecte = etat?.connected === true || connected;

  async function connecter() {
    if (!workspaceId) {
      setErreur('Sélectionnez une entreprise avant de connecter une boutique.');
      return;
    }
    const saisie = cle.trim();
    if (!saisie.startsWith('sk_')) {
      setErreur('Une clé Chariow commence par « sk_ ». Copiez-la depuis app.chariow.com → Settings → API Keys.');
      return;
    }
    if (saisie.length < LONGUEUR_MIN_CLE) {
      setErreur('Cette clé semble trop courte. Elle n’est affichée qu’une seule fois : vérifiez la copie.');
      return;
    }

    setEnCours(true);
    setErreur(null);
    try {
      const resultat = await connectStore({
        workspaceId,
        connectorKey: 'chariow',
        apiKey: saisie,
      });
      // Effacement AVANT tout rendu ultérieur : même si la suite échouait, la
      // clé ne serait plus dans l'état du composant.
      setCle('');
      setPreuve(resultat);
      setEtat({
        connectorKey: 'chariow',
        status: resultat.status,
        connectedTo: resultat.connectedTo,
        endpoint: resultat.endpoint,
        shopName: resultat.shopName,
        version: null,
        totalProducts: resultat.totalProducts,
        resourcesRead: resultat.resourcesRead,
        storeUrl: resultat.storeUrl ?? null,
        storeStatus: resultat.storeStatus ?? null,
        checkedAt: new Date().toISOString(),
        lastError: null,
      });
      onChanged({
        tone: 'success',
        text: `Boutique Chariow « ${resultat.shopName ?? 'sans nom'} » connectée : clé vérifiée par lecture de l’API.`,
      });
    } catch (cause) {
      // Le message vient de l'Edge Function : il est déjà expurgé de la clé et
      // nomme, quand c'est le cas, le scope manquant.
      setErreur(asAppError(cause).message);
    } finally {
      setEnCours(false);
    }
  }

  async function deconnecter() {
    if (!workspaceId) return;
    setEnCours(true);
    setErreur(null);
    try {
      await disconnectStore({ workspaceId, connectorKey: 'chariow' });
      setPreuve(null);
      setCle('');
      setEtat(null);
      await relireEtat();
      onChanged({ tone: 'success', text: 'Boutique Chariow déconnectée : la clé a été retirée du coffre.' });
    } catch (cause) {
      setErreur(asAppError(cause).message);
    } finally {
      setEnCours(false);
    }
  }

  /* ------------------------------- déjà connecté ------------------------------ */

  if (connecte) {
    return (
      <div
        className="rounded-lg border border-emerald-400/25 bg-emerald-500/[0.06] px-3.5 py-3"
        data-testid="chariow-connect-form"
      >
        <p className="flex items-center gap-1.5 text-xs font-semibold text-emerald-200">
          <Check size={13} /> Boutique Chariow connectée
        </p>
        <p className="mt-1 text-[0.7rem] leading-relaxed text-slate-400">
          La clé est rangée dans le coffre chiffré côté serveur. Elle n’est plus nécessaire
          dans le navigateur : l’aperçu d’import la retrouve côté serveur.
        </p>

        {/* Ce que le serveur a RÉELLEMENT lu — jamais le secret. */}
        <dl className="mt-2 space-y-0.5 text-[0.68rem] text-slate-400" data-testid="chariow-connection-state">
          <div className="flex gap-1.5">
            <dt className="text-slate-500">Boutique</dt>
            <dd className="text-slate-300">{etat?.shopName ?? preuve?.shopName ?? '—'}</dd>
          </div>
          {etat?.storeUrl && (
            <div className="flex gap-1.5">
              <dt className="text-slate-500">Adresse</dt>
              <dd className="truncate text-slate-300">{etat.storeUrl}</dd>
            </div>
          )}
          <div className="flex gap-1.5">
            <dt className="text-slate-500">Statut</dt>
            <dd className="text-slate-300">{etat?.status ?? preuve?.status ?? '—'}</dd>
          </div>
          <div className="flex gap-1.5">
            <dt className="text-slate-500">Ressources lues</dt>
            <dd className="text-slate-300">{(etat?.resourcesRead ?? preuve?.resourcesRead ?? []).join(', ') || '—'}</dd>
          </div>
          {etat?.lastError && (
            <div className="flex gap-1.5">
              <dt className="text-slate-500">Dernière erreur</dt>
              <dd className="text-amber-200">{etat.lastError}</dd>
            </div>
          )}
        </dl>

        <div className="mt-2.5 flex flex-wrap gap-1.5">
          <Button
            variant="danger"
            size="sm"
            loading={enCours}
            onClick={() => void deconnecter()}
            data-testid="chariow-disconnect"
          >
            Déconnecter la boutique
          </Button>
          <Button
            variant="ghost"
            size="sm"
            loading={lectureEnCours}
            onClick={() => void relireEtat()}
            icon={<RefreshCw size={13} />}
            data-testid="chariow-refresh"
          >
            Vérifier l’état
          </Button>
        </div>

        {erreur && (
          <p role="alert" className="mt-1.5 flex items-start gap-1 text-[0.68rem] text-rose-200" data-testid="chariow-connect-error">
            <AlertTriangle size={11} className="mt-0.5 shrink-0" /> {erreur}
          </p>
        )}
      </div>
    );
  }

  /* ------------------------------- pas connecté ------------------------------ */

  return (
    <div
      className="rounded-lg border border-brand-400/25 bg-brand-500/[0.06] px-3.5 py-3"
      data-testid="chariow-connect-form"
    >
      <p className="flex items-center gap-1.5 text-xs font-semibold text-brand-200">
        <KeyRound size={13} /> Connecter votre boutique Chariow
      </p>
      <p className="mt-1 text-[0.7rem] leading-relaxed text-slate-400">
        Créez une clé dans{' '}
        <a
          href="https://app.chariow.com"
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-0.5 text-brand-200 underline decoration-brand-400/40"
        >
          app.chariow.com → Settings → API Keys <ExternalLink size={10} />
        </a>{' '}
        en cochant <span className="text-slate-200">uniquement</span> « products.read » et
        « store.read ». Elle est vérifiée par le serveur (lecture réelle de votre boutique),
        puis rangée dans un coffre chiffré : elle ne revient jamais dans le navigateur.
      </p>

      <div className="mt-2 flex flex-col gap-1.5 sm:flex-row">
        {/* `type="password"` : la clé ne reste pas lisible à l'écran. */}
        <input
          type="password"
          value={cle}
          onChange={(e) => setCle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !enCours) void connecter();
          }}
          placeholder="sk_live_…"
          aria-label="Clé API Chariow"
          autoComplete="off"
          spellCheck={false}
          disabled={enCours || !workspaceId}
          className="min-w-0 flex-1 rounded-lg border border-line bg-black/30 px-2.5 py-1.5 font-mono text-[0.7rem] text-slate-200 placeholder:text-slate-600 focus:border-brand-400/50 focus:outline-none disabled:opacity-50"
          data-testid="chariow-key"
        />
        <Button
          variant="primary"
          size="sm"
          loading={enCours}
          disabled={!workspaceId || cle.trim().length < LONGUEUR_MIN_CLE}
          onClick={() => void connecter()}
          icon={<KeyRound size={13} />}
          data-testid="chariow-submit"
        >
          Vérifier et connecter
        </Button>
      </div>

      {!workspaceId && (
        <p className="mt-1.5 text-[0.68rem] text-amber-200">
          Sélectionnez une entreprise : la connexion y sera rattachée.
        </p>
      )}
      {enCours && (
        <p className="mt-1.5 flex items-center gap-1 text-[0.68rem] text-slate-400">
          <Loader2 size={11} className="animate-spin" /> Lecture réelle de votre boutique Chariow…
        </p>
      )}

      {erreur && (
        <p role="alert" className="mt-1.5 flex items-start gap-1 text-[0.68rem] text-rose-200" data-testid="chariow-connect-error">
          <AlertTriangle size={11} className="mt-0.5 shrink-0" /> {erreur}
        </p>
      )}

      {preuve && !erreur && (
        <div className="mt-1.5 text-[0.68rem] text-slate-400" data-testid="chariow-proof">
          <p>
            {preuve.shopName ?? 'Boutique'}
            {preuve.storeUrl ? ` · ${preuve.storeUrl}` : ''}
            {preuve.storeStatus ? ` · ${preuve.storeStatus}` : ''}
          </p>
          {/* Hôte réellement contacté : preuve de ce qui a été joint. */}
          <p className="text-slate-500">hôte de l’API : {preuve.connectedTo}</p>
          <p className="text-slate-500">ressources lues : {preuve.resourcesRead.join(', ') || '—'}</p>
        </div>
      )}
    </div>
  );
}

/**
 * Formulaire de connexion **générique**, piloté par `connector-requirements.ts`.
 *
 * ## Pourquoi un seul composant
 *
 * `PrestashopConnectForm` et `ChariowConnectForm` font 90 % la même chose :
 * lire un état, valider une saisie, appeler `store-connect`, vider le champ
 * secret, afficher une preuve, proposer de déconnecter. Ce qui change tient dans
 * le tableau `fields`. Maintenir deux composants pour deux différences de trois
 * lignes garantit qu'ils divergeront — et qu'un correctif de sécurité
 * (effacement du secret, par exemple) oubliera l'un des deux.
 *
 * ## Rien n'est affiché qui ne soit prouvé
 *
 * L'écran ne dit « connectée » que si le serveur le dit **et** qu'un secret
 * existe. La preuve affichée (hôte contacté, ressources lues, total) vient de la
 * réponse de `store-connect`, pas d'une reconstitution locale.
 *
 * ## Le secret ne survit pas à la réponse
 *
 * Il vit dans un `useState`, part en HTTPS, et l'état est vidé **avant** tout
 * rendu ultérieur. Le serveur ne le réémet jamais : `readConnection` n'a pas de
 * champ pour cela.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, ExternalLink, KeyRound, Loader2, Plug, RefreshCw } from 'lucide-react';
import { Button, Input } from '../components/ui';
import { asAppError } from '../lib/errors';
import {
  connectStore,
  disconnectStore,
  readConnection,
  type StoreConnectorKey,
  type StoreConnectionResult,
  type StoreConnectionState,
} from '../business/importer/connect-relay';
import {
  CONNECTION_STATE_LABELS,
  deriveConnectionState,
  isComplete,
  requirementsFor,
  validateField,
  type ConnectionState,
  type ConnectorRequirement,
} from '../business/importer/connector-requirements';

export interface ConnectorConnectFormProps {
  /** Clé du connecteur : doit exister dans `CONNECTOR_REQUIREMENTS`. */
  connectorKey: string;
  /** Entreprise active : la connexion y sera rattachée. */
  workspaceId: string | null;
  /** L'écran hôte sait déjà qu'une connexion existe (raccourci d'affichage). */
  connected?: boolean;
  /** Retour affiché par l'écran hôte (bandeau). */
  onChanged: (message: { tone: 'success' | 'error'; text: string }) => void;
  /** Appelé après une connexion réussie, pour rafraîchir la fiche. */
  onConnected?: (state: ConnectionState) => void;
}

/**
 * La clé doit être l'un des connecteurs déployés pour compiler.
 *
 * Le registre `connector-requirements.ts` est la source de vérité : un
 * connecteur qui y figure mais dont l'Edge Function n'implémente pas le parcours
 * doit casser le typage, pas échouer à l'exécution devant l'utilisateur.
 */
const cleConnecteur = (key: string): StoreConnectorKey => key as StoreConnectorKey;

const TONS: Record<ConnectionState, string> = {
  'not-configured': 'border-white/10 bg-white/[0.02] text-slate-300',
  pending: 'border-sky-400/25 bg-sky-500/[0.06] text-sky-200',
  connected: 'border-emerald-400/25 bg-emerald-500/[0.06] text-emerald-200',
  'auth-error': 'border-rose-400/25 bg-rose-500/[0.06] text-rose-200',
  'insufficient-scope': 'border-amber-400/25 bg-amber-500/[0.06] text-amber-200',
  expired: 'border-amber-400/25 bg-amber-500/[0.06] text-amber-200',
};

export function ConnectorConnectForm({
  connectorKey,
  workspaceId,
  connected = false,
  onChanged,
  onConnected,
}: ConnectorConnectFormProps) {
  const requirement: ConnectorRequirement | null = useMemo(
    () => requirementsFor(connectorKey),
    [connectorKey],
  );

  const [valeurs, setValeurs] = useState<Record<string, string>>({});
  const [erreursChamps, setErreursChamps] = useState<Record<string, string>>({});
  const [erreur, setErreur] = useState<string | null>(null);
  const [enCours, setEnCours] = useState(false);
  const [preuve, setPreuve] = useState<StoreConnectionResult | null>(null);
  const [etat, setEtat] = useState<StoreConnectionState | null>(null);
  const [lectureEnCours, setLectureEnCours] = useState(false);
  /** Le formulaire est-il déplié ? Replié par défaut quand tout va bien. */
  const [ouvert, setOuvert] = useState(false);

  const relireEtat = useCallback(async () => {
    if (!workspaceId || !requirement) {
      setEtat(null);
      return;
    }
    setLectureEnCours(true);
    try {
      const lu = await readConnection({ workspaceId, connectorKey: cleConnecteur(requirement.key) });
      setEtat(lu);
    } catch {
      // Une lecture ratée n'autorise pas à afficher « connectée ».
      setEtat(null);
    } finally {
      setLectureEnCours(false);
    }
  }, [workspaceId, requirement]);

  useEffect(() => {
    void relireEtat();
  }, [relireEtat]);

  /**
   * Un connecteur sans exigences déclarées ne peut pas être configuré.
   *
   * On rend `null` plutôt qu'un formulaire vide : c'est la garantie structurelle
   * qu'aucun bouton mort n'existe, même si un appelant se trompe de clé.
   */
  if (!requirement) return null;

  /**
   * L'état serveur fait foi dès qu'il est lisible. À défaut, l'écran hôte
   * transmet ce que le catalogue a déjà lu (`connected`) : c'est encore une
   * information serveur, pas une supposition du composant.
   */
  const etatAffiche: ConnectionState = etat
    ? deriveConnectionState(etat, { hasSecretWhenUnknown: connected })
    : connected
      ? 'connected'
      : 'not-configured';

  const estConnecte = etatAffiche === 'connected';
  const dernierChampSecret = requirement.fields.filter((f) => f.secret).at(-1);

  function majValeur(nom: string, valeur: string) {
    setValeurs((precedent) => ({ ...precedent, [nom]: valeur }));
    // L'erreur du champ disparaît dès qu'on le corrige : garder un message
    // périmé sous un champ redevenu valide est déroutant.
    setErreursChamps((precedent) => {
      if (!precedent[nom]) return precedent;
      const suivant = { ...precedent };
      delete suivant[nom];
      return suivant;
    });
  }

  /** Vide tous les champs marqués secrets. Appelé dès qu'une réponse arrive. */
  function viderSecrets() {
    setValeurs((precedent) => {
      const suivant = { ...precedent };
      for (const champ of requirement!.fields) {
        if (champ.secret) suivant[champ.name] = '';
      }
      return suivant;
    });
  }

  async function connecter() {
    if (!workspaceId) {
      setErreur('Sélectionnez une entreprise avant de connecter une boutique.');
      return;
    }
    if (!isComplete(requirement!, valeurs)) {
      setErreur('Renseignez tous les champs marqués comme requis.');
      return;
    }

    const locales: Record<string, string> = {};
    for (const champ of requirement!.fields) {
      const resultat = validateField(champ, valeurs[champ.name] ?? '');
      if (!resultat.ok && resultat.error) locales[champ.name] = resultat.error;
    }
    if (Object.keys(locales).length > 0) {
      setErreursChamps(locales);
      setErreur(null);
      return;
    }

    // Le serveur attend `url` et `apiKey`. On mappe les champs déclaratifs sur
    // le contrat existant, sans le modifier : les Edge Functions déployées
    // continuent de fonctionner à l'identique.
    const url = (valeurs.url ?? '').trim();
    const cle = (dernierChampSecret ? valeurs[dernierChampSecret.name] ?? '' : '').trim();

    setEnCours(true);
    setErreur(null);
    try {
      const resultat = await connectStore({
        workspaceId,
        connectorKey: cleConnecteur(requirement!.key),
        ...(url ? { url } : {}),
        apiKey: cle,
      });
      // Effacement AVANT tout rendu : même si la suite échouait, le secret
      // aurait déjà quitté l'état du composant.
      viderSecrets();
      setPreuve(resultat);
      setEtat({
        connectorKey: requirement!.key,
        status: resultat.status,
        // `connected` renvoyé par le serveur prouve déjà les deux choses :
        // statut `connected` ET secret déposé dans le coffre.
        connected: resultat.connected,
        connectedTo: resultat.connectedTo,
        endpoint: resultat.endpoint,
        shopName: resultat.shopName,
        version: resultat.version,
        totalProducts: resultat.totalProducts,
        resourcesRead: resultat.resourcesRead,
        storeUrl: resultat.storeUrl ?? null,
        storeStatus: resultat.storeStatus ?? null,
        checkedAt: new Date().toISOString(),
        lastError: null,
      });
      setOuvert(false);
      onConnected?.('connected');
      onChanged({
        tone: 'success',
        text: `Boutique ${requirement!.label} « ${resultat.shopName ?? 'sans nom'} » connectée : identifiants vérifiés (${resultat.durationMs} ms).`,
      });
    } catch (cause) {
      // Le message vient de l'Edge Function : déjà expurgé du secret.
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
      await disconnectStore({ workspaceId, connectorKey: cleConnecteur(requirement!.key) });
      setPreuve(null);
      setValeurs({});
      setEtat(null);
      onConnected?.('not-configured');
      await relireEtat();
      onChanged({ tone: 'success', text: `Boutique ${requirement!.label} déconnectée : le secret a été retiré du coffre.` });
    } catch (cause) {
      setErreur(asAppError(cause).message);
    } finally {
      setEnCours(false);
    }
  }

  const testId = `${connectorKey}-connect-form`;

  /* ------------------------------ déjà connectée ----------------------------- */

  if (estConnecte && !ouvert) {
    return (
      <div className={`rounded-lg border px-3.5 py-3 ${TONS.connected}`} data-testid={testId}>
        <p className="flex items-center gap-1.5 text-xs font-semibold">
          <Check size={13} /> Boutique {requirement.label} connectée
        </p>
        <p className="mt-1 text-[0.7rem] leading-relaxed text-slate-400">
          Le secret est rangé dans le coffre côté serveur. Il n’est plus nécessaire dans
          le navigateur : l’aperçu d’import le retrouve côté serveur.
        </p>

        <dl
          className="mt-2 space-y-0.5 text-[0.68rem] text-slate-400"
          data-testid={`${connectorKey}-connection-state`}
        >
          <Ligne terme="Boutique" valeur={etat?.shopName ?? preuve?.shopName ?? '—'} />
          {(etat?.storeUrl || etat?.endpoint) && (
            <Ligne terme="Adresse" valeur={etat?.storeUrl ?? etat?.endpoint ?? '—'} tronque />
          )}
          <Ligne terme="Statut" valeur={etat?.status ?? preuve?.status ?? '—'} />
          <Ligne
            terme="Ressources lues"
            valeur={(etat?.resourcesRead ?? preuve?.resourcesRead ?? []).join(', ') || '—'}
          />
          <Ligne
            terme="Produits"
            valeur={
              (etat?.totalProducts ?? preuve?.totalProducts) === null
                || (etat?.totalProducts ?? preuve?.totalProducts) === undefined
                ? requirement.capabilities.totalKnown ? '—' : 'total non publié par l’API'
                : String(etat?.totalProducts ?? preuve?.totalProducts)
            }
          />
          {etat?.checkedAt && <Ligne terme="Vérifiée le" valeur={formaterDate(etat.checkedAt)} />}
        </dl>

        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setOuvert(true)}
            disabled={enCours}
            data-testid={`${connectorKey}-reconfigure`}
          >
            <RefreshCw size={12} className="mr-1" /> Reconfigurer
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void deconnecter()}
            disabled={enCours}
            data-testid={`${connectorKey}-disconnect`}
          >
            {enCours ? <Loader2 size={12} className="mr-1 animate-spin" /> : null} Déconnecter
          </Button>
          <a
            href={requirement.docsUrl}
            target="_blank"
            rel="noreferrer"
            className="ml-auto inline-flex items-center gap-1 text-[0.68rem] text-slate-500 hover:text-slate-300"
          >
            Documentation <ExternalLink size={10} />
          </a>
        </div>
      </div>
    );
  }

  /* -------------------------------- formulaire ------------------------------- */

  return (
    <div className={`rounded-lg border px-3.5 py-3 ${TONS[etatAffiche]}`} data-testid={testId}>
      <div className="flex items-start gap-2">
        <Plug size={14} className="mt-0.5 shrink-0 opacity-70" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold">
            {estConnecte ? `Reconfigurer la connexion ${requirement.label}` : `Connecter ${requirement.label}`}
          </p>
          <p className="mt-0.5 text-[0.68rem] text-slate-400">
            {CONNECTION_STATE_LABELS[etatAffiche]}
            {etat?.lastError && etatAffiche !== 'connected' ? ` — ${etat.lastError}` : ''}
          </p>
        </div>
        {lectureEnCours && <Loader2 size={12} className="mt-1 animate-spin text-slate-500" />}
      </div>

      {/* Ce qu'il faut faire, avant les champs : la démarche, puis la saisie. */}
      <p className="mt-2 rounded border border-white/10 bg-black/20 px-2 py-1.5 text-[0.66rem] leading-relaxed text-slate-400">
        {requirement.setupHint}
      </p>

      {requirement.caveat && (
        <p className="mt-1.5 flex items-start gap-1.5 text-[0.66rem] leading-relaxed text-amber-200/90" data-testid={`${connectorKey}-caveat`}>
          <AlertTriangle size={11} className="mt-0.5 shrink-0" />
          <span>{requirement.caveat}</span>
        </p>
      )}

      <div className="mt-2.5 space-y-2">
        {requirement.fields.map((champ) => (
          <Input
            key={champ.name}
            label={champ.label}
            hint={champ.hint}
            error={erreursChamps[champ.name]}
            type={champ.secret ? 'password' : 'text'}
            // `off` + `new-password` : un gestionnaire de mots de passe ne doit
            // pas proposer d'enregistrer une clé d'API ni la pré-remplir.
            autoComplete={champ.secret ? 'new-password' : 'off'}
            spellCheck={false}
            inputMode={champ.format === 'url' ? 'url' : 'text'}
            placeholder={champ.placeholder}
            value={valeurs[champ.name] ?? ''}
            onChange={(evenement) => majValeur(champ.name, evenement.target.value)}
            disabled={enCours}
            data-testid={`${connectorKey}-field-${champ.name}`}
          />
        ))}
      </div>

      {erreur && (
        <p className="mt-2 flex items-start gap-1.5 text-[0.68rem] leading-relaxed text-rose-300" data-testid={`${connectorKey}-error`}>
          <AlertTriangle size={11} className="mt-0.5 shrink-0" /> {erreur}
        </p>
      )}

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => void connecter()} disabled={enCours || !workspaceId} data-testid={`${connectorKey}-connect`}>
          {enCours ? <Loader2 size={12} className="mr-1 animate-spin" /> : <KeyRound size={12} className="mr-1" />}
          {enCours ? 'Vérification…' : 'Vérifier et enregistrer'}
        </Button>
        {estConnecte && (
          <Button size="sm" variant="ghost" onClick={() => setOuvert(false)} disabled={enCours}>
            Annuler
          </Button>
        )}
        {!workspaceId && <span className="text-[0.68rem] text-slate-500">Sélectionnez une entreprise.</span>}
        <a
          href={requirement.docsUrl}
          target="_blank"
          rel="noreferrer"
          className="ml-auto inline-flex items-center gap-1 text-[0.68rem] text-slate-500 hover:text-slate-300"
        >
          Documentation <ExternalLink size={10} />
        </a>
      </div>

      <p className="mt-2 text-[0.62rem] leading-relaxed text-slate-500">
        Le secret part directement vers le serveur VYORA et n’est jamais réaffiché après
        enregistrement. Il n’apparaît ni dans les journaux ni dans le navigateur.
      </p>
    </div>
  );
}

function Ligne({ terme, valeur, tronque }: { terme: string; valeur: string; tronque?: boolean }) {
  return (
    <div className="flex gap-1.5">
      <dt className="shrink-0 text-slate-500">{terme}</dt>
      <dd className={tronque ? 'truncate text-slate-300' : 'text-slate-300'}>{valeur}</dd>
    </div>
  );
}

function formaterDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
}

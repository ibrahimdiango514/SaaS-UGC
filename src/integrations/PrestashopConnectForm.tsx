/**
 * Connexion PrestaShop depuis la fiche du catalogue d'intégrations.
 *
 * ## Pourquoi ce formulaire vit ici et pas dans la fiche
 * La fiche affiche un état ; ce composant détient une clé le temps d'un envoi.
 * Les séparer permet de garantir une chose simple et vérifiable : **la clé
 * n'existe que dans cet état local**, jamais dans le composant parent, jamais
 * dans un contexte partagé, et elle est vidée dès que le serveur a répondu.
 *
 * ## Ce qui est vérifié, et par qui
 * Le navigateur n'ouvre aucune connexion vers la boutique : il n'envoie que
 * l'adresse et la clé à l'Edge Function `store-connect`, qui résout le domaine,
 * refuse les adresses internes, se connecte sur l'IP contrôlée, lit réellement
 * `shops` et `languages`, puis range la clé dans Vault. Le retour affiché est
 * la preuve de cette lecture (nom de boutique, version, ressources lues).
 */
import { useState } from 'react';
import { AlertTriangle, Check, KeyRound, Loader2 } from 'lucide-react';
import { Button } from '../components/ui';
import { asAppError } from '../lib/errors';
import { connectStore, disconnectStore, type StoreConnectionResult } from '../business/importer/connect-relay';

export interface PrestashopConnectFormProps {
  /** Entreprise active : la connexion y sera rattachée. */
  workspaceId: string | null;
  /** Appelé après une connexion ou une déconnexion réussie (relecture d'état). */
  onChanged: (message: { tone: 'success' | 'error'; text: string }) => void;
  /** Déjà connecté : le formulaire devient un bouton de déconnexion. */
  connected: boolean;
}

export function PrestashopConnectForm({ workspaceId, onChanged, connected }: PrestashopConnectFormProps) {
  const [url, setUrl] = useState('');
  const [cle, setCle] = useState('');
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const [preuve, setPreuve] = useState<StoreConnectionResult | null>(null);

  async function connecter() {
    if (!workspaceId) {
      setErreur('Sélectionnez une entreprise avant de connecter une boutique.');
      return;
    }
    if (!url.trim()) {
      setErreur('Saisissez l’adresse de votre boutique PrestaShop.');
      return;
    }
    if (cle.trim().length < 8) {
      setErreur('La clé Webservice PrestaShop est requise (au moins 8 caractères).');
      return;
    }
    setEnCours(true);
    setErreur(null);
    try {
      const resultat = await connectStore({
        workspaceId, connectorKey: 'prestashop', url: url.trim(), apiKey: cle.trim(),
      });
      // La clé est effacée AVANT tout rendu : même si le rendu échouait
      // ensuite, elle n'est plus dans l'état du composant.
      setCle('');
      setPreuve(resultat);
      onChanged({
        tone: 'success',
        text: `${resultat.shopName ?? 'Boutique'} connectée : ${resultat.totalProducts ?? 0} produit(s) lu(s) par l’API.`,
      });
    } catch (cause) {
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
      await disconnectStore({ workspaceId, connectorKey: 'prestashop' });
      setPreuve(null);
      setCle('');
      onChanged({ tone: 'success', text: 'Boutique déconnectée : la clé a été retirée du coffre.' });
    } catch (cause) {
      setErreur(asAppError(cause).message);
    } finally {
      setEnCours(false);
    }
  }

  return (
    <div className="rounded-lg border border-brand-400/25 bg-brand-500/[0.06] px-3.5 py-3" data-testid="prestashop-connect-form">
      {connected ? (
        <>
          <p className="flex items-center gap-1.5 text-xs font-semibold text-emerald-200">
            <Check size={13} /> Boutique connectée
          </p>
          <p className="mt-1 text-[0.7rem] leading-relaxed text-slate-400">
            La clé Webservice est rangée côté serveur. Elle n’est plus nécessaire dans le
            navigateur : l’aperçu d’import la retrouve dans le coffre.
          </p>
          <Button
            variant="danger"
            size="sm"
            className="mt-2.5"
            loading={enCours}
            onClick={() => void deconnecter()}
            data-testid="prestashop-disconnect"
          >
            Déconnecter la boutique
          </Button>
        </>
      ) : (
        <>
          <p className="flex items-center gap-1.5 text-xs font-semibold text-brand-200">
            <KeyRound size={13} /> Connecter votre boutique PrestaShop
          </p>
          <p className="mt-1 text-[0.7rem] leading-relaxed text-slate-400">
            Créez une clé dans PrestaShop (Paramètres avancés → Webservice), avec les droits
            de lecture du catalogue. Elle est vérifiée par le serveur puis rangée dans un
            coffre chiffré : elle ne revient jamais dans le navigateur.
          </p>
          <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
            <input
              type="url"
              inputMode="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://ma-boutique.com"
              aria-label="Adresse de la boutique PrestaShop"
              disabled={enCours || !workspaceId}
              className="rounded-lg border border-line bg-black/30 px-2.5 py-1.5 text-[0.7rem] text-slate-200 placeholder:text-slate-600 focus:border-brand-400/50 focus:outline-none disabled:opacity-50"
              data-testid="prestashop-url"
            />
            {/* `type="password"` : la clé ne reste pas lisible à l'écran. */}
            <input
              type="password"
              value={cle}
              onChange={(e) => setCle(e.target.value)}
              placeholder="Clé Webservice"
              aria-label="Clé Webservice PrestaShop"
              autoComplete="off"
              disabled={enCours || !workspaceId}
              className="rounded-lg border border-line bg-black/30 px-2.5 py-1.5 text-[0.7rem] text-slate-200 placeholder:text-slate-600 focus:border-brand-400/50 focus:outline-none disabled:opacity-50"
              data-testid="prestashop-key"
            />
          </div>
          <Button
            variant="primary"
            size="sm"
            className="mt-2"
            loading={enCours}
            disabled={!workspaceId || !url.trim() || cle.trim().length < 8}
            onClick={() => void connecter()}
            icon={<KeyRound size={13} />}
            data-testid="prestashop-submit"
          >
            Vérifier et connecter
          </Button>
          {!workspaceId && (
            <p className="mt-1.5 text-[0.68rem] text-amber-200">
              Sélectionnez une entreprise : la connexion y sera rattachée.
            </p>
          )}
          {enCours && (
            <p className="mt-1.5 flex items-center gap-1 text-[0.68rem] text-slate-400">
              <Loader2 size={11} className="animate-spin" /> Lecture réelle de votre boutique en cours…
            </p>
          )}
        </>
      )}

      {erreur && (
        <p role="alert" className="mt-1.5 flex items-start gap-1 text-[0.68rem] text-rose-200" data-testid="prestashop-connect-error">
          <AlertTriangle size={11} className="mt-0.5 shrink-0" /> {erreur}
        </p>
      )}

      {preuve && !erreur && (
        <div className="mt-1.5 text-[0.68rem] text-slate-400" data-testid="prestashop-proof">
          <p>
            {preuve.shopName ?? 'Boutique'}
            {preuve.version ? ` · PrestaShop ${preuve.version}` : ''}
            {preuve.totalProducts !== null ? ` · ${preuve.totalProducts} produit(s)` : ''}
          </p>
          {/* Adresse réellement contactée : preuve du contrôle SSRF. */}
          <p className="text-slate-500">adresse contrôlée : {preuve.connectedTo}</p>
          <p className="text-slate-500">ressources lues : {preuve.resourcesRead.join(', ') || '—'}</p>
        </div>
      )}
    </div>
  );
}

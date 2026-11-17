/**
 * VYORA — panneau d'import de boutique.
 *
 * ## Parcours, en trois étapes visibles
 *
 *   1. **Choisir la source** : URL de boutique, ou fichier (CSV/XLSX/XML).
 *   2. **Prévisualiser** : produits, prix, images, catégories, variantes,
 *      doublons et avertissements. Rien n'est encore écrit.
 *   3. **Confirmer** : l'écriture n'a lieu qu'après un clic explicite, et le
 *      décompte des produits réellement créés est rapporté tel quel.
 *
 * ## Import par URL : toujours via le serveur
 *
 * Le navigateur ne contacte **jamais** la boutique : il ne peut ni résoudre le
 * DNS ni épingler une IP. L'URL part vers l'Edge Function `store-import`
 * (`relay.ts`), qui valide, résout, contrôle chaque adresse avant connexion,
 * lit le catalogue et renvoie un aperçu. La confirmation renvoie le
 * `previewId` émis par le serveur — le navigateur ne peut donc pas écrire un
 * catalogue qu'il n'a pas prévisualisé.
 *
 * ## Import par fichier : aussi via le serveur
 *
 * Le fichier était auparavant analysé localement puis écrit par des `insert`
 * PostgREST successifs. Ces `insert` ne sont contrôlés que par l'appartenance à
 * l'entreprise (`ugc_private.can_edit_workspace`), **pas par l'abonnement** :
 * un compte sans abonnement pouvait donc créer des produits, alors qu'il était
 * refusé sur le chemin URL. Un verrou qui ne protège qu'une porte n'est pas un
 * verrou.
 *
 * Le fichier est maintenant envoyé à la même Edge Function, qui vérifie
 * l'abonnement avant toute analyse et n'écrit qu'après confirmation explicite.
 *
 * ## Ce que l'interface ne fait pas
 *
 * - Aucune requête réseau directe vers la boutique.
 * - Aucune écriture directe dans `ugc_products` : l'écriture est serveur, donc
 *   soumise à la garde d'abonnement.
 * - Aucun produit affiché tant que la prévisualisation n'a pas réussi.
 * - Aucune écriture sans confirmation explicite.
 * - Aucun produit créé pendant l'aperçu, ni côté navigateur ni côté serveur.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle, ArrowLeft, Check, FileSpreadsheet, Globe, KeyRound, Link2, Loader2, Package,
  RotateCcw, Upload, X,
} from 'lucide-react';
import { Button, cn } from '../../components/ui';
import { asAppError } from '../../lib/errors';
import { PLATFORM_LABELS } from './platform';
import {
  importStore, previewConnectedStore, previewFile, previewStore, previewValidity,
  type PreviewValidity, type StorePreview,
} from './relay';
import {
  connectStore, disconnectStore, readConnection,
  type StoreConnectionResult, type StoreConnectionState,
} from './connect-relay';

export interface StoreImportPanelProps {
  workspaceId: string | null;
  /**
   * Catalogue existant.
   *
   * Conservé dans l'interface publique, mais **plus utilisé pour décider** : la
   * détection de doublons est faite par le serveur, sur son propre catalogue.
   * Un navigateur qui se tromperait ne peut donc pas contourner la règle.
   */
  existing: Array<{ id: string; name: string }>;
  /** Appelé après une écriture réussie, pour rafraîchir la liste. */
  onImported: () => void | Promise<void>;
  onClose: () => void;
}

type Étape = 'source' | 'apercu' | 'ecriture';

export function StoreImportPanel({ workspaceId, onImported, onClose }: StoreImportPanelProps) {
  const [étape, setÉtape] = useState<Étape>('source');
  const [erreurs, setErreurs] = useState<string[]>([]);
  const [avertissements, setAvertissements] = useState<string[]>([]);
  const [chargement, setChargement] = useState(false);
  const [écriture, setÉcriture] = useState(false);
  const [résultat, setRésultat] = useState<{ créés: number; échecs: Array<{ nom: string; raison: string }> } | null>(null);
  const [glisser, setGlisser] = useState(false);
  const fichierInput = useRef<HTMLInputElement>(null);
  /**
   * L'adresse de la boutique PrestaShop (`urlPrestashop`) et celle de l'aperçu
   * public (`url`) sont deux champs distincts : partager un seul état ferait
   * qu'une adresse de connexion écraserait silencieusement l'URL d'un aperçu en
   * cours, et l'utilisateur verrait deux champs identiques se répercuter l'un
   * l'autre.
   */
  const [url, setUrl] = useState('');
  const [urlPrestashop, setUrlPrestashop] = useState('');
  /** Aperçu renvoyé par le serveur : seule source d'une écriture par URL. */
  const [apercuServeur, setApercuServeur] = useState<StorePreview | null>(null);
  /**
   * Validité de l'aperçu, recalculée chaque seconde.
   *
   * `null` tant qu'aucun aperçu n'existe. L'état `expired` désactive le bouton
   * de confirmation : on ne propose jamais une action que le serveur refusera.
   */
  const [validité, setValidité] = useState<PreviewValidity | null>(null);
  /**
   * Dernière source prévisualisée, conservée pour la relance.
   *
   * Sans elle, « relancer l'analyse » obligerait l'utilisateur à retrouver son
   * fichier et à le redéposer — c'est précisément la confusion à éviter quand
   * un aperçu expire.
   */
  const [dernièreSource, setDernièreSource] = useState<
    | { kind: 'file'; fichier: File }
    | { kind: 'url'; url: string }
    | { kind: 'chariow' }
    | null
  >(null);

  /*
   * Connexion par clé d'API (PrestaShop).
   *
   * La clé saisie ne quitte cet état qu'une fois envoyée au serveur : elle
   * n'est ni recopiée dans l'URL, ni conservée après la réponse, ni renvoyée
   * par l'API. Ce qui reste à l'écran après une connexion réussie est la
   * PREUVE de ce qui a été lu (boutique, version, nombre de produits),
   * jamais le secret.
   */
  const [cléApi, setCléApi] = useState('');
  /**
   * Clé Chariow et état de SA connexion, séparés de ceux de PrestaShop.
   *
   * Un état partagé ferait qu'une clé PrestaShop saisie resterait affichée
   * après avoir basculé sur Chariow, et que « connecté » d'un connecteur
   * s'afficherait pour l'autre. Deux connecteurs, deux secrets, deux états.
   */
  const [cléChariow, setCléChariow] = useState('');
  const [connexionChariow, setConnexionChariow] = useState<StoreConnectionState | null>(null);
  const [connexionChariowEnCours, setConnexionChariowEnCours] = useState(false);
  const [connexionChariowErreur, setConnexionChariowErreur] = useState<string | null>(null);
  const [connexion, setConnexion] = useState<StoreConnectionState | null>(null);
  const [connexionEnCours, setConnexionEnCours] = useState(false);
  const [connexionErreur, setConnexionErreur] = useState<string | null>(null);
  const [, setConnexionOk] = useState<StoreConnectionResult | null>(null);

  /**
   * L'aperçu par URL passe par l'Edge Function `store-import`, seule à disposer
   * d'un résolveur DNS et d'une connexion épinglée sur l'IP validée. Aucun appel
   * direct à la boutique n'est possible depuis le navigateur.
   */
  const relaisDisponible = typeof window !== 'undefined';

  /**
   * Relit l'état de connexion quand l'entreprise change.
   *
   * L'écran doit refléter la réalité au retour de l'utilisateur : afficher
   * « non connecté » alors qu'une connexion existe l'obligerait à ressaisir sa
   * clé, et afficher « connecté » après une déconnexion ferait échouer son
   * aperçu sans explication. En cas d'échec de lecture, on n'invente rien — on
   * laisse l'état inconnu et la saisie disponible.
   */
  useEffect(() => {
    let annulé = false;
    setConnexion(null);
    setConnexionOk(null);
    setConnexionErreur(null);
    if (!workspaceId) return;
    void (async () => {
      try {
        const état = await readConnection({ workspaceId, connectorKey: 'prestashop' });
        if (!annulé) setConnexion(état);
      } catch {
        if (!annulé) setConnexion(null);
      }
      // Chariow a sa PROPRE connexion : la lire ici aussi, sinon l'écran
      // afficherait « non connecté » sur une boutique déjà liée, et l'utilisateur
      // ressaisirait une clé qu'il n'a plus (elle n'est affichée qu'une fois).
      try {
        const état = await readConnection({ workspaceId, connectorKey: 'chariow' });
        if (!annulé) setConnexionChariow(état);
      } catch {
        if (!annulé) setConnexionChariow(null);
      }
    })();
    return () => { annulé = true; };
  }, [workspaceId]);

  /**
   * Connecte la boutique : le serveur vérifie la clé en lisant réellement
   * l'API, puis dépose le secret dans Vault.
   */
  const connecter = async () => {
    if (!workspaceId) {
      setConnexionErreur('Sélectionnez une entreprise avant de connecter une boutique.');
      return;
    }
    const adresse = urlPrestashop.trim();
    if (!adresse) {
      setConnexionErreur('Saisissez l’adresse de votre boutique PrestaShop.');
      return;
    }
    if (cléApi.trim().length < 8) {
      setConnexionErreur('La clé Webservice PrestaShop est requise (au moins 8 caractères).');
      return;
    }
    setConnexionEnCours(true);
    setConnexionErreur(null);
    setConnexionOk(null);
    try {
      const résultat = await connectStore({
        workspaceId, connectorKey: 'prestashop', url: adresse, apiKey: cléApi.trim(),
      });
      setConnexionOk(résultat);
      // La clé n'est plus nécessaire : le serveur la retrouve dans Vault.
      setCléApi('');
      setConnexion({
        connectorKey: 'prestashop',
        status: résultat.status,
        connectedTo: résultat.connectedTo,
        endpoint: résultat.endpoint,
        shopName: résultat.shopName,
        version: résultat.version,
        totalProducts: résultat.totalProducts,
        resourcesRead: résultat.resourcesRead,
        checkedAt: new Date().toISOString(),
        lastError: null,
      });
    } catch (erreur) {
      setConnexionErreur(asAppError(erreur).message);
    } finally {
      setConnexionEnCours(false);
    }
  };

  /** Déconnecte : la boutique n'est plus lisible, l'aperçu le dira clairement. */
  const déconnecter = async () => {
    if (!workspaceId) return;
    setConnexionEnCours(true);
    setConnexionErreur(null);
    try {
      await disconnectStore({ workspaceId, connectorKey: 'prestashop' });
      setConnexionOk(null);
      setConnexion(null);
    } catch (erreur) {
      setConnexionErreur(asAppError(erreur).message);
    } finally {
      setConnexionEnCours(false);
    }
  };

  /**
   * Connecte la boutique Chariow : le serveur vérifie la clé en lisant
   * réellement `GET /v1/store` puis `GET /v1/products`, puis la range dans
   * Vault. Aucune URL n'est demandée : l'API est hébergée chez Chariow.
   */
  const connecterChariow = async () => {
    if (!workspaceId) {
      setConnexionChariowErreur('Sélectionnez une entreprise avant de connecter une boutique.');
      return;
    }
    const clé = cléChariow.trim();
    if (!clé.startsWith('sk_') || clé.length < 20) {
      setConnexionChariowErreur('Collez la clé Chariow complète (elle commence par « sk_ »).');
      return;
    }
    setConnexionChariowEnCours(true);
    setConnexionChariowErreur(null);
    try {
      const résultat = await connectStore({ workspaceId, connectorKey: 'chariow', apiKey: clé });
      // Effacée avant tout rendu : elle ne doit pas rester dans l'état.
      setCléChariow('');
      setConnexionChariow({
        connectorKey: 'chariow',
        status: résultat.status,
        connected: true,
        connectedTo: résultat.connectedTo,
        endpoint: résultat.endpoint,
        shopName: résultat.shopName,
        version: null,
        totalProducts: résultat.totalProducts,
        resourcesRead: résultat.resourcesRead,
        storeUrl: résultat.storeUrl ?? null,
        storeStatus: résultat.storeStatus ?? null,
        checkedAt: new Date().toISOString(),
        lastError: null,
      });
    } catch (erreur) {
      setConnexionChariowErreur(asAppError(erreur).message);
    } finally {
      setConnexionChariowEnCours(false);
    }
  };

  /** Déconnecte Chariow : le secret quitte Vault, l'aperçu le dira ensuite. */
  const déconnecterChariow = async () => {
    if (!workspaceId) return;
    setConnexionChariowEnCours(true);
    setConnexionChariowErreur(null);
    try {
      await disconnectStore({ workspaceId, connectorKey: 'chariow' });
      setConnexionChariow(null);
      setCléChariow('');
    } catch (erreur) {
      setConnexionChariowErreur(asAppError(erreur).message);
    } finally {
      setConnexionChariowEnCours(false);
    }
  };

  /**
   * Aperçu du catalogue Chariow — **aucune écriture**.
   *
   * Aucune URL n'est envoyée : la clé vient de Vault côté serveur, et l'hôte
   * de l'API est fixe. Le navigateur ne contacte donc ni Chariow ni la vitrine.
   */
  const prévisualiserChariow = async () => {
    if (!workspaceId) {
      setErreurs(['Sélectionnez une entreprise avant d’importer.']);
      return;
    }
    setChargement(true);
    setErreurs([]);
    setAvertissements([]);
    setRésultat(null);
    setApercuServeur(null);
    try {
      const apercu = await previewConnectedStore({ workspaceId, connectorKey: 'chariow' });
      setApercuServeur(apercu);
      setAvertissements(apercu.warnings);
      setDernièreSource({ kind: 'chariow' });
      setÉtape('apercu');
    } catch (erreur) {
      setErreurs([asAppError(erreur).message]);
    } finally {
      setChargement(false);
    }
  };

  const réinitialiser = useCallback(() => {
    setErreurs([]);
    setAvertissements([]);
    setRésultat(null);
    setÉtape('source');
  }, []);

  /**
   * Import par fichier — **via le serveur**.
   *
   * Le fichier n'est plus analysé localement puis écrit par des `insert`
   * PostgREST : il part à l'Edge Function, qui vérifie l'abonnement avant même
   * de l'analyser. C'est ce qui rend la restriction réelle et non décorative.
   */
  const traiterFichier = async (fichier: File) => {
    if (!workspaceId) {
      setErreurs(['Sélectionnez une entreprise avant d’importer.']);
      return;
    }
    setChargement(true);
    setErreurs([]);
    setAvertissements([]);
    setRésultat(null);
    setApercuServeur(null);
    try {
      const octets = new Uint8Array(await fichier.arrayBuffer());
      const apercu = await previewFile({ workspaceId, fileName: fichier.name, bytes: octets });
      setApercuServeur(apercu);
      setAvertissements(apercu.warnings);
      setDernièreSource({ kind: 'file', fichier });
      setÉtape('apercu');
    } catch (erreur) {
      setErreurs([asAppError(erreur).message]);
    } finally {
      setChargement(false);
    }
  };

  /**
   * Aperçu d'une boutique par URL — **aucune écriture**.
   *
   * L'URL part au serveur qui la valide, résout le DNS, contrôle chaque adresse
   * avant connexion et lit le catalogue public. Le navigateur n'ouvre aucune
   * connexion vers la boutique.
   */
  const prévisualiserUrl = async () => {
    if (!workspaceId) {
      setErreurs(['Sélectionnez une entreprise avant d’importer.']);
      return;
    }
    const saisie = url.trim();
    if (!saisie) {
      setErreurs(['Saisissez l’adresse de votre boutique (https://…).']);
      return;
    }
    setChargement(true);
    setErreurs([]);
    setAvertissements([]);
    setRésultat(null);
    setApercuServeur(null);
    try {
      const apercu = await previewStore({ workspaceId, url: saisie });
      setApercuServeur(apercu);
      setAvertissements(apercu.warnings);
      setDernièreSource({ kind: 'url', url: saisie });
      setÉtape('apercu');
    } catch (erreur) {
      setErreurs([asAppError(erreur).message]);
    } finally {
      setChargement(false);
    }
  };

  /**
   * Confirmation de l'import — URL **ou** fichier.
   *
   * Envoie le `previewId` émis par le serveur : le navigateur ne peut pas
   * écrire un catalogue qu'il n'a pas prévisualisé, et un aperçu ne se rejoue
   * pas. Les produits retenus sont ceux que le serveur a marqués importables.
   */
  const confirmer = async () => {
    if (!apercuServeur || !workspaceId) return;
    setÉcriture(true);
    setÉtape('ecriture');
    try {
      const sélection = apercuServeur.products.filter((p) => p.importable).map((p) => p.index);
      const résultat = await importStore({
        workspaceId,
        previewId: apercuServeur.previewId,
        selection: sélection,
      });
      setRésultat({
        créés: résultat.created,
        échecs: résultat.failed.map((f) => ({ nom: f.name, raison: f.reason })),
      });
      setApercuServeur(null);
      if (résultat.created > 0) await onImported();
    } catch (erreur) {
      // Aperçu expiré ou consommé : on renvoie vers un nouvel aperçu.
      setErreurs([asAppError(erreur).message]);
      setApercuServeur(null);
      setÉtape('source');
    } finally {
      setÉcriture(false);
    }
  };

  /**
   * Recale la validité de l'aperçu, une fois par seconde.
   *
   * ## Pourquoi un minuteur côté client alors que le serveur décide
   * Le serveur reste seul juge (il refuse un aperçu échu, quel que soit
   * l'affichage). Le minuteur sert uniquement à prévenir avant l'échec et à
   * désactiver un bouton qui ne mènerait nulle part. Il ne peut donc pas rendre
   * un aperçu valide : au pire, il l'affiche expiré un instant trop tôt, et
   * l'utilisateur relance — jamais l'inverse.
   */
  useEffect(() => {
    if (!apercuServeur) {
      setValidité(null);
      return;
    }
    const recalculer = () => setValidité(previewValidity(apercuServeur.expiresAt, Date.now()));
    recalculer();
    const minuteur = setInterval(recalculer, 1000);
    return () => clearInterval(minuteur);
  }, [apercuServeur]);

  /**
   * Relance l'analyse de la même source.
   *
   * Conserve la source d'origine pour éviter de faire redéposer le fichier.
   * Le nouvel aperçu reçoit un nouvel identifiant : l'ancien reste consommable
   * par le serveur jusqu'à son échéance, mais l'interface n'en propose plus la
   * confirmation.
   */
  const relancer = async () => {
    if (!dernièreSource) return;
    if (dernièreSource.kind === 'file') await traiterFichier(dernièreSource.fichier);
    else if (dernièreSource.kind === 'chariow') await prévisualiserChariow();
    else {
      setUrl(dernièreSource.url);
      await prévisualiserUrl();
    }
  };

  const surDépôt = async (événement: React.DragEvent<HTMLDivElement>) => {
    événement.preventDefault();
    setGlisser(false);
    const fichier = événement.dataTransfer.files?.[0];
    if (fichier) await traiterFichier(fichier);
  };

  return (
    <div className="rounded-2xl border border-cyan-300/20 bg-cyan-400/[0.03] p-4" data-testid="store-importer">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="flex items-center gap-1.5 text-xs font-semibold text-cyan-100">
            <Package size={14} /> Importer un catalogue
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
            Rien n’est enregistré avant votre confirmation. Les prix, images et
            catégories sont vérifiés avant l’aperçu.
          </p>
        </div>
        <button type="button" onClick={onClose} className="text-slate-500 transition hover:text-white" aria-label="Fermer l’import">
          <X size={16} />
        </button>
      </div>

      {erreurs.length > 0 && (
        <div role="alert" className="mt-3 rounded-xl border border-rose-400/25 bg-rose-400/[0.06] px-3 py-2.5 text-[11px] text-rose-100">
          <p className="flex items-center gap-1.5 font-semibold"><AlertTriangle size={13} /> Import impossible</p>
          <ul className="mt-1 space-y-0.5">
            {erreurs.map((erreur) => <li key={erreur}>· {erreur}</li>)}
          </ul>
        </div>
      )}

      {/* Étape 1 — source */}
      {étape === 'source' && (
        <div className="mt-3 space-y-3">
          <div
            onDragOver={(e) => { e.preventDefault(); setGlisser(true); }}
            onDragLeave={() => setGlisser(false)}
            onDrop={(e) => void surDépôt(e)}
            className={cn(
              'rounded-xl border border-dashed px-4 py-6 text-center transition',
              glisser ? 'border-cyan-300/60 bg-cyan-400/[0.08]' : 'border-white/15 bg-black/20',
            )}
          >
            <FileSpreadsheet size={22} className="mx-auto text-cyan-300/80" />
            <p className="mt-2 text-xs text-slate-300">Déposez un fichier CSV, XLSX ou XML</p>
            <p className="mt-0.5 text-[10px] text-slate-500">8 Mio maximum · aucune formule n’est évaluée</p>
            <input
              ref={fichierInput}
              type="file"
              accept=".csv,.tsv,.xlsx,.xml,text/csv,application/xml,text/xml"
              className="sr-only"
              onChange={(e) => {
                const fichier = e.target.files?.[0];
                if (fichier) void traiterFichier(fichier);
              }}
            />
            <Button
              size="sm"
              variant="outline"
              className="mt-3"
              loading={chargement}
              onClick={() => fichierInput.current?.click()}
              icon={<Upload size={13} />}
            >
              Choisir un fichier
            </Button>
          </div>

          {/* Connexion PrestaShop — la clé part au serveur, jamais l'inverse */}
          <div className="rounded-xl border border-white/[0.07] bg-black/20 px-3 py-2.5" data-testid="store-connect">
            <p className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-300">
              <KeyRound size={13} className="text-slate-500" /> Boutique PrestaShop (clé Webservice)
            </p>
            <p className="mt-1 text-[10px] leading-relaxed text-slate-500">
              La clé est vérifiée par le serveur, puis rangée dans un coffre chiffré.
              Elle ne revient jamais dans le navigateur, et n’apparaît ni dans les
              journaux ni dans les réponses.
            </p>

            {connexion?.status === 'connected' ? (
              <div className="mt-2 rounded-lg border border-emerald-400/20 bg-emerald-400/[0.05] px-2.5 py-2 text-[10px] text-emerald-100" data-testid="store-connect-connected">
                <p className="flex items-center gap-1.5 font-semibold"><Check size={11} /> Boutique connectée</p>
                {connexion.shopName && <p className="mt-0.5 text-slate-300">{connexion.shopName}{connexion.version ? ` · ${connexion.version}` : ''}</p>}
                {connexion.totalProducts !== null && (
                  <p className="text-slate-400">{connexion.totalProducts} produit(s) annoncé(s) par l’API</p>
                )}
                {connexion.connectedTo && (
                  // Preuve du contrôle SSRF : l'adresse réellement contactée.
                  <p className="text-slate-500">adresse contrôlée : {connexion.connectedTo}</p>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  className="mt-1.5"
                  loading={connexionEnCours}
                  onClick={() => void déconnecter()}
                  icon={<X size={12} />}
                  data-testid="store-connect-disconnect"
                >
                  Déconnecter
                </Button>
              </div>
            ) : (
              <>
                <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
                  <input
                    type="url"
                    inputMode="url"
                    value={urlPrestashop}
                    onChange={(événement) => setUrlPrestashop(événement.target.value)}
                    placeholder="https://ma-boutique.com"
                    aria-label="Adresse de la boutique PrestaShop"
                    disabled={connexionEnCours || !workspaceId}
                    className="rounded-lg border border-white/[0.09] bg-black/30 px-2.5 py-1.5 text-[11px] text-slate-200 placeholder:text-slate-600 focus:border-cyan-300/40 focus:outline-none disabled:opacity-50"
                    data-testid="store-connect-url"
                  />
                  {/* `type="password"` : la clé ne doit pas rester lisible à l'écran. */}
                  <input
                    type="password"
                    value={cléApi}
                    onChange={(événement) => setCléApi(événement.target.value)}
                    placeholder="Clé Webservice"
                    aria-label="Clé Webservice PrestaShop"
                    autoComplete="off"
                    disabled={connexionEnCours || !workspaceId}
                    className="rounded-lg border border-white/[0.09] bg-black/30 px-2.5 py-1.5 text-[11px] text-slate-200 placeholder:text-slate-600 focus:border-cyan-300/40 focus:outline-none disabled:opacity-50"
                    data-testid="store-connect-key"
                  />
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    loading={connexionEnCours}
                    disabled={!workspaceId || !urlPrestashop.trim() || cléApi.trim().length < 8}
                    onClick={() => void connecter()}
                    icon={<KeyRound size={13} />}
                    data-testid="store-connect-submit"
                  >
                    Vérifier et connecter
                  </Button>
                  {connexion?.status === 'error' && connexion.lastError && (
                    <span className="text-[10px] text-amber-200">{connexion.lastError}</span>
                  )}
                </div>
              </>
            )}

            {connexionErreur && (
              <p className="mt-1.5 text-[10px] text-rose-200" data-testid="store-connect-error">{connexionErreur}</p>
            )}
          </div>

          {/* --- Chariow : clé API, sans URL (API hébergée chez l'éditeur) --- */}
          <div
            className="rounded-xl border border-white/[0.07] bg-black/20 px-3 py-2.5"
            data-testid="store-chariow-block"
          >
            <p className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-300">
              <KeyRound size={13} className="text-slate-500" /> Boutique Chariow (clé API)
            </p>

            {connexionChariow?.connected ? (
              <>
                <p className="mt-1 text-[10px] leading-relaxed text-emerald-200" data-testid="store-chariow-connected">
                  Connectée : {connexionChariow.shopName ?? 'boutique Chariow'}
                  {connexionChariow.storeUrl ? ` · ${connexionChariow.storeUrl}` : ''}
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    loading={chargement}
                    disabled={!workspaceId}
                    onClick={() => void prévisualiserChariow()}
                    icon={<Link2 size={13} />}
                    data-testid="store-chariow-preview"
                  >
                    Prévisualiser le catalogue
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={connexionChariowEnCours}
                    onClick={() => void déconnecterChariow()}
                    data-testid="store-chariow-disconnect"
                  >
                    Déconnecter
                  </Button>
                </div>
              </>
            ) : (
              <>
                <p className="mt-1 text-[10px] leading-relaxed text-slate-500">
                  Clé créée dans app.chariow.com → Settings → API Keys, avec les scopes
                  « products.read » et « store.read ». Le serveur la vérifie en lisant réellement
                  votre boutique, puis la range dans le coffre. Elle n’est jamais renvoyée au navigateur.
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <input
                    type="password"
                    value={cléChariow}
                    onChange={(événement) => setCléChariow(événement.target.value)}
                    onKeyDown={(événement) => {
                      if (événement.key === 'Enter') {
                        événement.preventDefault();
                        void connecterChariow();
                      }
                    }}
                    placeholder="sk_live_…"
                    aria-label="Clé API Chariow"
                    autoComplete="off"
                    spellCheck={false}
                    disabled={connexionChariowEnCours || !workspaceId}
                    className="min-w-0 flex-1 rounded-lg border border-white/[0.09] bg-black/30 px-2.5 py-1.5 font-mono text-[11px] text-slate-200 placeholder:text-slate-600 focus:border-cyan-300/40 focus:outline-none disabled:opacity-50"
                    data-testid="store-chariow-key"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    loading={connexionChariowEnCours}
                    disabled={!workspaceId || cléChariow.trim().length < 20}
                    onClick={() => void connecterChariow()}
                    icon={<KeyRound size={13} />}
                    data-testid="store-chariow-connect"
                  >
                    Vérifier et connecter
                  </Button>
                </div>
              </>
            )}

            {connexionChariowErreur && (
              <p className="mt-1.5 text-[10px] text-rose-200" data-testid="store-chariow-error">
                {connexionChariowErreur}
              </p>
            )}
          </div>

          <div className="rounded-xl border border-white/[0.07] bg-black/20 px-3 py-2.5">
            <p className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-300">
              <Globe size={13} className="text-slate-500" /> Importer depuis une URL de boutique
            </p>
            <p className="mt-1 text-[10px] leading-relaxed text-slate-500">
              Lecture effectuée par le serveur VYORA : vérification DNS, refus des
              adresses internes et connexion épinglée sur l’adresse contrôlée.
              Votre navigateur ne contacte jamais la boutique.
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input
                type="url"
                inputMode="url"
                value={url}
                onChange={(événement) => setUrl(événement.target.value)}
                onKeyDown={(événement) => {
                  if (événement.key === 'Enter') {
                    événement.preventDefault();
                    void prévisualiserUrl();
                  }
                }}
                placeholder="https://ma-boutique.com"
                aria-label="Adresse de la boutique"
                disabled={chargement || !workspaceId || !relaisDisponible}
                className="min-w-0 flex-1 rounded-lg border border-white/[0.09] bg-black/30 px-2.5 py-1.5 text-[11px] text-slate-200 placeholder:text-slate-600 focus:border-cyan-300/40 focus:outline-none disabled:opacity-50"
                data-testid="store-url-input"
              />
              <Button
                size="sm"
                variant="outline"
                loading={chargement}
                disabled={!workspaceId || !url.trim()}
                onClick={() => void prévisualiserUrl()}
                icon={<Link2 size={13} />}
                data-testid="store-url-preview"
              >
                Prévisualiser
              </Button>
            </div>
            {!workspaceId && (
              <p className="mt-1.5 text-[10px] text-amber-200">
                Sélectionnez une entreprise pour importer dans son catalogue.
              </p>
            )}
          </div>
        </div>
      )}

      {/* Étape 2 — aperçu (serveur, quel que soit le type de source) */}
      {étape === 'apercu' && apercuServeur && (
        <div
          className="mt-3"
          data-testid={apercuServeur.origin.kind === 'file' ? 'store-file-preview-panel' : 'store-url-preview-panel'}
        >
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <span className="rounded-full border border-cyan-300/25 bg-cyan-400/10 px-2 py-0.5 text-cyan-100">
              {apercuServeur.origin.kind === 'file'
                ? apercuServeur.origin.reference
                : PLATFORM_LABELS[apercuServeur.origin.platform]}
            </span>
            <span className="text-slate-400">{apercuServeur.summary.total} produit(s) détecté(s)</span>
            {apercuServeur.summary.duplicateInBatch > 0 && (
              <span className="text-amber-200">{apercuServeur.summary.duplicateInBatch} doublon(s) dans la source</span>
            )}
            {apercuServeur.summary.duplicateExisting > 0 && (
              <span className="text-amber-200">{apercuServeur.summary.duplicateExisting} déjà dans votre catalogue</span>
            )}
            {apercuServeur.summary.unpriced > 0 && (
              <span className="text-slate-500">{apercuServeur.summary.unpriced} sans prix (à compléter)</span>
            )}
          </div>

          {avertissements.length > 0 && (
            <div className="mt-2 rounded-lg border border-amber-400/20 bg-amber-400/[0.05] px-3 py-2 text-[10px] text-amber-100">
              {avertissements.slice(0, 4).map((avertissement) => <p key={avertissement}>· {avertissement}</p>)}
            </div>
          )}

          {/*
            Rappel explicite : un aperçu n'écrit rien. Placé dans le bloc unifié
            pour qu'il soit dit aussi bien après un fichier qu'après une URL.
          */}
          {/*
            Validité de l'aperçu, affichée en clair.

            Trois états distincts, et pas un seul bandeau : « valable », « ça
            approche », « expiré ». Le bouton de confirmation suit le dernier —
            on ne propose jamais une action que le serveur refusera, et le
            serveur reste seul juge (il revérifie l'échéance).
          */}
          {validité && (
            <div
              role={validité.state === 'expiring' || validité.state === 'expired' ? 'alert' : 'status'}
              className={cn(
                'mt-2 rounded-lg border px-3 py-2 text-[10px]',
                validité.state === 'expired'
                  ? 'border-rose-400/25 bg-rose-400/[0.06] text-rose-100'
                  : validité.state === 'expiring'
                    ? 'border-amber-400/25 bg-amber-400/[0.06] text-amber-100'
                    : 'border-white/[0.07] bg-black/20 text-slate-400',
              )}
              data-testid="preview-validity"
              data-state={validité.state}
            >
              <p className="flex items-center gap-1.5">
                {validité.state === 'expired' || validité.state === 'expiring'
                  ? <AlertTriangle size={11} />
                  : <Check size={11} />}
                {validité.label}
              </p>
              {validité.state === 'expired' && (
                <p className="mt-1 text-slate-400">
                  Rien n’a été enregistré. Relancez l’analyse pour obtenir un nouvel
                  aperçu — vous n’avez pas à redéposer le fichier.
                </p>
              )}
            </div>
          )}

          <p className="mt-2 text-[10px] text-slate-500">
            Aucun produit n’a été créé à cette étape. L’import n’a lieu qu’après votre
            confirmation, et l’aperçu expire au bout de dix minutes.
          </p>

          {/*
            * Brouillons écartés chez la source (Chariow).
            *
            * Affiché à part, et pas seulement noyé dans les avertissements :
            * « 3 produits » sur une boutique qui en compte 8 ferait conclure à
            * une panne d'import. Ce décompte dit exactement ce qui a été laissé
            * de côté, et pourquoi.
            */}
          {(apercuServeur.draftsSkipped ?? 0) > 0 && (
            <div
              className="mt-2 rounded-lg border border-amber-400/25 bg-amber-400/[0.05] px-3 py-2 text-[10px] text-amber-100"
              data-testid="preview-drafts-skipped"
            >
              {apercuServeur.draftsSkipped} produit(s) non publié(s) chez Chariow (brouillon ou suspendu)
              {apercuServeur.draftsSkipped === 1 ? ' a' : ' ont'} été écarté(s) : seuls les produits
              publiés sont importés.
            </div>
          )}

          {apercuServeur.rejected.length > 0 && (
            <div className="mt-2 rounded-lg border border-rose-400/20 bg-rose-400/[0.05] px-3 py-2 text-[10px] text-rose-100">
              {apercuServeur.rejected.slice(0, 4).map((r) => <p key={`${r.line}-${r.reason}`}>· ligne {r.line} : {r.reason}</p>)}
            </div>
          )}

          <ul className="vy-scroll mt-3 max-h-80 space-y-1.5 overflow-y-auto pr-1" data-testid="import-preview">
            {apercuServeur.products.slice(0, 40).map((produit) => (
              <li
                key={`${produit.index}-${produit.name}`}
                className={cn(
                  'flex items-start gap-2.5 rounded-lg border px-2.5 py-2',
                  produit.duplicate ? 'border-amber-400/20 bg-amber-400/[0.04]' : 'border-white/[0.07] bg-black/20',
                )}
                data-testid={`import-preview-${produit.index}`}
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium text-white">{produit.name}</p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-slate-500">
                    <span className="text-slate-300">{produit.price}</span>
                    {produit.productUrl && (
                      <a
                        href={produit.productUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-0.5 text-cyan-300/80 underline underline-offset-2"
                      >
                        <Link2 size={9} /> fiche
                      </a>
                    )}
                  </p>
                  {produit.warnings.length > 0 && (
                    <p className="mt-0.5 text-[10px] text-amber-200/80">{produit.warnings.join(' · ')}</p>
                  )}
                  {(produit.variants?.length ?? 0) > 0 && (
                    /**
                     * Le détail des déclinaisons, pas seulement leur nombre :
                     * l'utilisateur doit voir CE QUI sera écrit (option, prix,
                     * stock) pour pouvoir vérifier avant de confirmer.
                     */
                    <ul className="mt-1 flex flex-wrap gap-1" data-testid={`import-variants-${produit.index}`}>
                      {produit.variants!.slice(0, 8).map((variante, position) => (
                        <li
                          key={`${variante.name}-${position}`}
                          className="rounded border border-cyan-300/20 bg-cyan-400/[0.05] px-1.5 py-0.5 text-[9px] text-cyan-100/90"
                        >
                          {variante.attributeName ? `${variante.attributeName} ` : ''}
                          {variante.name}
                          {' · '}{variante.price}
                          {variante.stock !== null ? ` · stock ${variante.stock}` : ''}
                          {variante.sku ? ` · ${variante.sku}` : ''}
                        </li>
                      ))}
                      {(produit.variants?.length ?? 0) > 8 && (
                        <li className="text-[9px] text-slate-500">+{(produit.variants?.length ?? 0) - 8} autre(s)</li>
                      )}
                    </ul>
                  )}
                  {produit.duplicate && (
                    <p className="mt-0.5 text-[10px] text-amber-300">
                      {produit.duplicate === 'in-batch'
                        ? 'Doublon dans la source — ne sera pas créé deux fois'
                        : 'Existe déjà dans votre catalogue — sera créé si vous confirmez'}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ul>
          {apercuServeur.products.length > 40 && (
            <p className="mt-1 text-[10px] text-slate-500">
              Aperçu limité à 40 produits sur {apercuServeur.summary.total}. Tous les produits
              importables seront écrits.
            </p>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="primary"
              // Rien d'importable ⇒ rien à confirmer : un bouton « Importer 0
              // produit(s) » serait un piège, pas une action.
              // Un aperçu échu n'est pas confirmable : le serveur le refuse, et
              // proposer le bouton ferait perdre le clic. Rien d'importable ⇒
              // rien à confirmer non plus.
              disabled={
                écriture
                || !workspaceId
                || apercuServeur.summary.importable === 0
                || validité?.state === 'expired'
              }
              onClick={() => void confirmer()}
              icon={<Check size={13} />}
              data-testid="import-confirm"
            >
              Importer {apercuServeur.summary.importable} produit(s)
            </Button>
            <Button
              size="sm"
              variant="outline"
              loading={chargement}
              onClick={() => void relancer()}
              icon={<RotateCcw size={13} />}
              data-testid="preview-restart"
            >
              Relancer l’analyse
            </Button>
            <Button size="sm" variant="ghost" onClick={réinitialiser} icon={<ArrowLeft size={13} />}>
              Changer de source
            </Button>
          </div>
        </div>
      )}

      {/* Étape 3 — écriture */}
      {étape === 'ecriture' && (
        <div className="mt-3 flex items-center gap-2 text-xs text-slate-300">
          {écriture ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} className="text-emerald-400" />}
          {écriture ? 'Import en cours…' : 'Import terminé.'}
        </div>
      )}

      {résultat && (
        <div className="mt-3 rounded-xl border border-white/[0.07] bg-black/25 px-3 py-2.5 text-[11px]" data-testid="import-result">
          <p className="text-emerald-200">{résultat.créés} produit(s) créé(s) dans votre catalogue.</p>
          {résultat.échecs.length > 0 && (
            <>
              <p className="mt-1 text-rose-200">{résultat.échecs.length} produit(s) non créé(s) :</p>
              <ul className="mt-0.5 space-y-0.5 text-rose-100/80">
                {résultat.échecs.slice(0, 5).map((échec) => (
                  <li key={échec.nom}>· {échec.nom} : {échec.raison}</li>
                ))}
              </ul>
            </>
          )}
          <div className="mt-2 flex gap-2">
            <Button size="sm" variant="ghost" onClick={réinitialiser}>Importer une autre source</Button>
            <Button size="sm" variant="ghost" onClick={onClose}>Terminer</Button>
          </div>
        </div>
      )}
    </div>
  );
}


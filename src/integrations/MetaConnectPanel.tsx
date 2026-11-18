/**
 * VYORA Integrations — parcours de connexion Meta.
 *
 * ## Ce que cet écran ne peut pas faire
 *
 * Il ne peut pas fabriquer une connexion. Le bouton « Connecter » demande au
 * serveur un `state` et un `config_id` ; le parcours se déroule chez Meta ; le
 * retour est un `code` à usage unique que le serveur échange avec l'App Secret,
 * puis VÉRIFIE (WABA et numéro pour WhatsApp, propriété des pages pour les
 * autres produits) avant d'écrire quoi que ce soit.
 *
 * ## Deux parcours, une seule fonction
 *
 * - WhatsApp : SDK JavaScript Meta (`FB.login`) avec `config_id` et
 *   `response_type: 'code'`. `sessionInfo` donne le WABA et le numéro ; ils
 *   partent avec le `code` et sont recontrôlés côté serveur.
 * - Facebook Pages, Messenger, Instagram : redirection vers
 *   `facebook.com/dialog/oauth`, retour sur `/meta-connect/callback`, puis
 *   sélection des pages dans cet écran.
 *
 * ## Si Meta n'est pas configuré
 *
 * Le serveur répond `META_NOT_CONFIGURED` ou `META_CONFIG_ID_MISSING`. L'écran
 * l'affiche tel quel : il n'existe aucun mode dégradé qui ferait semblant.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, ExternalLink, Loader2, Plug, RefreshCw, Unplug } from 'lucide-react';
import { Button } from '../components/ui';
import { asAppError } from '../lib/errors';
import {
  disconnectMeta,
  finishEmbeddedSignup,
  listMetaPages,
  readMetaStatus,
  refreshMetaToken,
  selectMetaPages,
  startMetaConnect,
  verifyMetaConnection,
  type MetaConnectionView,
  type MetaPageOption,
  type MetaProduct,
} from './meta/api';
import { MetaOperationsPanel } from './MetaOperationsPanel';
import { MetaTestFlowPanel } from './MetaTestFlowPanel';

/* ------------------------------ SDK Meta (JS) ------------------------------ */

interface FacebookSdk {
  init(options: { appId: string; version: string; xfbml?: boolean; cookie?: boolean }): void;
  login(
    callback: (response: { authResponse?: { code?: string } | null; status?: string }) => void,
    options: Record<string, unknown>,
  ): void;
}

declare global {
  interface Window {
    FB?: FacebookSdk;
    fbAsyncInit?: () => void;
  }
}

const SDK_ID = 'facebook-jssdk';

/**
 * Charge le SDK Meta une seule fois. L'App ID est public (il figure dans
 * l'URL de toute boîte de dialogue) ; aucun secret n'est utilisé ici.
 */
function loadFacebookSdk(appId: string, version: string): Promise<FacebookSdk> {
  if (window.FB) {
    window.FB.init({ appId, version, xfbml: false, cookie: false });
    return Promise.resolve(window.FB);
  }
  return new Promise((resolve, reject) => {
    const minuteur = setTimeout(() => reject(new Error('Le SDK Meta n’a pas répondu (réseau bloqué ?).')), 20_000);
    window.fbAsyncInit = () => {
      try {
        window.FB?.init({ appId, version, xfbml: false, cookie: false });
      } catch (erreur) {
        clearTimeout(minuteur);
        reject(erreur instanceof Error ? erreur : new Error('Initialisation du SDK Meta impossible.'));
        return;
      }
      clearTimeout(minuteur);
      if (window.FB) resolve(window.FB);
      else reject(new Error('SDK Meta indisponible après chargement.'));
    };
    if (document.getElementById(SDK_ID)) return;
    const script = document.createElement('script');
    script.id = SDK_ID;
    script.async = true;
    script.src = 'https://connect.facebook.net/fr_FR/sdk.js';
    script.onerror = () => {
      clearTimeout(minuteur);
      reject(new Error('Chargement du SDK Meta impossible (réseau ou bloqueur de scripts).'));
    };
    document.body.appendChild(script);
  });
}

/* -------------------------------- libellés -------------------------------- */

const LIBELLES_PRODUIT: Record<MetaProduct, string> = {
  whatsapp: 'WhatsApp Business',
  facebook: 'Facebook Pages',
  messenger: 'Messenger',
  instagram: 'Instagram Business',
};

const ETATS: Record<string, { texte: string; ton: string }> = {
  connected: { texte: 'Connecté', ton: 'border-emerald-400/30 bg-emerald-500/10 text-emerald-200' },
  expired: { texte: 'Jeton expiré', ton: 'border-amber-400/30 bg-amber-500/10 text-amber-100' },
  revoked: { texte: 'Accès révoqué', ton: 'border-rose-400/30 bg-rose-500/10 text-rose-100' },
  error: { texte: 'Erreur de connexion', ton: 'border-rose-400/30 bg-rose-500/10 text-rose-100' },
  disconnected: { texte: 'Non connecté', ton: 'border-white/10 bg-white/[0.03] text-slate-300' },
};

export interface MetaConnectPanelProps {
  product: MetaProduct;
  workspaceId: string | null;
  /** Signale au catalogue qu'un état a changé (relecture de la fiche). */
  onChanged: (message: { tone: 'success' | 'error'; text: string }) => void;
  /** Appelé après une connexion ou une déconnexion réussie. */
  onConnected?: () => void;
}

export function MetaConnectPanel({ product, workspaceId, onChanged, onConnected }: MetaConnectPanelProps) {
  const [connexion, setConnexion] = useState<MetaConnectionView | null>(null);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [configIdPresent, setConfigIdPresent] = useState<boolean | null>(null);
  const [chargement, setChargement] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [pages, setPages] = useState<MetaPageOption[] | null>(null);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const contexte = useRef<{ state: string; wabaId: string; phoneNumberId: string } | null>(null);

  const label = LIBELLES_PRODUIT[product];

  const relire = useCallback(async () => {
    if (!workspaceId) {
      setChargement(false);
      setConnexion(null);
      return;
    }
    setChargement(true);
    try {
      const etat = await readMetaStatus(workspaceId, product);
      setConfigured(etat.configured);
      setConfigIdPresent(Boolean(etat.configIds?.[product]));
      setConnexion(etat.connections.find((c) => c.product === product) ?? null);
      setErreur(null);
    } catch (e) {
      const err = asAppError(e);
      setConfigured(null);
      setErreur(err.message);
      setConnexion(null);
    } finally {
      setChargement(false);
    }
  }, [workspaceId, product]);

  useEffect(() => {
    void relire();
  }, [relire]);

  /* --------------------------- WhatsApp Embedded --------------------------- */

  const demarrerWhatsApp = async () => {
    if (!workspaceId) return;
    setBusy('start');
    setErreur(null);
    try {
      const lancement = await startMetaConnect(workspaceId, 'whatsapp');
      if (lancement.mode !== 'embedded-signup') throw new Error('Parcours Meta inattendu pour WhatsApp.');
      const sdk = await loadFacebookSdk(lancement.appId, lancement.graphVersion);
      contexte.current = { state: lancement.state, wabaId: '', phoneNumberId: '' };

      const reponse = await new Promise<{ code?: string } | null>((resolve) => {
        sdk.login(
          (res) => resolve(res.authResponse?.code ? { code: res.authResponse.code } : null),
          {
            config_id: lancement.configId,
            response_type: 'code',
            override_default_response_type: true,
            // `version` explicite : sans elle, Meta sert la version par défaut
            // (v4 aujourd'hui), qui peut changer sans préavis.
            extras: { setup: {}, version: lancement.embeddedSignupVersion },
          },
        );
      });
      const code = reponse?.code;
      const ctx = contexte.current;
      if (!code || !ctx) {
        throw new Error('Le parcours Meta a été interrompu ou refusé : aucune autorisation n’a été accordée.');
      }
      if (!ctx.wabaId || !ctx.phoneNumberId) {
        throw new Error(
          'Meta n’a pas transmis le compte WhatsApp Business et le numéro. Relancez le parcours et allez jusqu’à l’enregistrement du numéro.',
        );
      }
      setBusy('finish');
      await finishEmbeddedSignup(workspaceId, {
        state: ctx.state,
        code,
        wabaId: ctx.wabaId,
        phoneNumberId: ctx.phoneNumberId,
      });
      onChanged({ tone: 'success', text: `${label} : compte vérifié et connecté.` });
      onConnected?.();
      await relire();
    } catch (e) {
      const err = asAppError(e);
      setErreur(err.message);
      onChanged({ tone: 'error', text: err.message });
    } finally {
      setBusy(null);
    }
  };

  /**
   * Écoute `message` du SDK : Meta pousse `WA_EMBEDDED_SIGNUP` avec le compte
   * WhatsApp et le numéro. On ne fait que mémoriser ces identifiants ; ils ne
   * sont crus qu'après vérification serveur.
   *
   * ## Deux formes à accepter, pas une
   *
   * Depuis Embedded Signup **v5**, l'objet de session ne contient plus
   * `waba_id` : il expose `messaging_account_ids` (un TABLEAU) et
   * `is_on_biz_app`. En v4 et avant, c'était un `waba_id` scalaire. Un
   * écouteur qui ne lit que `waba_id` reçoit donc une chaîne vide en v5 et le
   * parcours échoue à tous les coups, avec « Meta n'a pas transmis le compte
   * WhatsApp Business ».
   *
   * On accepte les deux formes. Le serveur revalide de toute façon que le
   * jeton voit bien ce compte et ce numéro : accepter deux écritures ne
   * relâche aucun contrôle.
   */
  useEffect(() => {
    if (product !== 'whatsapp') return undefined;
    const ecoute = (event: MessageEvent) => {
      if (!/facebook\.com$/.test(new URL(event.origin).hostname || '')) return;
      let donnees: {
        type?: string;
        event?: string;
        data?: {
          waba_id?: string;
          messaging_account_ids?: string[];
          is_on_biz_app?: boolean;
          phone_number_id?: string;
        };
      } | null = null;
      try {
        donnees = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
      } catch {
        return;
      }
      if (donnees?.type !== 'WA_EMBEDDED_SIGNUP') return;
      if (donnees.event === 'FINISH' || donnees.event === 'FINISH_ONLY_WABA' || donnees.event === 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING') {
        // v5 d'abord (tableau), v4 et antérieurs ensuite (scalaire).
        const idsV5 = Array.isArray(donnees.data?.messaging_account_ids)
          ? donnees.data?.messaging_account_ids.filter((v) => typeof v === 'string' && v.length > 0)
          : [];
        const waba = idsV5[0] ?? (typeof donnees.data?.waba_id === 'string' ? donnees.data.waba_id : '');
        contexte.current = {
          state: contexte.current?.state ?? '',
          wabaId: waba,
          phoneNumberId: String(donnees.data?.phone_number_id ?? ''),
        };
      }
      if (donnees.event === 'CANCEL' || donnees.event === 'ERROR') {
        contexte.current = null;
      }
    };
    window.addEventListener('message', ecoute);
    return () => window.removeEventListener('message', ecoute);
  }, [product]);

  /* ---------------------------- Login for Business ------------------------- */

  const demarrerRedirection = async () => {
    if (!workspaceId) return;
    setBusy('start');
    setErreur(null);
    try {
      const lancement = await startMetaConnect(workspaceId, product);
      if (lancement.mode !== 'redirect') throw new Error('Parcours Meta inattendu pour ce produit.');
      // Redirection pleine page : le retour se fait sur l'écran Intégrations.
      window.location.assign(lancement.url);
    } catch (e) {
      const err = asAppError(e);
      setErreur(err.message);
      onChanged({ tone: 'error', text: err.message });
      setBusy(null);
    }
  };

  /* -------------------------------- Pages --------------------------------- */

  const chargerPages = async () => {
    if (!workspaceId) return;
    setBusy('pages');
    setErreur(null);
    try {
      const resultat = await listMetaPages(workspaceId, product);
      setPages(resultat.pages);
      setSelection(new Set(resultat.pages.filter((p) => p.selected).map((p) => p.page_id)));
    } catch (e) {
      setErreur(asAppError(e).message);
    } finally {
      setBusy(null);
    }
  };

  const enregistrerPages = async () => {
    if (!workspaceId) return;
    setBusy('select');
    setErreur(null);
    try {
      const resultat = await selectMetaPages(workspaceId, product, [...selection]);
      if (resultat.refused.length > 0) {
        onChanged({
          tone: 'error',
          text: `${resultat.refused.length} page(s) refusée(s) : vous n’en êtes pas administrateur.`,
        });
      } else {
        onChanged({ tone: 'success', text: `${resultat.selected} page(s) rattachée(s) à l’entreprise.` });
      }
      onConnected?.();
      setPages(null);
      await relire();
    } catch (e) {
      setErreur(asAppError(e).message);
    } finally {
      setBusy(null);
    }
  };

  /* ------------------------------ Actions état ---------------------------- */

  const verifier = async () => {
    if (!workspaceId) return;
    setBusy('verify');
    setErreur(null);
    try {
      const r = await verifyMetaConnection(workspaceId, product);
      onChanged({
        tone: r.valid ? 'success' : 'error',
        text: r.valid ? 'Autorisation Meta vérifiée.' : 'Autorisation Meta invalide : reconnectez le compte.',
      });
      await relire();
    } catch (e) {
      setErreur(asAppError(e).message);
    } finally {
      setBusy(null);
    }
  };

  const renouveler = async () => {
    if (!workspaceId) return;
    setBusy('refresh');
    setErreur(null);
    try {
      const r = await refreshMetaToken(workspaceId, product);
      onChanged({ tone: 'success', text: r.refreshed ? 'Jeton Meta renouvelé.' : r.message ?? 'Aucun renouvellement nécessaire.' });
      await relire();
    } catch (e) {
      setErreur(asAppError(e).message);
    } finally {
      setBusy(null);
    }
  };

  const deconnecter = async () => {
    if (!workspaceId) return;
    if (!window.confirm(`Déconnecter ${label} de cette entreprise ? Les jetons seront retirés de Vault.`)) return;
    setBusy('disconnect');
    setErreur(null);
    try {
      const r = await disconnectMeta(workspaceId, product);
      onChanged({
        tone: 'success',
        text: r.remoteRevoked
          ? `${label} déconnecté, autorisation révoquée chez Meta.`
          : `${label} déconnecté de VYORA. L’autorisation Meta n’a pas pu être révoquée à distance.`,
      });
      await relire();
    } catch (e) {
      setErreur(asAppError(e).message);
    } finally {
      setBusy(null);
    }
  };

  /* --------------------------------- Rendu -------------------------------- */

  const etat = connexion ? ETATS[connexion.status] ?? ETATS.error : null;
  const meta = connexion?.metadata ?? {};
  const telephone = typeof meta.display_phone_number === 'string' ? meta.display_phone_number : null;
  const wabaName = typeof meta.waba_name === 'string' ? meta.waba_name : null;
  const enAttenteConfig = configured === false || configIdPresent === false;
  const peutConnecter = Boolean(workspaceId) && !enAttenteConfig;
  const doitReconnecter = connexion ? ['expired', 'revoked', 'error'].includes(connexion.status) : false;
  const choixPossibles = useMemo(() => (pages ?? []).filter((p) => p.has_token), [pages]);

  return (
    <div className="space-y-2" data-testid={`meta-panel-${product}`}>
      {chargement && (
        <p className="flex items-center gap-2 text-xs text-slate-400">
          <Loader2 size={13} className="animate-spin" /> Lecture de l’état réel…
        </p>
      )}

      {!chargement && etat && connexion && (
        <div className={`rounded-lg border px-3 py-2.5 text-xs ${etat.ton}`}>
          <p className="flex items-center gap-1.5 font-medium">
            <Check size={12} /> {etat.texte} · {connexion.display_name ?? connexion.external_account_id}
          </p>
          <p className="mt-1 leading-relaxed opacity-90">
            {product === 'whatsapp'
              ? `WABA ${connexion.external_account_id}${wabaName ? ` (${wabaName})` : ''}${telephone ? ` · numéro ${telephone}` : ''}`
              : `Compte Meta ${connexion.external_account_id} · ${connexion.pages.length} page(s)`}
          </p>
          {connexion.token_expires_at && (
            <p className="mt-0.5 opacity-80">
              Jeton valable jusqu’au {new Date(connexion.token_expires_at).toLocaleDateString('fr-FR')}.
            </p>
          )}
          {Array.isArray(meta.missing_scopes) && (meta.missing_scopes as unknown[]).length > 0 && (
            <p className="mt-1 flex items-start gap-1">
              <AlertTriangle size={11} className="mt-0.5 shrink-0" />
              Permissions manquantes : {(meta.missing_scopes as string[]).join(', ')}
            </p>
          )}
          {product === 'whatsapp' && meta.registered === false && (
            <p className="mt-1 flex items-start gap-1">
              <AlertTriangle size={11} className="mt-0.5 shrink-0" />
              Numéro pas encore enregistré pour l’API Cloud
              {typeof meta.register_error === 'string' && meta.register_error ? ` (${meta.register_error})` : ''} :
              les messages ne peuvent pas encore être envoyés. Utilisez « Vérifier » après enregistrement dans
              WhatsApp Manager.
            </p>
          )}
          {connexion.last_error && <p className="mt-1 opacity-90">{connexion.last_error}</p>}
          {connexion.pages.length > 0 && (
            <ul className="mt-1.5 space-y-0.5">
              {connexion.pages.map((p) => (
                <li key={p.page_id} className="opacity-90">
                  · {p.name}
                  {p.instagram_username ? ` → @${p.instagram_username}` : ''}
                  {p.webhook_subscribed ? ' (webhooks actifs)' : ''}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {!chargement && !connexion && (
        <p className="rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2.5 text-xs leading-relaxed text-slate-400">
          {enAttenteConfig
            ? `Le serveur n’a pas encore reçu ${configured === false ? 'META_APP_ID / META_APP_SECRET' : 'l’identifiant de configuration Meta'} pour ${label}. Aucune connexion n’est possible tant que ces secrets ne sont pas renseignés.`
            : `Aucun compte ${label} n’est connecté à cette entreprise.`}
        </p>
      )}

      {erreur && (
        <p className="flex items-start gap-1.5 rounded-lg border border-rose-400/25 bg-rose-500/10 px-3 py-2 text-xs leading-relaxed text-rose-100">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" /> {erreur}
        </p>
      )}

      {product === 'whatsapp' && (
        <MetaTestFlowPanel
          workspaceId={workspaceId}
          onChanged={(etat) => {
            onChanged?.(etat);
            // La fiche parente relit son état : la connexion de test est la
            // même ligne `whatsapp`, l'affichage doit suivre au même endroit.
            if (etat.tone === 'success') void relire();
          }}
        />
      )}

      <div className="flex flex-wrap gap-2">
        {!connexion && (
          <Button
            size="sm"
            disabled={!peutConnecter || busy !== null}
            loading={busy === 'start' || busy === 'finish'}
            onClick={() => { void (product === 'whatsapp' ? demarrerWhatsApp() : demarrerRedirection()); }}
            icon={<Plug size={13} />}
          >
            Connecter {label}
          </Button>
        )}

        {connexion && doitReconnecter && (
          <Button
            size="sm"
            disabled={!peutConnecter || busy !== null}
            loading={busy === 'start'}
            onClick={() => { void (product === 'whatsapp' ? demarrerWhatsApp() : demarrerRedirection()); }}
            icon={<RefreshCw size={13} />}
          >
            Reconnecter
          </Button>
        )}

        {connexion && !doitReconnecter && product !== 'whatsapp' && (
          <Button size="sm" variant="secondary" disabled={busy !== null} loading={busy === 'pages'} onClick={() => { void chargerPages(); }} icon={<Plug size={13} />}>
            {connexion.pages.length > 0 ? 'Modifier les pages' : 'Choisir les pages'}
          </Button>
        )}

        {connexion && (
          <>
            <Button size="sm" variant="ghost" disabled={busy !== null} loading={busy === 'verify'} onClick={() => { void verifier(); }} icon={<Check size={13} />}>
              Vérifier
            </Button>
            {product !== 'whatsapp' && (
              <Button size="sm" variant="ghost" disabled={busy !== null} loading={busy === 'refresh'} onClick={() => { void renouveler(); }} icon={<RefreshCw size={13} />}>
                Renouveler le jeton
              </Button>
            )}
            <Button size="sm" variant="ghost" disabled={busy !== null} loading={busy === 'disconnect'} onClick={() => { void deconnecter(); }} icon={<Unplug size={13} />}>
              Déconnecter
            </Button>
          </>
        )}
      </div>

      {pages && (
        <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
          <p className="text-xs font-medium text-slate-200">Pages Facebook autorisées</p>
          <p className="mt-0.5 text-[0.7rem] leading-relaxed text-slate-400">
            Seules les pages cochées seront rattachées à cette entreprise. Une page dont vous n’êtes pas
            administrateur est refusée par le serveur.
          </p>
          <ul className="mt-2 space-y-1">
            {choixPossibles.length === 0 && <li className="text-xs text-slate-400">Aucune page autorisée avec ce compte.</li>}
            {choixPossibles.map((p) => (
              <li key={p.page_id}>
                <label className="flex items-start gap-2 text-xs text-slate-300">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={selection.has(p.page_id)}
                    onChange={(e) => {
                      setSelection((prev) => {
                        const suivant = new Set(prev);
                        if (e.target.checked) suivant.add(p.page_id);
                        else suivant.delete(p.page_id);
                        return suivant;
                      });
                    }}
                  />
                  <span>
                    {p.name}
                    {p.instagram_business_account_id ? ' · compte Instagram relié' : ''}
                    {p.tasks.includes('MANAGE') ? '' : ' · droits limités'}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <div className="mt-2 flex gap-2">
            <Button size="sm" loading={busy === 'select'} disabled={busy !== null} onClick={() => { void enregistrerPages(); }}>
              Enregistrer la sélection
            </Button>
            <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setPages(null)}>
              Annuler
            </Button>
          </div>
        </div>
      )}

      {/*
        Exploitation réelle de la connexion : publication, commentaires,
        statistiques, boîte de réception, modèles, Instagram. Les données
        viennent de Meta, jamais d'un jeu de démonstration.
      */}
      {connexion?.status === 'connected' && workspaceId && (
        <MetaOperationsPanel
          product={product}
          workspaceId={workspaceId}
          connexion={connexion}
          onChanged={onChanged}
        />
      )}

      {connexion && product !== 'whatsapp' && connexion.pages.length === 0 && !pages && (
        <p className="text-[0.7rem] leading-relaxed text-amber-200/90">
          Autorisation obtenue, mais aucune page n’est encore rattachée : choisissez les pages à connecter.
        </p>
      )}

      {configured && product !== 'whatsapp' && (
        <p className="text-[0.68rem] leading-relaxed text-slate-500">
          Le parcours ouvre Meta dans cet onglet ; vous revenez ici après autorisation.
          <a
            className="ml-1 inline-flex items-center gap-0.5 text-brand-300 hover:underline"
            href="https://developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow"
            target="_blank"
            rel="noreferrer noopener"
          >
            Documentation Meta <ExternalLink size={10} />
          </a>
        </p>
      )}
    </div>
  );
}

/**
 * « Mes serveurs MCP » — l'utilisateur connecte SES serveurs MCP distants.
 *
 * ## Ce que cet écran ne fait PAS
 *
 * - Il ne simule rien : chaque action appelle une route réelle de la fonction
 *   `mcp-client` (`/gestion/...`), qui lit et écrit PostgreSQL.
 * - Il n'affiche jamais un secret après l'avoir envoyé. Le champ est vidé dès
 *   la création réussie, et la réponse du serveur ne le contient pas.
 * - Il ne prétend pas qu'une connexion est saine sans l'avoir testée : une
 *   connexion nouvellement créée affiche « Jamais testé », pas « Connecté ».
 * - Il ne propose aucune autorisation d'écriture : elle n'existe pas en base.
 *
 * ## Les deux vérités de cet écran
 *
 * 1. **Découvrir n'accorde rien.** Après un test réussi, tous les outils sont
 *    en attente. L'utilisateur doit les autoriser un par un.
 * 2. **Une permission affichée n'est pas une permission accordée** tant que le
 *    serveur n'a pas répondu. En cas d'échec, l'écran revient à l'état réel
 *    relu depuis la base, jamais à l'état optimiste.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Loader2,
  Lock,
  Play,
  Plug,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  X,
  XCircle,
} from 'lucide-react';
import { Badge, Button, Card, Input, Modal, PageHeader, Select, Spinner } from '../components/ui';
import { getWorkspaces } from '../lib/api';
import {
  creerServeur,
  definirPermission,
  demarrerOAuth,
  etatPermission,
  executerOutil,
  LIBELLES_AUTH,
  LIBELLES_ETAT,
  listerServeurs,
  revoquerServeur,
  testerConnexion,
  texteDuContenu,
  ErreurGestion,
  type ModeAuth,
  type ResultatExecution,
  type ServeurMcp,
} from '../mcp/serveurs';

type Message = { ton: 'succes' | 'erreur' | 'info'; texte: string };

function formaterDate(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

function tonBadge(ton: 'ok' | 'attention' | 'erreur' | 'neutre'): string {
  switch (ton) {
    case 'ok': return 'emerald';
    case 'attention': return 'amber';
    case 'erreur': return 'rose';
    default: return 'slate';
  }
}

export function MesServeursMcpPage({ sansEnTete = false }: { sansEnTete?: boolean } = {}) {
  const [serveurs, setServeurs] = useState<ServeurMcp[] | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string>('');
  const [chargement, setChargement] = useState(true);
  const [message, setMessage] = useState<Message | null>(null);
  const [creationOuverte, setCreationOuverte] = useState(false);
  const [aRevoquer, setARevoquer] = useState<ServeurMcp | null>(null);
  const [enCours, setEnCours] = useState<string>('');
  /** Outil en cours de préparation d'exécution : `{ serveur, outil }`. */
  const [aExecuter, setAExecuter] = useState<{ serveur: ServeurMcp; outil: string } | null>(null);
  const [argsTexte, setArgsTexte] = useState('{}');
  const [resultat, setResultat] = useState<ResultatExecution | null>(null);
  const [erreurExecution, setErreurExecution] = useState<string | null>(null);
  const [executionEnCours, setExecutionEnCours] = useState(false);

  const charger = useCallback(async () => {
    setChargement(true);
    setMessage(null);
    try {
      const [espaces, liste] = await Promise.all([getWorkspaces(), listerServeurs()]);
      setWorkspaceId((actuel) => actuel || espaces[0]?.id || '');
      setServeurs(liste);
    } catch (erreur) {
      setMessage({
        ton: 'erreur',
        texte: erreur instanceof ErreurGestion ? erreur.message : 'Impossible de charger vos serveurs MCP.',
      });
      setServeurs([]);
    } finally {
      setChargement(false);
    }
  }, []);

  useEffect(() => { void charger(); }, [charger]);

  /** Relit l'état réel après une action, sans supposer qu'elle a réussi. */
  const rafraichir = useCallback(async () => {
    try {
      setServeurs(await listerServeurs());
    } catch {
      /* on garde l'état précédent : un rafraîchissement raté ne doit pas vider l'écran */
    }
  }, []);

  const tester = useCallback(async (serveur: ServeurMcp) => {
    setEnCours(serveur.id);
    setMessage(null);
    try {
      const resultat = await testerConnexion(serveur.id);
      setMessage({
        ton: resultat.ok ? 'succes' : 'erreur',
        texte: resultat.ok
          ? `${resultat.message}${resultat.protocole ? ` (protocole ${resultat.protocole})` : ''}`
          : resultat.message,
      });
    } catch (erreur) {
      setMessage({
        ton: 'erreur',
        texte: erreur instanceof ErreurGestion ? erreur.message : 'Le test a échoué.',
      });
    } finally {
      setEnCours('');
      await rafraichir();
    }
  }, [rafraichir]);

  const changerPermission = useCallback(async (
    serveur: ServeurMcp,
    outil: string,
    etat: 'allowed' | 'denied',
  ) => {
    setEnCours(`${serveur.id}:${outil}`);
    setMessage(null);
    try {
      await definirPermission(serveur.id, outil, etat);
      setMessage({
        ton: 'info',
        texte: etat === 'allowed'
          ? `« ${outil} » est désormais autorisé.`
          : `« ${outil} » est refusé.`,
      });
    } catch (erreur) {
      setMessage({
        ton: 'erreur',
        texte: erreur instanceof ErreurGestion ? erreur.message : 'La permission n’a pas pu être modifiée.',
      });
    } finally {
      setEnCours('');
      // Toujours relire : l'état affiché doit être celui de la base.
      await rafraichir();
    }
  }, [rafraichir]);

  /**
   * Lance l'autorisation OAuth : on demande une URL au serveur, puis on y
   * envoie le navigateur.
   *
   * Rien n'est stocké ici : ni verifier PKCE, ni état. Ils vivent côté serveur,
   * dans une table à usage unique. Si la navigation n'a pas lieu, l'état expire
   * en dix minutes et ne laisse aucun résidu exploitable.
   *
   * En cas d'échec, on affiche le motif RÉEL du serveur : « ce fournisseur
   * n'annonce pas PKCE S256 » est une information dont l'utilisateur a besoin,
   * pas un détail technique à masquer derrière « une erreur est survenue ».
   */
  const autoriserOAuth = useCallback(async (serveur: ServeurMcp) => {
    setEnCours(serveur.id);
    setMessage(null);
    try {
      const demarrage = await demarrerOAuth(serveur.id);
      if (!demarrage.pkceAnnonce) {
        setMessage({
          ton: 'info',
          texte: 'Ce fournisseur n’annonce pas PKCE S256 dans ses métadonnées. '
            + 'VYORA l’envoie quand même, mais la protection n’est pas confirmée par le serveur.',
        });
      }
      window.location.assign(demarrage.autorisationUrl);
      return;
    } catch (erreur) {
      setMessage({
        ton: 'erreur',
        texte: erreur instanceof ErreurGestion
          ? erreur.message
          : 'L’autorisation OAuth n’a pas pu être préparée.',
      });
    } finally {
      setEnCours('');
    }
  }, []);

  const revoquer = useCallback(async () => {
    if (!aRevoquer) return;
    setEnCours(aRevoquer.id);
    try {
      await revoquerServeur(aRevoquer.id);
      setMessage({ ton: 'succes', texte: 'Connexion révoquée : son secret a été détruit.' });
      setARevoquer(null);
    } catch (erreur) {
      setMessage({
        ton: 'erreur',
        texte: erreur instanceof ErreurGestion ? erreur.message : 'La révocation a échoué.',
      });
    } finally {
      setEnCours('');
      await rafraichir();
    }
  }, [aRevoquer, rafraichir]);

  /**
   * Ouvre la préparation d'un appel. On remet les arguments à zéro : réutiliser
   * ceux de l'appel précédent risquerait d'envoyer une valeur qu'on n'a pas
   * relue.
   */
  const ouvrirExecution = useCallback((serveur: ServeurMcp, outil: string) => {
    setAExecuter({ serveur, outil });
    setArgsTexte('{}');
    setResultat(null);
    setErreurExecution(null);
  }, []);

  const fermerExecution = useCallback(() => {
    setAExecuter(null);
    setResultat(null);
    setErreurExecution(null);
    setArgsTexte('{}');
  }, []);

  /**
   * Lance réellement l'appel.
   *
   * Aucune confirmation d'écriture n'est transmise : la fonctionnalité est en
   * lecture seule côté serveur, et cette interface ne prétend pas le contraire.
   * Les arguments sont validés ici (JSON objet) pour éviter un aller-retour
   * inutile, mais le serveur revalide de toute façon.
   */
  const lancerExecution = useCallback(async () => {
    if (!aExecuter) return;
    let args: Record<string, unknown>;
    try {
      const brut = argsTexte.trim() === '' ? {} : JSON.parse(argsTexte);
      if (typeof brut !== 'object' || brut === null || Array.isArray(brut)) {
        setErreurExecution('Les arguments doivent être un objet JSON, par exemple { "query": "…" }.');
        return;
      }
      args = brut as Record<string, unknown>;
    } catch {
      setErreurExecution('Les arguments ne sont pas un JSON valide.');
      return;
    }

    setExecutionEnCours(true);
    setErreurExecution(null);
    setResultat(null);
    try {
      const r = await executerOutil(aExecuter.serveur.id, aExecuter.outil, args);
      setResultat(r);
    } catch (erreur) {
      setErreurExecution(
        erreur instanceof ErreurGestion ? erreur.message : 'L’outil n’a pas pu être exécuté.',
      );
    } finally {
      setExecutionEnCours(false);
    }
  }, [aExecuter, argsTexte]);

  const actifs = (serveurs ?? []).filter((s) => !s.revokedAt);
  const revoques = (serveurs ?? []).filter((s) => s.revokedAt);

  return (
    <div className="space-y-5">
      {!sansEnTete && (
      <PageHeader
        eyebrow="VYORA · MCP"
        title="Mes serveurs MCP"
        description="Connectez vos propres serveurs MCP : VYORA découvre leurs outils, et vous décidez de ce qu’il peut faire."
        actions={(
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={() => void charger()} disabled={chargement}>
              <RefreshCw className="mr-1.5 h-4 w-4" /> Rafraîchir
            </Button>
            <Button onClick={() => setCreationOuverte(true)} disabled={!workspaceId}>
              <Plus className="mr-1.5 h-4 w-4" /> Ajouter un serveur
            </Button>
          </div>
        )}
      />
      )}

      {message && (
        <div
          role="status"
          className={[
            'flex items-start gap-2 rounded-xl border px-3.5 py-3 text-sm',
            message.ton === 'succes' ? 'border-emerald-400/30 bg-emerald-400/[0.07] text-emerald-100'
              : message.ton === 'erreur' ? 'border-rose-400/30 bg-rose-400/[0.07] text-rose-100'
              : 'border-sky-400/30 bg-sky-400/[0.07] text-sky-100',
          ].join(' ')}
        >
          {message.ton === 'succes' ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
            : message.ton === 'erreur' ? <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
            : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />}
          <span className="min-w-0 flex-1">{message.texte}</span>
          <button type="button" onClick={() => setMessage(null)} aria-label="Fermer" className="opacity-60 hover:opacity-100">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2.5 text-xs leading-relaxed text-slate-400">
        <ShieldCheck className="mr-1.5 inline h-3.5 w-3.5 text-emerald-300" />
        Vos jetons sont stockés côté serveur dans Vault et ne sont jamais renvoyés au navigateur.
        Les écritures ne sont pas activées : VYORA n’exécute que les outils que vous autorisez expressément.
      </div>

      {chargement ? (
        <div className="flex items-center gap-2 py-10 text-sm text-slate-400">
          <Spinner /> Chargement de vos serveurs…
        </div>
      ) : actifs.length === 0 && revoques.length === 0 ? (
        <Card className="p-6 text-center">
          <Plug className="mx-auto mb-3 h-8 w-8 text-slate-500" />
          <p className="text-sm font-medium text-white">Aucun serveur MCP connecté</p>
          <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-slate-400">
            Ajoutez l’URL d’un serveur MCP compatible Streamable HTTP. VYORA teste la connexion,
            découvre ses outils et vous laisse choisir lesquels autoriser.
          </p>
          <Button className="mt-4" onClick={() => setCreationOuverte(true)} disabled={!workspaceId}>
            <Plus className="mr-1.5 h-4 w-4" /> Ajouter mon premier serveur
          </Button>
        </Card>
      ) : (
        <div className="space-y-3">
          {[...actifs, ...revoques].map((serveur) => {
            const etat = LIBELLES_ETAT[serveur.status] ?? LIBELLES_ETAT.unknown;
            const revoque = Boolean(serveur.revokedAt) || serveur.status === 'revoked';
            const enTest = enCours === serveur.id;
            return (
              <Card key={serveur.id} className={revoque ? 'p-4 opacity-70' : 'p-4'}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="truncate text-sm font-semibold text-white">{serveur.nom}</h3>
                      <Badge tone={tonBadge(etat.ton)}>{etat.libelle}</Badge>
                      <Badge tone="slate">{LIBELLES_AUTH[serveur.authKind] ?? serveur.authKind}</Badge>
                      {serveur.aSecret && (
                        <span className="inline-flex items-center gap-1 text-[11px] text-slate-400">
                          <Lock className="h-3 w-3" /> secret en Vault
                        </span>
                      )}
                    </div>
                    <p className="mt-1 truncate font-mono text-xs text-slate-400">{serveur.url}</p>
                    <p className="mt-1 text-[11px] text-slate-500">
                      Dernier test : {formaterDate(serveur.dernierTestAt)}
                      {serveur.serverName ? ` · ${serveur.serverName}` : ''}
                      {serveur.protocolVersion ? ` · ${serveur.protocolVersion}` : ''}
                    </p>
                    {serveur.derniereErreur && !revoque && (
                      <p className="mt-1.5 text-[11px] text-amber-200/80">{serveur.derniereErreur}</p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {/*
                     * Sur une connexion révoquée, on n'affiche AUCUNE action.
                     *
                     * Un bouton « Tester » désactivé laisserait croire qu'un
                     * test est possible un jour ; il ne l'est pas — le secret
                     * est détruit et le serveur répondra toujours 409. Mieux
                     * vaut ne rien proposer que proposer un bouton mort.
                     */}
                    {revoque ? (
                      <span className="text-[11px] text-slate-500">
                        Reconnectez ce serveur pour l’utiliser à nouveau.
                      </span>
                    ) : (
                      <>
                        {serveur.authKind === 'oauth' && (
                          /*
                           * `aria-label` explicite : « Autoriser » seul serait
                           * ambigu à l'écran comme pour un lecteur d'écran,
                           * puisqu'un bouton « Autoriser » existe aussi par
                           * outil. Deux actions différentes, deux noms.
                           */
                          <Button
                            variant="ghost"
                            aria-label={serveur.oauthExpireLe ? 'Réautoriser via OAuth' : 'Autoriser via OAuth'}
                            onClick={() => void autoriserOAuth(serveur)}
                            disabled={enTest}
                          >
                            {enTest ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Lock className="mr-1.5 h-4 w-4" />}
                            {serveur.oauthExpireLe ? 'Réautoriser' : 'Autoriser'}
                          </Button>
                        )}
                        <Button variant="ghost" onClick={() => void tester(serveur)} disabled={enTest}>
                          {enTest ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-1.5 h-4 w-4" />}
                          Tester
                        </Button>
                        <Button variant="ghost" onClick={() => setARevoquer(serveur)}>
                          <Trash2 className="mr-1.5 h-4 w-4" /> Révoquer
                        </Button>
                      </>
                    )}
                  </div>
                </div>

                {!revoque && (
                  <div className="mt-3 border-t border-white/[0.06] pt-3">
                    {serveur.outils.length === 0 ? (
                      <p className="text-xs text-slate-500">
                        Aucun outil découvert. Lancez « Tester » pour interroger le serveur.
                      </p>
                    ) : (
                      <>
                        <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-slate-500">
                          Outils découverts — {serveur.outils.length}
                        </p>
                        <ul className="space-y-1.5">
                          {serveur.outils.map((outil) => {
                            const valeur = etatPermission(serveur.toolPermissions[outil.name]);
                            const cle = `${serveur.id}:${outil.name}`;
                            const enAttente = enCours === cle;
                            return (
                              <li
                                key={outil.name}
                                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2"
                              >
                                <div className="min-w-0 flex-1">
                                  <p className="truncate text-xs font-medium text-slate-200">{outil.name}</p>
                                  {outil.description && (
                                    <p className="truncate text-[11px] text-slate-500">{outil.description}</p>
                                  )}
                                </div>
                                <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                                  {/* Le classement vient du serveur, jamais du navigateur. */}
                                  {outil.lecture === false ? (
                                    <span className="text-[11px] text-slate-500" title="Les écritures ne sont pas activées.">
                                      écriture · désactivée
                                    </span>
                                  ) : outil.lecture === true ? (
                                    <span className="text-[11px] text-slate-500">lecture</span>
                                  ) : null}
                                  {valeur === 'allowed' && (
                                    <span className="inline-flex items-center gap-1 text-[11px] text-emerald-300">
                                      <Check className="h-3 w-3" /> autorisé
                                    </span>
                                  )}
                                  {valeur === 'denied' && (
                                    <span className="inline-flex items-center gap-1 text-[11px] text-rose-300">
                                      <X className="h-3 w-3" /> refusé
                                    </span>
                                  )}
                                  {valeur === 'pending' && (
                                    <span className="text-[11px] text-slate-400">en attente</span>
                                  )}
                                  <Button
                                    variant="ghost"
                                    onClick={() => void changerPermission(serveur, outil.name, 'allowed')}
                                    disabled={enAttente || valeur === 'allowed'}
                                  >
                                    {enAttente ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Autoriser'}
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    onClick={() => void changerPermission(serveur, outil.name, 'denied')}
                                    disabled={enAttente || valeur === 'denied'}
                                  >
                                    Refuser
                                  </Button>
                                  {/*
                                    * « Exécuter » n'apparaît que si les DEUX
                                    * conditions sont réunies : outil de lecture
                                    * (classement du serveur) et permission
                                    * `allowed`. Sur une écriture, aucun bouton :
                                    * la proposer laisserait croire qu'un clic
                                    * peut l'activer, alors que le serveur la
                                    * refuse toujours.
                                    */}
                                  {outil.lecture === true && valeur === 'allowed' && (
                                    <Button
                                      onClick={() => ouvrirExecution(serveur, outil.name)}
                                      disabled={enAttente || executionEnCours}
                                    >
                                      <Play className="mr-1.5 h-3.5 w-3.5" /> Exécuter
                                    </Button>
                                  )}
                                </div>
                              </li>
                            );
                          })}
                        </ul>
                        <p className="mt-2 text-[11px] text-slate-500">
                          Seuls les outils autorisés peuvent être exécutés. VYORA revérifie cette
                          autorisation en base à chaque appel, pas seulement ici.
                        </p>
                      </>
                    )}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}

      <FormulaireCreation
        ouvert={creationOuverte}
        workspaceId={workspaceId}
        onFermer={() => setCreationOuverte(false)}
        onCree={async (nom) => {
          setCreationOuverte(false);
          setMessage({ ton: 'succes', texte: `« ${nom} » ajouté. Lancez un test pour découvrir ses outils.` });
          await rafraichir();
        }}
      />

      <Modal
        open={Boolean(aExecuter)}
        onClose={fermerExecution}
        title={aExecuter ? `Exécuter « ${aExecuter.outil} »` : 'Exécuter un outil'}
        description="VYORA vérifie l’autorisation en base, puis appelle réellement le serveur distant."
        footer={(
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={fermerExecution}>Fermer</Button>
            <Button onClick={() => void lancerExecution()} disabled={executionEnCours}>
              {executionEnCours ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Play className="mr-1.5 h-4 w-4" />}
              Lancer l’appel
            </Button>
          </div>
        )}
      >
        <div className="space-y-3">
          <div>
            <label htmlFor="mcp-args" className="mb-1 block text-xs font-medium text-slate-300">
              Arguments (JSON)
            </label>
            <textarea
              id="mcp-args"
              value={argsTexte}
              onChange={(evenement) => setArgsTexte(evenement.target.value)}
              spellCheck={false}
              rows={4}
              className="w-full resize-y rounded-lg border border-white/10 bg-slate-950/60 px-3 py-2 font-mono text-xs text-slate-100 outline-none focus:border-sky-400/50"
            />
            <p className="mt-1 text-[11px] text-slate-500">
              Objet JSON transmis tel quel à l’outil. VYORA n’y ajoute rien.
            </p>
          </div>

          {erreurExecution && (
            <div role="alert" className="flex items-start gap-2 rounded-lg border border-rose-400/30 bg-rose-400/[0.07] px-3 py-2 text-xs text-rose-100">
              <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1">{erreurExecution}</span>
            </div>
          )}

          {resultat && (
            <div className="space-y-1.5">
              <div className="flex items-center gap-2 text-xs">
                <span className="font-medium text-slate-200">Résultat</span>
                {resultat.isError ? (
                  <Badge tone="rose">le serveur signale une erreur</Badge>
                ) : (
                  <Badge tone="emerald">reçu</Badge>
                )}
              </div>
              <pre
                data-testid="resultat-execution"
                className="max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border border-white/[0.08] bg-slate-950/70 p-3 text-[11px] leading-relaxed text-slate-200"
              >
                {texteDuContenu(resultat.contenu)}
              </pre>
            </div>
          )}
        </div>
      </Modal>

      <Modal
        open={Boolean(aRevoquer)}
        onClose={() => setARevoquer(null)}
        title="Révoquer cette connexion ?"
        description="Le secret sera définitivement détruit. L’historique de la connexion est conservé."
        footer={(
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setARevoquer(null)}>Annuler</Button>
            <Button onClick={() => void revoquer()} disabled={Boolean(enCours)}>
              {enCours ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Trash2 className="mr-1.5 h-4 w-4" />}
              Révoquer
            </Button>
          </div>
        )}
      >
        <p className="text-sm text-slate-300">
          {aRevoquer?.nom} — cette action est irréversible. Pour réutiliser ce serveur, il faudra
          le reconnecter et fournir à nouveau un secret.
        </p>
      </Modal>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Formulaire de création                                                      */
/* -------------------------------------------------------------------------- */

function FormulaireCreation({
  ouvert, workspaceId, onFermer, onCree,
}: {
  ouvert: boolean;
  workspaceId: string;
  onFermer: () => void;
  onCree: (nom: string) => Promise<void> | void;
}) {
  const [nom, setNom] = useState('');
  const [url, setUrl] = useState('');
  const [authKind, setAuthKind] = useState<ModeAuth>('none');
  const [secret, setSecret] = useState('');
  const [envoi, setEnvoi] = useState(false);
  const [erreur, setErreur] = useState('');

  const reinitialiser = () => {
    setNom(''); setUrl(''); setAuthKind('none'); setSecret(''); setErreur(''); setEnvoi(false);
  };

  const fermer = () => { reinitialiser(); onFermer(); };

  const soumettre = async () => {
    setErreur('');
    if (!workspaceId) { setErreur('Aucun espace de travail disponible.'); return; }
    if (!nom.trim()) { setErreur('Donnez un nom à ce serveur.'); return; }
    if (!/^https:\/\//i.test(url.trim())) { setErreur('L’URL doit commencer par https://'); return; }
    if (authKind !== 'none' && !secret.trim()) { setErreur('Ce mode d’authentification exige un secret.'); return; }

    setEnvoi(true);
    try {
      await creerServeur({
        workspaceId,
        nom: nom.trim(),
        url: url.trim(),
        authKind,
        // Le secret est envoyé une seule fois, puis oublié de l'état React.
        ...(authKind === 'none' ? {} : { secret }),
      });
      const nomCree = nom.trim();
      // Vidé AVANT le rappel : même si l'affichage échouait, le secret ne
      // resterait pas dans l'état du composant.
      reinitialiser();
      await onCree(nomCree);
    } catch (e) {
      setErreur(e instanceof ErreurGestion ? e.message : 'La création a échoué.');
      setEnvoi(false);
    }
  };

  return (
    <Modal
      open={ouvert}
      onClose={fermer}
      title="Ajouter un serveur MCP"
      description="VYORA se connectera à l’URL indiquée pour découvrir ses outils."
      footer={(
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={fermer} disabled={envoi}>Annuler</Button>
          <Button onClick={() => void soumettre()} disabled={envoi}>
            {envoi ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Plus className="mr-1.5 h-4 w-4" />}
            Ajouter
          </Button>
        </div>
      )}
    >
      <div className="space-y-3">
        <Input
          label="Nom"
          placeholder="Mon serveur de documentation"
          value={nom}
          maxLength={120}
          onChange={(e) => setNom(e.target.value)}
        />
        <Input
          label="URL du serveur"
          placeholder="https://exemple.com/mcp"
          hint="Transport Streamable HTTP. Seules les URL https:// sont acceptées."
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <Select
          label="Authentification"
          value={authKind}
          onChange={(e) => setAuthKind(e.target.value as ModeAuth)}
        >
          <option value="none">Aucune (serveur public)</option>
          <option value="bearer">Jeton Bearer</option>
          <option value="api_key">Clé d’API</option>
          <option value="oauth">OAuth</option>
        </Select>
        {authKind !== 'none' && (
          <Input
            label="Secret"
            type="password"
            autoComplete="off"
            placeholder="Collez votre jeton"
            hint="Stocké dans Vault côté serveur. Jamais renvoyé au navigateur, jamais journalisé."
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
          />
        )}
        {erreur && (
          <p className="flex items-start gap-1.5 text-xs text-rose-300">
            <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{erreur}
          </p>
        )}
      </div>
    </Modal>
  );
}

export default MesServeursMcpPage;

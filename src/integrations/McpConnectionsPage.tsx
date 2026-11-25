/**
 * « MCP et connexions IA » — connecter un client IA à SORAHNEX.
 *
 * ## Le besoin
 *
 * Un utilisateur qui veut utiliser SORAHNEX depuis Claude, Cursor ou VS Code doit
 * pouvoir, sans lire de documentation technique :
 *
 *   1. trouver l'URL du serveur MCP ;
 *   2. créer un jeton et le copier une fois ;
 *   3. voir ce qui est autorisé, et le retirer s'il change d'avis ;
 *   4. vérifier que son client a bien appelé SORAHNEX.
 *
 * ## Les trois règles de cet écran
 *
 * 1. **Le secret n'apparaît qu'une fois.** Il est créé côté serveur, affiché
 *    dans un bloc que l'utilisateur doit copier, puis effacé de l'état React
 *    dès qu'il ferme le bloc. Il n'est jamais relisible ensuite.
 * 2. **Rien n'est « connecté » par cette page.** Un jeton actif ne prouve pas
 *    qu'un client l'a utilisé : `dernier usage` et le journal disent la vérité.
 *    Tant qu'aucun appel n'a eu lieu, l'écran affiche « jamais utilisé ».
 * 3. **Aucun outil n'est promis s'il n'existe pas.** La liste affichée est
 *    celle que le serveur expose réellement (`OUTILS_LECTURE` / `OUTILS_ECRITURE`
 *    de `core.ts`), pas une description marketing.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  KeyRound,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Trash2,
  XCircle,
} from 'lucide-react';
import { Badge, Button, EmptyState, Input } from '../components/ui';
import {
  MCP_SERVER_URL,
  creerJeton,
  definirPermission,
  faireTournerJeton,
  listerActivite,
  listerJetons,
  listerPermissions,
  revoquerJeton,
  type EvenementMcp,
  type JetonCree,
  type JetonMcp,
  type PermissionOutil,
  type TypeClient,
} from '../mcp/api';
import { OUTILS_AFFICHES, OUTILS_LECTURE_AFFICHES } from '../mcp/outils';
import { edgeFunctionName } from '../lib/platform-identity';

const CLIENTS: Array<{ valeur: TypeClient; libelle: string; aide: string }> = [
  {
    valeur: 'claude',
    libelle: 'Claude (Desktop / Code)',
    aide: 'Paramètres → Connecteurs → Ajouter un serveur MCP personnalisé, puis collez l’URL et le jeton.',
  },
  {
    valeur: 'cursor',
    libelle: 'Cursor',
    aide: 'Fichier `.cursor/mcp.json` : ajoutez une entrée « url » avec l’URL SORAHNEX et un en-tête Authorization Bearer.',
  },
  {
    valeur: 'vscode',
    libelle: 'VS Code',
    aide: 'Fichier `.vscode/mcp.json` : type « http », l’URL SORAHNEX et l’en-tête Authorization.',
  },
  {
    valeur: 'generic',
    libelle: 'Autre client MCP',
    aide: 'Tout client compatible Streamable HTTP accepte un POST JSON-RPC avec l’en-tête Authorization Bearer.',
  },
  {
    valeur: 'autre',
    libelle: 'Autre',
    aide: 'Utilisez l’URL et le jeton ci-dessus dans la configuration MCP de votre outil.',
  },
];

function formaterDate(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

type Message = { tone: 'success' | 'error'; text: string };

export function McpConnectionsPage({ sansEnTete = false }: { sansEnTete?: boolean } = {}) {
  const [jetons, setJetons] = useState<JetonMcp[] | null>(null);
  const [activite, setActivite] = useState<EvenementMcp[]>([]);
  const [chargement, setChargement] = useState(true);
  const [erreur, setErreur] = useState<string | null>(null);
  const [message, setMessage] = useState<Message | null>(null);

  const [formulaireOuvert, setFormulaireOuvert] = useState(false);
  const [label, setLabel] = useState('Mon client IA');
  const [typeClient, setTypeClient] = useState<TypeClient>('claude');
  const [ecriture, setEcriture] = useState(false);
  const [creation, setCreation] = useState(false);

  /** Secret affiché UNE fois. Vidé dès que l'utilisateur ferme le bloc. */
  const [secret, setSecret] = useState<JetonCree | null>(null);
  const [copie, setCopie] = useState(false);

  const [permissions, setPermissions] = useState<Record<string, PermissionOutil[]>>({});
  const [ouvert, setOuvert] = useState<string | null>(null);

  const lire = useCallback(async () => {
    setChargement(true);
    setErreur(null);
    try {
      const [liste, journal] = await Promise.all([listerJetons(), listerActivite(20)]);
      setJetons(liste);
      setActivite(journal);
    } catch (cause) {
      setErreur(cause instanceof Error ? cause.message : 'Lecture impossible.');
      setJetons(null);
    } finally {
      setChargement(false);
    }
  }, []);

  useEffect(() => { void lire(); }, [lire]);

  const actifs = useMemo(() => (jetons ?? []).filter((j) => j.actif), [jetons]);
  const revoques = useMemo(() => (jetons ?? []).filter((j) => !j.actif), [jetons]);

  async function creer() {
    setCreation(true);
    setMessage(null);
    try {
      const resultat = await creerJeton({
        label: label.trim() || 'Mon client IA',
        clientName: CLIENTS.find((c) => c.valeur === typeClient)?.libelle ?? 'Client MCP',
        clientKind: typeClient,
        ecriture,
      });
      setSecret(resultat);
      setCopie(false);
      setFormulaireOuvert(false);
      setEcriture(false);
      await lire();
    } catch (cause) {
      const texte = cause instanceof Error ? cause.message : 'Création impossible.';
      // Le message du serveur dit précisément quoi corriger (libellé déjà
      // utilisé, portées invalides) : on le transmet tel quel.
      setMessage({ tone: 'error', text: texte });
    } finally {
      setCreation(false);
    }
  }

  async function copier(valeur: string) {
    try {
      await navigator.clipboard.writeText(valeur);
      setCopie(true);
    } catch {
      setMessage({ tone: 'error', text: 'Copie impossible : sélectionnez le jeton à la main.' });
    }
  }

  async function revoquer(jeton: JetonMcp) {
    setMessage(null);
    try {
      const fait = await revoquerJeton(jeton.tokenId);
      setMessage(fait
        ? { tone: 'success', text: `Jeton « ${jeton.label} » révoqué. Tout client qui l’utilise est déconnecté.` }
        : { tone: 'error', text: 'Ce jeton était déjà révoqué.' });
      await lire();
    } catch (cause) {
      setMessage({ tone: 'error', text: cause instanceof Error ? cause.message : 'Révocation impossible.' });
    }
  }

  async function faireTourner(jeton: JetonMcp) {
    setMessage(null);
    try {
      const resultat = await faireTournerJeton(jeton.tokenId);
      if (!resultat) {
        setMessage({ tone: 'error', text: 'Ce jeton est déjà révoqué : créez-en un nouveau.' });
        return;
      }
      setSecret(resultat);
      setCopie(false);
      await lire();
    } catch (cause) {
      setMessage({ tone: 'error', text: cause instanceof Error ? cause.message : 'Rotation impossible.' });
    }
  }

  async function ouvrirPermissions(jeton: JetonMcp) {
    if (ouvert === jeton.tokenId) {
      setOuvert(null);
      return;
    }
    setOuvert(jeton.tokenId);
    if (!permissions[jeton.tokenId]) {
      try {
        const liste = await listerPermissions(jeton.tokenId);
        setPermissions((p) => ({ ...p, [jeton.tokenId]: liste }));
      } catch (cause) {
        setMessage({ tone: 'error', text: cause instanceof Error ? cause.message : 'Lecture impossible.' });
      }
    }
  }

  async function basculer(jeton: JetonMcp, nomOutil: string, actuel: boolean) {
    try {
      await definirPermission(jeton.tokenId, nomOutil, !actuel);
      const liste = await listerPermissions(jeton.tokenId);
      setPermissions((p) => ({ ...p, [jeton.tokenId]: liste }));
    } catch (cause) {
      setMessage({ tone: 'error', text: cause instanceof Error ? cause.message : 'Modification impossible.' });
    }
  }

  const aideClient = CLIENTS.find((c) => c.valeur === typeClient)?.aide ?? '';

  return (
    <div className="space-y-5" data-testid="mcp-page">
      {!sansEnTete && (
      <header>
        <h1 className="font-display text-xl font-semibold text-white">MCP et connexions IA</h1>
        <p className="mt-1 max-w-2xl text-sm leading-relaxed text-slate-400">
          Connectez Claude, Cursor, VS Code ou tout autre client compatible MCP à votre compte
          SORAHNEX. Vos outils n’accèdent qu’à VOS données : le serveur déduit l’identité du jeton,
          jamais d’un identifiant transmis par le client.
        </p>
      </header>
      )}

      {message && (
        <p
          className={`rounded-lg border px-3.5 py-2.5 text-xs leading-relaxed ${
            message.tone === 'success'
              ? 'border-emerald-500/25 bg-emerald-500/[0.08] text-emerald-200'
              : 'border-rose-500/25 bg-rose-500/[0.08] text-rose-200'
          }`}
          data-testid="mcp-message"
        >
          {message.text}
        </p>
      )}

      {/* ------------------------------ URL officielle ------------------------------ */}
      <section className="rounded-xl border border-line bg-white/[0.03] p-4" data-testid="mcp-url">
        <h2 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">
          <ShieldCheck size={13} /> URL officielle du serveur
        </h2>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-lg border border-line bg-black/40 px-3 py-2 font-mono text-xs text-brand-200">
            {MCP_SERVER_URL || 'URL indisponible : configuration VITE_SUPABASE_URL absente'}
          </code>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void copier(MCP_SERVER_URL)}
            disabled={!MCP_SERVER_URL}
            icon={<Copy size={12} />}
          >
            Copier
          </Button>
        </div>
        <p className="mt-2 text-[0.7rem] leading-relaxed text-slate-500">
          Transport Streamable HTTP, réponse JSON directe (<code>POST</code>). Aucun flux SSE
          n’est maintenu ouvert. L’authentification se fait par l’en-tête
          <code> Authorization: Bearer vyora_mcp_… </code>.
        </p>
      </section>

      {/* ------------------------------ Secret affiché une fois ------------------------------ */}
      {secret && (
        <section
          className="rounded-xl border border-amber-500/30 bg-amber-500/[0.08] p-4"
          data-testid="mcp-secret"
        >
          <h2 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.14em] text-amber-200">
            <KeyRound size={13} /> Copiez ce jeton maintenant
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-amber-100">
            Il ne sera plus jamais affiché : le serveur n’en garde qu’une empreinte. Si vous le
            perdez, révoquez-le et créez-en un autre.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <code
              className="min-w-0 flex-1 break-all rounded-lg border border-amber-500/30 bg-black/50 px-3 py-2 font-mono text-xs text-amber-100"
              data-testid="mcp-secret-value"
            >
              {secret.secret}
            </code>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void copier(secret.secret)}
              icon={copie ? <Check size={12} /> : <Copy size={12} />}
            >
              {copie ? 'Copié' : 'Copier'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => { setSecret(null); setCopie(false); }}
              data-testid="mcp-secret-close"
            >
              J’ai copié, masquer
            </Button>
          </div>
        </section>
      )}

      {/* ------------------------------ Création ------------------------------ */}
      <section className="rounded-xl border border-line bg-white/[0.03] p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">
            Jetons ({actifs.length} actif{actifs.length > 1 ? 's' : ''})
          </h2>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={() => void lire()} loading={chargement} icon={<RefreshCw size={12} />}>
              Actualiser
            </Button>
            <Button
              size="sm"
              onClick={() => setFormulaireOuvert((v) => !v)}
              data-testid="mcp-new-token"
              icon={<KeyRound size={12} />}
            >
              Créer un jeton
            </Button>
          </div>
        </div>

        {formulaireOuvert && (
          <div className="mt-3 space-y-2.5 rounded-lg border border-line bg-black/20 p-3" data-testid="mcp-token-form">
            <Input
              label="Nom du jeton"
              hint="Sert à vous y retrouver : « Claude bureau », « Cursor portable »…"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              disabled={creation}
              data-testid="mcp-label"
            />
            <div>
              <p className="mb-1 text-[0.7rem] font-medium text-slate-300">Client IA</p>
              <div className="flex flex-wrap gap-1.5">
                {CLIENTS.map((client) => (
                  <button
                    key={client.valeur}
                    type="button"
                    onClick={() => setTypeClient(client.valeur)}
                    className={`rounded-lg border px-2.5 py-1.5 text-[0.7rem] transition ${
                      typeClient === client.valeur
                        ? 'border-brand-400/50 bg-brand-500/15 text-brand-100'
                        : 'border-line bg-white/[0.03] text-slate-400 hover:text-slate-200'
                    }`}
                    data-testid={`mcp-client-${client.valeur}`}
                  >
                    {client.libelle}
                  </button>
                ))}
              </div>
              <p className="mt-1.5 text-[0.68rem] leading-relaxed text-slate-500">{aideClient}</p>
            </div>

            <label className="flex items-start gap-2 text-[0.7rem] leading-relaxed text-slate-400">
              <input
                type="checkbox"
                checked={ecriture}
                onChange={(e) => setEcriture(e.target.checked)}
                className="mt-0.5"
                data-testid="mcp-write"
              />
              <span>
                Autoriser les outils d’<strong className="text-slate-200">écriture</strong> (création
                de produits et de projets). Décochez pour un jeton strictement en lecture.
              </span>
            </label>

            <div className="flex gap-2">
              <Button size="sm" onClick={() => void creer()} loading={creation} data-testid="mcp-create">
                Créer et afficher le jeton
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setFormulaireOuvert(false)} disabled={creation}>
                Annuler
              </Button>
            </div>
          </div>
        )}

        {erreur && (
          <p className="mt-3 flex items-start gap-1.5 rounded-lg border border-rose-500/25 bg-rose-500/[0.08] px-3 py-2 text-xs text-rose-200">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" /> {erreur}
          </p>
        )}

        {!erreur && jetons !== null && jetons.length === 0 && (
          <div className="mt-3">
            <EmptyState
              icon={<KeyRound size={20} />}
              title="Aucun jeton MCP"
              description="Créez un jeton pour connecter votre premier client IA à SORAHNEX."
            />
          </div>
        )}

        {jetons !== null && jetons.length > 0 && (
          <ul className="mt-3 space-y-2">
            {[...actifs, ...revoques].map((jeton) => (
              <li
                key={jeton.tokenId}
                className="rounded-lg border border-line bg-white/[0.02] px-3 py-2.5"
                data-testid={`mcp-token-${jeton.tokenId}`}
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-1.5 text-xs font-medium text-slate-200">
                      {jeton.label}
                      {jeton.actif ? (
                        <Badge tone="success"><CheckCircle2 size={10} className="mr-1" />Actif</Badge>
                      ) : (
                        <Badge tone="neutral"><XCircle size={10} className="mr-1" />Révoqué</Badge>
                      )}
                      {jeton.scopes.includes('write') && <Badge tone="warning">Écriture</Badge>}
                    </p>
                    <p className="mt-0.5 font-mono text-[0.68rem] text-slate-500">{jeton.tokenPrefix}…</p>
                    <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[0.68rem] text-slate-400">
                      <span className="inline-flex items-center gap-1">
                        <Clock size={10} /> Créé le {formaterDate(jeton.createdAt)}
                      </span>
                      <span data-testid={`mcp-last-use-${jeton.tokenId}`}>
                        {jeton.lastUsedAt
                          ? `Dernier appel : ${formaterDate(jeton.lastUsedAt)} (${jeton.useCount})`
                          : 'Jamais utilisé par un client'}
                      </span>
                      {jeton.expiresAt && <span>Expire le {formaterDate(jeton.expiresAt)}</span>}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <Button size="sm" variant="ghost" onClick={() => void ouvrirPermissions(jeton)} data-testid={`mcp-perms-${jeton.tokenId}`}>
                      Autorisations
                    </Button>
                    {jeton.actif && (
                      <>
                        <Button size="sm" variant="ghost" onClick={() => void faireTourner(jeton)}>
                          Renouveler
                        </Button>
                        <Button size="sm" variant="danger" onClick={() => void revoquer(jeton)} icon={<Trash2 size={11} />} data-testid={`mcp-revoke-${jeton.tokenId}`}>
                          Révoquer
                        </Button>
                      </>
                    )}
                  </div>
                </div>

                {ouvert === jeton.tokenId && (
                  <div className="mt-2.5 rounded-lg border border-line bg-black/30 p-2.5" data-testid={`mcp-perm-list-${jeton.tokenId}`}>
                    <p className="mb-1.5 text-[0.68rem] leading-relaxed text-slate-500">
                      Par défaut, tout outil autorisé par la portée du jeton est accessible.
                      Décocher un outil le refuse immédiatement pour ce jeton.
                    </p>
                    <ul className="space-y-1">
                      {OUTILS_AFFICHES.filter((o) => !o.ecriture || jeton.scopes.includes('write')).map((outil) => {
                        const perm = (permissions[jeton.tokenId] ?? []).find((p) => p.toolName === outil.nom);
                        const autorise = perm ? perm.allowed : true;
                        return (
                          <li key={outil.nom} className="flex items-center justify-between gap-2">
                            <span className="min-w-0 truncate text-[0.7rem] text-slate-300">
                              <code className="text-slate-500">{outil.nom}</code> — {outil.libelle}
                            </span>
                            <button
                              type="button"
                              disabled={!jeton.actif}
                              onClick={() => void basculer(jeton, outil.nom, autorise)}
                              className={`shrink-0 rounded px-2 py-0.5 text-[0.65rem] ${
                                autorise ? 'bg-emerald-500/15 text-emerald-200' : 'bg-rose-500/15 text-rose-200'
                              } disabled:opacity-40`}
                            >
                              {autorise ? 'Autorisé' : 'Refusé'}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ------------------------------ Outils exposés ------------------------------ */}
      <section className="rounded-xl border border-line bg-white/[0.03] p-4" data-testid="mcp-tools">
        <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">
          Outils exposés ({OUTILS_LECTURE_AFFICHES.length} en lecture)
        </h2>
        <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
          {OUTILS_AFFICHES.map((outil) => (
            <li key={outil.nom} className="flex items-center gap-1.5 text-[0.7rem] text-slate-400">
              {outil.ecriture
                ? <ShieldCheck size={11} className="shrink-0 text-amber-300" />
                : <Check size={11} className="shrink-0 text-brand-300" />}
              <code className="text-slate-500">{outil.nom}</code>
              <span className="truncate">— {outil.libelle}</span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-[0.68rem] leading-relaxed text-slate-500">
          Les outils d’écriture ne sont proposés qu’aux jetons qui en ont la portée, et seulement
          si l’exploitant a activé l’écriture sur le déploiement. Une création de produit reste
          dans SORAHNEX : aucune écriture n’est faite chez une plateforme e-commerce.
        </p>
      </section>

      {/* ------------------------------ Journal ------------------------------ */}
      <section className="rounded-xl border border-line bg-white/[0.03] p-4" data-testid="mcp-activity">
        <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">
          Derniers appels reçus
        </h2>
        {activite.length === 0 ? (
          <p className="mt-2 text-[0.7rem] text-slate-500">
            Aucun appel enregistré. Le journal se remplit dès qu’un client utilise un jeton.
          </p>
        ) : (
          <ul className="mt-2 space-y-1">
            {activite.map((e, index) => (
              <li key={index} className="flex flex-wrap items-center gap-x-2 text-[0.68rem] text-slate-400">
                <span className={e.outcome === 'ok' ? 'text-emerald-300' : 'text-rose-300'}>
                  {e.outcome === 'ok' ? <CheckCircle2 size={10} className="inline" /> : <XCircle size={10} className="inline" />}
                </span>
                <code className="text-slate-500">{e.toolName ?? e.method}</code>
                {e.errorCode && <span className="text-amber-300">({e.errorCode})</span>}
                {e.durationMs !== null && <span>{e.durationMs} ms</span>}
                <span className="text-slate-600">{formaterDate(e.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ------------------------------ Aide client ------------------------------ */}
      <section className="rounded-xl border border-line bg-white/[0.03] p-4">
        <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">
          Configurer mon client
        </h2>
        <ol className="mt-2 space-y-1.5 text-[0.7rem] leading-relaxed text-slate-400">
          <li>1. Créez un jeton ci-dessus et copiez-le immédiatement.</li>
          <li>2. Dans votre client MCP, ajoutez un serveur distant avec l’URL officielle.</li>
          <li>3. Ajoutez l’en-tête <code className="text-slate-300">Authorization: Bearer &lt;votre jeton&gt;</code>.</li>
          <li>4. Lancez l’initialisation : le client doit recevoir la liste des outils.</li>
          <li>5. Revenez ici : « Dernier appel » et le journal confirmeront que la connexion fonctionne.</li>
        </ol>
        {/*
          * Honnêteté de la promesse : SORAHNEX implémente le protocole MCP, mais
          * aucun client tiers n'est certifié par un essai réel de bout en bout.
          * Annoncer « compatible ChatGPT » sans l'avoir essayé serait un
          * mensonge que l'utilisateur découvrirait à ses frais.
          */}
        <p
          className="mt-2 rounded-lg border border-amber-400/25 bg-amber-400/[0.06] px-2.5 py-2 text-[0.68rem] leading-relaxed text-amber-100/90"
          data-testid="avertissement-compatibilite"
        >
          SORAHNEX parle le protocole MCP (Streamable HTTP + OAuth 2.1/PKCE). Aucun client tiers
          (ChatGPT, Claude Code, Cursor, VS Code…) n’a encore été validé par un essai réel de bout
          en bout : considérez la compatibilité comme <strong>attendue</strong>, pas certifiée.
          Le journal ci-dessus est la preuve de ce qui se passe réellement.
        </p>
        <p className="mt-2 flex items-start gap-1.5 text-[0.68rem] leading-relaxed text-slate-500">
          <Loader2 size={11} className="mt-0.5 shrink-0" />
          Si votre client reste « non connecté » alors que le journal montre des appels, c’est
          l’initialisation qui échoue : vérifiez que l’URL se termine bien par
          <code> /functions/v1/{edgeFunctionName('mcp')}</code>.
        </p>
      </section>
    </div>
  );
}

export default McpConnectionsPage;

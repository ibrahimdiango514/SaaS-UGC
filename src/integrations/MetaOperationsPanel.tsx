/**
 * VYORA Integrations — exploitation réelle d'une connexion Meta.
 *
 * ## Règle unique
 *
 * **Rien n'est simulé.** Chaque bouton appelle une action `meta-connect` qui
 * interroge Meta avec le jeton stocké côté serveur. Quand Meta n'est pas
 * configuré, quand une permission manque ou quand une page n'est pas
 * sélectionnée, l'écran affiche le refus tel quel : il n'existe aucun jeu de
 * données de démonstration, aucun compteur inventé, aucun « brouillon » local.
 *
 * ## Ce que chaque produit ouvre
 *
 * - **Facebook Pages** : publier (texte + lien), lire les publications réelles,
 *   supprimer une publication de la page, lire les commentaires d'une
 *   publication, lire les statistiques, lire les événements reçus par webhook.
 * - **Messenger** : boîte de réception (dernier message par contact), fil de
 *   conversation, réponse envoyée via `messenger.send`.
 * - **WhatsApp Business** : même boîte de réception sur le canal WhatsApp,
 *   modèles approuvés, envoi de modèle hors fenêtre de 24 h.
 * - **Instagram** : compte professionnel relié, publication d'un média HTTPS,
 *   statistiques.
 *
 * Les identifiants de page viennent **toujours** de `connexion.pages` (sélection
 * enregistrée par `pages.select`), jamais d'une saisie libre.
 */
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, BarChart3, Inbox, Loader2, MessageCircle, Send, Trash2 } from 'lucide-react';
import { Button, Input, Textarea } from '../components/ui';
import { asAppError } from '../lib/errors';
import {
  deleteFacebookPost,
  listFacebookComments,
  listFacebookPosts,
  listMetaConversations,
  listMetaMessages,
  listMetaPageEvents,
  listWhatsAppTemplates,
  publishFacebookPost,
  publishInstagram,
  readFacebookInsights,
  readInstagramAccount,
  readInstagramInsights,
  sendMessenger,
  sendWhatsApp,
  type MetaConnectionView,
  type MetaConversation,
  type MetaMessage,
  type MetaPageView,
  type MetaProduct,
} from './meta/api';

type Ton = 'success' | 'error';
type Signaler = (message: { tone: Ton; text: string }) => void;

interface Props {
  product: MetaProduct;
  workspaceId: string;
  connexion: MetaConnectionView;
  onChanged: Signaler;
}

const dateHeure = (iso: string | null | undefined) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
};

const extrait = (texte: string | null | undefined, max = 120) => {
  const t = (texte ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return '(sans texte)';
  return t.length > max ? `${t.slice(0, max)}…` : t;
};

/**
 * Enveloppe un appel : renvoie `null` en cas d'échec après avoir affiché le
 * message réel du serveur. Aucun repli silencieux sur une valeur par défaut.
 */
function useAppel() {
  const [busy, setBusy] = useState<string | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const executer = useCallback(async <T,>(cle: string, action: () => Promise<T>): Promise<T | null> => {
    setBusy(cle);
    setErreur(null);
    try {
      return await action();
    } catch (e) {
      setErreur(asAppError(e).message);
      return null;
    } finally {
      setBusy(null);
    }
  }, []);
  return { busy, erreur, executer, setErreur };
}

function BlocErreur({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p className="mt-2 flex items-start gap-1.5 rounded-lg border border-rose-400/25 bg-rose-500/10 px-3 py-2 text-xs leading-relaxed text-rose-100">
      <AlertTriangle size={12} className="mt-0.5 shrink-0" /> {message}
    </p>
  );
}

function Entete({ icon, titre, aide }: { icon: React.ReactNode; titre: string; aide?: string }) {
  return (
    <div>
      <p className="flex items-center gap-1.5 text-xs font-medium text-slate-200">{icon} {titre}</p>
      {aide && <p className="mt-0.5 text-[0.7rem] leading-relaxed text-slate-400">{aide}</p>}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*                          Boîte de réception (inbox)                        */
/* -------------------------------------------------------------------------- */

function InboxPanel({ product, workspaceId, accountRef: compteInitial, onChanged }: {
  product: MetaProduct;
  workspaceId: string;
  /** WhatsApp : `phone_number_id`. Messenger : `page_id`. */
  accountRef: string | null;
  onChanged: Signaler;
}) {
  const envoi = useAppel();
  const [conversations, setConversations] = useState<MetaConversation[] | null>(null);
  const [active, setActive] = useState<MetaConversation | null>(null);
  const [messages, setMessages] = useState<MetaMessage[] | null>(null);
  const [reponse, setReponse] = useState('');
  const [chargement, setChargement] = useState(true);

  const canal = product === 'whatsapp' ? 'whatsapp' : 'messenger';
  const accountRef = compteInitial;

  const chargerConversations = useCallback(async () => {
    setChargement(true);
    try {
      const r = await listMetaConversations(workspaceId, canal, accountRef ?? undefined);
      setConversations(r.conversations);
    } catch (e) {
      setConversations(null);
      setErreur(asAppError(e).message);
    } finally {
      setChargement(false);
    }
  }, [workspaceId, canal, accountRef]);

  const { erreur, setErreur } = envoi;

  useEffect(() => { void chargerConversations(); }, [chargerConversations]);

  const ouvrir = async (conversation: MetaConversation) => {
    setActive(conversation);
    setMessages(null);
    const r = await envoi.executer('fil', () => listMetaMessages(workspaceId, canal, conversation.conversation_ref, conversation.account_ref));
    setMessages(r?.messages ?? []);
  };

  const envoyer = async () => {
    if (!active) return;
    const texte = reponse.trim();
    if (!texte) return;
    const r = await envoi.executer('send', () =>
      canal === 'whatsapp'
        ? sendWhatsApp(workspaceId, { to: active.conversation_ref, text: texte })
        : sendMessenger(workspaceId, { pageId: active.account_ref, recipientId: active.conversation_ref, text: texte }));
    if (!r) return;
    setReponse('');
    onChanged({ tone: 'success', text: 'Meta a accepté le message.' });
    await ouvrir(active);
    await chargerConversations();
  };

  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
      <Entete
        icon={<Inbox size={12} />}
        titre="Boîte de réception"
        aide="Messages réellement reçus par webhook, et réponses envoyées via Meta. Aucun message n’est créé localement."
      />
      {chargement && (
        <p className="mt-2 flex items-center gap-2 text-xs text-slate-400"><Loader2 size={12} className="animate-spin" /> Lecture…</p>
      )}
      {!chargement && conversations && conversations.length === 0 && (
        <p className="mt-2 text-xs leading-relaxed text-slate-400">
          Aucun message reçu pour l’instant. Un message n’apparaît ici qu’après un webhook signé de Meta
          et seulement si {product === 'whatsapp' ? 'le numéro' : 'la page'} est bien rattaché à cette entreprise.
        </p>
      )}
      {conversations && conversations.length > 0 && (
        <ul className="mt-2 max-h-56 space-y-1 overflow-y-auto pr-1">
          {conversations.map((c) => (
            <li key={`${c.account_ref}:${c.conversation_ref}`}>
              <button
                type="button"
                onClick={() => { void ouvrir(c); }}
                className={`w-full rounded-md px-2 py-1.5 text-left text-xs transition hover:bg-white/5 ${active?.conversation_ref === c.conversation_ref ? 'bg-white/10' : ''}`}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="font-medium text-slate-200">{c.conversation_ref}</span>
                  <span className="text-[0.65rem] text-slate-500">{dateHeure(c.last_at)}</span>
                </span>
                <span className="mt-0.5 block truncate text-slate-400">
                  {c.last_direction === 'in' ? '↘ ' : '↗ '}{extrait(c.last_body, 70)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {active && (
        <div className="mt-3 border-t border-white/10 pt-3">
          <p className="text-[0.7rem] text-slate-400">
            Conversation avec <span className="text-slate-200">{active.conversation_ref}</span> · compte {active.account_ref}
          </p>
          {messages === null && <p className="mt-1 flex items-center gap-2 text-xs text-slate-400"><Loader2 size={12} className="animate-spin" /> Lecture du fil…</p>}
          {messages && messages.length === 0 && (
            <p className="mt-1 text-xs text-slate-400">Aucun message dans ce fil.</p>
          )}
          {messages && messages.length > 0 && (
            <ul className="mt-1 max-h-56 space-y-1 overflow-y-auto pr-1">
              {messages.map((m) => (
                <li key={m.id} className={`rounded-md px-2 py-1.5 text-xs ${m.direction === 'in' ? 'bg-white/[0.04]' : 'bg-brand-500/10'}`}>
                  <span className="flex flex-wrap items-center gap-1.5 text-[0.65rem] text-slate-500">
                    <span>{m.direction === 'in' ? 'Reçu' : 'Envoyé'}</span>
                    <span>· {dateHeure(m.sent_at)}</span>
                    {m.direction === 'out' && <span>· {m.status}</span>}
                    {m.error_message && <span className="text-rose-300">· {m.error_message}</span>}
                  </span>
                  <span className="mt-0.5 block whitespace-pre-wrap break-words text-slate-200">{m.body ?? `[${m.message_type}]`}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-2 flex flex-col gap-2 sm:flex-row">
            <Input
              value={reponse}
              onChange={(e) => setReponse(e.target.value)}
              placeholder="Réponse"
              aria-label="Réponse"
              className="sm:flex-1"
            />
            <Button
              size="sm"
              disabled={envoi.busy === 'send' || !reponse.trim()}
              loading={envoi.busy === 'send'}
              onClick={() => { void envoyer(); }}
              icon={<Send size={12} />}
            >
              Envoyer
            </Button>
          </div>
          <p className="mt-1 text-[0.68rem] leading-relaxed text-slate-500">
            {canal === 'whatsapp'
              ? 'WhatsApp n’accepte un texte libre que dans les 24 h suivant un message du contact ; au-delà, un modèle approuvé est requis.'
              : 'Messenger applique la même fenêtre de 24 h.'}
          </p>
        </div>
      )}
      <BlocErreur message={erreur} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*                              Facebook Pages                                */
/* -------------------------------------------------------------------------- */

function FacebookPanel({ workspaceId, pages, onChanged }: {
  workspaceId: string;
  pages: MetaPageView[];
  onChanged: Signaler;
}) {
  const [pageId, setPageId] = useState<string>(pages[0]?.page_id ?? '');
  const appel = useAppel();
  const [message, setMessage] = useState('');
  const [lien, setLien] = useState('');
  const [posts, setPosts] = useState<Array<{ id: string; message?: string; created_time?: string; permalink_url?: string }> | null>(null);
  const [commentaires, setCommentaires] = useState<Record<string, Array<{ id: string; message?: string; created_time?: string; from?: { name?: string } }>>>({});
  const [stats, setStats] = useState<Array<{ name: string; period: string; values: Array<{ value: unknown }> }> | null>(null);
  const [evenements, setEvenements] = useState<Array<{ id: number; item: string | null; message: string | null; occurred_at: string }> | null>(null);

  useEffect(() => { setPageId(pages[0]?.page_id ?? ''); }, [pages]);

  const chargerPosts = useCallback(async () => {
    if (!pageId) return;
    const r = await appel.executer('posts', () => listFacebookPosts(workspaceId, pageId));
    setPosts(r?.posts ?? []);
  }, [appel, workspaceId, pageId]);

  useEffect(() => { void chargerPosts(); }, [chargerPosts]);

  const publier = async () => {
    if (!pageId) return;
    const r = await appel.executer('publish', () => publishFacebookPost(workspaceId, {
      pageId,
      message: message.trim(),
      ...(lien.trim() ? { link: lien.trim() } : {}),
    }));
    if (!r) return;
    setMessage('');
    setLien('');
    onChanged({ tone: 'success', text: 'Publication créée sur la page (identifiant rendu par Meta).' });
    await chargerPosts();
  };

  const supprimer = async (postId: string) => {
    if (!window.confirm('Supprimer définitivement cette publication sur la page ?')) return;
    const r = await appel.executer(`del:${postId}`, () => deleteFacebookPost(workspaceId, pageId, postId));
    if (!r) return;
    onChanged({ tone: 'success', text: 'Publication supprimée chez Meta.' });
    await chargerPosts();
  };

  const lireCommentaires = async (postId: string) => {
    const r = await appel.executer(`com:${postId}`, () => listFacebookComments(workspaceId, pageId, postId));
    if (!r) return;
    setCommentaires((prev) => ({ ...prev, [postId]: r.comments }));
  };

  const lireStats = async () => {
    const r = await appel.executer('insights', () => readFacebookInsights(workspaceId, pageId));
    if (!r) return;
    setStats(r.insights);
  };

  const lireEvenements = async () => {
    const r = await appel.executer('events', () => listMetaPageEvents(workspaceId, 'facebook', pageId));
    if (!r) return;
    setEvenements(r.events);
  };

  if (pages.length === 0) {
    return (
      <p className="rounded-lg border border-amber-400/25 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-100">
        Aucune page sélectionnée : publier, lire les statistiques ou les commentaires exige d’abord de choisir une page.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {pages.length > 1 && (
        <label className="field">
          <span className="field-label">Page utilisée</span>
          <select className="input" value={pageId} onChange={(e) => setPageId(e.target.value)} aria-label="Page utilisée">
            {pages.map((p) => <option key={p.page_id} value={p.page_id}>{p.name}</option>)}
          </select>
        </label>
      )}
      {pages.length === 1 && (
        <p className="text-[0.7rem] text-slate-400">Page : <span className="text-slate-200">{pages[0].name}</span> ({pages[0].page_id})</p>
      )}

      <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
        <Entete icon={<Send size={12} />} titre="Publier sur la page" aide="La publication part réellement chez Meta et apparaît publiquement si la page est publiée." />
        <div className="mt-2 space-y-2">
          <Textarea value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Texte de la publication" aria-label="Texte de la publication" />
          <Input value={lien} onChange={(e) => setLien(e.target.value)} placeholder="Lien (facultatif, https://…)" aria-label="Lien de la publication" />
          <Button
            size="sm"
            // Seule la publication en cours bloque ce bouton : lire la liste des
            // publications en arrière-plan ne doit pas empêcher d'écrire.
            disabled={appel.busy === 'publish' || (!message.trim() && !lien.trim())}
            loading={appel.busy === 'publish'}
            onClick={() => { void publier(); }}
            icon={<Send size={12} />}
          >
            Publier
          </Button>
        </div>
      </div>

      <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Entete icon={<MessageCircle size={12} />} titre="Publications de la page" aide="Lues chez Meta à l’instant, sans cache local." />
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" loading={appel.busy === 'posts'} onClick={() => { void chargerPosts(); }}>Actualiser</Button>
            <Button size="sm" variant="ghost" loading={appel.busy === 'insights'} onClick={() => { void lireStats(); }} icon={<BarChart3 size={12} />}>Statistiques</Button>
            <Button size="sm" variant="ghost" loading={appel.busy === 'events'} onClick={() => { void lireEvenements(); }}>Événements reçus</Button>
          </div>
        </div>
        {posts === null && <p className="mt-2 flex items-center gap-2 text-xs text-slate-400"><Loader2 size={12} className="animate-spin" /> Lecture…</p>}
        {posts && posts.length === 0 && <p className="mt-2 text-xs text-slate-400">Aucune publication renvoyée par Meta pour cette page.</p>}
        {posts && posts.length > 0 && (
          <ul className="mt-2 space-y-2">
            {posts.map((p) => (
              <li key={p.id} className="rounded-md bg-white/[0.03] px-2 py-1.5 text-xs">
                <span className="flex flex-wrap items-center justify-between gap-2 text-[0.65rem] text-slate-500">
                  <span>{dateHeure(p.created_time)} · {p.id}</span>
                  <span className="flex gap-2">
                    {p.permalink_url && (
                      <a className="text-brand-300 hover:underline" href={p.permalink_url} target="_blank" rel="noreferrer noopener">Voir</a>
                    )}
                    <button type="button" className="text-slate-300 hover:underline" onClick={() => { void lireCommentaires(p.id); }}>Commentaires</button>
                    <button type="button" className="text-rose-300 hover:underline" onClick={() => { void supprimer(p.id); }}>
                      <Trash2 size={10} className="mr-0.5 inline" />Supprimer
                    </button>
                  </span>
                </span>
                <span className="mt-0.5 block whitespace-pre-wrap break-words text-slate-200">{extrait(p.message, 240)}</span>
                {commentaires[p.id] && (
                  <ul className="mt-1 space-y-1 border-l border-white/10 pl-2">
                    {commentaires[p.id].length === 0 && <li className="text-[0.68rem] text-slate-400">Aucun commentaire.</li>}
                    {commentaires[p.id].map((c) => (
                      <li key={c.id} className="text-[0.68rem] text-slate-300">
                        <span className="text-slate-500">{c.from?.name ?? 'Inconnu'} · {dateHeure(c.created_time)} : </span>
                        {c.message ?? '(sans texte)'}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}

        {stats && (
          <div className="mt-2 rounded-md bg-white/[0.03] px-2 py-1.5 text-xs">
            <p className="text-[0.65rem] uppercase tracking-wide text-slate-500">Statistiques rendues par Meta</p>
            {stats.length === 0 && <p className="text-slate-400">Meta n’a rendu aucune métrique.</p>}
            <ul className="mt-1 space-y-0.5">
              {stats.map((s) => (
                <li key={s.name} className="text-slate-300">
                  {s.name} ({s.period}) : {s.values.map((v) => JSON.stringify(v.value)).join(', ')}
                </li>
              ))}
            </ul>
          </div>
        )}

        {evenements && (
          <div className="mt-2 rounded-md bg-white/[0.03] px-2 py-1.5 text-xs">
            <p className="text-[0.65rem] uppercase tracking-wide text-slate-500">Événements de page reçus par webhook</p>
            {evenements.length === 0 && <p className="text-slate-400">Aucun événement enregistré. Un événement n’apparaît qu’après un webhook signé de Meta.</p>}
            <ul className="mt-1 space-y-0.5">
              {evenements.map((e) => (
                <li key={e.id} className="text-slate-300">
                  <span className="text-slate-500">{dateHeure(e.occurred_at)} · {e.item ?? '—'} : </span>{extrait(e.message, 100)}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <BlocErreur message={appel.erreur} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*                                 Instagram                                  */
/* -------------------------------------------------------------------------- */

function InstagramPanel({ workspaceId, pages, onChanged }: {
  workspaceId: string;
  pages: MetaPageView[];
  onChanged: Signaler;
}) {
  const liees = pages.filter((p) => Boolean(p.instagram_business_account_id));
  const [pageId, setPageId] = useState<string>(liees[0]?.page_id ?? '');
  const appel = useAppel();
  const [compte, setCompte] = useState<{ id: string; username?: string; followers_count?: number; media_count?: number } | null>(null);
  const [imageUrl, setImageUrl] = useState('');
  const [legende, setLegende] = useState('');
  const [stats, setStats] = useState<Array<{ name: string; period: string; values: Array<{ value: unknown }> }> | null>(null);

  useEffect(() => { setPageId(liees[0]?.page_id ?? ''); }, [liees]);

  if (liees.length === 0) {
    return (
      <p className="rounded-lg border border-amber-400/25 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-100">
        Aucun compte Instagram professionnel n’est relié aux pages sélectionnées. Dans Meta Business Suite,
        rattachez le compte Instagram à la page, puis revenez choisir la page ici.
      </p>
    );
  }

  const lire = async () => {
    const r = await appel.executer('account', () => readInstagramAccount(workspaceId, pageId));
    if (r) setCompte(r.account);
  };
  const lireStats = async () => {
    const r = await appel.executer('insights', () => readInstagramInsights(workspaceId, pageId));
    if (r) setStats(r.insights);
  };
  const publier = async () => {
    const r = await appel.executer('publish', () => publishInstagram(workspaceId, {
      pageId,
      imageUrl: imageUrl.trim(),
      ...(legende.trim() ? { caption: legende.trim() } : {}),
    }));
    if (!r) return;
    onChanged({ tone: 'success', text: 'Média publié sur Instagram (identifiant rendu par Meta).' });
    setImageUrl('');
    setLegende('');
  };

  return (
    <div className="space-y-3">
      {liees.length > 1 && (
        <label className="field">
          <span className="field-label">Page portant le compte Instagram</span>
          <select className="input" value={pageId} onChange={(e) => setPageId(e.target.value)} aria-label="Page portant le compte Instagram">
            {liees.map((p) => (
              <option key={p.page_id} value={p.page_id}>{p.name}{p.instagram_username ? ` → @${p.instagram_username}` : ''}</option>
            ))}
          </select>
        </label>
      )}
      <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Entete icon={<MessageCircle size={12} />} titre="Compte professionnel relié" aide="Lu chez Meta avec le jeton de la page." />
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" loading={appel.busy === 'account'} onClick={() => { void lire(); }}>Lire le compte</Button>
            <Button size="sm" variant="ghost" loading={appel.busy === 'insights'} onClick={() => { void lireStats(); }} icon={<BarChart3 size={12} />}>Statistiques</Button>
          </div>
        </div>
        {compte && (
          <p className="mt-2 text-xs text-slate-300">
            @{compte.username ?? '—'} · {compte.followers_count ?? 0} abonnés · {compte.media_count ?? 0} médias · id {compte.id}
          </p>
        )}
        {stats && (
          <div className="mt-2 rounded-md bg-white/[0.03] px-2 py-1.5 text-xs">
            {stats.length === 0 && <p className="text-slate-400">Meta n’a rendu aucune métrique.</p>}
            <ul className="space-y-0.5">
              {stats.map((s) => (
                <li key={s.name} className="text-slate-300">{s.name} ({s.period}) : {s.values.map((v) => JSON.stringify(v.value)).join(', ')}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
        <Entete
          icon={<Send size={12} />}
          titre="Publier un média"
          aide="Instagram exige une image JPEG accessible en HTTPS. Le fichier doit déjà être hébergé."
        />
        <div className="mt-2 space-y-2">
          <Input value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} placeholder="https://…/image.jpg" aria-label="URL de l’image Instagram" />
          <Textarea value={legende} onChange={(e) => setLegende(e.target.value)} placeholder="Légende" aria-label="Légende Instagram" />
          <Button
            size="sm"
            disabled={appel.busy === 'publish' || !/^https:\/\//i.test(imageUrl.trim())}
            loading={appel.busy === 'publish'}
            onClick={() => { void publier(); }}
            icon={<Send size={12} />}
          >
            Publier sur Instagram
          </Button>
        </div>
      </div>
      <BlocErreur message={appel.erreur} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*                              Modèles WhatsApp                              */
/* -------------------------------------------------------------------------- */

function WhatsAppTemplatesPanel({ workspaceId, onChanged }: { workspaceId: string; onChanged: Signaler }) {
  const appel = useAppel();
  const envoi = useAppel();
  const [modeles, setModeles] = useState<Array<{ id: string; name: string; language: string; status: string; category?: string }> | null>(null);
  const [destinataire, setDestinataire] = useState('');

  const charger = async () => {
    const r = await appel.executer('list', () => listWhatsAppTemplates(workspaceId));
    if (r) setModeles(r.templates);
  };

  const envoyerModele = async (nom: string, langue: string) => {
    const r = await envoi.executer(`send:${nom}`, () => sendWhatsApp(workspaceId, { to: destinataire, template: { name: nom, language: langue } }));
    if (!r) return;
    onChanged({ tone: 'success', text: `Modèle « ${nom} » accepté par Meta.` });
  };

  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Entete
          icon={<MessageSquareIcon />}
          titre="Modèles approuvés"
          aide="Nécessaires pour écrire hors de la fenêtre de 24 h. Créés et approuvés dans WhatsApp Manager."
        />
        <Button size="sm" variant="ghost" loading={appel.busy === 'list'} onClick={() => { void charger(); }}>Charger les modèles</Button>
      </div>
      {modeles === null && <p className="mt-2 text-xs text-slate-400">Aucune liste chargée pour l’instant.</p>}
      {modeles && modeles.length === 0 && <p className="mt-2 text-xs text-slate-400">Aucun modèle sur ce compte WhatsApp Business.</p>}
      {modeles && modeles.length > 0 && (
        <>
          <Input
            value={destinataire}
            onChange={(e) => setDestinataire(e.target.value)}
            placeholder="Numéro destinataire (ex. 22370000000)"
            aria-label="Numéro destinataire du modèle"
            className="mt-2"
          />
          <ul className="mt-2 space-y-1">
            {modeles.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-white/[0.03] px-2 py-1.5 text-xs">
                <span className="text-slate-200">
                  {m.name} <span className="text-slate-500">· {m.language} · {m.category ?? '—'} · {m.status}</span>
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={envoi.busy !== null || m.status !== 'APPROVED' || !destinataire.trim()}
                  loading={envoi.busy === `send:${m.name}`}
                  onClick={() => { void envoyerModele(m.name, m.language); }}
                >
                  Envoyer
                </Button>
              </li>
            ))}
          </ul>
        </>
      )}
      <BlocErreur message={appel.erreur ?? envoi.erreur} />
    </div>
  );
}

function MessageSquareIcon() {
  return <MessageCircle size={12} />;
}

/* -------------------------------------------------------------------------- */
/*                                 Messenger                                  */
/* -------------------------------------------------------------------------- */

function MessengerPanel({ workspaceId, pages, onChanged }: {
  workspaceId: string;
  pages: MetaPageView[];
  onChanged: Signaler;
}) {
  const [pageId, setPageId] = useState(pages[0]?.page_id ?? '');
  useEffect(() => { setPageId(pages[0]?.page_id ?? ''); }, [pages]);

  if (pages.length === 0) {
    return (
      <p className="rounded-lg border border-amber-400/25 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-100">
        Autorisation obtenue, mais aucune page n’est rattachée : choisissez une page pour ouvrir la boîte de réception Messenger.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {pages.length > 1 && (
        <label className="field">
          <span className="field-label">Page Messenger</span>
          <select className="input" value={pageId} onChange={(e) => setPageId(e.target.value)} aria-label="Page Messenger">
            {pages.map((p) => <option key={p.page_id} value={p.page_id}>{p.name}</option>)}
          </select>
        </label>
      )}
      <InboxPanel product="messenger" workspaceId={workspaceId} accountRef={pageId} onChanged={onChanged} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */

export function MetaOperationsPanel({ product, workspaceId, connexion, onChanged }: Props) {
  if (connexion.status !== 'connected') return null;

  if (product === 'facebook') {
    return <FacebookPanel workspaceId={workspaceId} pages={connexion.pages} onChanged={onChanged} />;
  }
  if (product === 'instagram') {
    return <InstagramPanel workspaceId={workspaceId} pages={connexion.pages} onChanged={onChanged} />;
  }
  if (product === 'whatsapp') {
    return (
      <div className="space-y-3">
        <InboxPanel
          product="whatsapp"
          workspaceId={workspaceId}
          accountRef={typeof connexion.metadata?.phone_number_id === 'string' ? connexion.metadata.phone_number_id : null}
          onChanged={onChanged}
        />
        <WhatsAppTemplatesPanel workspaceId={workspaceId} onChanged={onChanged} />
      </div>
    );
  }
  return <MessengerPanel workspaceId={workspaceId} pages={connexion.pages} onChanged={onChanged} />;
}

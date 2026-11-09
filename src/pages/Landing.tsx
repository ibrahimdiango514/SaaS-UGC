import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight, BadgeCheck, Check, Clapperboard, Coins, FileText, Layers,
  LockKeyhole, Play, ShieldCheck, Sparkles, Users, Wand2, Zap,
} from 'lucide-react';
import { listPlans } from '../lib/api';
import { formatMoney } from '../lib/format';
import type { Plan } from '../lib/types';
import { Card, LoadingState, cn } from '../components/ui';

const FEATURES = [
  { icon: Wand2, title: 'Scripts IA en français', text: 'Générez des scripts UGC structurés (accroche, scènes, CTA) avec Groq, puis gardez chaque version dans l’historique.' },
  { icon: Users, title: 'Avatars & voix', text: 'Gérez vos avatars, identifiants fournisseur, voix et images de référence pour chaque campagne.' },
  { icon: Clapperboard, title: 'UGC Studio', text: 'Réglez durée, format, style, sous-titres et scènes avant de lancer une vraie génération vidéo.' },
  { icon: Sparkles, title: 'Bibliothèque & historique', text: 'Retrouvez chaque vidéo terminée, ses métadonnées, les événements de production et les mouvements de crédits.' },
  { icon: Coins, title: 'Crédits & quotas maîtrisés', text: 'Réservation, consommation et restitution automatiques des crédits, avec limites par formule.' },
  { icon: ShieldCheck, title: 'Sécurité par conception', text: 'Authentification Supabase, RLS sur chaque table, clés d’API uniquement côté serveur.' },
];

const STEPS = [
  { n: '01', title: 'Décrivez votre produit', text: 'Brief, audience, plateforme, objectif et ton.' },
  { n: '02', title: 'L’IA écrit le script', text: 'Accroche, scènes, sous-titres et appel à l’action.' },
  { n: '03', title: 'Choisissez l’avatar', text: 'Voix, style, format et paramètres vidéo.' },
  { n: '04', title: 'Générez & publiez', text: 'Suivi en temps réel, puis vidéo dans la bibliothèque.' },
];

const FAQ = [
  { q: 'Reelora génère-t-il réellement des vidéos ?', a: 'Oui. Reelora soumet la génération au fournisseur vidéo MuAPI avec le modèle et les paramètres que vous choisissez, puis télécharge et stocke le fichier produit dans votre bibliothèque privée. Le secret serveur MUAPI_API_KEY doit être configuré.' },
  { q: 'Que se passe-t-il si une clé API manque ?', a: 'Aucune fausse vidéo n’est créée. L’application affiche précisément le secret manquant, marque la tâche comme échouée et restitue intégralement les crédits réservés.' },
  { q: 'Mes données sont-elles isolées ?', a: 'Chaque espace de travail est isolé par des politiques RLS PostgreSQL. Les clés Groq et MuAPI, le jeton du worker et la clé service_role Supabase ne sont jamais envoyés au navigateur.' },
  { q: 'Comment fonctionnent les crédits ?', a: 'Le coût estimé est affiché avant confirmation. Chaque service a un coût en crédits, réservé au lancement, consommé uniquement en cas de succès et restitué en cas d’échec, d’expiration ou d’annulation. Une clé d’idempotence empêche tout double débit.' },
];

export default function Landing() {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [plansLoading, setPlansLoading] = useState(true);
  const [openFaq, setOpenFaq] = useState<number | null>(0);

  useEffect(() => {
    let active = true;
    listPlans().then((p) => { if (active) setPlans(p); })
      .catch(() => { if (active) setPlans([]); })
      .finally(() => { if (active) setPlansLoading(false); });
    return () => { active = false; };
  }, []);

  return (
    <div className="min-h-screen overflow-hidden">
      {/* Nav */}
      <header className="sticky top-0 z-40 border-b border-line bg-ink/80 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-7xl items-center gap-4 px-4 sm:px-6">
          <Link to="/" className="flex items-center gap-2.5">
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-brand-400 to-brand-700 text-white shadow-glow"><Clapperboard size={19} /></span>
            <span className="text-lg font-extrabold tracking-tight text-white">Reelora<span className="text-brand-400">.</span></span>
          </Link>
          <nav className="ml-8 hidden items-center gap-6 text-sm text-slate-400 md:flex">
            <a href="#fonctionnalites" className="hover:text-white">Fonctionnalités</a>
            <a href="#workflow" className="hover:text-white">Comment ça marche</a>
            <a href="#tarifs" className="hover:text-white">Tarifs</a>
            <a href="#faq" className="hover:text-white">FAQ</a>
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <Link to="/connexion" className="btn btn-ghost btn-sm hidden sm:inline-flex">Connexion</Link>
            <Link to="/inscription" className="btn btn-primary btn-sm">Commencer <ArrowRight size={14} /></Link>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="relative mx-auto max-w-7xl px-4 pb-20 pt-14 sm:px-6 sm:pt-24">
        <div className="grid items-center gap-12 lg:grid-cols-2">
          <div className="animate-fadeUp">
            <div className="inline-flex items-center gap-2 rounded-full border border-brand-400/25 bg-brand-500/10 px-3 py-1.5 text-xs font-semibold text-brand-200">
              <Sparkles size={13} /> Studio UGC propulsé par l’intelligence artificielle
            </div>
            <h1 className="mt-6 text-4xl font-extrabold leading-[1.08] tracking-tight text-white sm:text-6xl">
              Créez des vidéos <span className="gradient-text">UGC</span> qui convertissent, en quelques minutes.
            </h1>
            <p className="mt-6 max-w-xl text-base leading-relaxed text-slate-300 sm:text-lg">
              Reelora réunit la rédaction de scripts par IA, la gestion d’avatars, un studio de génération vidéo connecté à de vrais fournisseurs et une bibliothèque sécurisée. Tout est piloté depuis un seul espace, en français.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link to="/inscription" className="btn btn-primary btn-lg">Créer mon compte <ArrowRight size={17} /></Link>
              <a href="#fonctionnalites" className="btn btn-outline btn-lg"><Play size={16} /> Découvrir la plateforme</a>
            </div>
            <div className="mt-9 flex flex-wrap gap-x-7 gap-y-3 text-sm text-slate-400">
              {['Scripts IA illimités selon formule', 'Crédits restitués en cas d’échec', 'Données isolées par RLS'].map((x) => (
                <span key={x} className="flex items-center gap-2"><BadgeCheck size={16} className="text-emerald-400" /> {x}</span>
              ))}
            </div>
          </div>

          <div className="relative animate-fadeUp">
            <div className="absolute -inset-6 rounded-full bg-brand-600/20 blur-3xl" />
            <div className="relative rounded-2xl border border-line bg-panel/90 p-4 shadow-2xl">
              <div className="flex items-center gap-2 border-b border-line pb-3">
                <span className="h-2.5 w-2.5 rounded-full bg-rose-400/70" /><span className="h-2.5 w-2.5 rounded-full bg-amber-400/70" /><span className="h-2.5 w-2.5 rounded-full bg-emerald-400/70" />
                <span className="ml-2 text-xs text-slate-500">Reelora / UGC Studio</span>
              </div>
              <div className="mt-4 grid grid-cols-5 gap-3">
                <div className="col-span-2 space-y-3">
                  {[{ icon: FileText, t: 'Script', d: 'Accroche + 4 scènes' }, { icon: Users, t: 'Avatar', d: 'Voix française' }, { icon: Layers, t: 'Réglages', d: '9:16 · 15 s · HD' }].map((x) => (
                    <div key={x.t} className="rounded-xl border border-line bg-white/[0.03] p-3">
                      <x.icon size={15} className="text-brand-300" />
                      <p className="mt-2 text-xs font-semibold text-white">{x.t}</p>
                      <p className="text-[11px] text-slate-500">{x.d}</p>
                    </div>
                  ))}
                </div>
                <div className="col-span-3">
                  <div className="relative aspect-[9/16] overflow-hidden rounded-xl border border-line bg-gradient-to-br from-brand-900/60 via-panel2 to-cyan-900/30">
                    <div className="absolute inset-0 grid place-items-center">
                      <div className="grid h-14 w-14 place-items-center rounded-full border border-white/20 bg-white/10 backdrop-blur"><Play size={22} className="ml-1 text-white" /></div>
                    </div>
                    <div className="absolute bottom-3 left-3 right-3 space-y-1.5">
                      <div className="h-2 w-4/5 rounded-full bg-white/25" /><div className="h-2 w-3/5 rounded-full bg-white/15" />
                    </div>
                  </div>
                  <div className="mt-3 flex items-center justify-between rounded-xl border border-line bg-white/[0.03] px-3 py-2">
                    <span className="flex items-center gap-2 text-xs text-slate-300"><span className="h-2 w-2 animate-pulse rounded-full bg-emerald-400" /> Génération</span>
                    <span className="text-xs font-semibold text-brand-200">Suivi en direct</span>
                  </div>
                </div>
              </div>
            </div>
            <div className="absolute -bottom-6 -left-6 hidden animate-float rounded-xl border border-line bg-panel/95 p-3 shadow-xl sm:block">
              <p className="flex items-center gap-2 text-xs font-semibold text-white"><Coins size={14} className="text-amber-300" /> Crédits protégés</p>
              <p className="mt-1 text-[11px] text-slate-400">Réservés puis restitués si échec</p>
            </div>
          </div>
        </div>
      </section>

      {/* Features */}
      <section id="fonctionnalites" className="mx-auto max-w-7xl px-4 py-16 sm:px-6">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand-300">La plateforme</p>
          <h2 className="mt-3 text-3xl font-bold text-white sm:text-4xl">Tout le cycle de production UGC</h2>
          <p className="mt-3 text-slate-400">De l’idée à la vidéo stockée, chaque étape est réellement connectée à la base de données et aux services d’IA.</p>
        </div>
        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <Card key={f.title} className="group p-6 transition-colors hover:border-brand-400/30">
              <div className="grid h-11 w-11 place-items-center rounded-xl bg-brand-500/15 text-brand-300"><f.icon size={20} /></div>
              <h3 className="mt-4 text-base font-semibold text-white">{f.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-400">{f.text}</p>
            </Card>
          ))}
        </div>
      </section>

      {/* Workflow */}
      <section id="workflow" className="border-y border-line bg-panel/30 py-16">
        <div className="mx-auto max-w-7xl px-4 sm:px-6">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-cyan-300">Workflow</p>
              <h2 className="mt-3 text-3xl font-bold text-white">Quatre étapes, une seule plateforme</h2>
            </div>
            <Link to="/inscription" className="btn btn-outline btn-md">Lancer mon premier projet <ArrowRight size={15} /></Link>
          </div>
          <div className="mt-10 grid gap-4 md:grid-cols-4">
            {STEPS.map((s) => (
              <div key={s.n} className="relative rounded-2xl border border-line bg-panel/60 p-5">
                <span className="text-3xl font-black text-white/10">{s.n}</span>
                <h3 className="mt-2 text-sm font-semibold text-white">{s.title}</h3>
                <p className="mt-2 text-xs leading-relaxed text-slate-400">{s.text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section id="tarifs" className="mx-auto max-w-7xl px-4 py-16 sm:px-6">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand-300">Tarifs</p>
          <h2 className="mt-3 text-3xl font-bold text-white sm:text-4xl">Des formules adaptées à votre cadence</h2>
          <p className="mt-3 text-sm text-slate-400">Les formules et quotas ci-dessous proviennent directement de la base Reelora.</p>
        </div>
        {plansLoading && <LoadingState label="Chargement des formules…" />}
        {!plansLoading && plans.length === 0 && <p className="mt-10 text-center text-sm text-slate-400">Les formules seront affichées dès que la connexion à la base est disponible.</p>}
        <div className="mt-12 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {plans.map((plan) => (
            <Card key={plan.plan_key} className={cn('flex flex-col p-6', plan.plan_key === 'studio' && 'border-brand-400/50 ring-1 ring-brand-400/20')}>
              {plan.plan_key === 'studio' && <span className="mb-3 w-fit rounded-full bg-brand-500/20 px-2.5 py-1 text-[11px] font-semibold text-brand-200">Le plus choisi</span>}
              <h3 className="text-lg font-bold text-white">{plan.display_name}</h3>
              <p className="mt-1 text-xs text-slate-400">{plan.tagline}</p>
              <p className="mt-5 text-2xl font-extrabold text-white">{formatMoney(plan.monthly_price_minor, plan.currency)}<span className="text-sm font-normal text-slate-500"> / mois</span></p>
              <ul className="mt-5 flex-1 space-y-2.5">
                {plan.features.map((f) => <li key={f} className="flex items-start gap-2 text-xs text-slate-300"><Check size={14} className="mt-0.5 shrink-0 text-emerald-400" /> {f}</li>)}
              </ul>
              <div className="mt-5 rounded-lg border border-line bg-white/[0.03] px-3 py-2 text-xs text-slate-400">
                {plan.max_projects} projets · {plan.max_videos_per_month} vidéos/mois · {plan.max_scripts_per_month} scripts/mois
              </div>
              <Link to="/inscription" className={cn('btn btn-md mt-4 w-full', plan.plan_key === 'studio' ? 'btn-primary' : 'btn-outline')}>Choisir {plan.display_name}</Link>
            </Card>
          ))}
        </div>
      </section>

      {/* FAQ */}
      <section id="faq" className="border-t border-line bg-panel/30 py-16">
        <div className="mx-auto max-w-3xl px-4 sm:px-6">
          <h2 className="text-center text-3xl font-bold text-white">Questions fréquentes</h2>
          <div className="mt-10 space-y-3">
            {FAQ.map((item, i) => (
              <div key={item.q} className="rounded-xl border border-line bg-panel/60">
                <button onClick={() => setOpenFaq(openFaq === i ? null : i)} className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left text-sm font-semibold text-white">
                  {item.q} <span className="text-brand-300">{openFaq === i ? '−' : '+'}</span>
                </button>
                {openFaq === i && <p className="px-5 pb-5 text-sm leading-relaxed text-slate-400">{item.a}</p>}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="mx-auto max-w-7xl px-4 py-20 sm:px-6">
        <div className="relative overflow-hidden rounded-3xl border border-brand-400/25 bg-gradient-to-br from-brand-700/40 via-panel to-cyan-900/20 p-10 text-center sm:p-16">
          <div className="absolute -left-20 -top-20 h-64 w-64 rounded-full bg-brand-500/20 blur-3xl" />
          <div className="relative">
            <Zap className="mx-auto text-brand-200" size={28} />
            <h2 className="mt-4 text-3xl font-bold text-white sm:text-4xl">Prêt à produire votre première vidéo UGC ?</h2>
            <p className="mx-auto mt-3 max-w-xl text-sm text-slate-300">Créez votre espace, décrivez votre produit et laissez Reelora orchestrer le reste.</p>
            <Link to="/inscription" className="btn btn-primary btn-lg mt-7">Créer mon compte gratuitement <ArrowRight size={17} /></Link>
          </div>
        </div>
      </section>

      <footer className="border-t border-line py-8">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-4 px-4 text-xs text-slate-500 sm:flex-row sm:px-6">
          <div className="flex items-center gap-2"><Clapperboard size={15} className="text-brand-400" /> <span className="font-semibold text-slate-300">Reelora</span> · Studio UGC avec IA</div>
          <div className="flex flex-wrap items-center gap-5">
            <Link to="/confidentialite" className="hover:text-white">Confidentialité</Link>
            <Link to="/conditions" className="hover:text-white">Conditions d’utilisation</Link>
            <Link to="/connexion" className="hover:text-white">Connexion</Link>
            <span className="flex items-center gap-1.5"><LockKeyhole size={12} /> Données hébergées dans l’UE</span>
          </div>
        </div>
      </footer>
    </div>
  );
}

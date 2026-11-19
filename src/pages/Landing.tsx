/**
 * VYORA — landing publique.
 *
 * ## Ce que cette page doit faire
 *
 * Une seule chose : qu'un commerçant de Bamako, sur un Android d'entrée de
 * gamme en 3G, comprenne en dix secondes ce que VYORA lui fait gagner — puis
 * clique. Tout le reste (animation, mise en page, couleurs) est au service de
 * ce clic, jamais l'inverse.
 *
 * ## Ordre des sections, et pourquoi
 *
 *   1. Hero            — la promesse et un seul bouton
 *   2. Problème vécu   — on nomme la douleur avant de vendre la solution
 *   3. Solution        — les deux espaces, un CTA chacun
 *   4. Comment ça marche — 3 étapes, preuve de simplicité
 *   5. Fonctionnalités classées par douleur (pas par module)
 *   6. Tarifs          — lus en base
 *   7. FAQ
 *   8. CTA final
 *
 * ## Ce que cette page ne fait pas
 *
 *   - Aucun faux témoignage : la preuve sociale est pilotée par
 *     `landing.social.actif`, à `false` par défaut.
 *   - Aucun faux chiffre : pas de « 10 000 utilisateurs » sans donnée réelle.
 *   - Aucune fonction non opérationnelle présentée comme disponible : pas de
 *     mention de WhatsApp automatisé, de MCP, ni d'écriture sur boutique.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight, BadgeCheck, Check, ChevronDown, CircleDollarSign,
  Clock, FileText, Menu, ShieldCheck, Sparkles, X,
} from 'lucide-react';
import { BrandLockup } from '../components/Brand';
import { SceneHero } from '../marketing/3d/SceneHero';
import { chargerContenu, type CleContenu, CONTENU_PAR_DEFAUT } from '../marketing/contenu';
import { chargerTarifs, formaterFcfa, type TarifPlan } from '../marketing/tarifs';
import { ThemeToggle } from '../components/ThemeToggle';
import { cn } from '../components/ui';

const CLES: CleContenu[] = Object.keys(CONTENU_PAR_DEFAUT) as CleContenu[];

/** Fonctionnalités regroupées par douleur résolue, pas par module technique. */
const DOULEURS = [
  {
    douleur: '« Je perds de l’argent sans savoir où »',
    icon: CircleDollarSign,
    items: [
      { titre: 'Suivi des impayés', texte: 'Chaque facture sait qui doit, combien, et depuis quand.' },
      { titre: 'Relances prêtes à envoyer', texte: 'L’assistant rédige, vous validez, le message part par WhatsApp, SMS ou e-mail.' },
      { titre: 'Montant récupérable', texte: 'Une phrase claire, calculée sur vos vraies factures : combien vous pouvez récupérer cette semaine.' },
    ],
  },
  {
    douleur: '« Je n’ai pas le temps »',
    icon: Clock,
    items: [
      { titre: 'Vous parlez, ça s’enregistre', texte: '« Ajoute Fatou Traoré, a commandé 3 sacs, doit payer vendredi. » C’est fait.' },
      { titre: 'Photo de facture', texte: 'Vous photographiez, l’assistant lit et prépare le brouillon à valider.' },
      { titre: 'Ce qui est dû aujourd’hui', texte: 'Un écran unique à l’ouverture : les tâches et les relances du jour, rien d’autre.' },
    ],
  },
  {
    douleur: '« Je ne peux pas produire de contenu »',
    icon: Sparkles,
    items: [
      { titre: 'Scripts publicitaires', texte: 'Accroche, scènes, appel à l’action — en français, dans votre style.' },
      { titre: 'Vidéos à partir de votre produit', texte: 'Une photo suffit pour lancer une vidéo courte.' },
      { titre: 'Montage sans logiciel', texte: 'Coupez, sous-titrez, exportez depuis le navigateur. Aucun abonnement de plus.' },
    ],
  },
] as const;

const ETAPES = ['landing.etapes.item1', 'landing.etapes.item2', 'landing.etapes.item3'] as const;

export default function Landing() {
  const [contenu, setContenu] = useState<Record<string, string>>(() =>
    Object.fromEntries(CLES.map((k) => [k, CONTENU_PAR_DEFAUT[k] as string])),
  );
  const [tarifs, setTarifs] = useState<TarifPlan[]>([]);
  const [tarifsCharges, setTarifsCharges] = useState(false);
  const [menuOuvert, setMenuOuvert] = useState(false);

  useEffect(() => {
    // Contenu et tarifs en parallèle. La page s'affiche immédiatement avec les
    // valeurs par défaut : aucun écran de chargement sur une landing.
    void chargerContenu(CLES).then(setContenu);
    void chargerTarifs('business').then((t) => {
      setTarifs(t);
      setTarifsCharges(true);
    });
  }, []);

  const socialActif = contenu['landing.social.actif'] === 'true';

  const sections = useMemo(
    () => [
      { id: 'probleme', label: 'Le problème' },
      { id: 'solution', label: 'La solution' },
      { id: 'tarifs', label: 'Tarifs' },
      { id: 'faq', label: 'FAQ' },
    ],
    [],
  );

  return (
    <div data-univers="business" className="min-h-dvh bg-ink text-slate-100">
      {/* ---------------------------- Navigation ---------------------------- */}
      <header className="sticky top-0 z-40 border-b border-line bg-ink/85 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-3 px-4 sm:px-6">
          <Link to="/" className="vy-min0 flex items-center" aria-label="VYORA, accueil">
            <BrandLockup />
          </Link>

          <nav className="hidden items-center gap-1 md:flex" aria-label="Navigation principale">
            {sections.map((s) => (
              <a
                key={s.id}
                href={`#${s.id}`}
                className="tap inline-flex items-center rounded-lg px-3 text-sm text-slate-300 transition-colors hover:bg-white/5 hover:text-white"
              >
                {s.label}
              </a>
            ))}
          </nav>

          <div className="flex items-center gap-2">
            <ThemeToggle />
            <Link to="/connexion" className="btn btn-ghost btn-sm hidden sm:inline-flex">
              Connexion
            </Link>
            <Link to="/inscription" className="btn btn-primary btn-sm">
              Commencer
            </Link>
            <button
              type="button"
              className="btn btn-ghost btn-icon md:hidden"
              aria-label={menuOuvert ? 'Fermer le menu' : 'Ouvrir le menu'}
              aria-expanded={menuOuvert}
              onClick={() => setMenuOuvert((v) => !v)}
            >
              {menuOuvert ? <X size={20} /> : <Menu size={20} />}
            </button>
          </div>
        </div>

        {menuOuvert && (
          <nav className="border-t border-line px-4 py-2 md:hidden" aria-label="Navigation mobile">
            {sections.map((s) => (
              <a
                key={s.id}
                href={`#${s.id}`}
                onClick={() => setMenuOuvert(false)}
                className="flex min-h-12 items-center px-1 text-sm text-slate-300"
              >
                {s.label}
              </a>
            ))}
            <Link to="/connexion" className="flex min-h-12 items-center px-1 text-sm text-slate-300">
              Connexion
            </Link>
          </nav>
        )}
      </header>

      <main>
        {/* ------------------------------- Hero ------------------------------ */}
        <section className="relative overflow-hidden px-4 pb-12 pt-10 sm:px-6 sm:pb-16 sm:pt-14 lg:pt-20">
          <div className="mx-auto grid max-w-6xl gap-10 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)] lg:items-center">
            <div className="vy-min0">
              <p className="inline-flex items-center gap-2 rounded-full border border-line bg-white/[0.04] px-3 py-1 text-2xs font-medium uppercase tracking-wider text-slate-400">
                <span className="h-1.5 w-1.5 rounded-full bg-brand-500" aria-hidden="true" />
                {contenu['landing.hero.surtitre']}
              </p>

              <h1 className="mt-5 text-balance font-display text-4xl font-semibold leading-[1.05] tracking-tight text-white sm:text-5xl">
                {contenu['landing.hero.titre']}
              </h1>

              <p className="mt-5 max-w-prose text-lg leading-relaxed text-slate-300">
                {contenu['landing.hero.sous_titre']}
              </p>

              <div className="mt-7 flex flex-col gap-3 sm:flex-row sm:items-center">
                <Link to="/inscription" className="btn btn-primary btn-lg w-full sm:w-auto">
                  {contenu['landing.hero.cta_principal']}
                  <ArrowRight size={18} aria-hidden="true" />
                </Link>
                <a href="#solution" className="btn btn-outline btn-lg w-full sm:w-auto">
                  {contenu['landing.hero.cta_secondaire']}
                </a>
              </div>

              <p className="mt-4 text-xs text-slate-500">{contenu['landing.hero.rassurance']}</p>
            </div>

            {/* La 3D est décorative : elle vit dans un conteneur borné et ne
                capte aucun événement. Le titre et le CTA sont déjà rendus. */}
            <div className="vy-min0">
              <SceneHero
                univers="business"
                alt=""
                className="pointer-events-none w-full"
              />
            </div>
          </div>
        </section>

        {/* ----------------------------- Problème ---------------------------- */}
        <section id="probleme" className="scroll-mt-20 border-t border-line px-4 py-14 sm:px-6 sm:py-20">
          <div className="mx-auto max-w-6xl">
            <h2 className="max-w-2xl font-display text-3xl font-semibold tracking-tight text-white sm:text-4xl">
              {contenu['landing.probleme.titre']}
            </h2>

            <div className="mt-10 grid gap-5 md:grid-cols-3">
              {[1, 2, 3].map((i) => (
                <article
                  key={i}
                  className="rounded-2xl border border-line bg-panel/70 p-5 transition-colors hover:border-line-strong"
                >
                  <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-rose-500/10 text-rose-300">
                    {i === 1 ? <Clock size={19} /> : i === 2 ? <CircleDollarSign size={19} /> : <FileText size={19} />}
                  </div>
                  <h3 className="text-base font-semibold text-white">
                    {contenu[`landing.probleme.item${i}.titre`]}
                  </h3>
                  <p className="mt-2 text-sm leading-relaxed text-slate-400">
                    {contenu[`landing.probleme.item${i}.texte`]}
                  </p>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* ----------------------------- Solution ---------------------------- */}
        <section id="solution" className="scroll-mt-20 border-t border-line px-4 py-14 sm:px-6 sm:py-20">
          <div className="mx-auto max-w-6xl">
            <h2 className="font-display text-3xl font-semibold tracking-tight text-white sm:text-4xl">
              {contenu['landing.solution.titre']}
            </h2>
            <p className="mt-4 max-w-2xl text-base leading-relaxed text-slate-300">
              {contenu['landing.solution.texte']}
            </p>

            <div className="mt-10 grid gap-5 lg:grid-cols-2">
              {/* Business Grow */}
              <article
                data-univers="business"
                className="group relative overflow-hidden rounded-3xl border border-line bg-panel p-6 sm:p-8"
              >
                <div
                  className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full opacity-40 blur-3xl transition-opacity group-hover:opacity-60"
                  style={{ background: 'var(--vy-accent)' }}
                  aria-hidden="true"
                />
                <p className="text-2xs font-semibold uppercase tracking-widest text-brand-400">
                  Pour les commerçants et PME
                </p>
                <h3 className="mt-3 font-display text-2xl font-semibold text-white">Business Grow</h3>
                <p className="mt-2 text-sm leading-relaxed text-slate-300">
                  Récupérez les impayés, relancez au bon moment, ne perdez plus un client par oubli.
                </p>
                <ul className="mt-5 space-y-2.5">
                  {['Prospects et clients au même endroit', 'Factures, devis et reçus PDF', 'Relances préparées, que vous validez', '« Qui relancer aujourd’hui » calculé pour vous'].map(
                    (t) => (
                      <li key={t} className="flex items-start gap-2 text-sm text-slate-300">
                        <Check size={16} className="mt-0.5 shrink-0 text-brand-500" aria-hidden="true" />
                        <span className="vy-min0">{t}</span>
                      </li>
                    ),
                  )}
                </ul>
                <Link to="/inscription?espace=business" className="btn btn-primary btn-md mt-6 w-full sm:w-auto">
                  Ouvrir Business Grow
                  <ArrowRight size={16} aria-hidden="true" />
                </Link>
              </article>

              {/* Studio */}
              <article
                data-univers="studio"
                className="group relative overflow-hidden rounded-3xl border border-line bg-panel p-6 sm:p-8"
              >
                <div
                  className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full opacity-40 blur-3xl transition-opacity group-hover:opacity-60"
                  style={{ background: 'var(--vy-accent)' }}
                  aria-hidden="true"
                />
                <p className="text-2xs font-semibold uppercase tracking-widest text-brand-400">
                  Pour les créateurs et agences
                </p>
                <h3 className="mt-3 font-display text-2xl font-semibold text-white">VYORA Studio</h3>
                <p className="mt-2 text-sm leading-relaxed text-slate-300">
                  Produisez vos vidéos publicitaires sans studio, sans caméra, sans monteur.
                </p>
                <ul className="mt-5 space-y-2.5">
                  {['Scripts et accroches rédigés', 'Vidéo à partir d’une photo produit', 'Montage et export dans le navigateur', 'Coût affiché avant chaque génération'].map(
                    (t) => (
                      <li key={t} className="flex items-start gap-2 text-sm text-slate-300">
                        <Check size={16} className="mt-0.5 shrink-0 text-brand-500" aria-hidden="true" />
                        <span className="vy-min0">{t}</span>
                      </li>
                    ),
                  )}
                </ul>
                <Link to="/inscription?espace=studio" className="btn btn-primary btn-md mt-6 w-full sm:w-auto">
                  Ouvrir VYORA Studio
                  <ArrowRight size={16} aria-hidden="true" />
                </Link>
              </article>
            </div>
          </div>
        </section>

        {/* --------------------------- Comment ça marche --------------------- */}
        <section className="border-t border-line px-4 py-14 sm:px-6 sm:py-20">
          <div className="mx-auto max-w-6xl">
            <h2 className="font-display text-3xl font-semibold tracking-tight text-white sm:text-4xl">
              {contenu['landing.etapes.titre']}
            </h2>
            <ol className="mt-10 grid gap-5 md:grid-cols-3">
              {ETAPES.map((cle, i) => (
                <li key={cle} className="rounded-2xl border border-line bg-panel/60 p-5">
                  <span className="font-display text-3xl font-semibold text-brand-500/40" aria-hidden="true">
                    0{i + 1}
                  </span>
                  <h3 className="mt-2 text-base font-semibold text-white">{contenu[`${cle}.titre`]}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-slate-400">{contenu[`${cle}.texte`]}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* ------------------- Fonctionnalités par douleur ------------------- */}
        <section className="border-t border-line px-4 py-14 sm:px-6 sm:py-20">
          <div className="mx-auto max-w-6xl">
            <h2 className="font-display text-3xl font-semibold tracking-tight text-white sm:text-4xl">
              Ce que VYORA fait pour vous
            </h2>
            <div className="mt-10 space-y-10">
              {DOULEURS.map(({ douleur, icon: Icon, items }) => (
                <div key={douleur}>
                  <div className="flex items-center gap-3">
                    <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-500/12 text-brand-400">
                      <Icon size={18} aria-hidden="true" />
                    </span>
                    <h3 className="vy-min0 text-lg font-semibold text-white">{douleur}</h3>
                  </div>
                  <div className="mt-4 grid gap-4 sm:grid-cols-3">
                    {items.map((it) => (
                      <div key={it.titre} className="rounded-xl border border-line bg-panel/50 p-4">
                        <p className="text-sm font-semibold text-slate-100">{it.titre}</p>
                        <p className="mt-1.5 text-sm leading-relaxed text-slate-400">{it.texte}</p>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ------------------------------ Tarifs ----------------------------- */}
        <section id="tarifs" className="scroll-mt-20 border-t border-line px-4 py-14 sm:px-6 sm:py-20">
          <div className="mx-auto max-w-6xl">
            <h2 className="font-display text-3xl font-semibold tracking-tight text-white sm:text-4xl">
              {contenu['landing.tarifs.titre']}
            </h2>
            <p className="mt-3 max-w-2xl text-sm text-slate-400">{contenu['landing.tarifs.sous_titre']}</p>

            {!tarifsCharges ? (
              <div className="mt-10 grid gap-5 md:grid-cols-3" aria-hidden="true">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="skeleton h-72 rounded-2xl" />
                ))}
              </div>
            ) : tarifs.length === 0 ? (
              // Aucun prix inventé : on renvoie vers la demande d'accès.
              <div className="mt-10 rounded-2xl border border-line bg-panel/60 p-6">
                <p className="text-sm text-slate-300">
                  Les tarifs sont en cours de fixation. Créez votre espace : vous serez prévenu du
                  tarif de lancement avant tout paiement.
                </p>
                <Link to="/inscription" className="btn btn-primary btn-md mt-4">
                  Créer mon espace
                </Link>
              </div>
            ) : (
              <div className="mt-10 grid gap-5 md:grid-cols-3">
                {tarifs.map((t) => (
                  <article
                    key={t.planKey}
                    className={cn(
                      'relative flex flex-col rounded-2xl border bg-panel p-5 sm:p-6',
                      t.recommande ? 'border-brand-500/60 shadow-glow' : 'border-line',
                    )}
                  >
                    {t.recommande && (
                      <span className="absolute -top-3 left-5 rounded-full bg-brand-500 px-3 py-1 text-2xs font-semibold uppercase tracking-wide"
                        style={{ color: 'var(--vy-accent-ink)' }}>
                        Le plus choisi
                      </span>
                    )}
                    <h3 className="mt-1 text-lg font-semibold text-white">{t.nom}</h3>
                    <div className="mt-3">
                      {t.prixMinor > 0 ? (
                        <>
                          <span className="font-display text-3xl font-semibold text-white">
                            {formaterFcfa(t.prixMinor)}
                          </span>
                          <span className="ml-1 text-sm text-slate-400">/ mois</span>
                        </>
                      ) : (
                        // Prix non défini : on l'écrit, on ne l'invente pas.
                        <span className="inline-flex items-center gap-2 rounded-lg border border-amber-400/25 bg-amber-500/10 px-3 py-1.5 text-sm font-medium text-amber-200">
                          <BadgeCheck size={15} aria-hidden="true" />
                          {t.libellePrix ?? 'Tarif en cours de fixation'}
                        </span>
                      )}
                    </div>
                    <ul className="mt-5 flex-1 space-y-2">
                      {t.points.map((p) => (
                        <li key={p} className="flex items-start gap-2 text-sm text-slate-300">
                          <Check size={15} className="mt-0.5 shrink-0 text-brand-500" aria-hidden="true" />
                          <span className="vy-min0">{p}</span>
                        </li>
                      ))}
                    </ul>
                    <Link
                      to={`/inscription?plan=${t.planKey}`}
                      className={cn('btn btn-md mt-6 w-full', t.recommande ? 'btn-primary' : 'btn-outline')}
                    >
                      Choisir {t.nom}
                    </Link>
                  </article>
                ))}
              </div>
            )}

            <p className="mt-6 flex items-start gap-2 text-xs text-slate-500">
              <ShieldCheck size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span className="vy-min0">{contenu['landing.tarifs.note']}</span>
            </p>
          </div>
        </section>

        {/* -------------------------- Preuve sociale ------------------------- */}
        {/* Rendu uniquement si l'admin a explicitement activé ET rempli des
            témoignages réels. Par défaut : rien. Aucun faux témoignage. */}
        {socialActif && (
          <section className="border-t border-line px-4 py-14 sm:px-6">
            <div className="mx-auto max-w-6xl">
              <h2 className="font-display text-2xl font-semibold text-white">
                {contenu['landing.social.titre']}
              </h2>
            </div>
          </section>
        )}

        {/* ------------------------------- FAQ ------------------------------- */}
        <section id="faq" className="scroll-mt-20 border-t border-line px-4 py-14 sm:px-6 sm:py-20">
          <div className="mx-auto max-w-3xl">
            <h2 className="font-display text-3xl font-semibold tracking-tight text-white sm:text-4xl">
              {contenu['landing.faq.titre']}
            </h2>
            <div className="mt-8 divide-y divide-line">
              {[
                {
                  q: 'Est-ce que ça marche avec Orange Money ?',
                  r: 'Oui. Les paiements passent par Orange Money, Moov Money et Mobi Cash. Vous recevez vos crédits dès la confirmation du paiement.',
                },
                {
                  q: 'Je dois créer un compte pour essayer ?',
                  r: 'Oui, un compte gratuit avec 30 prospects et 60 actions d’assistant. Pas de carte bancaire, pas d’engagement.',
                },
                {
                  q: 'Faut-il connecter WhatsApp ou Facebook ?',
                  r: 'Non. VYORA fonctionne sans aucune connexion à Meta. Les relances sont préparées dans VYORA, puis vous les envoyez par WhatsApp, SMS ou e-mail en un clic — depuis votre propre téléphone.',
                },
                {
                  q: 'Qu’est-ce qui se passe si j’atteins ma limite ?',
                  r: 'Vous voyez exactement où vous en êtes, la date de renouvellement, et l’offre supérieure. Vos données ne sont jamais supprimées : seule la création est suspendue.',
                },
                {
                  q: 'Les vidéos, c’est vraiment utilisable pour vendre ?',
                  r: 'Le studio assemble un script, une voix ou un texte, et une vidéo courte au format vertical. Le coût vous est annoncé avant chaque génération, en crédits.',
                },
              ].map((item) => (
                <details key={item.q} className="group py-4">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-base font-medium text-slate-100">
                    <span className="vy-min0">{item.q}</span>
                    <ChevronDown
                      size={18}
                      className="shrink-0 text-slate-500 transition-transform group-open:rotate-180"
                      aria-hidden="true"
                    />
                  </summary>
                  <p className="mt-2.5 max-w-prose text-sm leading-relaxed text-slate-400">{item.r}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        {/* ----------------------------- CTA final --------------------------- */}
        <section className="border-t border-line px-4 py-16 sm:px-6 sm:py-24">
          <div className="mx-auto max-w-3xl text-center">
            <h2 className="font-display text-3xl font-semibold tracking-tight text-white sm:text-4xl">
              {contenu['landing.cta_final.titre']}
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-base leading-relaxed text-slate-300">
              {contenu['landing.cta_final.texte']}
            </p>
            <Link to="/inscription" className="btn btn-primary btn-lg mt-7 w-full sm:w-auto">
              {contenu['landing.cta_final.bouton']}
              <ArrowRight size={18} aria-hidden="true" />
            </Link>
            <p className="mt-4 text-xs text-slate-500">
              Sans carte bancaire · Prêt en 2 minutes · En français
            </p>
          </div>
        </section>
      </main>

      {/* ------------------------------ Pied de page ------------------------- */}
      <footer className="border-t border-line px-4 py-10 sm:px-6">
        <div className="mx-auto flex max-w-6xl flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="vy-min0">
            <BrandLockup />
            <p className="mt-3 max-w-xs text-xs leading-relaxed text-slate-500">
              VYORA — gérer son business et produire ses contenus, depuis le même compte.
            </p>
          </div>
          <nav className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-slate-400" aria-label="Liens de pied de page">
            <Link to="/conditions" className="hover:text-white">Conditions</Link>
            <Link to="/confidentialite" className="hover:text-white">Confidentialité</Link>
            <Link to="/confidentialite/suivi" className="hover:text-white">Données personnelles</Link>
            <Link to="/connexion" className="hover:text-white">Connexion</Link>
          </nav>
        </div>
        <div className="mx-auto mt-8 max-w-6xl border-t border-line pt-6">
          <p className="text-xs text-slate-600">
            © {new Date().getFullYear()} VYORA. Les prix affichés sont des tarifs de lancement et
            peuvent évoluer ; tout changement est annoncé avant application.
          </p>
        </div>
      </footer>
    </div>
  );
}

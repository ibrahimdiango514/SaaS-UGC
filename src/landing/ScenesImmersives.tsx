/**
 * Scènes du scroll immersif : Studio UGC, puis Grow.
 *
 * ## Règle de contenu
 * Aucun chiffre client, aucun témoignage, aucun résultat inventé. Les nombres
 * affichés décrivent le PRODUIT (nombre d'étapes, de vues, de modèles
 * catalogués), jamais la performance d'un client. Un `data-compteur` doit
 * toujours correspondre à une valeur vraie et vérifiable dans l'application ;
 * sinon le compteur est supprimé, pas approximé.
 *
 * ## Structure d'une scène
 * - `data-scene` : la section épinglée, celle que la caméra traverse ;
 * - `data-camera` : l'objet qui recule puis vient se poser ;
 * - `data-panneau` : les colonnes qui se séparent pendant la transition ;
 * - `data-mot` : les mots révélés par masque ;
 * - `data-compteur` : les nombres animés, déjà écrits en dur dans le HTML.
 */
import { Link } from 'react-router-dom';
import { ArrowRight, BadgeCheck, Brain, Clapperboard, Coins, Layers3, Sparkles } from 'lucide-react';
import { CTA_PRINCIPAL, PALETTE, REASSURANCE } from '../systeme/palette';
import { suivre } from '../systeme/tracking';

/** CTA répété à chaque section : même libellé, même destination, même mesure. */
function CtaSection({ emplacement }: { emplacement: string }) {
  return (
    <div className="mt-7">
      <Link
        to="/inscription"
        onClick={() => suivre('cta_clic', { emplacement })}
        className="btn inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold text-white transition hover:brightness-110"
        style={{ background: `linear-gradient(96deg, ${PALETTE.magenta}, ${PALETTE.rose})` }}
      >
        {CTA_PRINCIPAL} <ArrowRight size={15} />
      </Link>
      <p className="mt-2.5 text-[12px] text-slate-400">{REASSURANCE}</p>
    </div>
  );
}

/** Titre en typographie cinétique : mots répartis, révélés par masque. */
function TitreCinetique({ avant, accent, apres }: { avant: string; accent: string; apres?: string }) {
  const mots = [...avant.split(' '), accent, ...(apres ? apres.split(' ') : [])];
  return (
    <h2 className="font-display text-[1.8rem] font-bold leading-[1.1] tracking-[-0.01em] text-white sm:text-[2.4rem] lg:text-[2.9rem]">
      {mots.map((mot, index) => (
        <span key={`${mot}-${index}`} className="inline-block overflow-hidden align-bottom">
          <span
            data-mot
            className="inline-block"
            style={mot === accent
              ? {
                  backgroundImage: `linear-gradient(92deg, ${PALETTE.magenta}, ${PALETTE.rose})`,
                  WebkitBackgroundClip: 'text',
                  backgroundClip: 'text',
                  color: 'transparent',
                }
              : undefined}
          >
            {mot}
          </span>
          {index < mots.length - 1 ? '\u00A0' : ''}
        </span>
      ))}
    </h2>
  );
}

/** Écran géant traversé par la caméra : des plans vidéo UGC y défilent. */
function EcranGeant() {
  const plans = [
    { titre: 'Unboxing', teinte: PALETTE.magenta },
    { titre: 'Routine 30 s', teinte: PALETTE.rose },
    { titre: 'Avant / après', teinte: PALETTE.violet },
    { titre: 'Mise en situation', teinte: PALETTE.orange },
  ];

  return (
    <div
      className="relative overflow-hidden rounded-3xl border border-white/12 bg-[#0B0512] p-3 shadow-[0_40px_120px_-40px_rgba(240,56,158,0.5)] sm:p-4"
      style={{ transformStyle: 'preserve-3d' }}
    >
      <div className="flex items-center gap-2 border-b border-white/8 pb-2.5">
        <span className="h-2 w-2 rounded-full bg-rose-400/70" />
        <span className="h-2 w-2 rounded-full bg-amber-300/60" />
        <span className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Studio UGC · plans générés</span>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        {plans.map((plan, index) => (
          <figure key={plan.titre} className="relative overflow-hidden rounded-xl border border-white/10 bg-black/40">
            <div className="aspect-[9/16]" style={{ background: `linear-gradient(160deg, ${plan.teinte}33, #0B0512 72%)` }}>
              <div className="flex h-full flex-col justify-between p-2.5">
                <span className="text-[9px] font-semibold uppercase tracking-[0.14em] text-white/45">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <span className="text-[10px] font-semibold leading-tight text-white/85">{plan.titre}</span>
              </div>
            </div>
          </figure>
        ))}
      </div>
    </div>
  );
}

/** Tableau de bord stylisé : graphique qui monte, sans données inventées. */
function TableauDeBord() {
  return (
    <div className="overflow-hidden rounded-3xl border border-white/12 bg-[#0B0512] p-4 shadow-[0_40px_120px_-40px_rgba(124,58,237,0.5)]">
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Grow · vue générale</span>
        <span className="rounded-full border border-white/10 px-2 py-0.5 text-[9px] text-slate-400">Démo</span>
      </div>
      {/* Graphique en barres : une progression de démonstration, annoncée comme telle. */}
      <div className="mt-4 flex h-28 items-end gap-1.5">
        {[18, 26, 24, 34, 40, 38, 52, 58, 66, 74, 82, 92].map((hauteur, index) => (
          <span
            key={index}
            className="flex-1 rounded-t-sm"
            style={{
              height: `${hauteur}%`,
              background: index > 8
                ? `linear-gradient(180deg, ${PALETTE.rose}, ${PALETTE.magenta})`
                : 'rgba(255,255,255,0.12)',
            }}
          />
        ))}
      </div>
      <div className="mt-4 space-y-2">
        {[
          { texte: 'Pipeline saisi', icone: Layers3 },
          { texte: 'Relance programmée', icone: BadgeCheck },
          { texte: 'Trésorerie suivie', icone: Coins },
        ].map(({ texte, icone: Icone }) => (
          <div key={texte} className="flex items-center gap-2 rounded-lg border border-white/8 bg-white/[0.03] px-2.5 py-1.5">
            <Icone size={12} style={{ color: PALETTE.rose }} />
            <span className="text-[11px] text-slate-300">{texte}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function SceneStudio() {
  return (
    <section
      id="immersion"
      data-scene
      aria-labelledby="scene-studio-titre"
      className="relative scroll-mt-20 overflow-hidden border-t border-white/[0.06] py-16 sm:py-24"
    >
      <div aria-hidden="true" className="absolute inset-0 -z-10 bg-[#07030D]" />
      <div className="mx-auto grid max-w-7xl items-center gap-10 px-4 sm:px-6 lg:grid-cols-2 lg:gap-14">
        <div data-panneau className="relative z-10">
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em]" style={{ color: PALETTE.magenta }}>
            <Clapperboard size={12} className="mr-1.5 inline" /> 01 · Studio UGC
          </p>
          <div id="scene-studio-titre" className="mt-4">
            <TitreCinetique avant="Du brief à la vidéo," accent="sans changer d’outil." />
          </div>
          <p className="mt-5 max-w-lg text-[15px] leading-7 text-slate-300">
            Un brief, un script structuré, un storyboard, un modèle choisi dans le catalogue réel —
            puis une génération suivie jusqu’au fichier final. Le devis est vérifié côté serveur
            avant chaque lancement.
          </p>
          <ul className="mt-6 space-y-2.5 text-[13px] text-slate-300">
            {[
              'Scripts UGC : accroche, scènes, sous-titres, appel à l’action',
              'Catalogue de modèles issu du fournisseur, sans option inventée',
              'Devis affiché avant chaque génération',
            ].map((point) => (
              <li key={point} className="flex items-start gap-2">
                <BadgeCheck size={14} className="mt-0.5 shrink-0" style={{ color: PALETTE.magenta }} />
                {point}
              </li>
            ))}
          </ul>
          <CtaSection emplacement="scene_studio" />
        </div>

        <div data-camera className="relative z-0">
          <EcranGeant />
        </div>
      </div>
    </section>
  );
}

export function SceneGrow() {
  return (
    <section data-scene aria-labelledby="scene-grow-titre" className="relative overflow-hidden border-t border-white/[0.06] py-16 sm:py-24">
      <div aria-hidden="true" className="absolute inset-0 -z-10 bg-[#06030B]" />
      <div
        aria-hidden="true"
        className="absolute inset-0 -z-10 opacity-60"
        style={{ background: `radial-gradient(ellipse 50% 40% at 78% 20%, rgba(124,58,237,0.20), transparent 62%)` }}
      />
      <div className="mx-auto grid max-w-7xl items-center gap-10 px-4 sm:px-6 lg:grid-cols-2 lg:gap-14">
        <div data-camera className="relative order-2 lg:order-1">
          <TableauDeBord />
        </div>

        <div data-panneau className="relative z-10 order-1 lg:order-2">
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em]" style={{ color: PALETTE.violet }}>
            <Brain size={12} className="mr-1.5 inline" /> 02 · SORAHNEX Grow
          </p>
          <div id="scene-grow-titre" className="mt-4">
            <TitreCinetique avant="Votre activité," accent="pilotée" apres="au même endroit." />
          </div>
          <p className="mt-5 max-w-lg text-[15px] leading-7 text-slate-300">
            CRM, pipeline, ventes et facturation, relances, trésorerie, litiges, rentabilité,
            prospects et briefing quotidien. Une seule mémoire par entreprise, et des priorités
            qui en découlent.
          </p>
          <ul className="mt-6 space-y-2.5 text-[13px] text-slate-300">
            {['Une mémoire par entreprise', 'Relances et encaissements suivis', 'Briefing quotidien priorisé'].map(
              (point) => (
                <li key={point} className="flex items-start gap-2">
                  <BadgeCheck size={14} className="mt-0.5 shrink-0" style={{ color: PALETTE.violet }} />
                  {point}
                </li>
              ),
            )}
          </ul>
          <CtaSection emplacement="scene_grow" />
        </div>
      </div>

      {/* Bandeau « Bientôt » : rien n'est présenté comme déjà branché. */}
      <div className="mx-auto mt-12 max-w-7xl px-4 sm:px-6">
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-white/10 bg-white/[0.02] px-3.5 py-3">
          <Sparkles size={13} style={{ color: PALETTE.orange }} />
          <span className="text-[11px] font-semibold text-white">Bientôt :</span>
          {['Meta (Facebook, Instagram)', 'WhatsApp Business', 'Google Ads'].map((nom) => (
            <span key={nom} className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] text-slate-400">
              {nom}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

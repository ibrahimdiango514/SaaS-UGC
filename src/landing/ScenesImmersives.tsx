/**
 * Les quatre scènes du défilement immersif.
 *
 * Chacune obéit au même contrat : un paysage DOM réel, une caméra qui bouge
 * pendant l'épinglage, des états qui se succèdent, et un repli figé qui montre
 * la scène COMPLÈTE — pas un résumé, pas une autre page.
 *
 * ## Règle de contenu, non négociable
 * Aucun chiffre client, aucun témoignage, aucun résultat inventé. Les nombres
 * décrivent le produit (nombre d'étapes, de plans, de cartes), jamais la
 * performance d'un client. Ce qui n'est pas branché est écrit « Bientôt ».
 */
import { BadgeCheck, Bot, Clapperboard, GitBranch, Layers3, TrendingUp, Workflow, Zap } from 'lucide-react';
import { CTA_PRINCIPAL, PALETTE, REASSURANCE } from '../systeme/palette';
import { suivre } from '../systeme/tracking';
import { EcranProduit, Perspective, Scene, useProgresScene } from './SceneMoteur';

/* ------------------------------------------------------------------ */
/* Texte cinétique : un mot par ligne, révélé par masque                */
/* ------------------------------------------------------------------ */

/**
 * Chaque mot vit dans son propre masque `overflow: hidden` et arrive par le
 * bas. C'est la typographie cinétique demandée : la phrase se construit sous
 * les yeux au lieu d'apparaître d'un bloc.
 */
function MotsCinematiques({ mots }: { mots: Array<{ texte: string; accent?: boolean }> }) {
  return (
    <span className="mt-4 block">
      {mots.map((mot, index) => (
        <span key={mot.texte} className="block overflow-hidden">
          <span
            data-mot
            className="block will-change-transform"
            style={
              mot.accent
                ? {
                    backgroundImage: `linear-gradient(94deg, ${PALETTE.magenta}, ${PALETTE.rose} 58%, ${PALETTE.orange})`,
                    WebkitBackgroundClip: 'text',
                    backgroundClip: 'text',
                    color: 'transparent',
                  }
                : undefined
            }
          >
            {mot.texte}
            {index < mots.length - 1 ? '\u00A0' : ''}
          </span>
        </span>
      ))}
    </span>
  );
}

function Cta({ emplacement }: { emplacement: string }) {
  return (
    <div className="mt-6">
      <a
        href="/inscription"
        data-cta="principal"
        onClick={() => suivre('cta_clic', { emplacement })}
        className="btn inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold text-white transition hover:brightness-110"
        style={{ background: `linear-gradient(96deg, ${PALETTE.magenta}, ${PALETTE.rose})` }}
      >
        {CTA_PRINCIPAL}
      </a>
      <p className="mt-2 text-[11px] text-slate-400">{REASSURANCE}</p>
    </div>
  );
}

function Arguments({ points, teinte }: { points: string[]; teinte: string }) {
  return (
    <ul className="mt-5 space-y-2 text-[12px] text-slate-300">
      {points.map((point) => (
        <li key={point} className="flex items-start gap-2">
          <BadgeCheck size={13} className="mt-0.5 shrink-0" style={{ color: teinte }} />
          {point}
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------------ */
/* SCÈNE 1 — Studio UGC : l'écran se remplit de plans                   */
/* ------------------------------------------------------------------ */

const PLANS = [
  { titre: 'Unboxing', teinte: PALETTE.magenta },
  { titre: 'Routine 30 s', teinte: PALETTE.rose },
  { titre: 'Avant / après', teinte: PALETTE.rose },
  { titre: 'Mise en situation', teinte: PALETTE.orange },
];

export function SceneStudio() {
  const { progres, niveau } = useProgresScene();
  const anime = niveau === 'complet';

  return (
    <Scene
      id="immersion"
      numero="01"
      etiquette="Studio UGC"
      teinte={PALETTE.magenta}
      titre={<MotsCinematiques mots={[{ texte: 'Du brief' }, { texte: 'à la vidéo,' }, { texte: 'sans changer d’outil.', accent: true }]} />}
      decor={
        <Perspective>
          <EcranProduit titreEcran="Studio UGC — plans générés">
            {/* L'écran se remplit : chaque plan entre l'un après l'autre. */}
            <div className="grid grid-cols-2 gap-2 min-[420px]:grid-cols-4">
              {PLANS.map((plan, index) => {
                const debut = 0.08 + index * 0.17;
                const avance = anime ? Math.min(1, Math.max(0, (progres - debut) / 0.2)) : 1;
                return (
                  <figure
                    key={plan.titre}
                    className="relative overflow-hidden rounded-lg border border-white/10"
                    style={{
                      opacity: 0.25 + 0.75 * avance,
                      transform: `translate3d(0, ${(1 - avance) * 26}px, ${(1 - avance) * -60}px) scale(${0.92 + 0.08 * avance})`,
                      background: `linear-gradient(160deg, ${plan.teinte}3D, #0B0512 76%)`,
                    }}
                  >
                    <div className="aspect-[9/16]" />
                    <figcaption className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-1.5 text-[9px] font-semibold text-white/90">
                      {plan.titre}
                    </figcaption>
                  </figure>
                );
              })}
            </div>

            {/* Le script se remplit aussi : preuve que l'écran change d'état. */}
            <div className="mt-2.5 space-y-1">
              {['Accroche', 'Démonstration', 'Appel à l’action'].map((ligne, index) => {
                const debut = 0.55 + index * 0.12;
                const avance = anime ? Math.min(1, Math.max(0, (progres - debut) / 0.15)) : 1;
                return (
                  <div key={ligne} className="flex items-center gap-2">
                    <span className="text-[9px] uppercase tracking-[0.14em] text-slate-500">{ligne}</span>
                    <span className="h-px flex-1 overflow-hidden bg-white/10">
                      <span className="block h-px transition-none" style={{ width: `${avance * 100}%`, background: PALETTE.magenta }} />
                    </span>
                  </div>
                );
              })}
            </div>
          </EcranProduit>
        </Perspective>
      }
    >
      <p className="mt-4 max-w-md text-[13px] leading-6 text-slate-300">
        Un brief, un script structuré, un storyboard, un modèle choisi dans le catalogue réel — puis
        une génération suivie jusqu’au fichier final.
      </p>
      <Arguments
        teinte={PALETTE.magenta}
        points={[
          'Scripts UGC : accroche, scènes, sous-titres, appel à l’action',
          'Catalogue de modèles issu du fournisseur, sans option inventée',
          'Devis affiché avant chaque génération',
        ]}
      />
      <Cta emplacement="scene_studio" />
    </Scene>
  );
}

/* ------------------------------------------------------------------ */
/* SCÈNE 2 — Grow : tableau de bord, courbe qui se construit            */
/* ------------------------------------------------------------------ */

const VALEURS_COURBE = [22, 30, 27, 38, 46, 43, 58, 66, 78, 88, 94];

export function SceneGrow() {
  const { progres, niveau } = useProgresScene();
  const anime = niveau === 'complet';

  return (
    <Scene
      id="grow"
      numero="02"
      etiquette="SORAHNEX Grow"
      teinte={PALETTE.rose}
      duree={3.2}
      titre={<MotsCinematiques mots={[{ texte: 'Votre activité,' }, { texte: 'pilotée', accent: true }, { texte: 'au même endroit.' }]} />}
      decor={
        <Perspective intensite={1.1}>
          <EcranProduit titreEcran="Grow — vue générale">
            <div className="flex items-center justify-between">
              <span className="text-[9px] uppercase tracking-[0.16em] text-slate-500">Démo</span>
              <span className="flex items-center gap-1 text-[9px] font-semibold" style={{ color: PALETTE.rose }}>
                <TrendingUp size={11} /> progression
              </span>
            </div>

            {/* Courbe construite par le défilement : le tracé se dessine. */}
            <Courbe progres={anime ? progres : 0.85} anime={anime} />

            {/* Bulles de conversation qui apparaissent en cascade. */}
            <div className="mt-3 space-y-1.5">
              {[
                { de: 'vous', texte: 'Où en est le devis du client Renard ?' },
                { de: 'ia', texte: 'Envoyé hier, relance prévue vendredi. Je la prépare ?' },
                { de: 'vous', texte: 'Oui, et prépare le briefing de lundi.' },
              ].map((bulle, index) => {
                const debut = 0.3 + index * 0.16;
                const avance = anime ? Math.min(1, Math.max(0, (progres - debut) / 0.14)) : 1;
                const ia = bulle.de === 'ia';
                return (
                  <div
                    key={bulle.texte}
                    className={`max-w-[78%] rounded-xl px-2.5 py-1.5 text-[10px] leading-4 ${ia ? 'ml-auto' : ''}`}
                    style={{
                      opacity: avance,
                      transform: `translate3d(${(1 - avance) * (ia ? 22 : -22)}px, 0, 0)`,
                      background: ia ? `${PALETTE.violet}26` : 'rgba(255,255,255,0.05)',
                      border: `1px solid ${ia ? `${PALETTE.violet}44` : 'rgba(255,255,255,0.08)'}`,
                      color: ia ? '#E9D5FF' : '#CBD5E1',
                    }}
                  >
                    {bulle.texte}
                  </div>
                );
              })}
            </div>

            {/* Cartes de suivi. */}
            <div className="mt-2.5 grid grid-cols-3 gap-1.5">
              {['Pipeline', 'Relances', 'Trésorerie'].map((nom) => (
                <div key={nom} className="rounded-lg border border-white/8 bg-white/[0.03] px-2 py-1.5 text-center">
                  <span className="text-[9px] text-slate-400">{nom}</span>
                </div>
              ))}
            </div>
          </EcranProduit>
        </Perspective>
      }
    >
      <p className="mt-4 max-w-md text-[13px] leading-6 text-slate-300">
        CRM, pipeline, ventes, relances, trésorerie, rentabilité et briefing quotidien. Une seule
        mémoire par entreprise, et des priorités qui en découlent.
      </p>
      <Arguments teinte={PALETTE.rose} points={['Une mémoire par entreprise', 'Relances et encaissements suivis', 'Briefing quotidien priorisé']} />
      <Cta emplacement="scene_grow" />
    </Scene>
  );
}

/** Courbe en SVG : le tracé se dessine, les points arrivent après. */
function Courbe({ progres, anime }: { progres: number; anime: boolean }) {
  const largeur = 300;
  const hauteur = 86;
  const max = Math.max(...VALEURS_COURBE);
  const points = VALEURS_COURBE.map((valeur, index) => {
    const x = (index / (VALEURS_COURBE.length - 1)) * largeur;
    const y = hauteur - (valeur / max) * (hauteur - 8);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const chemin = `M${points.join(' L')}`;
  const avance = anime ? Math.min(1, progres / 0.6) : 1;

  return (
    <div className="relative mt-2">
      <svg viewBox={`0 0 ${largeur} ${hauteur}`} className="w-full" role="img" aria-label="Courbe de progression de démonstration">
        <defs>
          <linearGradient id="courbe-grow" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor={PALETTE.violet} />
            <stop offset="0.6" stopColor={PALETTE.rose} />
            <stop offset="1" stopColor={PALETTE.orange} />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1="0" y1={hauteur * f} x2={largeur} y2={hauteur * f} stroke="rgba(255,255,255,0.06)" strokeWidth="1" />
        ))}
        <path d={`${chemin} L${largeur},${hauteur} L0,${hauteur} Z`} fill={`${PALETTE.rose}14`} style={{ opacity: avance }} />
        <path
          d={chemin}
          fill="none"
          stroke="url(#courbe-grow)"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{
            strokeDasharray: 600,
            strokeDashoffset: 600 * (1 - avance),
          }}
        />
      </svg>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* SCÈNE 3 — Agent IA : cartes Valider / Refuser                        */
/* ------------------------------------------------------------------ */

export function SceneAgent() {
  const { progres, niveau } = useProgresScene();
  const anime = niveau === 'complet';

  return (
    <Scene
      id="agent"
      numero="03"
      etiquette="Agent IA"
      teinte={PALETTE.orange}
      duree={3.2}
      titre={<MotsCinematiques mots={[{ texte: 'Une IA qui' }, { texte: 'connaît', accent: true }, { texte: 'votre entreprise.' }]} />}
      decor={
        <Perspective intensite={1.05}>
          <div className="relative">
            {/* Le contexte que l'agent lit : c'est le produit, pas une promesse. */}
            <EcranProduit titreEcran="Agent — contexte de l’entreprise">
              <div className="space-y-1.5">
                {['Offre : abonnement mensuel', 'Marché : France et Afrique de l’Ouest', 'Ton : direct, sans jargon'].map((ligne) => (
                  <div key={ligne} className="flex items-center gap-2 rounded-md bg-white/[0.03] px-2 py-1.5">
                    <Layers3 size={11} style={{ color: PALETTE.orange }} />
                    <span className="text-[10px] text-slate-300">{ligne}</span>
                  </div>
                ))}
              </div>
            </EcranProduit>

            {/* Les cartes surgissent, l'une après l'autre, avec leur décision. */}
            <div className="mt-2.5 grid gap-2">
              <CarteDecision
                titre="Relancer le client Renard"
                detail="Devis envoyé il y a 6 jours, aucune réponse."
                avance={anime ? Math.min(1, Math.max(0, (progres - 0.2) / 0.18)) : 1}
                teinte={PALETTE.orange}
              />
              <CarteDecision
                titre="Préparer le briefing de lundi"
                detail="Trois priorités, à partir des données de la semaine."
                avance={anime ? Math.min(1, Math.max(0, (progres - 0.4) / 0.18)) : 1}
                teinte={PALETTE.magenta}
              />
            </div>
          </div>
        </Perspective>
      }
    >
      <p className="mt-4 max-w-md text-[13px] leading-6 text-slate-300">
        L’agent lit votre contexte réel et propose des actions concrètes. Chaque décision passe par
        vous : il ne modifie rien sans validation.
      </p>
      <Arguments teinte={PALETTE.orange} points={['Valider ou refuser chaque action', 'Contexte par entreprise, pas un prompt générique', 'Aucune écriture sans votre accord']} />
      <Cta emplacement="scene_agent" />
    </Scene>
  );
}

function CarteDecision({
  titre,
  detail,
  avance,
  teinte,
}: {
  titre: string;
  detail: string;
  avance: number;
  teinte: string;
}) {
  return (
    <div
      className="rounded-xl border border-white/10 bg-[#0C0713]/95 p-2.5"
      style={{
        opacity: avance,
        transform: `translate3d(0, ${(1 - avance) * 30}px, ${(1 - avance) * -70}px) rotateX(${(1 - avance) * -12}deg)`,
        borderLeft: `2px solid ${teinte}`,
      }}
    >
      <div className="flex items-start gap-2">
        <Bot size={13} className="mt-0.5 shrink-0" style={{ color: teinte }} />
        <div>
          <p className="text-[11px] font-semibold text-white">{titre}</p>
          <p className="text-[10px] leading-4 text-slate-400">{detail}</p>
        </div>
      </div>
      <div className="mt-2 flex gap-1.5">
        <span className="rounded-md px-2 py-1 text-[9px] font-semibold text-white" style={{ background: `${PALETTE.rose}33`, border: `1px solid ${PALETTE.rose}66` }}>
          Valider
        </span>
        <span className="rounded-md border border-white/12 px-2 py-1 text-[9px] font-semibold text-slate-300">Refuser</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* SCÈNE 4 — Automatisation : lignes d'énergie                          */
/* ------------------------------------------------------------------ */

export function SceneAutomatisation() {
  const { progres, niveau } = useProgresScene();
  const anime = niveau === 'complet';
  const avance = anime ? Math.min(1, progres / 0.7) : 1;

  return (
    <Scene
      id="automatisation"
      numero="04"
      etiquette="Automatisation"
      teinte={PALETTE.magenta}
      duree={3}
      titre={<MotsCinematiques mots={[{ texte: 'Ce qui se répète' }, { texte: 'se règle', accent: true }, { texte: 'tout seul.' }]} />}
      decor={
        <Perspective>
          <EcranProduit titreEcran="Automatisation — chaîne de tâches">
            <div className="relative">
              {/* Les lignes d'énergie relient les étapes : elles se remplissent. */}
              <FilEnergie avance={avance} />
              <div className="relative grid grid-cols-2 gap-3 min-[420px]:grid-cols-4 min-[420px]:gap-2">
                {[
                  { icone: Clapperboard, nom: 'Nouveau brief' },
                  { icone: Workflow, nom: 'Script' },
                  { icone: GitBranch, nom: 'Validation' },
                  { icone: Zap, nom: 'Publication' },
                ].map(({ icone: Icone, nom }, index) => {
                  const debut = index * 0.2;
                  const etat = anime ? Math.min(1, Math.max(0, (progres - debut) / 0.2)) : 1;
                  return (
                    <div key={nom} className="flex flex-col items-center gap-1.5 text-center">
                      <span
                        className="grid h-8 w-8 place-items-center rounded-full"
                        style={{
                          background: `${PALETTE.magenta}${etat > 0.5 ? '30' : '12'}`,
                          border: `1px solid ${PALETTE.magenta}${etat > 0.5 ? '77' : '33'}`,
                          boxShadow: etat > 0.5 ? `0 0 18px ${PALETTE.magenta}55` : 'none',
                        }}
                      >
                        <Icone size={13} style={{ color: etat > 0.5 ? PALETTE.rose : '#64748b' }} />
                      </span>
                      <span className="text-[9px] leading-tight text-slate-400">{nom}</span>
                    </div>
                  );
                })}
              </div>
            </div>
            <p className="mt-3 rounded-md border border-white/8 bg-white/[0.02] px-2 py-1.5 text-[10px] text-slate-400">
              Chaque étape reste visible et interruptible. Aucun envoi sans validation.
            </p>
          </EcranProduit>
        </Perspective>
      }
    >
      <p className="mt-4 max-w-md text-[13px] leading-6 text-slate-300">
        Les tâches répétitives s’enchaînent, avec un point de contrôle à chaque étape. Vous voyez ce
        qui se prépare, et vous pouvez arrêter.
      </p>
      <Arguments teinte={PALETTE.magenta} points={['Chaînes lisibles, étape par étape', 'Contrôle avant chaque envoi', 'Journal des exécutions']} />
      <Cta emplacement="scene_automatisation" />
    </Scene>
  );
}

/** Ligne d'énergie derrière les icônes : elle se remplit avec le défilement. */
function FilEnergie({ avance }: { avance: number }) {
  return (
    <div aria-hidden="true" className="absolute left-[12%] right-[12%] top-4 -z-10 h-[1.5px] overflow-hidden">
      <span
        className="block h-full"
        style={{
          width: `${avance * 100}%`,
          background: `linear-gradient(90deg, ${PALETTE.magenta}, ${PALETTE.rose} 55%, ${PALETTE.orange})`,
          boxShadow: `0 0 12px ${PALETTE.magenta}`,
          transition: 'width 60ms linear',
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Transition entre le récit et les blocs classiques                    */
/* ------------------------------------------------------------------ */

export function SceneVerdict() {
  return (
    <section className="relative overflow-hidden border-y border-white/[0.06] py-16 sm:py-24">
      <div aria-hidden="true" className="absolute inset-0 -z-10" style={{ background: 'linear-gradient(180deg, #07030D, #0B0512)' }} />
      <div className="mx-auto max-w-3xl px-4 text-center sm:px-6">
        <p className="text-[10px] font-semibold uppercase tracking-[0.24em]" style={{ color: PALETTE.rose }}>
          Après le récit
        </p>
        <h2 className="mt-3 font-display text-[1.8rem] font-bold leading-[1.12] text-white sm:text-[2.4rem]">
          Tout ce que vous venez de voir, dans un seul abonnement
        </h2>
        <p className="mt-3 text-sm leading-7 text-slate-400">
          Studio UGC pour produire, SORAHNEX Grow pour piloter, l’Agent IA pour décider. Le détail
          des espaces est juste en dessous.
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          {[
            { nom: 'Studio UGC', icone: Clapperboard },
            { nom: 'SORAHNEX Grow', icone: TrendingUp },
            { nom: 'Agent IA', icone: Bot },
          ].map(({ nom, icone: Icone }) => (
            <span key={nom} className="inline-flex items-center gap-1.5 rounded-full border border-white/12 bg-white/[0.04] px-3 py-1.5 text-[11px] font-semibold text-slate-200">
              <Icone size={12} style={{ color: PALETTE.rose }} /> {nom}
            </span>
          ))}
        </div>
        <div className="mt-6 flex justify-center">
          <Cta emplacement="scene_verdict" />
        </div>
      </div>
    </section>
  );
}

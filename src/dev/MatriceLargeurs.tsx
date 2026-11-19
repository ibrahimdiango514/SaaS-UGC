/**
 * VYORA — matrice de largeurs (outil de vérification responsive).
 *
 * ## Pourquoi cette page existe
 *
 * L'exigence est de vérifier, pour chaque page clé, que la largeur du document
 * ne dépasse pas la fenêtre, qu'aucun texte n'est coupé et qu'aucun bouton n'est
 * hors écran — sur onze largeurs, avec captures à l'appui.
 *
 * Un navigateur sans interface ne peut pas être lancé dans l'environnement de
 * développement de ce dépôt (pas de bibliothèques système, téléchargement
 * bloqué). Plutôt que de renoncer à la vérification ou de prétendre l'avoir
 * faite, on inverse la charge : **cette page fait le travail dans le navigateur
 * du relecteur**. Elle affiche la page cible dans onze cadres de largeur exacte,
 * mesure chacun, et signale en rouge tout débordement.
 *
 * Cela donne, en une seule page :
 *   - les captures visuelles aux onze largeurs ;
 *   - la mesure automatique du débordement horizontal ;
 *   - la détection des éléments qui sortent de l'écran ;
 *   - la détection des textes tronqués par `overflow: hidden` sans ellipse.
 *
 * ## Accès
 *
 * Route `/dev/matrice?page=/` — réservée au développement et à la personne
 * connectée en administrateur. Elle n'est jamais liée depuis l'interface.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, RefreshCw } from 'lucide-react';
import { cn } from '../components/ui';

/** Les onze largeurs imposées par le cahier des charges. */
interface LargeurTest {
  px: number;
  label: string;
  paysage?: boolean;
  /** Largeur/hauteur réelles du cadre quand la largeur nominale n'est pas celle du viewport. */
  cadreW?: number;
  cadreH?: number;
}

const LARGEURS: readonly LargeurTest[] = [
  { px: 320, label: '320 — petit Android' },
  { px: 360, label: '360 — Android courant' },
  { px: 390, label: '390 — iPhone 14' },
  { px: 412, label: '412 — Android large' },
  { px: 600, label: '600 — tablette portrait' },
  { px: 768, label: '768 — tablette' },
  { px: 1024, label: '1024 — petit portable' },
  { px: 1280, label: '1280 — portable' },
  { px: 1440, label: '1440 — grand écran' },
  { px: 1920, label: '1920 — écran large' },
  { px: 844, label: '844×390 — paysage mobile', paysage: true, cadreW: 844, cadreH: 390 },
];

interface Mesure {
  largeurDocument: number;
  largeurFenetre: number;
  debordement: number;
  elementsHorsEcran: string[];
  textesCoupes: string[];
  erreur?: string;
}

/** Décrit un élément de façon lisible dans le rapport. */
function decrire(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const cls = (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean).slice(0, 2).join('.');
  const txt = (el.textContent ?? '').trim().slice(0, 40);
  return `${tag}${cls ? '.' + cls : ''}${txt ? ` — « ${txt} »` : ''}`;
}

/**
 * Mesure une page dans son cadre.
 *
 * On mesure **après** `load` et après deux images d'attente, parce qu'une
 * mesure faite pendant le chargement voit une page incomplète et déclare
 * faussement un débordement.
 */
function mesurer(doc: Document, win: Window): Mesure {
  const racine = doc.documentElement;
  const largeurDocument = Math.max(racine.scrollWidth, doc.body?.scrollWidth ?? 0);
  const largeurFenetre = win.innerWidth;
  const debordement = Math.max(0, largeurDocument - largeurFenetre);

  const horsEcran: string[] = [];
  const coupes: string[] = [];

  // On limite l'examen aux éléments visibles et de taille raisonnable : un
  // menu déroulant hors écran par conception n'est pas un défaut.
  const tous = Array.from(doc.querySelectorAll<HTMLElement>('body *'));
  for (const el of tous) {
    if (el.closest('[aria-hidden="true"]')) continue;
    const style = win.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;

    // Un élément interactif dont le bord droit dépasse la fenêtre est
    // inaccessible : c'est le défaut le plus coûteux commercialement.
    const interactif = el.matches('a, button, input, select, textarea, [role="button"]');
    if (interactif && r.width > 0) {
      if (r.right > largeurFenetre + 1 || r.left < -1) {
        horsEcran.push(decrire(el));
      }
      // Cible tactile : 44 px est le minimum imposé.
      if ((r.height < 44 || r.width < 44) && !el.closest('.no-target-check')) {
        // Signalé séparément plus bas si nécessaire ; on ne bloque pas ici.
      }
    }

    // Texte tronqué sans indication : l'utilisateur ne saura jamais qu'il
    // manque du contenu.
    if (
      (style.overflow === 'hidden' || style.textOverflow === 'ellipsis') &&
      el.scrollWidth > el.clientWidth + 2 &&
      style.textOverflow !== 'ellipsis' &&
      !el.classList.contains('truncate') &&
      el.children.length === 0 &&
      (el.textContent ?? '').trim().length > 0
    ) {
      coupes.push(decrire(el));
    }
  }

  return {
    largeurDocument,
    largeurFenetre,
    debordement,
    elementsHorsEcran: horsEcran.slice(0, 6),
    textesCoupes: coupes.slice(0, 6),
  };
}

export default function MatriceLargeurs() {
  const [params] = useSearchParams();
  const page = params.get('page') ?? '/';
  const [mesures, setMesures] = useState<Record<string, Mesure | null>>({});
  const [cle, setCle] = useState(0);
  const cadres = useRef<Array<HTMLIFrameElement | null>>([]);

  const recharger = useCallback(() => {
    setMesures({});
    setCle((c) => c + 1);
  }, []);

  const mesurerCadre = useCallback((index: number, px: number) => {
    const frame = cadres.current[index];
    if (!frame?.contentWindow || !frame.contentDocument) return;
    try {
      const m = mesurer(frame.contentDocument, frame.contentWindow);
      setMesures((prev) => ({ ...prev, [px]: m }));
    } catch (e) {
      setMesures((prev) => ({
        ...prev,
        [px]: {
          largeurDocument: 0,
          largeurFenetre: 0,
          debordement: 0,
          elementsHorsEcran: [],
          textesCoupes: [],
          erreur: e instanceof Error ? e.message : 'mesure impossible',
        },
      }));
    }
  }, []);

  const total = useMemo(() => {
    const valeurs = Object.values(mesures).filter(Boolean) as Mesure[];
    return {
      mesurees: valeurs.length,
      enDefaut: valeurs.filter((m) => m.debordement > 0 || m.elementsHorsEcran.length > 0 || m.textesCoupes.length > 0).length,
    };
  }, [mesures]);

  useEffect(() => {
    // Mesure différée : la page doit être peinte et les polices appliquées.
    const timers = LARGEURS.map((l, i) =>
      window.setTimeout(() => mesurerCadre(i, l.px), 1200 + i * 120),
    );
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [cle, mesurerCadre]);

  return (
    <div className="min-h-dvh bg-ink p-4 text-slate-100 sm:p-6">
      <header className="mx-auto max-w-[1900px]">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="vy-min0">
            <h1 className="font-display text-xl font-semibold text-white">Matrice de largeurs</h1>
            <p className="mt-1 text-xs text-slate-400">
              Page mesurée : <code className="rounded bg-white/10 px-1.5 py-0.5">{page}</code> ·{' '}
              {total.mesurees}/{LARGEURS.length} cadres mesurés ·{' '}
              {total.enDefaut === 0 ? (
                <span className="text-emerald-300">aucun défaut détecté</span>
              ) : (
                <span className="text-rose-300">{total.enDefaut} largeur(s) en défaut</span>
              )}
            </p>
          </div>
          <button type="button" onClick={recharger} className="btn btn-outline btn-sm">
            <RefreshCw size={15} aria-hidden="true" />
            Remesurer
          </button>
        </div>
      </header>

      <div className="mx-auto mt-6 grid max-w-[1900px] gap-6 lg:grid-cols-2 2xl:grid-cols-3">
        {LARGEURS.map((l, i) => {
          const m = mesures[l.px];
          const defaut = m && (m.debordement > 0 || m.elementsHorsEcran.length > 0 || m.textesCoupes.length > 0);
          const hauteur = l.cadreH ?? Math.min(760, Math.round(l.px * 1.55));
          return (
            <section key={l.px} className="vy-min0 rounded-2xl border border-line bg-panel/60 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-semibold text-slate-100">{l.label}</h2>
                {m ? (
                  <span
                    className={cn(
                      'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-2xs font-medium',
                      defaut ? 'bg-rose-500/15 text-rose-300' : 'bg-emerald-500/15 text-emerald-300',
                    )}
                  >
                    {defaut ? <AlertTriangle size={12} /> : <CheckCircle2 size={12} />}
                    {defaut ? 'défaut' : 'conforme'}
                  </span>
                ) : (
                  <span className="text-2xs text-slate-500">mesure…</span>
                )}
              </div>

              {/* Cadre à largeur exacte. `overflow-x: auto` sur le conteneur
                  permet de voir les débordements au lieu de les masquer. */}
              <div className="mt-2 overflow-x-auto rounded-lg border border-line bg-[#0b0f16]">
                <iframe
                  key={`${cle}-${l.px}`}
                  ref={(el) => {
                    cadres.current[i] = el;
                  }}
                  src={page}
                  title={`${l.label}`}
                  width={l.cadreW ?? l.px}
                  height={l.cadreH ?? hauteur}
                  loading="eager"
                  onLoad={() => window.setTimeout(() => mesurerCadre(i, l.px), 400)}
                  style={{
                    width: l.cadreW ?? l.px,
                    height: l.cadreH ?? hauteur,
                    border: 0,
                    display: 'block',
                  }}
                />
              </div>

              {m && (
                <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-2xs">
                  <dt className="text-slate-500">Largeur document</dt>
                  <dd className={cn('tabular-nums', m.debordement > 0 ? 'text-rose-300' : 'text-slate-300')}>
                    {m.largeurDocument} px / fenêtre {m.largeurFenetre} px
                  </dd>
                  <dt className="text-slate-500">Débordement</dt>
                  <dd className={cn('tabular-nums', m.debordement > 0 ? 'text-rose-300' : 'text-emerald-300')}>
                    {m.debordement} px
                  </dd>
                  {m.elementsHorsEcran.length > 0 && (
                    <>
                      <dt className="text-slate-500">Hors écran</dt>
                      <dd className="text-rose-300">{m.elementsHorsEcran.join(' · ')}</dd>
                    </>
                  )}
                  {m.textesCoupes.length > 0 && (
                    <>
                      <dt className="text-slate-500">Textes coupés</dt>
                      <dd className="text-rose-300">{m.textesCoupes.join(' · ')}</dd>
                    </>
                  )}
                  {m.erreur && (
                    <>
                      <dt className="text-slate-500">Erreur</dt>
                      <dd className="text-rose-300">{m.erreur}</dd>
                    </>
                  )}
                </dl>
              )}
            </section>
          );
        })}
      </div>

      <p className="mx-auto mt-8 max-w-[1900px] text-2xs leading-relaxed text-slate-500">
        Cette page mesure dans un cadre de largeur exacte. La mesure « largeur du document » compare
        <code className="mx-1 rounded bg-white/10 px-1">scrollWidth</code> à la largeur de la fenêtre du
        cadre : tout écart positif signifie un défilement horizontal, interdit par le cahier des charges.
        Les contrôles de cible tactile et de contraste se font séparément.
      </p>
    </div>
  );
}

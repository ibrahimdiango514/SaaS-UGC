import { useId } from 'react';
import { DEGRADE_MARQUE, PALETTE, SLOGAN } from '../systeme/palette';

/**
 * Logo SORAHNEX — icône seule.
 *
 * Le tracé est celui du logo d'origine, inchangé : un « S » d'un seul geste,
 * surmonté d'un point lumineux. Seuls les arrêts du dégradé et la couleur du
 * point changent (magenta → rose → orange), conformément à la direction
 * artistique retenue. Rien n'est redessiné : ce serait un autre logo.
 *
 * Le dégradé porte un identifiant unique par instance. Sans cela, plusieurs
 * logos sur la même page partagent le même `id` et le navigateur ne résout que
 * le premier : les suivants s'affichent vides.
 */
export function LogoIcone({ size = 40, className }: { size?: number; className?: string }) {
  const id = `sorahnex-degrade-${useId().replace(/[:]/g, '')}`;
  const [debut, milieu, fin] = DEGRADE_MARQUE;

  return (
    <svg
      viewBox="0 0 40 40"
      width={size}
      height={size}
      className={className}
      fill="none"
      role="img"
      aria-label="SORAHNEX"
    >
      <defs>
        <linearGradient id={id} x1="8" y1="10" x2="32" y2="30" gradientUnits="userSpaceOnUse">
          <stop stopColor={debut} />
          <stop offset="0.56" stopColor={milieu} />
          <stop offset="1" stopColor={fin} />
        </linearGradient>
      </defs>
      {/* Plaque sombre : le logo reste lisible sur un fond clair ou sur une image. */}
      <rect width="40" height="40" rx="11" fill={PALETTE.inkSoft} />
      <rect x="0.5" y="0.5" width="39" height="39" rx="10.5" stroke="#FFFFFF" strokeOpacity="0.14" />
      {/* Le « S » : tracé d'origine, dégradé de marque. */}
      <path
        d="M26.5 14.2c-1.4-1.4-3.7-2.2-6.1-2.2-3.9 0-6.4 2-6.4 5 0 3 2.2 4.2 6.2 5 3.3.7 4.6 1.3 4.6 2.8 0 1.6-1.7 2.6-4.3 2.6-2.6 0-4.9-.9-6.5-2.5"
        stroke={`url(#${id})`}
        strokeWidth="3.2"
        strokeLinecap="round"
      />
      {/* Le point lumineux, désormais orange : l'accent de la charte. */}
      <path d="M30.5 9.5v3.6M28.7 11.3h3.6" stroke={PALETTE.orange} strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Version horizontale : icône + nom + slogan.
 *
 * `compact` masque le slogan (barre de navigation), `taille="grand"` sert le
 * pied de page, qui affiche le logo coupé en bas de l'écran.
 */
export function LogoHorizontal({
  size = 34,
  compact = false,
  className,
}: {
  size?: number;
  compact?: boolean;
  className?: string;
}) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className ?? ''}`}>
      <LogoIcone size={size} />
      <span className="flex flex-col leading-none">
        <span
          className="font-display font-bold tracking-[0.12em] text-white"
          style={{ fontSize: Math.round(size * 0.42) }}
        >
          SORAHNEX
        </span>
        {!compact && (
          <span
            className="mt-1 font-medium tracking-[0.18em] uppercase"
            style={{ fontSize: Math.max(7, Math.round(size * 0.2)), color: PALETTE.texteDoux }}
          >
            {SLOGAN}
          </span>
        )}
      </span>
    </span>
  );
}

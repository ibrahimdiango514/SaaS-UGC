#!/usr/bin/env node
/**
 * Audit des origines autorisées (CORS) — préparation de migration de domaine.
 *
 * Pourquoi
 * -------
 * Les listes d'origines sont dispersées dans le dépôt : listes par défaut des
 * Edge Functions, module partagé du frontend, vérificateur de production. Lors
 * d'un changement de domaine, oublier UNE liste produit un symptôme trompeur :
 * « backend absent ou injoignable » alors que la fonction répond très bien — elle
 * refuse simplement le navigateur.
 *
 * Ce script ne modifie rien. Il lit les listes, les compare entre elles, et
 * signale trois classes de problème :
 *   - ORIGINE MORTE      une origine codée en dur qui ne correspond plus au site servi ;
 *   - PRODUCTION ABSENTE le site réellement en service n'est pas dans les valeurs par défaut ;
 *   - DIVERGENCE         deux listes censées être identiques ne le sont pas.
 *
 * Usage :
 *   node scripts/audit-origins.mjs                     # site servi par défaut
 *   ORIGINE_PRODUCTION=https://mon-site.netlify.app node scripts/audit-origins.mjs
 *   node scripts/audit-origins.mjs --json              # sortie machine
 *
 * Code de sortie : 0 si aucun problème BLOQUANT pour la migration, 1 sinon.
 * « Bloquant » = une liste qui n'accepterait pas la nouvelle origine sans
 * modification du code (cas d'une liste fermée non complétée par un secret).
 */

import { readFileSync } from 'node:fs';

/** Origine du site en service, sauf indication contraire. */
const ORIGINE_PRODUCTION = (process.env.ORIGINE_PRODUCTION || 'https://vyora-saas-ugc.netlify.app').replace(/\/+$/, '');
const SORTIE_JSON = process.argv.includes('--json');

/** Anciennes origines connues : elles ne doivent plus servir de référence. */
const ORIGINES_HISTORIQUES = new Set([
  'https://vyora-ugc.netlify.app',
  'https://reelora.netlify.app',
]);

/**
 * Listes d'origines du dépôt. Chaque entrée documente OÙ la liste est lue et
 * COMMENT elle se complète. `completee_par_secret` est le point décisif : une
 * liste complétée par un secret peut accueillir la nouvelle origine sans
 * modification de code ; une liste fermée, non.
 */
const LISTES = [
  {
    fichier: 'supabase/functions/business-grow/index.ts',
    etiquette: 'business-grow — origines par défaut',
    motif: /const defaultAllowedOrigins = \[([\s\S]*?)\]\.join\(','\)/,
    completee_par_secret: 'BUSINESS_GROW_ALLOWED_ORIGINS',
  },
  {
    fichier: 'supabase/functions/business-grow/index.ts',
    etiquette: 'business-grow — productionOrigins (liste REDONDANTE, sans effet propre)',
    motif: /const productionOrigins = \[([^\]]*)\]/,
    // Unie à la liste principale : elle n'ajoute aucune restriction, mais elle
    // donne l'illusion fausse que l'ancien site est « la » production.
    completee_par_secret: 'BUSINESS_GROW_ALLOWED_ORIGINS',
    redondante: true,
  },
  {
    fichier: 'supabase/functions/_shared/saspay/http.ts',
    etiquette: 'saspay — STATIC_ORIGINS',
    motif: /STATIC_ORIGINS\s*=\s*new Set\(\[([\s\S]*?)\]\)/,
    completee_par_secret: 'VYORA_PAYMENTS_ALLOWED_ORIGINS',
  },
  {
    fichier: 'supabase/functions/_shared/saspay/http.ts',
    etiquette: 'saspay — ORIGIN_PATTERNS (prévisualisations)',
    motif: /ORIGIN_PATTERNS\s*=\s*\[([\s\S]*?)\];/,
    completee_par_secret: 'VYORA_PAYMENTS_ALLOWED_ORIGINS',
    // Liste de prévisualisations PAR CONCEPTION : elle ne doit pas accepter
    // l'origine de production. Lui reprocher son absence serait un faux positif.
    previsualisations: true,
  },
  {
    fichier: 'supabase/functions/reelora-owner-bootstrap/index.ts',
    etiquette: 'reelora-owner-bootstrap — DEFAULT_ALLOWED_ORIGINS',
    motif: /DEFAULT_ALLOWED_ORIGINS\s*=\s*\[([\s\S]*?)\];/,
    completee_par_secret: 'VYORA_ALLOWED_ORIGINS',
  },
  {
    fichier: 'src/lib/origin-allowlist.ts',
    etiquette: 'frontend partagé — DEFAULT_ALLOWED_ORIGINS',
    motif: /DEFAULT_ALLOWED_ORIGINS[^=]*=\s*\[([\s\S]*?)\]/,
    // Complétée par `buildAllowedOrigins(extra)` : les secrets ci-dessous
    // s'AJOUTENT aux valeurs par défaut, donc la nouvelle origine peut être
    // acceptée sans toucher au code.
    completee_par_secret: 'STORE_IMPORT_ALLOWED_ORIGINS / VYORA_ALLOWED_ORIGINS',
    // Copiée dans les artefacts épinglés du store : modifier les valeurs par
    // défaut change l'empreinte du bundle et exige une reconstruction + un
    // ré-épinglage. Passer par un secret évite cette manipulation.
    fige_dans_artefact: true,
  },
];

function lire(chemin) {
  try {
    return readFileSync(chemin, 'utf8');
  } catch {
    return null;
  }
}

/** Extrait les origines littérales d'un bloc de code. */
export function extraireOrigines(bloc) {
  const origines = [];
  for (const m of bloc.matchAll(/'(https?:\/\/[^']+)'/g)) origines.push(m[1]);
  // Motifs écrits en expression régulière (prévisualisations) : ils ne peuvent
  // pas correspondre à une origine de production fixe. On les conserve tels
  // quels, préfixés, pour que l'audit les montre sans conclure à tort.
  for (const m of bloc.matchAll(/\/(\^https:(?:\\.|[^/\n])+?\$)\//g)) {
    origines.push(`motif:${m[1].replace(/\\/g, '')}`);
  }
  return [...new Set(origines)];
}

/** Une origine Netlify de prévisualisation n'est pas une origine « de service ». */
export function estMotif(origine) {
  return origine.includes('*') || origine.startsWith('motif:');
}

/**
 * Compare une liste à l'origine de production.
 * Une prévisualisation (`*.e2b.app`, `deploy-preview-*`) n'accepte pas l'origine
 * de production : seules les correspondances exactes comptent.
 */
export function accepterait(origines, origine) {
  return origines.some((o) => o === origine);
}

export function auditer({ origineProduction = ORIGINE_PRODUCTION, racine = process.cwd() } = {}) {
  const constats = [];
  const listes = [];

  for (const definition of LISTES) {
    const source = lire(`${racine}/${definition.fichier}`);
    if (source === null) {
      constats.push({ niveau: 'attention', liste: definition.etiquette, message: `fichier introuvable : ${definition.fichier}` });
      continue;
    }
    const bloc = source.match(definition.motif)?.[1];
    if (!bloc) {
      constats.push({ niveau: 'attention', liste: definition.etiquette, message: 'motif non reconnu : la liste a peut-être été renommée, audit à mettre à jour' });
      continue;
    }
    const origines = extraireOrigines(bloc);
    const accepte = accepterait(origines, origineProduction);
    listes.push({
      etiquette: definition.etiquette,
      fichier: definition.fichier,
      origines,
      completee_par_secret: definition.completee_par_secret,
      fige_dans_artefact: Boolean(definition.fige_dans_artefact),
      redondante: Boolean(definition.redondante),
      previsualisations: Boolean(definition.previsualisations),
      accepte_production: accepte,
    });

    // 1. Origines mortes encore codées en dur.
    for (const origine of origines) {
      if (ORIGINES_HISTORIQUES.has(origine)) {
        constats.push({
          niveau: 'attention',
          liste: definition.etiquette,
          message: `origine HISTORIQUE encore codée en dur : ${origine} (site fermé ; seule la compatibilité de transition la justifie)`,
        });
      }
    }

    // 2. Le site réellement servi est-il accepté sans dépendre d'un secret ?
    // Une liste redondante (unie à une autre, sans effet propre) n'est pas
    // jugée ici : elle ne décide de rien, elle induit seulement en erreur.
    if (!accepte && !definition.redondante && !definition.previsualisations) {
      constats.push({
        niveau: definition.completee_par_secret ? 'attention' : 'bloquant',
        liste: definition.etiquette,
        message: definition.completee_par_secret
          ? `le site servi (${origineProduction}) n'est PAS dans les valeurs par défaut : il ne passe que par le secret ${definition.completee_par_secret}. Sa perte casse le site sans qu'aucun code ne change.`
          : `le site servi (${origineProduction}) n'est PAS accepté, et cette liste n'est complétée par aucun secret : la migration exigera de modifier le code${definition.fige_dans_artefact ? ' ET de reconstruire un artefact épinglé' : ''}.`,
      });
    }

    if (definition.redondante) {
      constats.push({
        niveau: 'attention',
        liste: definition.etiquette,
        message: 'liste redondante : unie à la liste principale, elle ne restreint rien. La conserver laisse croire que l\'ancien site est « la » production.',
      });
    }

    // 3. Aucune URL de production réelle : liste réduite aux prévisualisations.
    if (!definition.redondante && !definition.previsualisations && !origines.some((o) => !estMotif(o) && !ORIGINES_HISTORIQUES.has(o) && !o.includes('localhost') && !o.includes('127.0.0.1'))) {
      constats.push({
        niveau: 'attention',
        liste: definition.etiquette,
        message: 'aucune origine de production réelle (hors prévisualisation, localhost ou historique)',
      });
    }
  }

  // 4. Divergence entre les deux listes de business-grow.
  const bg = listes.filter((l) => l.fichier === 'supabase/functions/business-grow/index.ts');
  if (bg.length === 2) {
    const [principale, redondante] = bg;
    const seulementDansRedondante = redondante.origines.filter((o) => !principale.origines.includes(o));
    const seulementDansPrincipale = principale.origines.filter((o) => !redondante.origines.includes(o));
    if (seulementDansRedondante.length) {
      constats.push({ niveau: 'attention', liste: 'business-grow', message: `origines présentes UNIQUEMENT dans productionOrigins : ${seulementDansRedondante.join(', ')}` });
    }
    if (seulementDansPrincipale.length) {
      constats.push({ niveau: 'attention', liste: 'business-grow', message: `origines présentes UNIQUEMENT dans la liste principale : ${seulementDansPrincipale.join(', ')}` });
    }
  }

  return { origineProduction, listes, constats };
}

/** Résumé lisible, destiné à être collé dans un rapport. */
export function formater(resultat) {
  const lignes = [
    `Audit des origines — site servi : ${resultat.origineProduction}`,
    '',
  ];
  for (const liste of resultat.listes) {
    lignes.push(`• ${liste.etiquette}  (${liste.fichier})`);
    lignes.push(`  origines : ${liste.origines.join(', ') || '<aucune>'}`);
    lignes.push(`  accepte le site servi : ${liste.accepte_production ? 'oui' : 'NON'}`
      + (liste.completee_par_secret ? ` (complétée par ${liste.completee_par_secret})` : ' (liste fermée)')
      + (liste.fige_dans_artefact ? ' — figée dans un artefact épinglé' : ''));
  }
  lignes.push('');
  if (!resultat.constats.length) {
    lignes.push('Aucun écart détecté.');
  } else {
    const bloquants = resultat.constats.filter((c) => c.niveau === 'bloquant');
    lignes.push(`Constats : ${resultat.constats.length} (dont ${bloquants.length} bloquant(s))`);
    for (const constat of resultat.constats) {
      lignes.push(`  [${constat.niveau}] ${constat.liste} : ${constat.message}`);
    }
  }
  return lignes.join('\n');
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const resultat = auditer();
  if (SORTIE_JSON) {
    console.log(JSON.stringify(resultat, null, 2));
  } else {
    console.log(formater(resultat));
  }
  process.exit(resultat.constats.some((c) => c.niveau === 'bloquant') ? 1 : 0);
}

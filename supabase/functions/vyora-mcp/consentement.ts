/**
 * SORAHNEX — session et page de consentement OAuth.
 *
 * Ce module ne touche ni au réseau ni à la base : il transforme un en-tête
 * `Cookie` et une session Supabase en une identité vérifiable, puis rend le
 * HTML de consentement. Tout est pur, donc tout est testable.
 *
 * ## Pourquoi une page, et pas un consentement implicite
 *
 * Un client MCP s'enregistre dynamiquement puis ouvre `/oauth/authorize` dans
 * le navigateur de l'utilisateur. Si cette route émettait un code dès qu'une
 * session existe, il suffirait de faire cliquer un lien à quelqu'un pour
 * connecter le compte de son agresseur — ou pour lui faire autoriser un client
 * qu'il n'a jamais vu. Le code n'est donc émis qu'après un `POST` explicite.
 *
 * ## Le jeton anti-rejeu n'est pas stocké
 *
 * `csrfToken` est dérivé du jeton d'accès de la session :
 *
 *     csrf = SHA-256(préfixe fixe ‖ access_token)
 *
 * Conséquence utile : le jeton n'a pas besoin d'être conservé côté serveur, il
 * expire avec la session, et il est impossible à deviner sans lire le cookie.
 * Il ne protège pas contre un XSS (qui lit le cookie) — mais un XSS, à ce
 * stade, a déjà la session. La comparaison est à temps constant.
 */
import { sha256Hex, tempsConstant } from './oauth.ts';

/** Préfixe de dérivation : le même jeton ne sert jamais deux fois ailleurs. */
const PREFIXE_CSRF = 'vyora-oauth-csrf-v1:';

/** Lit un en-tête `Cookie` en paires clé/valeur. */
export function lireCookies(entete: string | null | undefined): Record<string, string> {
  const resultat: Record<string, string> = {};
  if (!entete) return resultat;
  for (const morceau of entete.split(';')) {
    const egal = morceau.indexOf('=');
    if (egal <= 0) continue;
    const nom = morceau.slice(0, egal).trim();
    let valeur = morceau.slice(egal + 1).trim();
    if (valeur.startsWith('"') && valeur.endsWith('"')) valeur = valeur.slice(1, -1);
    if (!nom) continue;
    // Premier gagnant : un en-tête ne doit pas pouvoir masquer une session
    // établie en répétant le même nom avec une valeur vide.
    if (!(nom in resultat)) resultat[nom] = valeur;
  }
  return resultat;
}

/**
 * Extrait le jeton d'accès d'un cookie de session Supabase.
 *
 * Selon la version du client JS, `sb-<ref>-auth-token` contient soit du JSON
 * brut, soit du JSON encodé en base64 préfixé par `base64-`. La session peut
 * aussi être découpée en `.0`, `.1`… quand elle dépasse la taille d'un cookie.
 * On reconstruit donc les morceaux avant de décoder.
 */
export function extraireJetonSession(cookies: Record<string, string>): string | null {
  /*
   * Deux dispositions coexistent selon la version de `@supabase/ssr` :
   *
   *   - un cookie unique `sb-<ref>-auth-token` ;
   *   - un cookie découpé `sb-<ref>-auth-token.0`, `.1`… et AUCUNE clé de base,
   *     quand la session dépasse la limite de 4096 octets par cookie.
   *
   * L'ancienne implémentation triait les clés et prenait la dernière : `.1` se
   * classant après la fin de chaîne, la base était écartée et la session
   * perdue. On distingue donc explicitement les deux formes.
   */
  const exact = Object.keys(cookies).find((nom) => /^sb-.+-auth-token$/.test(nom));
  let brut = exact ? (cookies[exact] ?? '') : '';

  if (!brut) {
    const premier = Object.keys(cookies).find((nom) => /^sb-.+-auth-token\.0$/.test(nom));
    if (!premier) return null;
    const prefixe = premier.slice(0, -2); // sans « .0 »
    for (let i = 0; i < 20; i += 1) {
      const morceau = cookies[`${prefixe}.${i}`];
      /*
       * Un trou dans la numérotation rend le cookie inexploitable : refuser est
       * plus sûr que reconstruire un JSON tronqué, qui produirait une erreur
       * floue à l'utilisateur et masquerait la vraie cause.
       */
      if (morceau === undefined) break;
      brut += morceau;
    }
  }

  let json: string = brut;
  if (brut.startsWith('base64-')) {
    try {
      json = atob(brut.slice('base64-'.length));
    } catch {
      return null;
    }
  }

  try {
    const objet = JSON.parse(json) as { access_token?: unknown };
    const jeton = typeof objet.access_token === 'string' ? objet.access_token : '';
    // Un JWT a trois segments : on refuse tout le reste avant tout appel réseau.
    return jeton.split('.').length === 3 ? jeton : null;
  } catch {
    return null;
  }
}

/** Dérive le jeton anti-rejeu lié à une session. */
export function deriverJetonAntiRejeu(accessToken: string): string {
  return sha256Hex(PREFIXE_CSRF + accessToken);
}

/**
 * Vérifie le champ caché du formulaire contre le cookie de session.
 *
 * `attendu` est recalculé depuis le jeton réel, jamais lu dans la requête : un
 * attaquant qui poste un formulaire ne peut donc pas fournir les deux côtés de
 * la comparaison.
 */
export function verifierAntiRejeu(attendu: string | null, fourni: string | null): boolean {
  if (!attendu || !fourni) return false;
  if (attendu.length !== fourni.length) return false;
  return tempsConstant(attendu, fourni);
}

/* -------------------------------------------------------------------------- */
/* Page HTML                                                                   */
/* -------------------------------------------------------------------------- */

/** Échappe une valeur pour un contexte HTML texte ET attribut. */
export function echapperHtml(valeur: string): string {
  return valeur
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Deux portées, en clair : « read » seul ne dit rien à un utilisateur. */
const LIBELLES_PORTEES: Record<string, string> = {
  read: 'Consulter les données de votre compte (commandes, produits, statistiques). Aucune modification.',
  write: 'Modifier des données (créer ou mettre à jour des ressources). Chaque écriture reste soumise à confirmation.',
};

export interface VueConsentement {
  clientName: string;
  scopes: string[];
  redirectHost: string;
  csrfToken: string;
  champs: Record<string, string>;
}

/**
 * Rend la page de consentement.
 *
 * Aucune ressource externe : pas de police, pas de script, pas d'image. La page
 * se charge donc même si le réseau de l'utilisateur filtre le reste, et elle
 * ne peut pas exfiltrer le jeton anti-rejeu vers un tiers.
 *
 * `redirectHost` n'est jamais cliquable : afficher une adresse en texte empêche
 * un client malveillant d'exploiter la page pour faire croire à une navigation
 * légitime.
 */
export function rendrePageConsentement(vue: VueConsentement): string {
  const champs = Object.entries(vue.champs)
    .map(([nom, valeur]) => `<input type="hidden" name="${echapperHtml(nom)}" value="${echapperHtml(valeur)}">`)
    .join('\n        ');

  const portees = vue.scopes
    .map((portee) => {
      const libelle = LIBELLES_PORTEES[portee] ?? 'Portée inconnue.';
      return `<li><strong>${echapperHtml(portee)}</strong> — ${echapperHtml(libelle)}</li>`;
    })
    .join('\n          ');

  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>Autoriser ${echapperHtml(vue.clientName)} — SORAHNEX</title>
  <style>
    :root { color-scheme: light dark; }
    body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0;
           display: flex; align-items: center; justify-content: center;
           min-height: 100vh; background: #0f1115; color: #e8eaed; padding: 24px; }
    main { max-width: 30rem; width: 100%; background: #171a21; border: 1px solid #272b35;
           border-radius: 14px; padding: 28px; }
    h1 { font-size: 1.15rem; margin: 0 0 6px; }
    .hote { color: #9aa4b2; font-size: .9rem; margin: 0 0 20px; word-break: break-all; }
    ul { padding-left: 18px; margin: 0 0 22px; line-height: 1.5; font-size: .94rem; }
    li { margin-bottom: 8px; }
    .actions { display: flex; gap: 10px; }
    button { flex: 1; padding: 11px 14px; border-radius: 9px; font-size: .95rem;
             cursor: pointer; border: 1px solid #2f3440; background: #232833; color: inherit; }
    button[type=submit] { background: #4f7cff; border-color: #4f7cff; color: #fff; font-weight: 600; }
    footer { margin-top: 20px; font-size: .8rem; color: #7b8494; line-height: 1.5; }
  </style>
</head>
<body>
  <main>
    <h1>Autoriser ${echapperHtml(vue.clientName)}</h1>
    <p class="hote">Cette application demande l’accès à votre compte SORAHNEX et sera renvoyée vers ${echapperHtml(vue.redirectHost)}.</p>
    <ul>
      ${portees}
    </ul>
    <form method="post" action="">
      ${champs}
      <input type="hidden" name="csrf_token" value="${echapperHtml(vue.csrfToken)}">
      <div class="actions">
        <button type="submit" name="decision" value="refuser">Refuser</button>
        <button type="submit" name="decision" value="autoriser">Autoriser</button>
      </div>
    </form>
    <footer>Vous pourrez révoquer cet accès à tout moment depuis SORAHNEX, dans « Connexions IA ».</footer>
  </main>
</body>
</html>`;
}

/** Page d'erreur : jamais de redirection vers une adresse jugée non fiable. */
export function rendrePageErreur(message: string): string {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>Autorisation refusée — SORAHNEX</title>
  <style>
    body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0;
           display: flex; align-items: center; justify-content: center;
           min-height: 100vh; background: #0f1115; color: #e8eaed; padding: 24px; }
    main { max-width: 30rem; background: #171a21; border: 1px solid #272b35;
           border-radius: 14px; padding: 28px; line-height: 1.55; }
    h1 { font-size: 1.1rem; margin: 0 0 10px; }
    p { margin: 0; color: #b6bec9; font-size: .94rem; }
  </style>
</head>
<body>
  <main>
    <h1>Autorisation impossible</h1>
    <p>${echapperHtml(message)}</p>
  </main>
</body>
</html>`;
}

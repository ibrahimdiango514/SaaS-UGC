/**
 * SORAHNEX AI — rendu Markdown minimal, sans dépendance.
 *
 * ## Pourquoi un rendu maison
 *
 * Les réponses de l'assistant contiennent du Markdown léger : titres, listes,
 * code, gras. Ajouter une bibliothèque complète (remark, markdown-it) pour cela
 * représente ~40 Ko de plus dans le bundle et une surface d'attaque
 * supplémentaire.
 *
 * ## Sécurité — le point important
 *
 * Les réponses viennent d'un modèle de langage : elles ne sont **pas** fiables.
 * Ce rendu :
 *   - échappe systématiquement le HTML avant toute transformation ;
 *   - n'accepte aucun attribut ni balise arbitraire ;
 *   - n'accepte que les liens `http`, `https` et `mailto`.
 *
 * Un `<script>` présent dans une réponse s'affiche donc comme du texte, pas
 * comme du code exécuté.
 */

/** Échappe les caractères HTML significatifs. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Vrai si l'URL est d'un schéma autorisé. */
export function isSafeHref(href: string): boolean {
  const value = href.trim();
  if (!value) return false;
  // Un schéma explicite autre que ceux autorisés est refusé : `javascript:`,
  // `data:`, `vbscript:` et les variantes obfusquées n'ont pas de correspondance.
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    return /^https?:/i.test(value) || /^mailto:/i.test(value);
  }
  // Chemin relatif ou ancre : accepté.
  return true;
}

/** Applique les transformations inline sur un fragment DÉJÀ échappé. */
function inline(text: string): string {
  let out = text;

  // Code inline d'abord : son contenu ne doit pas être réinterprété.
  const codes: string[] = [];
  out = out.replace(/`([^`]+)`/g, (_m, code: string) => {
    codes.push(code);
    return `\u0000CODE${codes.length - 1}\u0000`;
  });

  // Gras puis italique.
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');

  // Liens. Le libellé et l'URL sont déjà échappés ; on revérifie le schéma.
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label: string, href: string) => {
    if (!isSafeHref(href)) return match;
    const rel = 'rel="noopener noreferrer nofollow"';
    return `<a href="${href}" target="_blank" ${rel}>${label}</a>`;
  });

  // Restitution du code inline.
  out = out.replace(/\u0000CODE(\d+)\u0000/g, (_m, index: string) => `<code>${codes[Number(index)]}</code>`);
  return out;
}

/**
 * Convertit un Markdown léger en HTML sûr.
 *
 * Les blocs de code sont extraits avant tout traitement : leur contenu est
 * affiché tel quel, jamais interprété.
 */
export function renderMarkdown(source: string): string {
  if (!source) return '';

  const blocs: string[] = [];
  // On isole les blocs ```…``` avant l'échappement global.
  const sansBlocs = source.replace(/```([a-z0-9+#-]*)\n?([\s\S]*?)```/gi, (_m, _lang: string, code: string) => {
    blocs.push(code.replace(/\n$/, ''));
    return `\u0000BLOC${blocs.length - 1}\u0000`;
  });

  const echappe = escapeHtml(sansBlocs);
  const lignes = echappe.split('\n');
  const sortie: string[] = [];

  let liste: 'ul' | 'ol' | null = null;
  let paragraphe: string[] = [];

  const fermerListe = () => {
    if (liste) {
      sortie.push(`</${liste}>`);
      liste = null;
    }
  };
  const viderParagraphe = () => {
    if (paragraphe.length > 0) {
      sortie.push(`<p>${inline(paragraphe.join(' '))}</p>`);
      paragraphe = [];
    }
  };

  for (const ligne of lignes) {
    const brute = ligne;

    // Bloc de code restitué.
    if (/^\u0000BLOC\d+\u0000$/.test(brute.trim())) {
      viderParagraphe();
      fermerListe();
      const index = Number(/\u0000BLOC(\d+)\u0000/.exec(brute)![1]);
      sortie.push(`<pre><code>${escapeHtml(blocs[index])}</code></pre>`);
      continue;
    }

    if (!brute.trim()) {
      viderParagraphe();
      fermerListe();
      continue;
    }

    const titre = /^(#{1,3})\s+(.*)$/.exec(brute);
    if (titre) {
      viderParagraphe();
      fermerListe();
      const niveau = titre[1].length;
      sortie.push(`<h${niveau}>${inline(titre[2])}</h${niveau}>`);
      continue;
    }

    const citation = /^&gt;\s?(.*)$/.exec(brute);
    if (citation) {
      viderParagraphe();
      fermerListe();
      sortie.push(`<blockquote>${inline(citation[1])}</blockquote>`);
      continue;
    }

    const puce = /^[-*+]\s+(.*)$/.exec(brute);
    if (puce) {
      viderParagraphe();
      if (liste !== 'ul') {
        fermerListe();
        sortie.push('<ul>');
        liste = 'ul';
      }
      sortie.push(`<li>${inline(puce[1])}</li>`);
      continue;
    }

    const numero = /^\d+[.)]\s+(.*)$/.exec(brute);
    if (numero) {
      viderParagraphe();
      if (liste !== 'ol') {
        fermerListe();
        sortie.push('<ol>');
        liste = 'ol';
      }
      sortie.push(`<li>${inline(numero[1])}</li>`);
      continue;
    }

    fermerListe();
    paragraphe.push(brute.trim());
  }

  viderParagraphe();
  fermerListe();
  return sortie.join('\n');
}

/** Texte brut d'une réponse, pour la copie et la synthèse vocale. */
export function toPlainText(markdown: string): string {
  return markdown
    .replace(/```[a-z0-9+#-]*\n?([\s\S]*?)```/gi, (_m, code: string) => code)
    .replace(/^#{1,3}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^&gt;\s?/gm, '')
    .trim();
}

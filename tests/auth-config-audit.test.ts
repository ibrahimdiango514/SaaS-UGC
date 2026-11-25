import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const lire = (chemin: string) => readFileSync(join(process.cwd(), chemin), 'utf8');

describe('Audit de la configuration Auth — document honnête', () => {
  const doc = lire('docs/AUTH_CONFIG_AUDIT.md');

  it('signale la limite réelle d’envoi d’e-mails (2 par heure)', () => {
    expect(doc).toContain('rate_limit_email_sent');
    expect(doc).toMatch(/2 e-mails par heure|deux personnes par heure|2\b.*heure/i);
    // Le document doit dire que le troisième essai échoue, pas rester allusif.
    expect(doc).toMatch(/troisième/i);
  });

  it('signale l’absence de SMTP personnalisé et ne la présente pas comme anodine', () => {
    expect(doc).toMatch(/SMTP/i);
    expect(doc).toMatch(/non appliquée|non appliqué|demande des identifiants/i);
  });

  it('explique la conséquence de mailer_autoconfirm = true sans la cacher', () => {
    expect(doc).toContain('mailer_autoconfirm');
    expect(doc).toMatch(/jamais vérifiées|aucune preuve de possession/i);
  });

  it('rappelle que uri_allow_list est REMPLACÉE, pas complétée', () => {
    expect(doc).toContain('uri_allow_list');
    expect(doc).toMatch(/écrase|remplace|remplacer la liste entière/i);
  });

  it('distingue l’OAuth utilisateur (absent) des connecteurs OAuth sortants', () => {
    expect(doc).toMatch(/aucun fournisseur OAuth activé|Aucun fournisseur OAuth/i);
    expect(doc).toMatch(/sortant/i);
  });

  it('ne prétend pas avoir appliqué des changements de configuration', () => {
    // Tout changement d'auth est une décision utilisateur : le document doit le
    // dire, sinon il laisse croire que le travail est fait.
    expect(doc).toMatch(/décision produit|t'appartiennent|avec autorisation|non appliqué/i);
  });
});

describe('Le code d’authentification gère bien les retours', () => {
  it('AuthCallback traite la récupération de mot de passe et le paramètre next', () => {
    const source = lire('src/pages/AuthCallback.tsx');
    expect(source).toContain('recovery');
    expect(source).toContain('next');
  });

  it('SITE_URL retombe sur l’origine courante plutôt que sur un domaine figé', () => {
    const source = lire('src/lib/supabase.ts');
    expect(source).toContain('window.location.origin');
    // Aucune adresse Netlify en dur dans ce fichier : le domaine vient de
    // l'environnement, sinon la bascule demanderait une édition du code.
    expect(source).not.toMatch(/https:\/\/[a-z0-9-]+\.netlify\.app/);
  });

  it('la session survit à un changement d’hébergement (clé de stockage stable)', () => {
    const source = lire('src/lib/supabase.ts');
    expect(source).toContain("storageKey: 'reelora.auth.v1'");
  });
});

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Garde-fous sur la migration `20261126120000` (autonomie de l'agent, journal).
 *
 * ## Ce que ces tests prouvent — et ce qu'ils NE prouvent PAS
 * Ils lisent le SQL. Ils n'affirment pas que PostgreSQL se comporte ainsi :
 * **aucun PostgreSQL n'est disponible dans cet environnement d'exécution**, donc
 * la migration n'a pas été appliquée. La preuve de comportement ne pourra venir
 * que d'une base réelle (environnement jetable ou production), et je ne la
 * déclare pas ici.
 *
 * Ils verrouillent les décisions qui se perdraient le plus facilement lors
 * d'une réécriture : pas d'accès anonyme, vérification d'appartenance à
 * l'entreprise sur CHAQUE fonction, et aucun moyen d'enregistrer un niveau
 * automatique sans règle nommée.
 */

const SQL = readFileSync(
  'supabase/migrations/20261126120000_business_grow_agent_autonomy.sql',
  'utf8',
);

/** Retire les commentaires : un mot dans un commentaire n'est pas une règle. */
function sansCommentaires(sql: string): string {
  return sql
    .split('\n')
    .map((ligne) => ligne.replace(/--.*$/, ''))
    .join('\n');
}

const CODE = sansCommentaires(SQL);

/** Corps d'une fonction, du CREATE jusqu'à la fin de son bloc `$$`. */
function corpsFonction(nom: string): string {
  const debut = CODE.search(new RegExp(`CREATE OR REPLACE FUNCTION saas_business\\.${nom}\\(`, 'i'));
  expect(debut, `fonction ${nom} absente de la migration`).toBeGreaterThan(-1);
  const fin = CODE.indexOf('$$;', CODE.indexOf('$$', debut + 10));
  return CODE.slice(debut, fin === -1 ? undefined : fin + 3);
}

const FONCTIONS = [
  'bg_agent_journal_limit',
  'bg_get_agent_autonomy',
  'bg_set_agent_autonomy',
  'bg_journal_append',
  'bg_journal_list',
];

describe('Migration autonomie — ADDITIVE uniquement', () => {
  it('ne supprime, ne renomme et ne modifie aucune table existante', () => {
    expect(CODE).not.toMatch(/DROP\s+TABLE/i);
    expect(CODE).not.toMatch(/DROP\s+COLUMN/i);
    expect(CODE).not.toMatch(/ALTER\s+TABLE[^;]*DROP/i);
    expect(CODE).not.toMatch(/RENAME\s+TO/i);
    expect(CODE).not.toMatch(/TRUNCATE/i);
    expect(CODE).not.toMatch(/DELETE\s+FROM/i);
    expect(CODE).not.toMatch(/CREATE\s+TABLE/i);
  });

  it('ne modifie pas les 9 autres catégories : la fonction partagée n’est pas redéfinie', () => {
    // Redéfinir `bg_create_scoped_module_record` changerait la limite de 500
    // pour TOUTES les catégories métier. Le journal a sa propre insertion.
    expect(CODE).not.toMatch(/CREATE OR REPLACE FUNCTION saas_business\.bg_create_scoped_module_record/i);
    expect(CODE).not.toMatch(/CREATE OR REPLACE FUNCTION saas_business\.bg_module_validate/i);
  });

  it('crée exactement les cinq fonctions attendues', () => {
    const creees = [...CODE.matchAll(/CREATE OR REPLACE FUNCTION saas_business\.([a-z_]+)\(/gi)]
      .map((m) => m[1]);
    expect(creees.sort()).toEqual([...FONCTIONS].sort());
  });
});

describe('Migration autonomie — droits', () => {
  it('révoque l’exécution pour PUBLIC, anon et authenticated sur les cinq fonctions', () => {
    for (const nom of FONCTIONS) {
      const ligne = CODE.split('\n').find((l) => l.includes(`REVOKE ALL ON FUNCTION saas_business.${nom}(`));
      expect(ligne, `aucun REVOKE pour ${nom}`).toBeTruthy();
      expect(ligne).toMatch(/FROM PUBLIC, anon, authenticated/);
    }
  });

  it('n’accorde l’exécution qu’au rôle serveur bg_edge', () => {
    const grants = [...CODE.matchAll(/GRANT EXECUTE ON FUNCTION saas_business\.([a-z_]+)\([^)]*\) TO ([a-z_, ]+);/gi)];
    expect(grants.length).toBe(5);
    for (const [, , roles] of grants) {
      expect(roles.trim()).toBe('bg_edge');
    }
  });

  it('n’accorde jamais rien à anon ni à service_role', () => {
    expect(CODE).not.toMatch(/GRANT[^;]*\banon\b/i);
    expect(CODE).not.toMatch(/GRANT[^;]*service_role/i);
  });
});

describe('Migration autonomie — isolation par espace de travail', () => {
  it('vérifie l’appartenance à l’entreprise en LECTURE', () => {
    expect(corpsFonction('bg_get_agent_autonomy')).toMatch(/bg_require_workspace\(p_user_id, p_workspace_id, false\)/);
    expect(corpsFonction('bg_journal_list')).toMatch(/bg_require_workspace\(p_user_id, p_workspace_id, false\)/);
  });

  it('vérifie les droits d’ÉCRITURE (et verrouille) sur les trois fonctions qui écrivent', () => {
    for (const nom of ['bg_set_agent_autonomy', 'bg_journal_append']) {
      expect(corpsFonction(nom), nom).toMatch(/bg_lock_workspace_access\(p_user_id, p_workspace_id, true\)/);
    }
  });

  it('filtre TOUJOURS sur user_id ET workspace_id : aucun accès inter-espaces', () => {
    for (const nom of ['bg_get_agent_autonomy', 'bg_journal_list']) {
      const corps = corpsFonction(nom);
      expect(corps, nom).toMatch(/r\.user_id = p_user_id/);
      expect(corps, nom).toMatch(/r\.workspace_id IS NOT DISTINCT FROM p_workspace_id/);
    }
  });

  it('utilise IS NOT DISTINCT FROM, qui traite correctement le périmètre NULL (héritage)', () => {
    // `= NULL` ne renvoie jamais rien : la lecture d'un espace hérité serait
    // silencieusement vide, et personne ne verrait l'erreur.
    const corps = corpsFonction('bg_get_agent_autonomy');
    expect(corps).not.toMatch(/workspace_id\s*=\s*p_workspace_id/);
    expect(corps).toMatch(/IS NOT DISTINCT FROM/);
  });

  it('déclare toutes les fonctions SECURITY DEFINER avec search_path figé', () => {
    for (const nom of FONCTIONS) {
      const corps = corpsFonction(nom);
      if (nom === 'bg_agent_journal_limit') continue; // immutable, sans accès aux tables
      expect(corps, nom).toMatch(/SECURITY DEFINER/);
      expect(corps, nom).toMatch(/SET search_path = pg_catalog, saas_business/);
    }
  });
});

describe('Migration autonomie — le niveau automatique exige une règle', () => {
  it('refuse « automatique » sans règle nommée, côté base', () => {
    const corps = corpsFonction('bg_set_agent_autonomy');
    expect(corps).toMatch(/p_level = 'automatique' AND \(p_rule_id IS NULL OR btrim\(p_rule_id\) = ''\)/);
    expect(corps).toMatch(/RAISE EXCEPTION 'automatic level requires a named rule'/);
  });

  it('refuse tout niveau inconnu plutôt que de le normaliser en silence', () => {
    expect(corpsFonction('bg_set_agent_autonomy')).toMatch(/IF p_level NOT IN \('lecture', 'preparation', 'automatique'\)/);
  });

  it('n’accepte que les six statuts de journal prévus', () => {
    const corps = corpsFonction('bg_journal_append');
    for (const statut of ['proposee', 'validee', 'refusee', 'executee', 'echouee', 'annulee']) {
      expect(corps).toContain(`'${statut}'`);
    }
    expect(corps).toMatch(/IF v_status NOT IN/);
  });

  it('reconstruit l’entrée de journal : aucune clé inconnue n’est recopiée', () => {
    const corps = corpsFonction('bg_journal_append');
    // Un `p_entry || ...` recopierait tout, y compris des clés arbitraires.
    expect(corps).not.toMatch(/p_entry\s*\|\|/);
    expect(corps).toMatch(/jsonb_build_object\(/);
  });

  it('ignore une catégorie cible invalide au lieu de la stocker', () => {
    expect(corpsFonction('bg_journal_append')).toMatch(/\^bg_module_\[a-z0-9_\]\{2,60\}\$/);
  });
});

describe('Migration autonomie — volume borné', () => {
  it('borne le journal à 5 000 entrées et échoue franchement au-delà', () => {
    expect(SQL).toMatch(/SELECT 5000/);
    expect(corpsFonction('bg_journal_append')).toMatch(/v_count >= saas_business\.bg_agent_journal_limit\(\)/);
    expect(corpsFonction('bg_journal_append')).toMatch(/'journal limit reached'/);
  });

  it('n’utilise PAS la fonction partagée qui plafonnerait le journal à 500', () => {
    const corps = corpsFonction('bg_journal_append');
    expect(corps).not.toMatch(/bg_create_scoped_module_record/);
    expect(corps).toMatch(/INSERT INTO saas_business\.module_records/);
  });

  it('borne la lecture entre 1 et 200 entrées, même si l’appelant demande plus', () => {
    expect(corpsFonction('bg_journal_list')).toMatch(/LEAST\(GREATEST\(COALESCE\(p_limit, 50\), 1\), 200\)/);
  });
});

describe('Migration autonomie — aucune donnée existante touchée', () => {
  it('ne déplace pas les litiges ni les règles déjà stockées', () => {
    /*
     * Un seul UPDATE est légitime : celui de la ligne d'autonomie, quand on
     * change le niveau d'un outil. L'interdire en bloc serait faux ; l'autoriser
     * sans contrôle le serait aussi. On vérifie donc OÙ il se trouve.
     */
    const updates = [...CODE.matchAll(/UPDATE saas_business\.module_records/gi)];
    expect(updates.length).toBe(1);
    expect(corpsFonction('bg_set_agent_autonomy')).toMatch(/UPDATE saas_business\.module_records/);
    for (const nom of ['bg_journal_append', 'bg_journal_list', 'bg_get_agent_autonomy']) {
      expect(corpsFonction(nom), nom).not.toMatch(/UPDATE saas_business\.module_records/i);
    }
    // Aucun déplacement de données d'une catégorie existante.
    expect(CODE).not.toMatch(/bg_module_receivable_disputes/);
    expect(CODE).not.toMatch(/bg_module_automation_rules/);
    expect(CODE).not.toMatch(/bg_module_crm_|bg_module_sales_|bg_module_receivables/);
  });

  it('l’UPDATE d’autonomie est borné à la catégorie et à l’utilisateur', () => {
    const corps = corpsFonction('bg_set_agent_autonomy');
    const index = corps.indexOf('UPDATE saas_business.module_records');
    const debut = corps.lastIndexOf('WHERE', index) > -1 ? corps.slice(0, index) : corps.slice(0, index);
    // Les filtres de la SELECT qui précède portent bien sur l'utilisateur,
    // l'espace et la catégorie : la ligne modifiée ne peut être qu'une ligne
    // d'autonomie de cet espace.
    expect(debut).toMatch(/r\.user_id = p_user_id/);
    expect(debut).toMatch(/r\.workspace_id IS NOT DISTINCT FROM p_workspace_id/);
    expect(debut).toMatch(/'bg_module_agent_autonomy'/);
    // Et l'écriture se fait par identifiant de ligne, pas par prédicat large.
    expect(corps).toMatch(/UPDATE saas_business\.module_records\s+SET data = v_datasets\s+WHERE id = v_record_id/);
  });

  it('ne contient aucun secret ni identifiant en dur', () => {
    expect(SQL).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/); // jeton JWT
    expect(SQL).not.toMatch(/postgres:\/\//i);
    expect(SQL).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });
});

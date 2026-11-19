// @vitest-environment jsdom
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * VYORA Integrations — tests du catalogue.
 *
 * ## Ce que ces tests protègent
 *
 * L'exigence centrale est « ne jamais simuler une connexion ». Elle est
 * implémentée dans `deriveStatus()` : le statut est **calculé**, jamais saisi.
 * Un test qui vérifierait seulement « la page s'affiche » ne la protégerait
 * pas. On teste donc la fonction de dérivation directement, cas par cas, puis
 * l'affichage qui en découle.
 */

const rpc = vi.hoisted(() => vi.fn());

vi.mock('../src/lib/supabase', () => ({
  supabase: { rpc },
  SUPABASE_URL: 'https://test.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'pk_test',
  isSupabaseConfigured: true,
}));

import { existsSync, readFileSync } from 'node:fs';

import CatalogPage from '../src/integrations/CatalogPage';
import {
  INTEGRATIONS, INTEGRATION_BY_ID, CAPABILITY_LABELS, countByCategory,
  searchIntegrations, type IntegrationEntry,
} from '../src/integrations/catalog';
import {
  deriveStatus, canConnect, normalizeProvider, summarize, accountFor,
  missingCapabilities, STATUS_LABELS, type ConnectedAccount,
} from '../src/integrations/connections';

beforeEach(() => {
  rpc.mockReset();
  rpc.mockResolvedValue({ data: [], error: null });
});

afterEach(() => {
  cleanup();
});

function monter() {
  return render(
    <MemoryRouter initialEntries={['/app/connect']}>
      <CatalogPage />
    </MemoryRouter>,
  );
}

const compte = (over: Partial<ConnectedAccount> = {}): ConnectedAccount => ({
  id: 'a1',
  provider: 'gmail',
  externalAccountId: 'sub-1',
  displayName: 'Awa Diango',
  email: 'awa@vyora.test',
  capabilities: ['read', 'send'],
  status: 'connected',
  lastVerifiedAt: new Date().toISOString(),
  lastError: null,
  createdAt: new Date().toISOString(),
  ...over,
});

/** Ligne brute telle que `oauth_list_accounts()` la renvoie (snake_case). */
const ligneBase = () => ({
  id: 'a1',
  provider: 'gmail',
  external_account_id: 'sub-1',
  display_name: 'Awa Diango',
  email: 'awa@vyora.test',
  capabilities: ['read', 'send'],
  status: 'connected',
  last_verified_at: new Date().toISOString(),
  last_error: null,
  created_at: new Date().toISOString(),
});

describe('catalogue — structure', () => {
  it('couvre les quatre catégories demandées', () => {
    const counts = countByCategory();
    expect(counts.social).toBeGreaterThan(0);
    expect(counts.commerce).toBeGreaterThan(0);
    expect(counts.productivity).toBeGreaterThan(0);
    expect(counts.business).toBeGreaterThan(0);
  });

  it('inclut les plateformes de boutiques prioritaires', () => {
    for (const id of ['shopify', 'woocommerce', 'prestashop', 'magento', 'wix', 'bigcommerce', 'squarespace', 'ecwid', 'opencart']) {
      expect(INTEGRATION_BY_ID[id]).toBeTruthy();
    }
  });

  it('inclut les réseaux sociaux et outils de productivité demandés', () => {
    for (const id of ['instagram', 'facebook', 'tiktok', 'youtube', 'linkedin', 'pinterest']) {
      expect(INTEGRATION_BY_ID[id]).toBeTruthy();
    }
    for (const id of ['gmail', 'google_drive', 'google_calendar', 'microsoft365', 'outlook', 'slack', 'notion']) {
      expect(INTEGRATION_BY_ID[id]).toBeTruthy();
    }
  });

  it('aucune intégration ne déclare un connecteur inexistant', () => {
    // Un `engine` non nul est une PROMESSE : il doit exister un connecteur
    // réel derrière. On vérifie donc la présence du code, pas seulement la
    // forme du modèle. PrestaShop est aujourd'hui le seul dont le moteur est
    // écrit (clé vérifiée côté serveur, catalogue lu par l'API Webservice ou
    // par l'API Chariow) ; les autres fiches restent à `null` et l'affichent.
    /*
     * `custom-api` est un moteur ÉCRIT (actions `probe-custom` et `save-custom`
     * de `store-connect`), mais il ne se vérifie pas de la même façon : il n'a
     * pas de branche par connecteur dans le handler — c'est justement ce qui le
     * rend universel. Il est donc vérifié séparément, plus bas.
     */
    /*
     * Les quatre produits Meta ont leur moteur dans `meta-connect` (échange de
     * code côté serveur, vérification des ressources, jetons en Vault). Ils ne
     * passent PAS par `store-connect` : leur vérification est plus bas.
     */
    const MOTEURS_META = new Set(['whatsapp', 'facebook', 'messenger', 'instagram']);
    const MOTEURS_ECRITS = new Set(['prestashop', 'chariow', 'shopify', 'woocommerce']);
    for (const entry of INTEGRATIONS) {
      if (MOTEURS_META.has(entry.id)) {
        expect(entry.engine, `${entry.id} : moteur Meta annoncé`).not.toBeNull();
        // La fiche n'est une promesse que si la fonction Edge existe et gère
        // réellement ce produit.
        expect(existsSync('supabase/functions/meta-connect/handler.ts')).toBe(true);
        expect(existsSync('supabase/functions/meta-connect/index.ts')).toBe(true);
        const metaHandler = readFileSync('supabase/functions/meta-connect/handler.ts', 'utf8');
        expect(metaHandler).toContain(`'${entry.id}'`);
      } else if (MOTEURS_ECRITS.has(entry.id)) {
        expect(entry.engine, `${entry.id} : moteur annoncé`).not.toBeNull();
        // Le point qui rend la promesse vérifiable : le code du connecteur et
        // son point d'entrée déployé existent dans le dépôt.
        expect(existsSync(`supabase/functions/store-connect/handler.ts`)).toBe(true);
        expect(existsSync(`supabase/functions/store-connect/index.ts`)).toBe(true);
        // Le connecteur doit être RÉELLEMENT branché dans les deux fonctions :
        // une fiche à `engine: 'api-key'` sans branchement serait un bouton
        // qui échoue à la première requête.
        const handler = readFileSync('supabase/functions/store-connect/handler.ts', 'utf8');
        expect(handler).toContain(`'${entry.id}'`);
        const importHandler = readFileSync('supabase/functions/store-import/handler.ts', 'utf8');
        expect(importHandler).toContain(`'${entry.id}'`);
      } else if (entry.id === 'custom-api') {
        expect(entry.engine).toBe('custom-api');
      } else {
        expect(entry.engine, `${entry.id} : aucun moteur écrit`).toBeNull();
      }
    }
  });

  it('PrestaShop ne déclare que des capacités réellement fournies', () => {
    const prestashop = INTEGRATION_BY_ID.prestashop as IntegrationEntry;
    // `orders-read` était annoncé sans qu'aucune commande ne soit lue.
    expect(prestashop.capabilities).toContain('catalog-read');
    expect(prestashop.capabilities).toContain('inventory-read');
    expect(prestashop.capabilities).not.toContain('orders-read');
  });

  it('un connecteur au moteur écrit est proposé dès le premier usage', () => {
    const prestashop = INTEGRATION_BY_ID.prestashop as IntegrationEntry;
    // Premier usage : aucune ligne de connexion ⇒ `needs_config`. Le bouton
    // doit être proposé, sinon le connecteur existe sans être atteignable.
    expect(canConnect(prestashop, 'needs_config')).toBe(true);
    expect(canConnect(prestashop, 'not_connected')).toBe(true);
    // On ne repropose pas de connecter ce qui l'est déjà.
    expect(canConnect(prestashop, 'connected')).toBe(false);
    expect(canConnect(prestashop, 'requested')).toBe(false);
  });

  it('chaque intégration a au moins un mode d’authentification décrit', () => {
    for (const entry of INTEGRATIONS) {
      expect(entry.auth.length).toBeGreaterThan(0);
      for (const mode of entry.auth) expect(mode.label.length).toBeGreaterThan(5);
    }
  });

  it('aucun identifiant n’est dupliqué', () => {
    const ids = INTEGRATIONS.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('recherche — pertinence', () => {
  it('trouve par nom', () => {
    const r = searchIntegrations(INTEGRATIONS, 'shopify', 'all');
    expect(r.map((e) => e.id)).toContain('shopify');
  });

  it('trouve par capacité, pas seulement par nom', () => {
    // « stocks » n'apparaît dans aucun nom : la recherche doit passer par les
    // libellés de capacités.
    const r = searchIntegrations(INTEGRATIONS, 'stocks', 'all');
    expect(r.length).toBeGreaterThan(0);
    expect(r.some((e) => e.capabilities.includes('inventory-read'))).toBe(true);
  });

  it('trouve par description', () => {
    const r = searchIntegrations(INTEGRATIONS, 'factur', 'all');
    expect(r.some((e) => e.id === 'odoo')).toBe(true);
  });

  it('respecte le filtre de catégorie', () => {
    const r = searchIntegrations(INTEGRATIONS, '', 'commerce');
    expect(r.every((e) => e.category === 'commerce')).toBe(true);
  });

  it('retourne tout quand la recherche est vide', () => {
    expect(searchIntegrations(INTEGRATIONS, '   ', 'all')).toHaveLength(INTEGRATIONS.length);
  });

  it('ne retourne rien pour une recherche absurde', () => {
    expect(searchIntegrations(INTEGRATIONS, 'zzzzqqqq', 'all')).toHaveLength(0);
  });
});

describe('deriveStatus — le statut ne peut pas mentir', () => {
  const shopify = INTEGRATION_BY_ID.shopify as IntegrationEntry;

  it('sans connecteur, jamais « connecté » ni « non connecté »', () => {
    const statut = deriveStatus(shopify, [], false);
    // Shopify a des modes sans approbation externe → configuration requise.
    expect(statut).toBe('needs_config');
    expect(statut).not.toBe('connected');
    expect(statut).not.toBe('not_connected');
  });

  it('avec une approbation externe connue, affiche « validation requise »', () => {
    const instagram = INTEGRATION_BY_ID.instagram as IntegrationEntry;
    expect(deriveStatus(instagram, [], false)).toBe('needs_approval');
  });

  it('un compte réel l’emporte sur toute supposition', () => {
    const statut = deriveStatus(shopify, [compte({ provider: 'shopify' })], false);
    expect(statut).toBe('connected');
  });

  it('reprend fidèlement le statut du socle', () => {
    expect(deriveStatus(shopify, [compte({ provider: 'shopify', status: 'expired' })], false)).toBe('expired');
    expect(deriveStatus(shopify, [compte({ provider: 'shopify', status: 'revoked' })], false)).toBe('revoked');
  });

  it('un compte en erreur donne « erreur », pas « connecté »', () => {
    expect(deriveStatus(shopify, [compte({ provider: 'shopify', status: 'error' })], false)).toBe('error');
  });

  it('ne mélange pas les fournisseurs', () => {
    // Un compte Gmail ne doit pas rendre Shopify « connecté ».
    expect(deriveStatus(shopify, [compte({ provider: 'gmail' })], false)).not.toBe('connected');
  });

  it('ne fusionne pas les services Google entre eux', () => {
    // La base distingue gmail / google_drive / google_calendar : un compte
    // Drive ne donne aucun droit sur Gmail. Fusionner les trois ferait
    // apparaître Gmail « connecté » alors que seul Drive l'est.
    expect(normalizeProvider('google_drive')).toBe('google_drive');
    expect(normalizeProvider('google_calendar')).toBe('google_calendar');
    expect(normalizeProvider('gmail')).toBe('gmail');
  });

  it('tolère la casse et les espaces du fournisseur', () => {
    expect(normalizeProvider(' Shopify ')).toBe('shopify');
  });

  it('un compte Drive ne rend pas Gmail connecté', () => {
    const gmail = INTEGRATION_BY_ID.gmail as IntegrationEntry;
    const drive = INTEGRATION_BY_ID.google_drive as IntegrationEntry;
    const accounts = [compte({ provider: 'google_drive' })];
    expect(deriveStatus(drive, accounts, false)).toBe('connected');
    expect(deriveStatus(gmail, accounts, false)).not.toBe('connected');
  });

  it('signale les capacités accordées en moins, sans casser la connexion', () => {
    // Compte réel qui n'a que « read » alors que la fiche en demande plus.
    const gmail = INTEGRATION_BY_ID.gmail as IntegrationEntry;
    const restreint = compte({ provider: 'gmail', capabilities: ['read'] });
    // La connexion reste valide...
    expect(deriveStatus(gmail, [restreint], false)).toBe('connected');
    // ... mais l'interface sait ce qui manque.
    const manquantes = missingCapabilities(gmail, restreint);
    expect(manquantes.length).toBeGreaterThan(0);
    expect(manquantes).not.toContain('read');
  });

  it('ne signale rien quand toutes les capacités sont accordées', () => {
    const gmail = INTEGRATION_BY_ID.gmail as IntegrationEntry;
    const complet = compte({ provider: 'gmail', capabilities: [...gmail.capabilities] });
    expect(missingCapabilities(gmail, complet)).toHaveLength(0);
  });

  it('ne signale rien en l’absence de compte', () => {
    expect(missingCapabilities(INTEGRATION_BY_ID.gmail as IntegrationEntry, null)).toHaveLength(0);
  });

  it('canConnect est faux tant qu’aucun moteur n’existe', () => {
    // OpenCart n'a ni moteur ni parcours de connexion : c'est le cas réel
    // restant. Shopify a désormais un moteur, il ne sert donc plus d'exemple.
    const opencart = INTEGRATION_BY_ID.opencart as IntegrationEntry;
    expect(opencart.engine).toBeNull();
    expect(canConnect(opencart, 'not_connected')).toBe(false);
    expect(canConnect(opencart, 'needs_config')).toBe(false);
    expect(canConnect(opencart, 'needs_approval')).toBe(false);
  });

  it('canConnect distingue « à configurer » de « à autoriser »', () => {
    /*
     * `needs_config` est CONNECTABLE : c'est l'état normal d'un connecteur à clé
     * (« il me manque des identifiants, laissez-moi les saisir »). Le bouton doit
     * donc s'afficher. `needs_approval` et `connected` le ferment.
     */
    expect(canConnect(shopify, 'needs_config')).toBe(true);
    expect(canConnect(shopify, 'not_connected')).toBe(true);
    expect(canConnect(shopify, 'needs_approval')).toBe(false);
    expect(canConnect(shopify, 'connected')).toBe(false);
  });

  it('canConnect est vrai quand un moteur existe et que l’état le permet', () => {
    const avecMoteur = { ...shopify, engine: 'oauth2' as const };
    expect(canConnect(avecMoteur, 'not_connected')).toBe(true);
    expect(canConnect(avecMoteur, 'connected')).toBe(false);
    expect(canConnect(avecMoteur, 'needs_approval')).toBe(false);
  });

  it('summarize compte chaque fiche exactement une fois', () => {
    const s = summarize(INTEGRATIONS, []);
    const total = Object.values(s).reduce((a, b) => a + b, 0);
    expect(total).toBe(INTEGRATIONS.length);
    expect(s.connected).toBe(0);
  });

  it('accountFor retrouve le bon compte et ignore les autres', () => {
    const shopify2 = INTEGRATION_BY_ID.shopify as IntegrationEntry;
    expect(accountFor(shopify2, [compte({ provider: 'shopify' })])?.id).toBe('a1');
    expect(accountFor(shopify2, [compte({ provider: 'gmail' })])).toBeNull();
  });

  it('chaque statut a un libellé français', () => {
    for (const statut of ['connected', 'expired', 'revoked', 'error', 'not_connected', 'needs_config', 'needs_approval', 'unavailable'] as const) {
      expect(STATUS_LABELS[statut].length).toBeGreaterThan(3);
    }
  });

  it('chaque capacité a un libellé lisible', () => {
    for (const entry of INTEGRATIONS) {
      for (const c of entry.capabilities) {
        expect(CAPABILITY_LABELS[c]).toBeTruthy();
      }
    }
  });
});

describe('catalogue — affichage', () => {
  it('affiche le titre et les compteurs de catégorie', async () => {
    monter();
    await waitFor(() => expect(screen.getByText(/Connectez vos outils/i)).toBeTruthy());
    // `getByRole` avec le nom exact du filtre : le libellé apparaît aussi sur
    // les cartes (« Réseaux sociaux » sous le nom du fournisseur).
    expect(screen.getByRole('button', { name: /^Réseaux sociaux \(\d+\)$/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Boutiques en ligne \(\d+\)$/ })).toBeTruthy();
  });

  it('filtre par catégorie au clic', async () => {
    monter();
    // Le nom du fournisseur apparaît dans le titre ET dans sa description :
    // on vise la carte par son identifiant, sinon le sélecteur est ambigu.
    await waitFor(() => expect(screen.getByTestId('integration-shopify')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /^Productivité \(\d+\)$/ }));
    await waitFor(() => {
      expect(screen.queryByTestId('integration-shopify')).toBeNull();
      expect(screen.getByTestId('integration-gmail')).toBeTruthy();
    });
  });

  it('recherche et filtre la grille', async () => {
    monter();
    await waitFor(() => expect(screen.getByTestId('integration-shopify')).toBeTruthy());
    fireEvent.change(screen.getByLabelText(/Rechercher une intégration/i), { target: { value: 'notion' } });
    await waitFor(() => {
      expect(screen.getByTestId('integration-notion')).toBeTruthy();
      expect(screen.queryByTestId('integration-shopify')).toBeNull();
    });
  });

  it('affiche un état honnête, jamais « Connecté » sans compte', async () => {
    monter();
    await waitFor(() => expect(screen.getByTestId('integration-shopify')).toBeTruthy());
    expect(screen.queryByText('Connecté')).toBeNull();
    // Les états attendus sans connecteur ni compte.
    expect(screen.getAllByText(/Configuration requise|Validation externe requise/i).length).toBeGreaterThan(0);
  });

  it('affiche le compte réellement connecté et permet sa révocation', async () => {
    rpc.mockReset();
    rpc.mockImplementation(async (nom: string) => {
      if (nom === 'oauth_list_accounts') return { data: [ligneBase()], error: null };
      if (nom === 'oauth_audit_list') return { data: [], error: null };
      return { data: null, error: null };
    });
    monter();
    await waitFor(() => expect(screen.getAllByText(/Awa Diango/i).length).toBeGreaterThan(0));
    expect(screen.getByText(/Vos connexions actives/i)).toBeTruthy();

    // La révocation demande confirmation.
    fireEvent.click(screen.getByRole('button', { name: /Révoquer/i }));
    await waitFor(() => expect(screen.getByText(/Révoquer cette connexion/i)).toBeTruthy());
  });

  it('affiche l’erreur et n’invente aucun état si la lecture échoue', async () => {
    rpc.mockReset();
    rpc.mockImplementation(async () => ({ data: null, error: { message: 'permission denied' } }));
    monter();
    await waitFor(() => expect(screen.getByText(/Impossible de lire vos connexions/i)).toBeTruthy());
    expect(screen.queryByText('Connecté')).toBeNull();
    expect(screen.queryByText(/Vos connexions actives/i)).toBeNull();
  });

  it('ouvre la fiche détaillée avec capacités et permissions', async () => {
    monter();
    await waitFor(() => expect(screen.getByTestId('integration-shopify')).toBeTruthy());
    fireEvent.click(screen.getByTestId('integration-shopify'));
    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: /Fiche Shopify/i })).toBeTruthy();
    });
    // Ces titres existent aussi sur les cartes de la grille encore montee.
    expect(screen.getAllByText(/Ce que la connexion permettra/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Connexion et permissions/i).length).toBeGreaterThan(0);
  });

  it('la fiche explique ce qu’il faut avant de connecter', async () => {
    monter();
    await waitFor(() => expect(screen.getByTestId('integration-instagram')).toBeTruthy());
    fireEvent.click(screen.getByTestId('integration-instagram'));
    await waitFor(() => expect(screen.getByRole('dialog', { name: /Fiche Instagram/i })).toBeTruthy());
    /*
     * Instagram a désormais un moteur (`meta-connect`) : la fiche n'affiche
     * plus « validation externe requise » mais la revue Meta à passer ET
     * l'état réel du serveur — ici « non configuré », puisque la preview refuse
     * l'appel. Ce qui doit rester vrai : aucun bouton ne promet une connexion
     * déjà faite, et l'approbation Meta est annoncée.
     */
    expect(screen.getByText(/App Review Meta/i)).toBeTruthy();
  });
});

/**
 * Phase B — les capacités affichées doivent correspondre au code qui existe.
 *
 * Le défaut corrigé : Shopify et WooCommerce annonçaient `catalog-write`,
 * `inventory-write` et `orders-read`. Aucune ligne ne les implémente, aucun
 * parcours d'authentification n'existe (`engine: null`) et la sortie réseau des
 * Edge Functions refuse toute méthode autre que GET. OpenCart annonçait
 * `orders-read` alors que son API cœur n'expose même pas les produits.
 */
describe('catalogue — capacités réellement implémentées', () => {
  const entrees = (id: string) => INTEGRATION_BY_ID[id] as IntegrationEntry;

  /*
   * Périmètre : les boutiques. Les connecteurs hors commerce (OAuth social et
   * productivité) déclarent encore des écritures sans moteur — écart réel,
   * distinct, qui ne relève pas de cette mission et qui est consigné dans
   * `docs/audit-connexions-boutiques.md`. Le test est volontairement borné
   * plutôt que d'être affaibli pour tout le catalogue.
   */
  it('aucune boutique sans moteur ne déclare de capacité d’écriture', () => {
    for (const entry of INTEGRATIONS) {
      if (entry.category !== 'commerce' || entry.engine !== null) continue;
      const ecritures = entry.capabilities.filter((c) => /write/.test(c));
      expect(ecritures, `${entry.id} déclare ${ecritures.join(',')} sans moteur`).toEqual([]);
    }
  });

  it('Shopify et WooCommerce n’annoncent que ce que store-import lit', () => {
    for (const id of ['shopify', 'woocommerce']) {
      expect(entrees(id).capabilities.sort(), id).toEqual(['catalog-read', 'inventory-read']);
      /*
       * `engine: 'api-key'` depuis la phase E : un parcours de connexion
       * authentifié existe réellement, avec vérification de la clé côté serveur
       * et lecture par l'API officielle. Aucune écriture n'est annoncée — les
       * capacités d'écriture n'existent même pas dans le type.
       */
      expect(entrees(id).engine, id).toBe('api-key');
    }
  });

  it('les deux connecteurs implémentés ne promettent pas d’écriture', () => {
    for (const id of ['prestashop', 'chariow']) {
      const entry = entrees(id);
      expect(entry.engine, id).toBe('api-key');
      expect(entry.capabilities, id).toEqual(expect.arrayContaining(['catalog-read']));
      expect(entry.capabilities.some((c) => /write/.test(c)), id).toBe(false);
    }
  });

  it('OpenCart ne prétend ni catalogue ni commandes par API', () => {
    const opencart = entrees('opencart');
    // L'API cœur est à session et n'expose pas les produits : déclarer
    // `catalog-read` enverrait l'utilisateur chercher une clé inutile.
    expect(opencart.capabilities).toEqual([]);
    expect(opencart.engine).toBeNull();
    expect(opencart.caveat ?? '').toMatch(/session|export/i);
    // L'export reste proposé : c'est le seul chemin réel.
    expect(opencart.auth.some((a) => a.mode === 'file-import')).toBe(true);
  });

  it('Shopify et WooCommerce disent qu’ils sont en LECTURE SEULE', () => {
    for (const id of ['shopify', 'woocommerce']) {
      const caveat = entrees(id).caveat ?? '';
      expect(caveat, id).toMatch(/lecture seule/i);
      // Et rappellent qu'aucune commande n'est lue : ce sont des données
      // personnelles d'acheteurs, hors périmètre.
      if (id === 'woocommerce') expect(caveat).toMatch(/commande/i);
    }
  });
});

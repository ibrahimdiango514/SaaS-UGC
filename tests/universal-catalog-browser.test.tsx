// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { UniversalCatalogBrowser } from '../src/pages/admin/UniversalCatalogBrowser';
import { getUniversalAdminModelDetail, getUniversalAdminModels, getUniversalCatalogSummary } from '../src/lib/api';
vi.mock('../src/lib/api', () => ({ universalRuntime:vi.fn(async()=>({config:null,plans:['pro'],limits:{enabled:false,daily_usd:0},assessment:{operational:false,blockers:['PAID_VALIDATION_PENDING']}})), getUniversalAdminModelDetail:vi.fn(), getUniversalAdminModels:vi.fn(), getUniversalCatalogSummary:vi.fn() }));
vi.mock('../src/pages/admin/UniversalIntegrationProgress',()=>({UniversalIntegrationProgress:()=>null}));
const model={provider_model_id:'model-a',provider_key:'muapi',display_name:'Modèle A',category:'Text to Text',public_catalog_present:true,account_access:'unverified',integration_status:'catalog_only',studio_enabled:false,adapter_key:null,detail_status:'ok',detail_http_status:200};
afterEach(() => { cleanup(); vi.resetAllMocks(); });
describe('explorateur admin universel', () => {
  it('charge les pages, applique les filtres et explique les preuves disponibles', async () => {
    vi.mocked(getUniversalCatalogSummary).mockResolvedValue({models:861,details_ok:861,detail_errors:0,enabled:0,last_sync:null,categories:{'Text to Text':168}});
    vi.mocked(getUniversalAdminModels).mockImplementation(async args => args.after ? {total:861,items:[{...model,provider_model_id:'model-b',display_name:'Modèle B'}],next_cursor:null} : {total:861,items:[model],next_cursor:'model-a'});
    vi.mocked(getUniversalAdminModelDetail).mockResolvedValue({...model,description:null,input_fields:['prompt'],required_fields:['prompt'],input_schema:{schemas:{input_data:{type:'object',properties:{prompt:{type:'string',title:'Prompt'}},required:['prompt']}}},output_schema:null,metadata:{},provider_enabled:true,coming_soon:false,detail_checked_at:null,recent_changes:[{id:1,change_type:'added',created_at:'2026-01-01'}]});
    render(<UniversalCatalogBrowser />);
    fireEvent.click(await screen.findByRole('button',{name:/Modèle A/}));
    await screen.findByRole('region',{name:'Fiche du modèle'});
    expect(screen.getByText(/Aperçu des paramètres du schéma/)).toBeTruthy();
    expect(screen.getByText(/cet aperçu n’est pas un formulaire de génération validé/)).toBeTruthy();
    expect(screen.getByText(/coût interne et marge : non enregistrés/)).toBeTruthy();
    expect(screen.getByText(/non renseignée — adaptation non établie/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'Page suivante'}));
    await screen.findByRole('button',{name:/Modèle B/});
    expect(vi.mocked(getUniversalAdminModels).mock.calls.at(-1)?.[0].after).toBe('model-a');
    fireEvent.change(screen.getByLabelText('Rechercher un modèle'),{target:{value:'prompt'}});
    fireEvent.click(screen.getByRole('button',{name:'Rechercher'}));
    await waitFor(() => expect(vi.mocked(getUniversalAdminModels).mock.calls.at(-1)?.[0]).toMatchObject({query:'prompt',after:''}));
    fireEvent.change(screen.getByLabelText('Catégorie'),{target:{value:'Text to Text'}});
    await waitFor(() => expect(vi.mocked(getUniversalAdminModels).mock.calls.at(-1)?.[0].category).toBe('Text to Text'));
  });
  it('affiche les erreurs sans prétendre que le registre est vide', async () => {
    vi.mocked(getUniversalAdminModels).mockRejectedValue(new Error('forbidden'));
    vi.mocked(getUniversalCatalogSummary).mockRejectedValue(new Error('forbidden'));
    render(<UniversalCatalogBrowser />);
    expect((await screen.findByRole('alert')).textContent).toContain('droits nécessaires');
    expect(screen.queryByText('Aucun modèle pour ces filtres.')).toBeNull();
  });
});

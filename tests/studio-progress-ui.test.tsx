// @vitest-environment jsdom
import {it,expect,vi,afterEach} from 'vitest';
import {render,screen,fireEvent,waitFor,cleanup} from '@testing-library/react';
import {UniversalIntegrationProgress} from '../src/pages/admin/UniversalIntegrationProgress';
import {universalRuntime} from '../src/lib/api';
vi.mock('../src/lib/api',()=>({universalRuntime:vi.fn()}));
afterEach(()=>{cleanup();vi.resetAllMocks();});
it('shows persisted simulated progress without claiming operational availability',async()=>{
 vi.mocked(universalRuntime).mockResolvedValue({counts:{total:861,assessed:861,prepared:10,technical_tests:10},families:{'text-to-image':85},items:[{provider_model_id:'example',display_name:'Example',family:'text-to-image',status:'integration_prepared',protocol:'muapi_output_urls_v1',stages:{technical_test_succeeded:true,real_test_pending:true},operational:false,enabled:false,blockers:['REAL_TEST_PENDING']}]});
 render(<UniversalIntegrationProgress/>);
 await screen.findByText(/861 modèles/);expect(screen.getByText(/10 intégrations préparées/)).toBeTruthy();
 expect(screen.getByText(/Intégration préparée, test réel en attente/)).toBeTruthy();
 fireEvent.change(screen.getByLabelText('Famille'),{target:{value:'text-to-image'}});
 await waitFor(()=>expect(vi.mocked(universalRuntime).mock.calls.at(-1)?.[1]).toMatchObject({family:'text-to-image',after:''}));
});
it('handles permission or malformed response failures without crashing',async()=>{
 vi.mocked(universalRuntime).mockResolvedValue({});render(<UniversalIntegrationProgress/>);
 expect(await screen.findByRole('alert')).toBeTruthy();
});

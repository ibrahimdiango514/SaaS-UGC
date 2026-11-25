// @vitest-environment jsdom
import {it,expect,vi,afterEach} from 'vitest';
import {render,screen,cleanup,fireEvent} from '@testing-library/react';
import UniversalStudio from '../src/studio/UniversalStudio';
vi.mock('../src/studio/components/StudioShell',()=>({StudioShell:({children}:{children:unknown})=><div>{children as any}</div>}));
vi.mock('../src/lib/api',()=>({uploadUniversalInput:vi.fn(),universalRuntime:vi.fn(async(action:string)=>action==='history'?{jobs:[]}:{total:2,categories:{},credits:10,workspace_id:'workspace',next_cursor:null,items:[{model_id:'blocked',display_name:'Not validated',category:'Image',operational:false,credits:null,blockers:['PAID_VALIDATION_PENDING'],schema:null},{model_id:'ready',display_name:'Validated model',category:'Image',operational:true,credits:4,blockers:[],schema:null}]})}));
afterEach(cleanup);
it('keeps an unverified reference visible with its exact reason but never offers a generation',async()=>{
 render(<UniversalStudio/>);await screen.findByRole('button',{name:/Validated model/});
 const blocked=screen.getByRole('button',{name:/Not validated/});
 expect(screen.getByText(/2 modèles catalogués/)).toBeTruthy();
 expect(blocked.textContent).toContain('Non disponible');
 fireEvent.click(blocked);
 expect(screen.getAllByText(/Validation réelle en attente d’autorisation financière/).length).toBeGreaterThan(0);
 expect(screen.queryByRole('button',{name:/Obtenir le prix en crédits/})).toBeNull();
});

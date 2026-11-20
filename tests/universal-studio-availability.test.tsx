// @vitest-environment jsdom
import {it,expect,vi,afterEach} from 'vitest';
import {render,screen,cleanup} from '@testing-library/react';
import UniversalStudio from '../src/studio/UniversalStudio';
vi.mock('../src/studio/components/StudioShell',()=>({StudioShell:({children}:{children:unknown})=><div>{children as any}</div>}));
vi.mock('../src/lib/api',()=>({uploadUniversalInput:vi.fn(),universalRuntime:vi.fn(async(action:string)=>action==='history'?{jobs:[]}:{total:2,categories:{},credits:10,workspace_id:'workspace',next_cursor:null,items:[{model_id:'blocked',display_name:'Not validated',category:'Image',operational:false,credits:null,blockers:['PAID_VALIDATION_PENDING'],schema:null},{model_id:'ready',display_name:'Validated model',category:'Image',operational:true,credits:4,blockers:[],schema:null}]})}));
afterEach(cleanup);
it('does not offer a generation card for an unverified catalog reference',async()=>{
 render(<UniversalStudio/>);await screen.findByRole('button',{name:/Validated model/});
 expect(screen.queryByRole('button',{name:/Not validated/})).toBeNull();
 expect(screen.getByText(/2 modèles catalogués/)).toBeTruthy();
});

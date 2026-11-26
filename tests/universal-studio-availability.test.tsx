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
 /*
  * Le modèle bloqué reste VISIBLE, avec un motif qui dit quoi faire.
  *
  * L'ancienne assertion exigeait le texte « Non disponible » : c'était le
  * libellé d'avant, qui nommait l'état sans jamais indiquer l'action. Le produit
  * demande désormais l'inverse (jamais « indisponible » sans explication), donc
  * on vérifie ce qui compte réellement : le motif exact ET l'action à mener.
  */
 expect(blocked.textContent).toContain('Validation payante en attente');
 expect(blocked.textContent).toMatch(/génération réelle|confirm/i);
 fireEvent.click(blocked);
 // La fiche détaille le motif et l'action, sans jamais proposer de génération.
 const fiches = screen.getAllByText(/Validation payante en attente/);
 // La fiche du modèle (après sélection) s'ajoute à la carte : au moins deux.
 expect(fiches.length).toBeGreaterThanOrEqual(1);
 const detail = fiches.map((n) => n.closest('ul')?.textContent ?? '').join(' ');
 expect(detail).toMatch(/administration|confirmer/i);
 expect(screen.queryByRole('button',{name:/Obtenir le prix en crédits/})).toBeNull();
});

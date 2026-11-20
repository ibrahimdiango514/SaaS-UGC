// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { UniversalModelForm } from '../src/pages/admin/UniversalModelForm';
import { validateUniversalModelInput } from '../src/lib/api';
vi.mock('../src/lib/api', () => ({validateUniversalModelInput:vi.fn()}));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
it('builds typed parameters and validates them server-side, without generation', async () => {
  vi.mocked(validateUniversalModelInput).mockResolvedValue({validation:{ok:true,fields:['prompt','steps','enabled']},endpoint:{status:'declared',path:'x',url:'https://api.muapi.ai/api/v1/x',differs:false},mode:'validation_only',executable:false});
  const schema={schemas:{input_data:{type:'object',properties:{prompt:{type:'text',title:'Instruction'},steps:{type:'int',title:'Steps',default:4,minValue:1,maxValue:8,step:1},enabled:{type:'boolean',title:'Enabled'}},required:['prompt']}}};
  render(<UniversalModelForm modelId="x" schema={schema} />);
  fireEvent.change(screen.getByLabelText('Instruction *'),{target:{value:'Hello'}});
  fireEvent.change(screen.getByLabelText('Enabled'),{target:{value:'false'}});
  fireEvent.click(screen.getByRole('button',{name:'Valider les paramètres côté serveur'}));
  await screen.findByText(/Paramètres validés par le serveur/);
  expect(validateUniversalModelInput).toHaveBeenCalledWith('x',{prompt:'Hello',steps:4,enabled:false});
});
it('does not silently omit unsupported constraints', () => {
  render(<UniversalModelForm modelId="x" schema={{schemas:{input_data:{type:'object',properties:{images:{type:'array',conditionalMaxItems:{},items:{type:'string'}}}}}}} />);
  expect(screen.getByRole('status').textContent).toContain('Formulaire bloqué');
  expect(screen.queryByRole('button')).toBeNull();
});
it('renders structured dialogue fields and submits wire values without a manual JSON document',async()=>{
 const onSubmit=vi.fn().mockResolvedValue('Devis prêt');
 const schema={schemas:{input_data:{type:'object',properties:{dialogue:{type:'array',title:'Dialogue',items:{type:'object',required:['text','voice'],properties:{text:{type:'string',title:'Speech'},voice:{type:'string',title:'Voice',enum:[{label:'Official voice',value:'voice-id'}]}}}}}}}};
 render(<UniversalModelForm modelId="dialogue" schema={schema} onSubmit={onSubmit}/>);
 fireEvent.click(screen.getByRole('button',{name:'Ajouter un élément'}));
 fireEvent.change(screen.getByLabelText('Speech *'),{target:{value:'Bonjour'}});
 fireEvent.change(screen.getByLabelText('Voice *'),{target:{value:'voice-id'}});
 fireEvent.click(screen.getByRole('button',{name:'Obtenir le prix en crédits'}));
 await screen.findByText('Devis prêt');expect(onSubmit).toHaveBeenCalledWith({dialogue:[{text:'Bonjour',voice:'voice-id'}]});
});
it('omits null provider defaults rather than sending the literal string null',async()=>{
 const onSubmit=vi.fn().mockResolvedValue('Devis prêt');
 render(<UniversalModelForm modelId="tts" schema={{schemas:{input_data:{type:'object',properties:{language:{type:'string',default:null}}}}}} onSubmit={onSubmit}/>);
 fireEvent.click(screen.getByRole('button',{name:'Obtenir le prix en crédits'}));await screen.findByText('Devis prêt');expect(onSubmit).toHaveBeenCalledWith({});
});

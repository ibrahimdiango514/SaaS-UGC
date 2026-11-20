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

// @vitest-environment jsdom
import {it,expect,vi,afterEach} from 'vitest';
import {render,screen,cleanup} from '@testing-library/react';
import {SchemaValueInput} from '../src/pages/admin/SchemaValueInput';
import {UniversalModelForm} from '../src/pages/admin/UniversalModelForm';

/**
 * Incrément 17 : un champ déclaré « public URL » par le fournisseur doit être
 * saisi comme un lien HTTPS, jamais proposé comme import privé. Un champ média
 * ordinaire garde son import privé.
 */
afterEach(cleanup);

it('accepts a declared public link as text and never offers a private upload', () => {
  render(<SchemaValueInput id="zip" definition={{ type: 'string', field: 'zip', title: 'Images Zip URL', description: 'Public URL to a .zip archive containing 10-50 training images.' }} value="" onChange={() => {}} upload={vi.fn()} />);
  expect(screen.queryByText(/Importer un fichier privé/)).toBeNull();
  expect(screen.getByPlaceholderText(/Lien HTTPS public/)).toBeTruthy();
});

it('keeps the private upload for an ordinary media field', () => {
  render(<SchemaValueInput id="image" definition={{ type: 'string', field: 'image', title: 'Image' }} value="" onChange={() => {}} upload={vi.fn()} />);
  expect(screen.getByText(/Importer un fichier privé/)).toBeTruthy();
});

it('never offers a private upload for a declared public link in the generation form', () => {
  const schema = { schemas: { input_data: { type: 'object', endpoint_url: 'flux-lora-trainer', properties: {
    images_data_url: { type: 'string', field: 'zip', title: 'Images Zip URL', description: 'Public URL to a .zip archive containing 10-50 training images.' },
    trigger_phrase: { type: 'string', title: 'Trigger Phrase' },
  }, required: ['images_data_url'] } } };
  render(<UniversalModelForm modelId="flux-lora-trainer" schema={schema} upload={vi.fn()} onSubmit={vi.fn()} />);
  expect(screen.queryByText(/Importer un fichier privé/)).toBeNull();
  expect(screen.getByPlaceholderText(/Lien HTTPS public/)).toBeTruthy();
});

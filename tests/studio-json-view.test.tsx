// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach } from 'vitest';
import { describe, expect, it } from 'vitest';
import { JsonResult, isJsonDocument } from '../src/studio/components/JsonResult';

/**
 * Affichage d'un résultat de donnée : lisible, et surtout incapable d'injecter
 * du HTML ou du JavaScript. React n'émet que des nœuds texte.
 */

afterEach(cleanup);

describe('affichage d’un résultat JSON', () => {
  it('affiche une donnée imbriquée sans créer de HTML', () => {
    const value = JSON.stringify({ score: 0.91, tags: ['seo', 'audit'], nested: { ok: true, count: 3 } });
    const { container } = render(<JsonResult value={value} />);
    expect(screen.getByText(/score/)).toBeTruthy();
    expect(screen.getByText('0.91')).toBeTruthy();
    expect(screen.getByText('seo')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
  });

  it('neutralise un script ou un gestionnaire injecté dans une chaîne', () => {
    const hostile = JSON.stringify({ title: '<img src=x onerror="alert(1)">', body: '<script>alert(1)</script>' });
    const { container } = render(<JsonResult value={hostile} />);
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText(/<script>alert\(1\)<\/script>/)).toBeTruthy();
    expect(screen.getByText(/onerror="alert\(1\)"/)).toBeTruthy();
  });

  it('borne l’affichage d’un tableau très long', () => {
    const value = JSON.stringify({ items: Array.from({ length: 150 }, (_, index) => index) });
    render(<JsonResult value={value} />);
    expect(screen.getByText(/50 élément\(s\) supplémentaires non affichés/)).toBeTruthy();
  });

  it('borne une chaîne très longue et un texte non JSON', () => {
    const long = JSON.stringify({ text: 'a'.repeat(5000) });
    render(<JsonResult value={long} />);
    expect(screen.getByText(/5000 caractères/)).toBeTruthy();
    const { container } = render(<JsonResult value="<script>alert(1)</script>" />);
    expect(container.querySelector('pre')?.textContent).toBe('<script>alert(1)</script>');
    expect(container.querySelector('script')).toBeNull();
  });

  it('ne reconnaît comme document JSON qu’un objet ou un tableau réel', () => {
    expect(isJsonDocument('{"a":1}')).toBe(true);
    expect(isJsonDocument(' [1,2] ')).toBe(true);
    expect(isJsonDocument('42')).toBe(false);
    expect(isJsonDocument('"texte"')).toBe(false);
    expect(isJsonDocument('{invalide')).toBe(false);
    expect(isJsonDocument('<script>alert(1)</script>')).toBe(false);
  });
});

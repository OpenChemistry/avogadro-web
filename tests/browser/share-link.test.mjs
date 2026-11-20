// SPDX-License-Identifier: BSD-3-Clause
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { createShareLink, decodeSnapshot, parseStartupLink } from '../../web/editor/share-link.js';

const page = new URL('https://editor.example/index.html?ref=lesson#old');
const state = {
  tools: [{ id: 'navigate', label: 'Navigate' }, { id: 'MeasureTool', label: 'Measure' },
    { id: 'draw', label: 'Draw' }, { id: 'AutoOpt', label: 'Optimize' }],
  displayStyles: [{ id: 'VanDerWaals', label: 'Van der Waals' }],
};
const parse = suffix => parseStartupLink(new URL(suffix, page.origin), state);

test('Parse a molecule source and validated presentation settings', () => {
  assert.deepEqual(parse('?pdb=1CRN&mode=view&theme=light&tool=measure&style=sphere'), {
    source: { kind: 'pdb', value: '1CRN', format: undefined }, mode: 'view', theme: 'light',
    tool: 'MeasureTool', style: 'VanDerWaals',
  });
  assert.equal(parse('?url=https%3A%2F%2Feditor.example%2Ffile&type=sdf').source.format, 'sdf');
  assert.equal(parse('?mode=view').tool, 'navigate');
  assert.equal(parse('#about'), null);
});

test('Reject duplicate, conflicting and invalid settings', () => {
  for (const [query, error] of [
    ['?pdb=1CRN&cid=2519', /one molecule source/], ['?cid=2519#cid=42', /more than once/],
    ['?cid=2519#cjson=1.abc', /one molecule source/], ['?name=caffeine&type=sdf', /requires a file URL/],
    ['?theme=dark&theme=light', /more than once/], ['?theme=ultraviolet', /theme/],
    ['?tool=does-not-exist', /unavailable tool/], ['?mode=view&tool=draw', /View mode/],
    ['?mode=present', /edit or view/], ['?tool=autoopt', /Optimize/],
    ['?style=constructor', /unavailable display style/], ['?name=%gg', /URL encoding/],
    ['?name=%FF', /invalid name/], ['?name=', /invalid name/],
    [`#name=${'x'.repeat(8192)}`, /too long/],
  ]) assert.throws(() => parse(query), error);
});

test('Round-trip private fragments with bounds for transport and decompression', async () => {
  const text = JSON.stringify({ name: 'Café', atoms: { elements: { number: [6] } } });
  const link = new URL(await createShareLink(page, 'edit', { text }));
  assert.equal(link.search, '');
  assert.equal(await decodeSnapshot(parseStartupLink(link, state).source.value), text);
  const source = { kind: 'smiles', value: 'C/C=C\\C#N' };
  const sourceLink = new URL(await createShareLink(page, 'view', { source, text }));
  assert.equal(sourceLink.search, '');
  assert.deepEqual(parseStartupLink(sourceLink, state).source, { ...source, format: undefined });
  assert.equal(parseStartupLink(sourceLink, state).mode, 'view');
  assert.equal(await createShareLink(page, 'edit', { text: 'A'.repeat(1024 * 1024 + 1) }), null);
  const tooBig = gzipSync('A'.repeat(1024 * 1024 + 1)).toString('base64url');
  await assert.rejects(decodeSnapshot(`1.${tooBig}`), /exceeds 1 MiB/);
  await assert.rejects(decodeSnapshot('2.garbage'), /invalid format/);
  await assert.rejects(decodeSnapshot('1.garbage'));
});

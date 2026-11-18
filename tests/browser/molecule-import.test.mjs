// SPDX-License-Identifier: BSD-3-Clause
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchMolecule, maxImportBytes, prepareImport } from '../../web/editor/molecule-import.js';

const page = new URL('https://editor.example');
const resolve = (kind, value, format) => prepareImport({ kind, value, format }, page);

test('Resolve curated molecule sources and preserve SMILES metacharacters', () => {
  assert.equal(resolve('name', 'sodium chloride').url.href,
    'https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/sodium%20chloride/SDF?record_type=3d');
  assert.equal(resolve('cid', '2519').url.pathname, '/rest/pug/compound/cid/2519/SDF');
  const smiles = 'C/C=C\\C#N';
  const request = resolve('smiles', smiles);
  assert.equal(request.url.pathname, '/rest/pug/compound/smiles/SDF');
  assert.equal(request.url.searchParams.get('record_type'), '3d');
  assert.equal(request.body.get('smiles'), smiles);
  const inchi = resolve('inchi', 'InChI=1S/H2O/h1H2');
  assert.equal(inchi.url.pathname, '/rest/pug/compound/inchi/SDF');
  assert.equal(inchi.url.searchParams.get('record_type'), '3d');
  assert.equal(inchi.body.get('inchi'), 'InChI=1S/H2O/h1H2');
  assert.throws(() => resolve('inchi', 'InChIKey:INVALID'), /complete InChI/);
  assert.equal(resolve('pdb', '1crn').url.href, 'https://files.rcsb.org/download/1CRN.pdb');
  assert.throws(() => resolve('cid', '0'), /positive/);
  assert.throws(() => resolve('pdb', '../../1CRN'), /four-character/);
  assert.throws(() => resolve('name', '..'), /chemical name/);
});

test('Approve HTTPS URLs by exact origin and supported format', () => {
  assert.equal(resolve('url', 'https://editor.example/sample.XYZ?token=x').format, 'xyz');
  assert.equal(resolve('url', 'https://editor.example/download', 'sdf').format, 'sdf');
  assert.throws(() => resolve('url', 'http://editor.example/sample.xyz'), /HTTPS/);
  assert.throws(() => resolve('url', 'https://user:secret@editor.example/sample.xyz'), /credentials/);
  assert.throws(() => resolve('url', 'https://editor.example:9000/sample.xyz'), /approved/);
  assert.throws(() => resolve('url', 'https://files.rcsb.org.example/sample.pdb'), /approved/);
  assert.throws(() => resolve('url', 'https://editor.example/sample.txt'), /format/);
  assert.throws(() => prepareImport({ kind: 'pdb', value: '1CRN' }, new URL('file:///offline.html')), /HTTPS/);
});

test('Fetch with privacy controls and report missing 3D or over-limit streams', async t => {
  const request = resolve('smiles', 'CC');
  const controller = new AbortController();
  t.mock.method(globalThis, 'fetch', (_, options) => {
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.referrerPolicy, 'no-referrer');
    assert.equal(options.signal, controller.signal);
    assert.equal(options.method, 'POST');
    assert.equal(options.body.get('smiles'), 'CC');
    return new Response('3D SDF fixture');
  });
  assert.equal((await fetchMolecule(request, controller.signal)).text, '3D SDF fixture');
  t.mock.restoreAll();

  t.mock.method(globalThis, 'fetch', () => new Response('No record', { status: 404 }));
  await assert.rejects(fetchMolecule(request), /no matching structure with 3D coordinates/);
  t.mock.restoreAll();

  let bodyCancelled = false;
  const chunk = new Uint8Array(maxImportBytes / 4);
  const body = new ReadableStream({
    pull(stream) { stream.enqueue(chunk); },
    cancel() { bodyCancelled = true; },
  });
  t.mock.method(globalThis, 'fetch', () => new Response(body));
  await assert.rejects(fetchMolecule(request), /32 MiB/);
  assert.equal(bodyCancelled, true);
  controller.abort();
  await assert.rejects(fetchMolecule(request, controller.signal), { name: 'AbortError' });
});

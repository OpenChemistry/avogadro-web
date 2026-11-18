// SPDX-License-Identifier: BSD-3-Clause
// Run: node molecule-import-smoke.mjs STAGED_SINGLE_THREAD_PACKAGE
import assert from 'node:assert/strict';
import { openFixture, origin, pubchem, sdf, xyz } from './fixtures/https-editor.mjs';

const noRecord = `${pubchem}/cid/999/SDF?record_type=3d`;
const caffeine = `${pubchem}/name/caffeine/SDF?record_type=3d`;
const smiles = `${pubchem}/smiles/SDF?record_type=3d`;
const pdb = 'https://files.rcsb.org/download/1CRN.pdb';
const remoteXYZ = `${origin}/helium.xyz`;
const redirect = `${origin}/redirect.xyz`;
const slow = `${origin}/slow.xyz`;
const requests = [];
const observed = Promise.withResolvers();
const release = Promise.withResolvers();
const slowResponded = Promise.withResolvers();
const fixtures = new Map([
  [caffeine, { body: sdf }],
  [smiles, { body: sdf }],
  [noRecord, { status: 404 }],
  [pdb, { body: 'HETATM    1  O   HOH A   1       0.000   0.000   0.000  1.00  0.00           O  \nEND\n' }],
  [remoteXYZ, { body: xyz }],
  [redirect, { status: 302, headers: { location: remoteXYZ } }],
  [slow, { body: '2\nHydrogen\nH 0 0 0\nH 0 0 1\n' }],
]);
const routes = new Map([...fixtures].map(([url, fixture]) => [url, async (request, respond) => {
  requests.push({ url, body: request.postData(), method: request.method(), headers: request.headers() });
  if (url === slow) {
    observed.resolve();
    await release.promise;
    // Chromium may cancel the intercepted request before we deliver this fixture.
    try { await respond({ status: 200, ...fixture }); } catch (error) {
      if (!/Invalid InterceptionId/.test(error.message)) throw error;
    } finally { slowResponded.resolve(); }
    return;
  }
  await respond({ status: 200, ...fixture });
}]));

const { browser, page, go, waitText, requestErrors, violations } = await openFixture(process.argv[2], routes);
async function submit(kind, value) {
  await page.click('#lookup');
  await page.select('#lookup-kind', kind);
  await page.$eval('#lookup-value', (input, value) => { input.value = value; }, value);
  await page.click('#lookup-form [type="submit"]');
}
async function drop() {
  await page.evaluate(xyz => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File([xyz], 'local.xyz'));
    document.getElementById('viewport').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
  }, xyz);
}
try {
  await go();
  await page.click('#lookup');
  await waitText('lookup-privacy', 'PubChem');
  assert.equal(requests.length, 0);
  await page.click('#close-lookup');
  await submit('name', 'caffeine');
  await waitText('document-name', 'PubChem structure.sdf');
  await waitText('counts', '1 atoms');
  assert.ok(!requests[0].headers.referer);
  assert.ok(!requests[0].headers.cookie);

  await submit('smiles', 'C/C=C\\C#N');
  await waitText('status', 'Molecule opened.');
  assert.equal(requests[1].method, 'POST');
  assert.equal(new URLSearchParams(requests[1].body).get('smiles'), 'C/C=C\\C#N');

  await submit('pdb', '1crn');
  await waitText('document-name', '1CRN.pdb');
  await submit('cid', '999');
  await waitText('status', 'no matching structure with 3D coordinates');
  await waitText('document-name', '1CRN.pdb');
  await submit('url', redirect);
  await waitText('status', 'whether the URL redirects');
  assert.ok(requests.every(request => request.url !== remoteXYZ));

  await submit('url', 'https://unapproved.example/helium.xyz');
  await waitText('lookup-error', 'outside the approved origins');
  await page.click('#close-lookup');
  await submit('url', remoteXYZ);
  await waitText('document-name', 'helium.xyz');

  await submit('url', slow);
  await observed.promise;
  await page.click('#cancel-lookup');
  await waitText('status', 'Lookup cancelled');
  await drop();
  await waitText('document-name', 'local.xyz');
  release.resolve();
  await slowResponded.promise;
  await waitText('document-name', 'local.xyz');

  await page.click('#new');
  await waitText('document-name', 'Untitled');
  await page.click('#viewport');
  await waitText('document-state', 'Unsaved changes');
  await submit('name', 'caffeine');
  await page.waitForSelector('#discard-dialog[open]');
  await page.click('#discard-dialog [value="cancel"]');
  await waitText('status', 'Lookup cancelled');
  await waitText('document-state', 'Unsaved changes');
  await drop();
  await page.waitForSelector('#discard-dialog[open]');
  await page.click('#discard-dialog [value="discard"]');
  await waitText('document-name', 'local.xyz');
  await waitText('document-state', 'Molecule ready');

  assert.deepEqual(await page.evaluate(() => window.cspViolations), []);
  assert.deepEqual(requestErrors, []);
  assert.deepEqual(violations, []);
  console.log('Lookup disclosure, PubChem 3D, PDB, URL policy, cancellation, unsaved changes and local drop passed.');
} finally {
  release.resolve();
  await browser.close();
}

// SPDX-License-Identifier: BSD-3-Clause
// Run with the staged single-threaded package. All network responses are fixtures.
import assert from 'node:assert/strict';
import { openFixture, origin, pubchem, sdf, xyz } from './fixtures/https-editor.mjs';

let requests = 0;
const url = origin + '/helium.xyz';
const routes = new Map([[url, async (_request, respond) => {
  ++requests;
  await respond({ status: 200, body: xyz });
}]]);
const identifiers = [];
for (const kind of ['smiles', 'inchi']) {
  routes.set(`${pubchem}/${kind}/SDF?record_type=3d`, async (request, respond) => {
    identifiers.push([kind, new URLSearchParams(request.postData()).get(kind)]);
    await respond({ status: 200, body: sdf });
  });
}
const threaded = process.argv.includes('--threaded');
const { browser, page, go, violations, requestErrors } = await openFixture(process.argv[2], routes,
  ['--enable-features=WebMCP,WebMCPTesting'], threaded);
const run = (name, input = {}) => page.evaluate(async (name, input) => {
  const context = document.modelContext ?? navigator.modelContext;
  const item = (await context.getTools()).find(item => item.name === name);
  const result = await context.executeTool(item, input);
  return typeof result === 'string' ? JSON.parse(result) : result;
}, name, input);
async function decide(approve) {
  await page.waitForSelector('#agent-dialog[open]');
  await page.click(approve ? '#agent-approve' : '#agent-deny');
}
try {
  await go();
  await page.waitForFunction(async () => (await document.modelContext.getTools()).some(t => t.name === 'run_molecule_action'));
  assert.deepEqual((await run('inspect_molecule')).atoms, []);
  assert.match((await run('edit_molecule', { operation: 'undo' })).error, /Enable/);
  await page.click('#allow-agent-edits');
  const input = { format: 'xyz', text: xyz };
  const cancelled = run('load_molecule', input);
  await decide(false);
  assert.match((await cancelled).error, /cancel/i);
  assert.equal((await run('inspect_molecule')).atomCount, 0);
  const accepted = run('load_molecule', input);
  await decide(true);
  assert.equal((await accepted).ok, true);
  assert.equal((await run('inspect_molecule')).atoms[0].atomicNumber, 2);
  assert.match((await run('run_molecule_action', { id: 'unknown' })).error, /Unavailable/);
  assert.equal((await run('set_editor_tool', { id: 'select' })).ok, true);
  assert.equal((await run('set_editor_theme', { theme: 'light' })).ok, true);
  assert.equal(await page.$eval('html', html => html.dataset.theme), 'light');
  const capture = await run('capture_viewport');
  assert.equal(capture.mimeType, 'image/png');
  assert.ok(capture.width > 0 && capture.height > 0 && Math.max(capture.width, capture.height) <= 1024);
  assert.equal(Buffer.from(capture.data, 'base64').subarray(1, 4).toString(), 'PNG');
  const lookup = { kind: 'url', value: url };
  const declinedLookup = run('lookup_molecule', lookup);
  await decide(false);
  assert.match((await declinedLookup).error, /cancel/i);
  assert.equal(requests, 0);
  const approvedLookup = run('lookup_molecule', lookup);
  await decide(true);
  assert.equal((await approvedLookup).ok, true);
  assert.equal(requests, 1);
  const names = await page.evaluate(async () => (await document.modelContext.getTools()).map(t => t.name));
  assert.equal(names.includes('optimize_geometry'), threaded);
  if (threaded) {
    const rejected = run('run_molecule_action', { id: 'energy' });
    await decide(false);
    assert.match((await rejected).error, /cancel/i);
    assert.equal(await page.$eval('#calculation-status', el => el.textContent), '');
    const approved = run('run_molecule_action', { id: 'energy' });
    await decide(true);
    assert.equal((await approved).ok, true);
    await page.waitForFunction(() => document.getElementById('calculation-status').textContent.includes('Energy'));
  }
  const originalName = await page.$eval('#document-name', el => el.textContent);
  const insertion = run('insert_fragment', { kind: 'smiles', value: 'C' });
  await decide(true);
  assert.equal((await insertion).ok, true);
  assert.deepEqual((await run('inspect_molecule')).atoms.map(atom => atom.atomicNumber), [2, 6]);
  await run('edit_molecule', { operation: 'undo' });
  assert.equal(await page.$eval('#document-name', el => el.textContent), originalName);
  await page.click('#lookup');
  await page.select('#lookup-kind', 'inchi');
  await page.type('#lookup-value', 'InChI=1S/CH4/h1H4');
  await page.click('#insert-fragment');
  await page.click('#lookup-form [type="submit"]');
  await page.waitForFunction(() => document.querySelector('#status').textContent === 'Fragment inserted.');
  assert.deepEqual(identifiers, [['smiles', 'C'], ['inchi', 'InChI=1S/CH4/h1H4']]);
  assert.deepEqual((await run('inspect_molecule')).atoms.map(atom => atom.atomicNumber), [2, 6]);
  await run('edit_molecule', { operation: 'undo' });
  const action = (id, args = {}) => run('run_molecule_action', { id, ...args });
  const atom = await action('atomProperties', { index: 0 });
  assert.equal(atom.properties.atomicNumber, 2);
  assert.equal((await run('inspect_molecule')).modified, false);
  await page.select('#molecule-action', 'atomProperties');
  await page.click('#run-action');
  await page.waitForFunction(() => document.querySelector('#action-result').textContent.includes('Atomic number: 2'));
  assert.match((await action('editUnitCell', { vectors: Array(9).fill(1) })).error, /lattice vectors/);
  assert.equal((await action('editUnitCell', { vectors: [3,0,0,0,3,0,0,0,3] })).ok, true);
  assert.match((await action('buildSupercell', { repeats: [33,1,1] })).error, /repeats/);
  assert.equal((await action('buildSupercell', { repeats: [2,1,1] })).ok, true);
  assert.equal((await run('inspect_molecule')).atomCount, 2);
  await run('edit_molecule', { operation: 'undo' });
  assert.equal((await run('inspect_molecule')).atomCount, 1);
  await run('edit_molecule', { operation: 'undo' });
  assert.equal((await run('inspect_molecule')).modified, false);
  await page.click('#allow-agent-edits');
  assert.match((await run('set_editor_tool', { id: 'draw' })).error, /Enable/);
  assert.deepEqual(await page.evaluate(() => window.cspViolations), []);
  assert.deepEqual(violations, []);
  assert.deepEqual(requestErrors, []);
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(document, 'modelContext', { value: undefined });
    Object.defineProperty(navigator, 'modelContext', { value: undefined });
  });
  await go();
  assert.equal(await page.$eval('#agent-control', el => el.hidden), true);
  console.log('PASS: inspection, PNG viewport, opt-in/revocation, replacement, edit commands, properties, unit cells, supercells, SMILES/InChI insertion, approved HTTPS lookup and cancellation');
} finally {
  await browser.close();
}

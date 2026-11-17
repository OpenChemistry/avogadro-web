// SPDX-License-Identifier: BSD-3-Clause
// Run: node browser-smoke.mjs URL EVIDENCE_DIRECTORY [--widget-update] [--plugins] [--webmcp] [--openbabel]
// Owns a new headless Chrome process/profile; never connects to a user's browser.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const url = process.argv[2] || 'http://127.0.0.1:8000';
const output = resolve(process.argv[3] || 'browser-evidence');
const testWidgetUpdate = process.argv.includes('--widget-update');
const testPlugins = process.argv.includes('--plugins');
const testWebMcp = process.argv.includes('--webmcp');
const testOpenBabel = process.argv.includes('--openbabel');
const quantumFixture = process.env.AVOGADRO_FCHK_FIXTURE;
await mkdir(output, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), 'avogadro-browser-'));
const browser = spawn(process.env.CHROME_BINARY || 'google-chrome', [
  '--headless', '--no-sandbox', '--disable-dev-shm-usage', '--remote-debugging-pipe',
  '--disable-background-networking', '--disable-sync', '--no-first-run',
  `--user-data-dir=${profile}`, '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
  ...(testWebMcp ? ['--enable-features=WebMCP,WebMCPTesting'] : []),
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
let sequence = 0, buffer = '', session;
const pending = new Map(), errors = [], checks = [];
browser.stderr.on('data', data => process.stderr.write(data));
browser.stdio[4].on('data', data => {
  buffer += data.toString();
  while (buffer.includes('\0')) {
    const index = buffer.indexOf('\0');
    const message = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
    if (message.id) {
      const request = pending.get(message.id); pending.delete(message.id);
      if (message.error) request?.reject(new Error(JSON.stringify(message.error)));
      else request?.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') {
      errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
      console.error(errors.at(-1));
    } else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      errors.push(message.params.args.map(arg => arg.value || arg.description).join(' '));
      console.error(errors.at(-1));
    }
  }
});
function send(method, params = {}, target = session) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    browser.stdio[3].write(JSON.stringify({ id, method, params, ...(target ? { sessionId: target } : {}) }) + '\0');
  });
}
async function evaluate(expression) {
  const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  return response.result.value;
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(expression, timeout = 90000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await evaluate(expression)) return; if (await evaluate(`document.querySelector('#status')?.textContent === 'The editor could not start.'`)) throw new Error(await evaluate(`document.querySelector('#loading').textContent`)); await delay(100); }
  throw new Error(`Timed out: ${expression}; ${await evaluate('document.body.innerText')}`);
}
async function click(id) { await evaluate(`document.getElementById(${JSON.stringify(id)}).click()`); await delay(150); }
async function set(id, value) {
  await evaluate(`{const el=document.getElementById(${JSON.stringify(id)});el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('change',{bubbles:true}));}`);
  await delay(100);
}
async function load(path) {
  const { root } = await send('DOM.getDocument');
  const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: '#file' });
  await send('DOM.setFileInputFiles', { nodeId, files: [path] });
  await delay(250);
}
async function screenshot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(join(output, name), Buffer.from(data, 'base64'));
}
const watchdog = setTimeout(() => { browser.kill('SIGTERM'); process.exitCode = 1; }, 180000);
try {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' }, null);
  ({ sessionId: session } = await send('Target.attachToTarget', { targetId, flatten: true }, null));
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: output }, null);
  if (testOpenBabel) {
    await send('Page.addScriptToEvaluateOnNewDocument', { source: `
      globalThis.openBabelWorkerCount = 0;
      const OriginalWorker = Worker;
      globalThis.Worker = class extends OriginalWorker {
        constructor(url, options) {
          super(url, options);
          if (String(url).endsWith('/openbabel-worker.js')) ++globalThis.openBabelWorkerCount;
        }
      };
    ` });
  }
  if (testWidgetUpdate) {
    // Install before WASM starts so cached WebGL function references are counted.
    await send('Page.addScriptToEvaluateOnNewDocument', { source: `
      globalThis.viewportDrawCalls = 0;
      for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) {
        const draw = WebGL2RenderingContext.prototype[name];
        WebGL2RenderingContext.prototype[name] = function (...args) {
          draw.apply(this, args);
          if (this.canvas.getRootNode().host?.id === 'qt-shadow-container')
            ++globalThis.viewportDrawCalls;
        };
      }
    ` });
  }
  console.log('Navigating', url);
  await send('Page.navigate', { url });
  await wait(`document.querySelector('#controls') && !document.querySelector('#controls').disabled`);
  console.log('WASM loaded');
  checks.push('WASM startup');
  assert.equal(await evaluate(`!!document.querySelector('#qt-shadow-container')?.shadowRoot?.querySelector('canvas')`), true);
  await delay(300);
  const rect = await evaluate(`(()=>{const r=document.querySelector('#viewport').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...rect, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...rect, button: 'left', clickCount: 1 });
  await wait(`document.querySelector('#counts').textContent.startsWith('5 atoms')`, 10000);
  checks.push('Draw carbon and automatic hydrogens');
  const inspect = () => evaluate(`(async () => {
    const context = document.modelContext;
    const tool = (await context.getTools()).find(tool => tool.name === 'inspect_molecule');
    const result = await context.executeTool(tool, {});
    return typeof result === 'string' ? JSON.parse(result) : result;
  })()`);
  if (testWebMcp) {
    const filesBeforeInspection = await readdir(output);
    const molecule = await inspect();
    assert.equal(molecule.modified, true);
    assert.equal(molecule.atomCount, 5);
    assert.equal(molecule.bondCount, 4);
    assert.deepEqual(molecule.atoms.map(atom => atom.atomicNumber), [6, 1, 1, 1, 1]);
    assert.deepEqual(molecule.bonds.map(({ begin, end, order }) => [
      Math.min(begin, end), Math.max(begin, end), order,
    ]).sort((a, b) => a[1] - b[1]), [[0, 1, 1], [0, 2, 1], [0, 3, 1], [0, 4, 1]]);
    assert.deepEqual(await readdir(output), filesBeforeInspection);
    assert.match(await evaluate("document.querySelector('#document-name').textContent"), /\*$/);
    checks.push('WebMCP reads the live unsaved atom and bond graph without a download');
  }
  if (testWidgetUpdate) {
    await wait('viewportDrawCalls > 0', 5000);
    const idleDrawCalls = await evaluate(`new Promise((resolve, reject) => {
      const started = performance.now();
      let lastDraw = viewportDrawCalls;
      let quietSince = started;
      function check(now) {
        if (viewportDrawCalls !== lastDraw) {
          lastDraw = viewportDrawCalls;
          quietSince = now;
        }
        if (now - quietSince >= 250) {
          try {
            globalThis.updateAvogadroViewportForTest();
            resolve(lastDraw);
          } catch (error) {
            reject(error);
          }
        } else if (now - started >= 5000) {
          reject(new Error('WebGL viewport did not go idle'));
        } else {
          requestAnimationFrame(check);
        }
      }
      requestAnimationFrame(check);
    })`);
    await wait(`viewportDrawCalls > ${idleDrawCalls}`, 5000);
    checks.push('External QWidget::update() redraws the idle WebGL viewport');
  }
  assert.equal(await evaluate(`(()=>{const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented;})()`), true);
  checks.push('Unsaved document navigation protection');
  await screenshot('draw.png');
  await click('undo'); await wait(`document.querySelector('#counts').textContent.startsWith('0 atoms')`, 5000);
  if (testWebMcp)
    assert.deepEqual(await inspect(), { atomCount: 0, bondCount: 0, modified: false, atoms: [], bonds: [] });
  await click('redo'); await wait(`document.querySelector('#counts').textContent.startsWith('5 atoms')`, 5000);
  checks.push('Undo/redo through HTML controls');
  await click('new'); await wait(`document.querySelector('#discard-dialog').open`, 5000);
  await evaluate(`document.querySelector('#discard-dialog button[value="cancel"]').click()`);
  assert.equal(await evaluate(`document.querySelector('#counts').textContent.startsWith('5 atoms')`), true);
  await click('new'); await evaluate(`document.querySelector('#discard-dialog button[value="discard"]').click()`);
  await wait(`document.querySelector('#counts').textContent.startsWith('0 atoms')`, 5000);
  checks.push('Unsaved-change confirmation and cancellation');
  await set('element', '8'); await set('bond', '2');
  await click('hydrogens');
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...rect, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...rect, button: 'left', clickCount: 1 });
  await wait(`document.querySelector('#counts').textContent.startsWith('1 atoms')`, 5000);
  checks.push('HTML draw settings without Qt panels');
  // Selection deletion is one undo transaction; HTML focus must not edit.
  await evaluate(`document.querySelector('#element').focus()`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
  await evaluate(`document.querySelector('[data-tool="select"]').click()`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...rect, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...rect, button: 'left', clickCount: 1 });
  await click('delete'); await wait(`document.querySelector('#counts').textContent.startsWith('0 atoms')`, 5000);
  await click('undo'); await wait(`document.querySelector('#counts').textContent.startsWith('1 atoms')`, 5000);
  checks.push('HTML keyboard focus, selection and grouped deletion undo');
  await click('download');
  await delay(400);
  const downloaded = (await readdir(output)).find(name => name.endsWith('.cjson'));
  assert.ok(downloaded, 'CJSON browser download');
  assert.deepEqual(JSON.parse(await readFile(join(output, downloaded), 'utf8')).atoms.elements.number, [8]);
  checks.push('CJSON download');
  const xyz = join(profile, 'hydrogen.xyz');
  await writeFile(xyz, '2\nHydrogen\nH 0 0 0\nH 0 0 0.74\n');
  await load(xyz);
  await wait(`document.querySelector('#counts').textContent.startsWith('2 atoms')`, 5000);
  const bad = join(profile, 'bad.cjson'); await writeFile(bad, 'not json'); await load(bad);
  await wait(`document.querySelector('#status').dataset.error === 'true'`, 5000);
  assert.equal(await evaluate(`document.querySelector('#counts').textContent.startsWith('2 atoms')`), true);
  checks.push('Browser file input; failed import preserves document');
  for (const format of ['mol', 'sdf', 'xyz']) { await set('format', format); await click('download'); }
  await delay(300);
  const files = await readdir(output);
  for (const extension of ['mol', 'sdf', 'xyz']) assert.ok(files.some(name => name.endsWith(`.${extension}`)));
  checks.push('MOL/SDF/XYZ downloads');
  if (testOpenBabel) {
    assert.equal(await evaluate('openBabelWorkerCount'), 0, 'Open Babel starts on demand');
    await set('format', 'cjson');
    await click('tab-calculations');
    const native = process.env.OPENBABEL_NATIVE_REFERENCE;
    assert.ok(native, 'Set OPENBABEL_NATIVE_REFERENCE to the native openbabel-web executable');
    const generatedMolecules = [];
    const exportMolecule = format => evaluate(`JSON.parse(avogadroInstanceForTest.exportMolecule(${JSON.stringify(format)})).text`);
    const canonical = (input, args) => {
      const converted = spawnSync(process.env.OBABEL_BINARY || 'obabel', [...args, '-ocan'], { input, encoding: 'utf8' });
      assert.equal(converted.status, 0, converted.stderr);
      assert.ok(converted.stdout.trim(), converted.stderr);
      return converted.stdout.trim().split(/\s/)[0];
    };
    const generate = async smiles => {
      await click('smiles-open');
      await wait(`document.querySelector('#smiles-dialog').open`, 3000);
      await set('smiles', smiles);
      await click('generate-3d');
      await wait(`document.querySelector('#status').textContent.startsWith('Generated 3D molecule') ||
        document.querySelector('#status').dataset.error === 'true' || document.querySelector('#discard-dialog').open`, 20000);
    };
    for (const [name, smiles, atomCount] of [
      ['ethanol', 'CCO', 9], ['benzene', 'c1ccccc1', 12], ['cyclohexane', 'C1CCCCC1', 18],
      ['lactic-acid', 'C[C@H](O)C(=O)O', 12], ['lactic-acid-enantiomer', 'C[C@@H](O)C(=O)O', 12],
      ['trans-difluoroethene', 'F/C=C/F', 6], ['cis-difluoroethene', 'F/C=C\\F', 6],
      ['ammonium', '[NH4+]', 5], ['sodium-chloride', '[Na+].[Cl-]', 2],
    ]) {
      const reference = spawnSync(native, ['--smiles'], { input: smiles, encoding: 'utf8' });
      assert.equal(reference.status, 0, reference.stderr + reference.stdout);
      const nativeMolecule = JSON.parse(reference.stdout);
      assert.equal(nativeMolecule.ok, true);
      assert.equal(nativeMolecule.optimized, true);
      const expected = canonical('', [`-:${smiles}`]);
      assert.equal(canonical(nativeMolecule.molfile, ['-imol']), expected);
      await generate(smiles);
      assert.equal(await evaluate(`document.querySelector('#status').dataset.error`), 'false', await evaluate(`document.querySelector('#status').textContent`));
      assert.equal(await evaluate(`document.querySelector('#discard-dialog').open`), false);
      assert.match(await evaluate(`document.querySelector('#status').textContent`), /UFF relaxation/);
      const molfile = await exportMolecule('mol');
      assert.equal(canonical(molfile, ['-imol']), expected, `${name} graph and stereochemistry`);
      const molecule = JSON.parse(await exportMolecule('cjson'));
      assert.equal(molecule.atoms.elements.number.length, atomCount);
      const coordinates = molecule.atoms.coords['3d'];
      assert.equal(coordinates.length, atomCount * 3);
      assert.ok(coordinates.every(Number.isFinite));
      const endpoints = molecule.bonds?.connections.index ?? [];
      for (let i = 0; i < endpoints.length; i += 2) {
        const a = 3 * endpoints[i], b = 3 * endpoints[i + 1];
        const distance = Math.hypot(...[0, 1, 2].map(axis => coordinates[a + axis] - coordinates[b + axis]));
        assert.ok(distance > 0.5 && distance < 2.6, `${name} bond length ${distance}`);
      }
      if (name === 'ethanol' || name === 'cyclohexane') {
        // A scalar triple product detects nonplanarity in any orientation.
        let volume = 0;
        for (let i = 1; i < atomCount; ++i) {
          const a = coordinates.slice(3 * i, 3 * i + 3).map((v, k) => v - coordinates[k]);
          for (let j = i + 1; j < atomCount; ++j) {
            const b = coordinates.slice(3 * j, 3 * j + 3).map((v, k) => v - coordinates[k]);
            for (let l = j + 1; l < atomCount; ++l) {
              const c = coordinates.slice(3 * l, 3 * l + 3).map((v, k) => v - coordinates[k]);
              volume = Math.max(volume, Math.abs(a[0] * (b[1] * c[2] - b[2] * c[1]) +
                a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0])));
            }
          }
        }
        assert.ok(volume > 0.1, `${name} has nonplanar 3D coordinates`);
      }
      assert.equal(await evaluate(`JSON.parse(avogadroInstanceForTest.editorState()).modified`), true);
      await writeFile(join(output, `generated-${name}.mol`), molfile);
      await writeFile(join(output, `generated-${name}.cjson`), JSON.stringify(molecule));
      if (name === 'ethanol') await screenshot('smiles-3d.png');
      await click('download');
      generatedMolecules.push({ name, smiles, atomCount, canonical: expected, optimized: true });
    }
    const unchanged = await exportMolecule('cjson');
    await generate('C1CC');
    assert.match(await evaluate(`document.querySelector('#status').textContent`), /Unable to parse/);
    assert.equal(await exportMolecule('cjson'), unchanged);
    await generate('CCO');
    const unsaved = await exportMolecule('cjson');
    await generate('O');
    assert.equal(await evaluate(`document.querySelector('#discard-dialog').open`), true);
    await evaluate(`document.querySelector('#discard-dialog [value="cancel"]').click()`);
    await wait(`!document.querySelector('#discard-dialog').open`, 3000);
    assert.equal(await exportMolecule('cjson'), unsaved);
    await generate('O');
    await evaluate(`document.querySelector('#discard-dialog [value="discard"]').click()`);
    await wait(`document.querySelector('#status').textContent.startsWith('Generated 3D molecule')`, 5000);
    assert.equal(await evaluate(`JSON.parse(avogadroInstanceForTest.editorState()).atomCount`), 3);
    await click('download');
    // Simulate a document edit while the worker is running, in the same event.
    await evaluate(`document.querySelector('#smiles').value = 'CCO';
      document.querySelector('#smiles-form').requestSubmit(); avogadroInstanceForTest.newMolecule();`);
    await wait(`document.querySelector('#status').dataset.error === 'true'`, 10000);
    assert.match(await evaluate(`document.querySelector('#status').textContent`), /changed during 3D generation/);
    assert.equal(await evaluate(`JSON.parse(avogadroInstanceForTest.editorState()).atomCount`), 0);
    await generate('CCO');
    await click('download');
    await writeFile(join(output, 'smiles-generation.json'), JSON.stringify({ results: generatedMolecules }, null, 2));
    checks.push('Nine SMILES generate native and browser 3D molecules with matching graphs, stereochemistry, explicit hydrogens and valid geometry');
    checks.push('SMILES generation preserves documents on invalid input and cancellation, marks results unsaved, and rejects stale results');
    const results = [];
    for (const [name, smiles] of [
      ['water', 'O'], ['ethanol', 'CCO'], ['benzene', 'c1ccccc1'],
      ['ammonium', '[NH4+]'], ['acetate', 'CC(=O)[O-]'], ['hydrogen', '[H][H]'],
    ]) {
      const fixture = join(profile, `${name}.mol`);
      const generated = spawnSync(process.env.OBABEL_BINARY || 'obabel', [`-:${smiles}`, '-omol', '-h', '--gen2d', '-O', fixture], { encoding: 'utf8' });
      assert.equal(generated.status, 0, generated.stderr);
      await load(fixture);
      await wait(`document.querySelector('#document-name').textContent === '${name}.mol'`, 5000);
      // Compare the exact MOL text handed to the worker, including Avogadro's
      // atom ordering, formal charges and explicit hydrogens.
      const molfile = await evaluate(`JSON.parse(avogadroInstanceForTest.exportMolecule('mol')).text`);
      await writeFile(join(output, `${name}.mol`), molfile);
      const reference = spawnSync(native, [], {
        input: molfile, encoding: 'utf8',
        env: { ...process.env, BABEL_DATADIR: '/nonexistent-openbabel-data' },
      });
      assert.equal(reference.status, 0, reference.stderr + reference.stdout);
      const expected = JSON.parse(reference.stdout).charges;
      await click('gasteiger-charges');
      await wait(`document.querySelector('#status').textContent.startsWith('Assigned Gasteiger') || document.querySelector('#status').dataset.error === 'true'`, 15000);
      assert.equal(await evaluate(`document.querySelector('#status').dataset.error`), 'false', await evaluate(`document.querySelector('#status').textContent`));
      const molecule = await evaluate(`JSON.parse(JSON.parse(avogadroInstanceForTest.exportMolecule('cjson')).text)`);
      const actual = molecule.atoms.partialCharges.gasteiger;
      if (name === 'water') await screenshot('gasteiger-charges.png');
      assert.equal(actual.length, expected.length);
      const maxError = Math.max(...actual.map((value, i) => Math.abs(value - expected[i])));
      assert.ok(maxError <= 1e-12, `${name}: maximum charge difference ${maxError}`);
      assert.match(await evaluate(`document.querySelector('#document-name').textContent`), /\*$/);
      await click('undo');
      assert.equal(await evaluate(`JSON.parse(JSON.parse(avogadroInstanceForTest.exportMolecule('cjson')).text).atoms.partialCharges?.gasteiger`), undefined);
      await click('redo');
      assert.deepEqual(await evaluate(`JSON.parse(JSON.parse(avogadroInstanceForTest.exportMolecule('cjson')).text).atoms.partialCharges.gasteiger`), actual);
      // Save and reload through CJSON, including the all-zero hydrogen case.
      const saved = join(profile, `${name}-charges.cjson`);
      await writeFile(saved, JSON.stringify(molecule));
      await click('download');
      await load(saved);
      await wait(`document.querySelector('#document-name').textContent === '${name}-charges.cjson'`, 5000);
      assert.deepEqual(await evaluate(`JSON.parse(JSON.parse(avogadroInstanceForTest.exportMolecule('cjson')).text).atoms.partialCharges.gasteiger`), actual);
      results.push({ name, atomCount: actual.length, maxError, native: expected, browser: actual });
    }
    assert.equal(await evaluate('openBabelWorkerCount'), 1, 'One worker is reused');
    const stale = await evaluate(`(() => {
      const instance = avogadroInstanceForTest;
      const revision = JSON.parse(instance.editorState()).revision;
      const molfile = JSON.parse(instance.exportMolecule('mol')).text;
      instance.loadMolecule(molfile, 'mol');
      return JSON.parse(instance.applyPartialCharges(revision, '[0,0]'));
    })()`);
    assert.equal(stale.ok, false);
    assert.match(stale.error, /changed/);
    const unsupported = spawnSync(process.env.OBABEL_BINARY || 'obabel', ['-:[Na+].[Cl-]', '-omol', '-h', '--gen2d'], { encoding: 'utf8' });
    assert.equal(unsupported.status, 0, unsupported.stderr);
    assert.equal(spawnSync(native, [], { input: unsupported.stdout }).status, 1);
    const recovery = await evaluate(`(async () => {
      const { OpenBabelClient } = await import('./openbabel-client.js');
      const client = new OpenBabelClient();
      let error;
      try { await client.gasteigerCharges('invalid MOL'); } catch (failure) { error = failure.message; }
      let unsupportedError;
      try { await client.gasteigerCharges(${JSON.stringify(unsupported.stdout)}); } catch (failure) { unsupportedError = failure.message; }
      const molfile = JSON.parse(avogadroInstanceForTest.exportMolecule('mol')).text;
      try { return { error, unsupportedError, result: await client.gasteigerCharges(molfile) }; }
      finally { client.dispose(); }
    })()`);
    assert.match(recovery.error, /Unable to read/);
    assert.match(recovery.unsupportedError, /could not assign/);
    assert.equal(recovery.result.ok, true);
    await writeFile(join(output, 'openbabel-comparison.json'), JSON.stringify({ tolerance: 1e-12, results }, null, 2));
    checks.push('On-demand Open Babel worker reused; six native/browser Gasteiger comparisons within 1e-12');
    checks.push('Gasteiger charges persist in CJSON, support undo/redo, reject stale results, and recover after invalid input');
  }
  if (testPlugins) {
    const tool = async id => {
      const selector = JSON.stringify(`[data-tool="${id}"]`);
      await evaluate(`document.querySelector(${selector}).click()`);
      await wait(`document.querySelector(${selector}).getAttribute('aria-pressed') === 'true'`, 5000);
    };
    const style = async (id, enabled) => {
      const selector = JSON.stringify(`[data-style="${id}"]`);
      await evaluate(`{ const input = document.querySelector(${selector}); if (input.checked !== ${enabled}) input.click(); }`);
      await delay(200);
    };
    const mouse = (type, point, button = 'left', clickCount = 1) => send('Input.dispatchMouseEvent', {
      type, ...point, button, clickCount,
    });
    const pick = async (point, clickCount = 1) => {
      await mouse('mousePressed', point, 'left', clickCount);
      await mouse('mouseReleased', point, 'left', clickCount);
      await delay(150);
    };
    const drag = async (point, dx, dy, button = 'left') => {
      await mouse('mousePressed', point, button);
      const end = { x: point.x + dx, y: point.y + dy };
      await send('Input.dispatchMouseEvent', {
        type: 'mouseMoved', ...end, buttons: button === 'left' ? 1 : 2,
      });
      await mouse('mouseReleased', end, button);
      await delay(200);
    };
    const atom = index => evaluate(`(() => {
      const r = document.querySelector('#viewport').getBoundingClientRect();
      const p = globalThis.avogadroAtomPositionForTest(${index});
      return { x: r.x + p.x, y: r.y + p.y };
    })()`);
    const viewportImage = async (name) => {
      const clip = await evaluate(`(() => {
        const {x, y, width, height} = document.querySelector('#viewport').getBoundingClientRect();
        return {x, y, width, height, scale: 1};
      })()`);
      // WASM redraws asynchronously. Compare settled frames rather than a
      // possibly queued repaint, especially under software rendering.
      let data, previous, stable = 0;
      for (let attempt = 0; attempt < 30 && stable < 2; ++attempt) {
        ({ data } = await send('Page.captureScreenshot', { format: 'png', clip }));
        stable = data === previous ? stable + 1 : 0;
        previous = data;
        await delay(100);
      }
      assert.equal(stable, 2, 'Viewport rendering settles before comparison');
      if (name) await writeFile(join(output, name), Buffer.from(data, 'base64'));
      return createHash('sha256').update(data).digest('hex');
    };
    const exportCjson = async () => {
      const before = new Set(await readdir(output));
      await set('format', 'cjson');
      await click('download');
      for (let i = 0; i < 20; ++i) {
        const name = (await readdir(output)).find(file => !before.has(file) && file.endsWith('.cjson'));
        if (name) {
          const path = join(output, name);
          const molecule = JSON.parse(await readFile(path, 'utf8'));
          await rm(path);
          return molecule;
        }
        await delay(100);
      }
      throw new Error('New CJSON download did not finish');
    };

    const fixture = join(profile, 'tool-fixture.cjson');
    await writeFile(fixture, JSON.stringify({
      chemicalJson: 1,
      atoms: { elements: { number: [6, 8] }, coords: { '3d': [1, 1, 0, 3, 2, 0] } },
      bonds: { connections: { index: [0, 1] }, order: [1] },
    }));
    await load(fixture);
    await wait(`document.querySelector('#document-name').textContent === 'tool-fixture.cjson'`, 5000);
    const discovered = await evaluate(`Array.from(document.querySelectorAll('[data-tool]'), button => button.dataset.tool)`);
    assert.deepEqual(discovered.sort(), ['AlignTool', 'BondCentric', 'LabelEditor', 'Manipulator', 'MeasureTool', 'draw', 'navigate', 'select'].sort());
    const styles = await evaluate(`Array.from(document.querySelectorAll('[data-style]'), input => input.dataset.style)`);
    assert.deepEqual(styles.sort(), ['BallStick', 'Cartoons', 'CrystalScene', 'Label', 'Licorice', 'SurfaceRender', 'VanDerWaals', 'Wireframe'].sort());
    checks.push('Tool and display controls discovered from WASM factories');

    await style('BallStick', false);
    const empty = await viewportImage('styles-empty.png');
    const renderings = new Set([empty]);
    for (const id of ['BallStick', 'Licorice', 'VanDerWaals', 'Wireframe']) {
      await style(id, true);
      renderings.add(await viewportImage(`style-${id}.png`));
      await style(id, false);
      assert.equal(await viewportImage(`style-${id}-disabled.png`), empty, `${id} stops drawing when disabled`);
    }
    assert.equal(renderings.size, 5, 'Each molecular style produces a different viewport image');
    await style('BallStick', true);
    const unlabeled = await viewportImage('unlabeled.png');
    await style('Label', true);
    assert.notEqual(await viewportImage('style-Label.png'), unlabeled, 'Labels are visible over atoms');
    await style('Label', false);
    assert.equal(await viewportImage('labels-disabled.png'), unlabeled, 'Disabling Labels restores the unlabelled molecule');
    await style('BallStick', false);
    await style('Licorice', true);
    const styled = await exportCjson();
    assert.deepEqual(styled.layer.enable.Licorice, [true]);
    assert.deepEqual(styled.layer.enable['Ball and Stick'], [false]);
    await writeFile(fixture, JSON.stringify(styled));
    await load(fixture);
    assert.equal(await evaluate(`document.querySelector('[data-style="Licorice"]').checked &&
      !document.querySelector('[data-style="BallStick"]').checked`), true);
    await style('Licorice', false);
    await style('BallStick', true);
    checks.push('All five display styles render, toggle off, and CJSON restores enabled styles');

    await tool('MeasureTool');
    const unmeasured = await viewportImage();
    await pick(await atom(0));
    await pick(await atom(1));
    assert.notEqual(await viewportImage('measure.png'), unmeasured);
    const r = await atom(1);
    const emptyPoint = { x: rect.x, y: Math.max(70, r.y - 190) };
    await pick(emptyPoint);
    await pick(emptyPoint, 2);
    assert.equal(await viewportImage(), unmeasured, 'Double-click clears the measurement overlay');
    checks.push('Measure draws and clears its distance overlay');

    await tool('AlignTool');
    await pick(await atom(0));
    await pick(await atom(1));
    await set('align-axis', 'y');
    await click('align');
    const aligned = (await exportCjson()).atoms.coords['3d'];
    assert.ok(aligned.every((value, index) => Math.abs(value - [0, 0, 0, 0, Math.sqrt(5), 0][index]) < 1e-5));
    await click('undo');
    assert.deepEqual((await exportCjson()).atoms.coords['3d'], [1, 1, 0, 3, 2, 0]);
    checks.push('Align moves picked atoms to the requested axis and undoes in one step');

    await tool('Manipulator');
    await drag(await atom(0), 20, -15);
    const moved = (await exportCjson()).atoms.coords['3d'];
    assert.notDeepEqual(moved.slice(0, 3), [1, 1, 0]);
    assert.deepEqual(moved.slice(3), [3, 2, 0]);
    await click('undo');
    checks.push('Manipulate drag moves the picked atom');

    await tool('BondCentric');
    const left = await atom(0), right = await atom(1);
    await pick({ x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 });
    await drag(right, 30, -15, 'right');
    const stretched = (await exportCjson()).atoms.coords['3d'];
    assert.ok(Math.abs(Math.hypot(stretched[3] - stretched[0], stretched[4] - stretched[1], stretched[5] - stretched[2]) - Math.sqrt(5)) > 1e-3);
    await click('undo');
    checks.push('Bond-Centric right-drag changes the selected bond length');

    await tool('LabelEditor');
    await pick(await atom(0));
    await wait(`!document.querySelector('#label-options').hidden`, 5000);
    await set('atom-label', 'T');
    await evaluate(`document.querySelector('#label-options button').click()`);
    await wait(`document.querySelector('[data-style="Label"]').checked`, 5000);
    assert.equal((await exportCjson()).atoms.labels[0], 'T');
    await viewportImage('edit-label.png');
    checks.push('Edit Labels saves a custom atom label and enables Labels');
  }
  if (quantumFixture) {
    await evaluate(`document.querySelector('#calculations').open = true`);
    const exportCoords = async () => {
      await set('format', 'cjson');
      await click('download');
      const path = join(output, 'strained.cjson');
      for (let i = 0; i < 30; ++i) {
        if ((await readdir(output)).includes('strained.cjson')) {
          const data = JSON.parse(await readFile(path, 'utf8'));
          await rm(path);
          return data.atoms.coords['3d'];
        }
        await delay(100);
      }
      throw new Error('Missing optimized CJSON');
    };
    const strained = join(profile, 'strained.xyz');
    await writeFile(strained, '3\nStrained water\nO 0 0 0\nH 0.55 0 0\nH 0 0.65 0\n');
    await load(strained);
    await wait(`document.querySelector('#counts').textContent.startsWith('3 atoms')`, 5000);
    const original = await exportCoords();
    await click('optimize');
    await wait(`document.querySelector('#calculation-status').textContent.includes('Energy') ||
      document.querySelector('#calculation-status').dataset.error === 'true'`, 20000);
    assert.match(await evaluate(`document.querySelector('#calculation-status').textContent`), /UFF Energy/);
    assert.notDeepEqual(await exportCoords(), original);
    await click('undo');
    assert.deepEqual(await exportCoords(), original);
    checks.push('UFF Optimize Geometry changes coordinates and undoes in one step');

    const surfaces = new Set();
    const renderSurface = async (type, image) => {
      await set('surface-type', type);
      await click('render-surface');
      await wait(`document.querySelector('#calculation-status').textContent === 'Surface Finished' ||
        document.querySelector('#calculation-status').dataset.error === 'true'`, 25000);
      assert.equal(await evaluate(`document.querySelector('#calculation-status').textContent`), 'Surface Finished');
      assert.equal(await evaluate(`document.querySelector('[data-style="SurfaceRender"]').checked`), true);
      await screenshot(image);
      surfaces.add(createHash('sha256').update(await readFile(join(output, image))).digest('hex'));
    };
    for (const type of ['renderVDW', 'renderSolventAccessible', 'renderSolventExcluded'])
      await renderSurface(type, `${type}.png`);
    checks.push('Van der Waals, solvent-accessible and solvent-excluded surfaces');

    await load(resolve(quantumFixture));
    await wait(`document.querySelector('#orbital').options.length > 1`, 7000);
    await renderSurface('renderOrbital', 'orbital.png');
    await renderSurface('renderElectronDensity', 'density.png');
    assert.equal(surfaces.size, 5, 'Surface renders produce distinct frames');
    checks.push('Formatted checkpoint import, molecular orbital and electron density');
    const dataDir = resolve(quantumFixture, '../..');
    await load(join(dataDir, 'molden/H2O.molden'));
    await wait(`document.querySelector('#document-name').textContent === 'H2O.molden' &&
      document.querySelector('#orbital').options.length > 1`, 7000);
    await renderSurface('renderOrbital', 'molden-orbital.png');
    await load(join(dataDir, 'cube/benzene-homo.cube'));
    await wait(`!document.querySelector('[value="renderCube"]').disabled`, 7000);
    await renderSurface('renderCube', 'imported-cube.png');
    checks.push('Molden orbital and imported Gaussian cube rendering');
  }
  await evaluate(`document.querySelector('[data-tool="navigate"]').click()`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...rect, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x + 70, y: rect.y + 30, buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x + 70, y: rect.y + 30, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...rect, deltaX: 0, deltaY: 120 });
  await click('reset');
  await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 700, deviceScaleFactor: 1, mobile: false });
  await delay(300); await screenshot('loaded.png');
  checks.push('Camera input, fit, viewport resize');
  assert.deepEqual(errors, []);
  await writeFile(join(output, 'result.json'), JSON.stringify({ checks, errors }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, checks }));
} catch (error) {
  await screenshot('failure.png').catch(() => {});
  await writeFile(join(output, 'failure.json'), JSON.stringify({ error: String(error), errors, checks }, null, 2));
  console.error(error); process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  await send('Browser.close', {}, null).catch(() => {});
  await delay(300); browser.kill();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}

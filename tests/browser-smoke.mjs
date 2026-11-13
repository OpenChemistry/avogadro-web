// SPDX-License-Identifier: BSD-3-Clause
// Run: node browser-smoke.mjs URL EVIDENCE_DIRECTORY [--widget-update] [--plugins]
// Owns a new headless Chrome process/profile; never connects to a user's browser.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const url = process.argv[2] || 'http://127.0.0.1:8000';
const output = resolve(process.argv[3] || 'browser-evidence');
const testWidgetUpdate = process.argv.includes('--widget-update');
const testPlugins = process.argv.includes('--plugins');
const quantumFixture = process.env.AVOGADRO_FCHK_FIXTURE;
await mkdir(output, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), 'avogadro-browser-'));
const browser = spawn(process.env.CHROME_BINARY || 'google-chrome', [
  '--headless', '--no-sandbox', '--disable-dev-shm-usage', '--remote-debugging-pipe',
  '--disable-background-networking', '--disable-sync', '--no-first-run',
  `--user-data-dir=${profile}`, '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
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
      const { data } = await send('Page.captureScreenshot', { format: 'png', clip });
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
    assert.deepEqual(discovered.sort(), ['AlignTool', 'AutoOpt', 'BondCentric', 'LabelEditor', 'Manipulator', 'MeasureTool', 'draw', 'navigate', 'select'].sort());
    const styles = await evaluate(`Array.from(document.querySelectorAll('[data-style]'), input => input.dataset.style)`);
    assert.deepEqual(styles.sort(), ['BallStick', 'Label', 'Licorice', 'SurfaceRender', 'VanDerWaals', 'Wireframe'].sort());
    checks.push('Tool and display controls discovered from WASM factories');

    await style('BallStick', false);
    const empty = await viewportImage();
    const renderings = new Set([empty]);
    for (const id of ['BallStick', 'Licorice', 'VanDerWaals', 'Wireframe', 'Label']) {
      await style(id, true);
      renderings.add(await viewportImage(`style-${id}.png`));
      await style(id, false);
      assert.equal(await viewportImage(), empty, `${id} stops drawing when disabled`);
    }
    assert.equal(renderings.size, 6, 'Each style produces a different viewport image');
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

    await evaluate(`document.querySelector('[data-tool="AutoOpt"]').click()`);
    await click('auto-opt');
    await wait(`document.querySelector('#auto-opt').textContent.startsWith('Stop')`, 5000);
    await wait(`document.querySelector('#document-name').textContent.endsWith(' *')`, 15000);
    await click('auto-opt');
    await wait(`document.querySelector('#auto-opt').textContent.startsWith('Start')`, 5000);
    assert.notDeepEqual(await exportCoords(), original);
    checks.push('AutoOptimize starts, updates coordinates, and stops');

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

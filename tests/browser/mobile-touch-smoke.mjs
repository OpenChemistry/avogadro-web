// SPDX-License-Identifier: BSD-3-Clause
// Run: node mobile-touch-smoke.mjs STAGED_SINGLE_THREAD_PACKAGE
import assert from 'node:assert/strict';
import { openFixture } from './fixtures/https-editor.mjs';

const { browser, page, go, waitText, requestErrors, violations } = await openFixture(process.argv[2], new Map());
const points = (x, y, radius) => [[x - radius, y, 1], [x + radius, y, 2]];
const counts = () => page.$eval('#counts', node => node.textContent);
const modelView = () => page.evaluate(() => window.lastMatrices.modelView);
const projectOrigin = async viewport => {
  const { modelView, projection } = await page.evaluate(() => window.lastMatrices);
  const clip = [0, 1, 2, 3].map(row =>
    modelView.slice(12).reduce((sum, entry, column) => sum + entry * projection[column * 4 + row], 0));
  return [viewport.width * (clip[0] / clip[3] + 1) / 2,
    viewport.height * (1 - clip[1] / clip[3]) / 2];
};
const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
try {
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  await page.evaluateOnNewDocument(() => {
    const context = WebGL2RenderingContext.prototype;
    const locations = new WeakMap();
    window.lastMatrices = {};
    const location = context.getUniformLocation;
    context.getUniformLocation = function (program, name) {
      const uniform = location.call(this, program, name);
      if (uniform && ['modelView', 'projection'].includes(name)) locations.set(uniform, name);
      return uniform;
    };
    const update = context.uniformMatrix4fv;
    context.uniformMatrix4fv = function (uniform, transpose, values, offset = 0) {
      update.apply(this, arguments);
      const name = locations.get(uniform);
      if (name) window.lastMatrices[name] = Array.from(values.slice(offset, offset + 16));
    };
  });
  await go();
  await page.tap('[data-tool="navigate"]');
  await waitText('active-tool', 'Navigate');
  await page.tap('[data-tool="draw"]');
  await waitText('active-tool', 'Draw');
  await page.tap('#inspector-toggle');
  await page.waitForSelector('#inspector', { visible: true });
  await page.tap('#inspector-close');
  await page.waitForSelector('#inspector', { hidden: true });
  const client = await page.createCDPSession();
  const touch = (type, locations = []) => client.send('Input.dispatchTouchEvent', {
    type, touchPoints: locations.map(([x, y, id]) => ({ x, y, id })),
  });
  async function pinch(x, y, from, to) {
    const initial = points(x, y, from);
    await touch('touchStart', [initial[0]]);
    // The first finger can move slightly before the second lands.
    await touch('touchMove', [[initial[0][0] + 4, y, 1]]);
    await touch('touchStart', initial);
    for (let index = 1; index <= 4; ++index) {
      await touch('touchMove', points(x, y, from + (to - from) * index / 4));
    }
    await touch('touchEnd');
    await frame();
  }

  async function movePair(x, y, dx, dy, from, to = from) {
    await touch('touchStart', points(x, y, from));
    for (let i = 1; i <= 4; ++i)
      await touch('touchMove', points(x + dx * i / 4, y + dy * i / 4, from + (to - from) * i / 4));
    await touch('touchEnd');
    await frame();
  }

  const dock = await page.$eval('#tools', node => {
    const r = node.getBoundingClientRect();
    return { y: r.y + r.height / 2, x: r.x + r.width * 0.8, width: r.width };
  });
  const viewport = await page.$eval('#viewport', node => {
    const r = node.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2),
      width: r.width, height: r.height, bottom: r.bottom };
  });
  assert.equal(viewport.width, 390);
  assert.ok(dock.y > viewport.bottom);
  assert.equal(await page.$eval('#viewport', node => getComputedStyle(node).touchAction), 'none');
  assert.equal(await page.$eval('#tools', node => getComputedStyle(node).touchAction), 'auto');
  const { x, y } = viewport;
  const dockX = Math.round(dock.x);
  const dockY = Math.round(dock.y);
  await touch('touchStart', [[dockX, dockY, 1]]);
  for (const offset of [20, 40, 65, 90, 120, 150]) await touch('touchMove', [[dockX - offset, dockY, 1]]);
  await touch('touchEnd');
  await page.waitForFunction(() => document.getElementById('tools').scrollLeft > 0);
  assert.equal(await counts(), '0 atoms · 0 bonds');

  await pinch(x, y, 36, 90);
  assert.equal(await counts(), '0 atoms · 0 bonds');
  assert.equal(await page.$eval('#undo', node => node.disabled), true);

  await touch('touchStart', [[x, y, 1]]);
  await touch('touchCancel');
  await touch('touchStart', points(x, y, 40));
  await touch('touchCancel');
  await frame();
  assert.equal(await counts(), '0 atoms · 0 bonds');
  await page.touchscreen.tap(x, y);
  await waitText('counts', '5 atoms · 4 bonds');
  await page.waitForFunction(() => window.lastMatrices.modelView && window.lastMatrices.projection);
  async function checkPan(dx, dy, from, to = from) {
    const before = await modelView();
    const focus = await projectOrigin(viewport);
    await movePair(x, y, dx, dy, from, to);
    const after = await modelView();
    const projected = await projectOrigin(viewport);
    assert.deepEqual(after.slice(0, 12), before.slice(0, 12), 'panning must preserve orientation');
    assert.ok(Math.hypot(projected[0] - focus[0] - dx, projected[1] - focus[1] - dy) < 2,
      `expected shift (${dx}, ${dy}) but got (${projected[0] - focus[0]}, ${projected[1] - focus[1]})`);
    if (from === to) assert.ok(Math.abs(after[14] - before[14]) < 1e-4, 'pure pan must preserve zoom');
    else assert.ok(Math.abs(after[14]) < Math.abs(before[14]), 'a spread must zoom in while panning');
  }

  const beforeTransitions = await modelView();
  await page.$eval('#viewport', (canvas, x, y) => {
    const pointer = (type, id, dx, dy) => canvas.dispatchEvent(new PointerEvent(type, {
      bubbles: true, pointerType: 'touch', pointerId: id, isPrimary: id === 1,
      clientX: x + dx, clientY: y + dy,
    }));
    pointer('pointerdown', 1, -40, 0);
    pointer('pointerdown', 2, 40, 0);
    pointer('pointerdown', 3, 60, 20);
    pointer('pointermove', 3, 90, 35);
    pointer('pointerup', 2, 40, 0);
    pointer('pointerup', 3, 90, 35);
    pointer('pointermove', 1, -40, -50);
    pointer('pointerdown', 4, 55, -35);
    pointer('pointerup', 1, -40, -50);
    pointer('pointerup', 4, 55, -35);
  }, x, y);
  await frame();
  assert.deepEqual(await modelView(), beforeTransitions, 'finger transitions must not move the camera');
  assert.equal(await counts(), '5 atoms · 4 bonds');

  await checkPan(36, -24, 45);
  const initial = await modelView();
  await pinch(x, y, 40, 100);
  const spread = await modelView();
  assert.deepEqual(spread.slice(0, 12), initial.slice(0, 12));
  assert.ok(Math.abs(spread[14]) < Math.abs(initial[14]), 'spreading zooms in');
  await checkPan(-20, 40, 45);
  await checkPan(24, -16, 40, 76);
  const zoomed = await modelView();
  await pinch(x, y, 100, 40);
  const contracted = await modelView();
  assert.deepEqual(contracted.slice(0, 12), initial.slice(0, 12));
  assert.ok(Math.abs(contracted[14]) > Math.abs(zoomed[14]), 'pinching zooms out');
  assert.equal(await counts(), '5 atoms · 4 bonds');

  await touch('touchStart', [[x - 120, y + 100, 1]]);
  await touch('touchMove', [[x - 105, y + 100, 1]]);
  await touch('touchMove', [[x - 70, y + 130, 1]]);
  await touch('touchEnd');
  await page.waitForFunction(() => Number(document.getElementById('counts').textContent.split(' ')[0]) > 5);
  const afterDraw = await counts();

  await page.click('[data-tool="navigate"]');
  await waitText('active-tool', 'Navigate');
  const beforeRotation = await modelView();
  await touch('touchStart', [[x, y, 1]]);
  await touch('touchMove', [[x + 30, y - 20, 1]]);
  await touch('touchMove', [[x + 80, y - 45, 1]]);
  await touch('touchEnd');
  await frame();
  assert.notDeepEqual((await modelView()).slice(0, 12), beforeRotation.slice(0, 12));
  assert.equal(await counts(), afterDraw);
  const beforePan = await modelView();
  await movePair(x, y, 28, 20, 40);
  const afterPan = await modelView();
  assert.deepEqual(afterPan.slice(0, 12), beforePan.slice(0, 12));
  assert.ok(afterPan[12] > beforePan[12] && afterPan[13] < beforePan[13]);
  assert.ok(Math.abs(afterPan[14] - beforePan[14]) < 1e-4);
  assert.equal(await counts(), afterDraw);

  await page.click('#inspector-toggle');
  await page.waitForSelector('#inspector', { visible: true });

  await page.setViewport({ width: 844, height: 390, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  await page.waitForFunction(() => matchMedia('(orientation: landscape)').matches);
  await page.click('#inspector-close');
  const landscape = await page.evaluate(() => ({
    viewport: document.getElementById('viewport').getBoundingClientRect().height,
    dockBottom: document.querySelector('.tool-rail').getBoundingClientRect().bottom,
    width: document.documentElement.scrollWidth,
    viewportWidth: innerWidth,
    height: innerHeight,
  }));
  assert.ok(landscape.viewport > 100);
  assert.ok(landscape.dockBottom <= landscape.height);
  assert.equal(landscape.width, landscape.viewportWidth);
  assert.equal(await counts(), afterDraw);
  assert.deepEqual(await page.evaluate(() => window.cspViolations), []);
  assert.deepEqual(violations, []);
  assert.deepEqual(requestErrors, []);
  console.log('Emulated phone draws, rotates, pans and pinches without editing, recovers from cancellation, scrolls controls and rotates layout.');
} finally {
  await browser.close();
}

// SPDX-License-Identifier: BSD-3-Clause
// Run: node mobile-first-placement.mjs STAGED_SINGLE_THREAD_PACKAGE
import assert from 'node:assert/strict';
import { openFixture } from './fixtures/https-editor.mjs';

const { browser, page, go, requestErrors, violations } = await openFixture(process.argv[2], new Map());
const applyMatrix = (matrix, value) => [0, 1, 2, 3].map(row =>
  value.reduce((sum, entry, column) => sum + entry * matrix[column * 4 + row], 0));
try {
  await page.evaluateOnNewDocument(() => {
    const inputMode = new URL(window.location.href).searchParams.get('touch-test');
    if (inputMode === 'missing-offsets') {
      for (const property of ['offsetX', 'offsetY']) {
        const nativeOffset = Object.getOwnPropertyDescriptor(MouseEvent.prototype, property).get;
        Object.defineProperty(PointerEvent.prototype, property, {
          get() { return this.pointerType === 'touch' ? 0 : nativeOffset.call(this); },
        });
      }
    }
    if (inputMode === 'missing-press-coordinates') {
      for (const property of ['clientX', 'clientY']) {
        const nativeCoordinate = Object.getOwnPropertyDescriptor(MouseEvent.prototype, property).get;
        Object.defineProperty(PointerEvent.prototype, property, {
          get() {
            return this.isTrusted && this.pointerType === 'touch' && this.type === 'pointerdown'
              ? 0 : nativeCoordinate.call(this);
          },
        });
      }
    }
    // Capture the real renderer's matrices to project the exported atom into
    // CSS pixels without using another placement path as the reference.
    const context = WebGL2RenderingContext.prototype;
    const locations = new WeakMap();
    const location = context.getUniformLocation;
    context.getUniformLocation = function (program, name) {
      const uniform = location.call(this, program, name);
      if (uniform && ['modelView', 'projection'].includes(name)) locations.set(uniform, name);
      return uniform;
    };
    const update = context.uniformMatrix4fv;
    window.matrices = {};
    context.uniformMatrix4fv = function (uniform, transpose, values, offset = 0) {
      update.apply(this, arguments);
      const name = locations.get(uniform);
      if (name) window.matrices[name] = Array.from(values.slice(offset, offset + 16));
    };
    const makeUrl = URL.createObjectURL;
    URL.createObjectURL = function (blob) {
      if (blob.type.startsWith('text/plain')) window.downloadText = blob.text();
      return makeUrl.call(this, blob);
    };
    document.addEventListener('click', event => {
      if (event.target instanceof HTMLAnchorElement && event.target.download)
        event.preventDefault();
    });
  });

  for (const deviceScaleFactor of [1, 2, 3]) {
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor, isMobile: true, hasTouch: true });
    const placements = [[0.25, 0.39, 'natural'], [0.76, 0.65, 'natural'],
      [0.25, 0.39, 'missing-offsets'], [0.76, 0.65, 'missing-press-coordinates']];
    if (deviceScaleFactor === 2) placements.push([0.64, 0.56, 'offset-and-scroll']);
    for (const [horizontal, vertical, inputMode] of placements) {
      await go(`/?touch-test=${inputMode}`);
      if (inputMode === 'offset-and-scroll') {
        await page.evaluate(() => {
          document.documentElement.style.overflowY = 'auto';
          document.body.style.margin = '200px 20px 0 35px';
          window.scrollTo(0, 130);
        });
        await page.waitForFunction(() => scrollY === 130 && document.getElementById('viewport').getBoundingClientRect().left === 35);
      }
      const rect = await page.$eval('#viewport', node => node.getBoundingClientRect().toJSON());
      const x = Math.round(rect.left + rect.width * horizontal);
      const y = Math.round(rect.top + rect.height * vertical);
      await page.touchscreen.tap(x, y);
      await page.waitForFunction(() => window.matrices.projection && window.matrices.modelView &&
        !document.getElementById('export-toggle').disabled && document.getElementById('document-state').textContent === 'Unsaved changes');
      await page.click('#export-toggle');
      await page.click('#download');
      const { document: molecule, matrices } = await page.evaluate(async () => ({
        document: JSON.parse(await window.downloadText),
        matrices: window.matrices,
      }));
      const numbers = molecule.atoms.elements.number;
      const heavy = numbers.flatMap((number, index) => number > 1 ? [index] : []);
      assert.equal(heavy.length, 1, 'a tap should add exactly one heavy atom');
      const bonds = molecule.bonds?.connections.index ?? [];
      for (let bond = 0; bond < bonds.length; bond += 2)
        assert.ok(numbers[bonds[bond]] === 1 || numbers[bonds[bond + 1]] === 1, 'a tap should add no heavy-atom bond');
      const position = molecule.atoms.coords['3d'].slice(heavy[0] * 3, heavy[0] * 3 + 3);
      const clip = applyMatrix(matrices.projection, applyMatrix(matrices.modelView, [...position, 1]));
      const projectedX = rect.left + rect.width * (clip[0] / clip[3] + 1) / 2;
      const projectedY = rect.top + rect.height * (1 - clip[1] / clip[3]) / 2;
      assert.ok(Math.hypot(projectedX - x, projectedY - y) < 3,
        `${inputMode} at DPR ${deviceScaleFactor}: tap (${x}, ${y}) produced carbon at (${projectedX}, ${projectedY})`);
    }
  }
  assert.deepEqual(await page.evaluate(() => window.cspViolations), []);
  assert.deepEqual(requestErrors, []);
  assert.deepEqual(violations, []);
  console.log('Fresh taps place one heavy atom at each contact point at DPR 1, 2 and 3.');
} finally {
  await browser.close();
}

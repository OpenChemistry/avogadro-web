// SPDX-License-Identifier: BSD-3-Clause
// Run: node share-link-smoke.mjs STAGED_SINGLE_THREAD_PACKAGE
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openFixture, pubchem, sdf } from './fixtures/https-editor.mjs';

const caffeine = `${pubchem}/name/caffeine/SDF?record_type=3d`;
let lookupRequests = 0;
const routes = new Map([[caffeine, async (_, respond) => {
  ++lookupRequests;
  await respond({ status: 200, body: sdf });
}]]);
const { browser, page, go, waitText, requestErrors, violations } = await openFixture(process.argv[2], routes);
const output = await mkdtemp(join(tmpdir(), 'avogadro-share-link-'));
async function copyLink() {
  await page.evaluate(() => { window.copiedLink = ''; });
  await page.click('#copy-link');
  await page.waitForFunction(() => window.copiedLink);
  return new URL(await page.evaluate(() => window.copiedLink));
}
try {
  const client = await page.createCDPSession();
  await client.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: output });
  page.on('dialog', dialog => dialog.accept());
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'clipboard', { value: {
      writeText: async text => { window.copiedLink = text; },
    } });
  });

  await go('/?name=caffeine&cid=2519');
  await waitText('status', 'one molecule source');
  assert.equal(lookupRequests, 0);
  await go('/?name=caffeine&tool=AutoOpt');
  await waitText('status', 'unavailable tool');
  assert.equal(lookupRequests, 0);
  await go('/?name=caffeine&mode=view&theme=light&style=sphere&tool=measure');
  await page.waitForSelector('#link-lookup-dialog[open]');
  await waitText('link-lookup-privacy', 'PubChem');
  assert.equal(lookupRequests, 0);
  await page.click('#link-lookup-dialog [value="cancel"]');
  await page.waitForSelector('#link-lookup-dialog[open]', { hidden: true });
  assert.equal(lookupRequests, 0);

  await go('/?name=caffeine&mode=view&theme=light&style=sphere&tool=measure');
  await page.click('#link-lookup-dialog [value="fetch"]');
  await page.waitForFunction(() => document.body.dataset.mode === 'view');
  assert.equal(lookupRequests, 1);
  assert.equal(await page.$eval('html', element => element.dataset.theme), 'light');
  await waitText('active-tool', 'Measure');
  assert.equal(await page.$eval('.tool-rail', element => getComputedStyle(element).display), 'none');
  await page.click('#viewport');
  await waitText('counts', '1 atoms');
  await waitText('document-state', 'Molecule ready');

  await go('/?name=caffeine');
  await page.click('#link-lookup-dialog [value="fetch"]');
  await waitText('counts', '1 atoms');
  const source = await copyLink();
  assert.equal(source.search, '');
  assert.equal(new URLSearchParams(source.hash.substring(1)).get('name'), 'caffeine');

  await page.click('#viewport', { offset: { x: 60, y: 100 } });
  await waitText('document-state', 'Unsaved changes');
  const edited = await copyLink();
  assert.equal(edited.search, '');
  assert.match(edited.hash, /^#cjson=1\./);
  const before = await page.$eval('#counts', element => element.textContent);
  await go(edited.pathname + edited.hash);
  await waitText('document-name', 'Shared molecule.cjson');
  assert.equal(await page.$eval('#counts', element => element.textContent), before);
  assert.equal(lookupRequests, 2);

  await go('/#cjson=1.garbage');
  await page.waitForSelector('#status[data-error="true"]');
  await waitText('counts', '0 atoms');

  const coordinates = Array.from({ length: 800 }, (_, i) =>
    `C ${(i * 2.8).toFixed(6)} ${(Math.sin(i) * 3).toFixed(8)} ${(Math.cos(i) * 3).toFixed(8)}`);
  const large = `800\nLarge fixture\n${coordinates.join('\n')}\n`;
  await page.evaluate(large => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File([large], 'large.xyz'));
    document.getElementById('viewport').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
  }, large);
  await waitText('counts', '800 atoms');
  await page.click('#copy-link');
  await waitText('status', 'CJSON download requested.');
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('CJSON fallback was not downloaded')), 10000);
    const check = setInterval(async () => {
      if (!(await readdir(output)).includes('large.cjson')) return;
      clearInterval(check);
      clearTimeout(timeout);
      resolve();
    }, 100);
    setTimeout(() => clearInterval(check), 10000).unref();
  });

  assert.deepEqual(await page.evaluate(() => window.cspViolations), []);
  assert.deepEqual(requestErrors, []);
  assert.deepEqual(violations, []);
  console.log('Link validation, consent, view settings, source identifiers, edited snapshots and file fallback passed.');
} finally {
  await browser.close();
  await rm(output, { recursive: true, force: true });
}

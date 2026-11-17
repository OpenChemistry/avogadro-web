// SPDX-License-Identifier: BSD-3-Clause
let modulePromise;
self.onmessage = async ({ data: { id, operation, input } }) => {
  try {
    modulePromise ??= import('./openbabel-web.js').then(({ default: createOpenBabel }) => createOpenBabel());
    const module = await modulePromise;
    if (operation !== 'gasteigerCharges' && operation !== 'generate3DFromSmiles')
      throw new Error('Unknown Open Babel operation.');
    self.postMessage({ id, ...JSON.parse(module[operation](input)) });
  } catch (error) {
    modulePromise = undefined;
    self.postMessage({ id, ok: false, fatal: true, error: error.message || 'Open Babel failed to start.' });
  }
};

// SPDX-License-Identifier: BSD-3-Clause
export class OpenBabelClient {
  constructor() {
    this.sequence = 0;
    this.pending = new Map();
  }

  gasteigerCharges(molfile) {
    return this.request('gasteigerCharges', molfile);
  }

  generate3DFromSmiles(smiles) {
    return this.request('generate3DFromSmiles', smiles);
  }

  request(operation, input) {
    if (!this.worker) {
      this.worker = new Worker(new URL('./openbabel-worker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = ({ data }) => {
        const request = this.pending.get(data.id);
        if (!request) return;
        clearTimeout(request.timer);
        this.pending.delete(data.id);
        if (data.fatal) this.dispose(new Error(data.error));
        if (data.ok) request.resolve(data);
        else request.reject(new Error(data.error));
      };
      this.worker.onerror = event => {
        event.preventDefault();
        this.dispose(new Error(event.message || 'Open Babel worker failed.'));
      };
      this.worker.onmessageerror = () => this.dispose(new Error('Invalid Open Babel worker response.'));
    }
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.dispose(new Error('Open Babel calculation timed out.')), 60000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.worker.postMessage({ id, operation, input });
      } catch (error) {
        this.dispose(error);
      }
    });
  }

  dispose(error = new Error('Open Babel worker stopped.')) {
    this.worker?.terminate();
    this.worker = undefined;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }
}

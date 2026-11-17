// SPDX-License-Identifier: BSD-3-Clause
// The wrapper owns no C++ pointers; all messages are plain values.
export class AvogadroEditor extends EventTarget {
  constructor(instance) {
    super();
    this.instance = instance;
    instance.onEditorStateChanged = text => {
      this.dispatchEvent(new CustomEvent('statechange', { detail: this.normalizeState(JSON.parse(text)) }));
    };
  }
  normalizeState(state) {
    // The published CI runtime initially exposed the three core tools only.
    // Keep newer capabilities driven by the runtime, never by demo controls.
    return { tools: [ { id: 'navigate', label: 'Navigate' }, { id: 'draw', label: 'Draw' }, { id: 'select', label: 'Select' } ],
      displayStyles: [], canOptimize: false, canRenderSurfaces: false,
      calculating: false, autoOptimizing: false, orbitalCount: 0, cubeCount: 0,
      calculationMessage: '', calculationError: false, pickedAtomIndex: -1,
      ...state };
  }
  get state() { return this.normalizeState(JSON.parse(this.instance.editorState())); }
  setTheme(theme) {
    if (!['dark', 'light'].includes(theme)) throw new Error('Unknown theme.');
    // Existing CI artifacts predate the optional renderer theme binding.
    if (typeof this.instance.setTheme !== 'function') return false;
    this.instance.setTheme(theme);
    return true;
  }
  setTool(name) { if (!this.instance.setTool(name)) throw new Error('Unknown tool.'); }
  setDisplayStyle(id, enabled) {
    if (!this.instance.setDisplayStyle(id, enabled)) throw new Error('Unknown display style.');
  }
  alignPickedAtoms(axis) {
    if (!this.instance.alignPickedAtoms(axis)) throw new Error('Pick one or two atoms to align.');
  }
  setPickedLabel(label) {
    if (!this.instance.setPickedLabel(label)) throw new Error('Pick an atom to label.');
  }
  calculate(command, options = {}) {
    if (!this.instance.calculate(command, JSON.stringify(options))) throw new Error('Calculation unavailable.');
  }
  setDrawOptions(options) {
    if (!this.instance.setDrawOptions(JSON.stringify(options))) throw new Error('Invalid draw options.');
  }
  newMolecule() { this.instance.newMolecule(); }
  loadMolecule(text, format) { return this.check(JSON.parse(this.instance.loadMolecule(text, format))); }
  exportMolecule(format = 'cjson') { return this.check(JSON.parse(this.instance.exportMolecule(format))).text; }
  check(result) { if (!result.ok) throw new Error(result.error || 'Unable to process this molecule.'); return result; }
  deleteSelection() { this.instance.deleteSelection(); }
  undo() { this.instance.undo(); }
  redo() { this.instance.redo(); }
  resetCamera() { this.instance.resetCamera(); }
  markSaved() { this.instance.markSaved(); }
}

export async function createAvogadroEditor(viewport, { onExit, print, printErr } = {}) {
  if (!globalThis.WebAssembly) throw new Error('This browser does not support WebAssembly.');
  const requiresIsolation = '@AVOGADRO_WEB_WASM_KIT@' !== 'wasm_singlethread';
  if (requiresIsolation && (!globalThis.crossOriginIsolated || !globalThis.SharedArrayBuffer))
    throw new Error('This build needs cross-origin isolation. Serve it with serve-wasm.py or configure COOP: same-origin and COEP: require-corp.');
  const probe = document.createElement('canvas').getContext('webgl2');
  if (!probe) throw new Error('WebGL 2 is unavailable. Enable browser hardware acceleration or use a supported device.');
  probe.getExtension('WEBGL_lose_context')?.loseContext();
  if (typeof globalThis.qtLoad !== 'function' || typeof globalThis.createAvogadroWeb !== 'function')
    throw new Error('Load avogadro-web.js and qtloader.js before creating the editor.');

  let resizeObserver;
  const wheelListener = new AbortController();
  let wheelFrame = 0;
  let wheelPixels = 0;
  const instance = await globalThis.qtLoad({
    qt: {
      containerElements: [viewport],
      entryFunction: globalThis.createAvogadroWeb,
      onExit: details => {
        resizeObserver?.disconnect();
        wheelListener.abort();
        cancelAnimationFrame(wheelFrame);
        onExit?.(details);
      },
    },
    print,
    printErr,
  });
  const editor = new AvogadroEditor(instance);
  resizeObserver = new ResizeObserver(() => instance.qtResizeContainerElement(viewport));
  if (!wheelListener.signal.aborted) resizeObserver.observe(viewport);

  // Combine wheel events Chrome delivers within a frame before Qt sees them.
  viewport.addEventListener('wheel', event => {
    event.preventDefault();
    event.stopPropagation();
    if (editor.state.calculating) return;
    const unit = event.deltaMode;
    const pixels = event.deltaY * (unit === 1 ? 16 : unit === 2 ? viewport.clientHeight : 1);
    if (!Number.isFinite(pixels) || pixels === 0) return;
    wheelPixels += pixels;
    if (wheelFrame) return;
    wheelFrame = requestAnimationFrame(() => {
      const delta = -wheelPixels / 120;
      wheelPixels = 0;
      wheelFrame = 0;
      instance.zoom(delta);
    });
  }, { capture: true, passive: false, signal: wheelListener.signal });

  return editor;
}

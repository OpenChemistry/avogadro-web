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
      actions: [], displayStyles: [], canOptimize: false, canRenderSurfaces: false,
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
  runAction(id, options = {}) {
    if (typeof this.instance.runAction !== 'function') throw new Error('Actions are unavailable in this build.');
    return this.check(JSON.parse(this.instance.runAction(id, JSON.stringify(options))));
  }
  calculate(command, options = {}) {
    if (!this.instance.calculate(command, JSON.stringify(options))) throw new Error('Calculation unavailable.');
  }
  setDrawOptions(options) {
    if (!this.instance.setDrawOptions(JSON.stringify(options))) throw new Error('Invalid draw options.');
  }
  newMolecule() { this.instance.newMolecule(); }
  loadMolecule(text, format) { return this.check(JSON.parse(this.instance.loadMolecule(text, format))); }
  insertFragment(sdf) {
    if (typeof this.instance.insertFragment !== 'function') throw new Error('Fragment insertion is unavailable.');
    return this.check(JSON.parse(this.instance.insertFragment(sdf)));
  }
  exportMolecule(format = 'cjson') { return this.check(JSON.parse(this.instance.exportMolecule(format))).text; }
  check(result) { if (!result.ok) throw new Error(result.error || 'Unable to process this molecule.'); return result; }
  deleteSelection() { this.instance.deleteSelection(); }
  undo() { this.instance.undo(); }
  redo() { this.instance.redo(); }
  resetCamera() { this.instance.resetCamera(); }
  markSaved() { this.instance.markSaved(); }
}

// Hold the first touch until a tap or drag is unambiguous. Qt WASM can lose
// coordinates from synthetic DOM pointer events, so pass viewport positions
// directly to the controller's existing Qt mouse input path.
function handleTouchGestures(viewport, instance, editor, signal) {
  const oldTouchAction = viewport.style.touchAction;
  viewport.style.touchAction = 'none';
  const touches = new Map();
  let gesture;
  let first;
  let pair;
  let cameraFrame = 0;
  let zoomDelta = 0;
  let panX = 0;
  let panY = 0;

  function sendPointer(phase, event) {
    const bounds = viewport.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const x = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
    const y = Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height));
    const modifiers = Number(event.shiftKey) + 2 * Number(event.ctrlKey) +
      4 * Number(event.altKey) + 8 * Number(event.metaKey);
    instance.touchPointer(phase, x, y, modifiers);
  }

  function samplePair() {
    if (touches.size !== 2) return undefined;
    const [a, b] = touches.values();
    return {
      x: (a.clientX + b.clientX) / 2,
      y: (a.clientY + b.clientY) / 2,
      span: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
    };
  }

  function flushCamera() {
    cameraFrame = 0;
    // The C++ zoom binding limits each update to half a wheel notch.
    // Bound the number of updates per frame as well as each update.
    let delta = Math.max(-6, Math.min(6, zoomDelta));
    const dx = panX;
    const dy = panY;
    zoomDelta = panX = panY = 0;
    if (editor.state.calculating) return;
    while (Math.abs(delta) > 0.001) {
      const step = Math.max(-0.5, Math.min(0.5, delta));
      instance.zoom(step);
      delta -= step;
    }
    // Apply translation at the resulting zoom, in viewport-relative units.
    if ((dx || dy) && typeof instance.pan === 'function') {
      const { width, height } = viewport.getBoundingClientRect();
      if (width && height) instance.pan(dx / width, dy / height);
    }
  }

  function updateCamera() {
    const next = samplePair();
    if (pair && next) {
      if (pair.span >= 8 && next.span >= 8)
        zoomDelta += Math.log(next.span / pair.span) * 35;
      panX += next.x - pair.x;
      panY += next.y - pair.y;
      if (!cameraFrame) cameraFrame = requestAnimationFrame(flushCamera);
    }
    pair = next;
  }

  function exceedsTapTolerance(event) {
    return Math.hypot(event.clientX - first.event.clientX, event.clientY - first.event.clientY) >= 8;
  }

  function route(event) {
    if (event.pointerType !== 'touch') return;
    const id = event.pointerId;
    const down = event.type === 'pointerdown';
    const move = event.type === 'pointermove';
    const cancelled = event.type === 'pointercancel';
    if (down) {
      if (touches.size === 0 && event.isPrimary) {
        first = { event };
        gesture = 'pending';
      }
      if (gesture === 'single' && touches.size === 1) {
        // Close Qt's one-finger drag before interpreting two fingers.
        const primary = touches.get(first.event.pointerId);
        sendPointer('release', primary);
        gesture = 'two-finger';
      }
      touches.set(id, event);
      if (touches.size > 1 && gesture === 'pending') gesture = 'two-finger';
      if (gesture === 'two-finger') pair = samplePair();
    } else if (touches.has(id)) {
      if (move) {
        touches.set(id, event);
        if (gesture === 'two-finger') updateCamera();
      } else {
        touches.delete(id);
        if (gesture === 'two-finger') pair = samplePair();
      }
    } else {
      return;
    }

    if (first?.event.pointerId === id) {
      if (gesture === 'pending' && !down && !cancelled) {
        if (move && (first.drag || exceedsTapTolerance(event))) first.drag = event;
        if (!move || (first.drag && event.timeStamp - first.event.timeStamp >= 110)) {
          gesture = 'single';
          // A tap has no drag motion. Send its press at the release point
          // so Qt receives one coherent click even if the initial coordinates
          // were incomplete. Replay fast drags only after observed movement.
          viewport.focus({ preventScroll: true });
          sendPointer('press', first.drag ? first.event : event);
          if (!move && first.drag) sendPointer('move', first.drag);
        }
      }
      if (gesture === 'single') {
        sendPointer(move ? 'move' : 'release', event);
        if (!move) { first = undefined; gesture = undefined; }
      }
    }

    if (cancelled && gesture === 'two-finger') {
      cancelAnimationFrame(cameraFrame);
      cameraFrame = 0;
      zoomDelta = panX = panY = 0;
      gesture = 'interrupted';
    }
    if (touches.size === 0) {
      first = undefined;
      gesture = undefined;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'])
    viewport.addEventListener(type, route, { capture: true, signal });
  signal.addEventListener('abort', () => {
    viewport.style.touchAction = oldTouchAction;
    cancelAnimationFrame(cameraFrame);
  }, { once: true });
}

export async function createAvogadroEditor(viewport, { onExit, print, printErr, wheelZoom = true, touchZoom = true } = {}) {
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
  const inputListeners = new AbortController();
  let wheelFrame = 0;
  let wheelPixels = 0;
  const instance = await globalThis.qtLoad({
    qt: {
      containerElements: [viewport],
      entryFunction: globalThis.createAvogadroWeb,
      onExit: details => {
        resizeObserver?.disconnect();
        inputListeners.abort();
        cancelAnimationFrame(wheelFrame);
        onExit?.(details);
      },
    },
    print,
    printErr,
  });
  const editor = new AvogadroEditor(instance);
  resizeObserver = new ResizeObserver(() => instance.qtResizeContainerElement(viewport));
  if (!inputListeners.signal.aborted) {
    resizeObserver.observe(viewport);
    if (touchZoom && typeof instance.touchPointer === 'function')
      handleTouchGestures(viewport, instance, editor, inputListeners.signal);
  }

  if (!wheelZoom) {
    // Keep Qt from consuming the wheel, leaving native page scrolling enabled.
    viewport.addEventListener('wheel', event => event.stopPropagation(),
      { capture: true, passive: true, signal: inputListeners.signal });
    return editor;
  }

  let calculating = editor.state.calculating;
  editor.addEventListener('statechange', event => { calculating = event.detail.calculating; },
    { signal: inputListeners.signal });

  // Combine wheel events Chrome delivers within a frame before Qt sees them.
  viewport.addEventListener('wheel', event => {
    event.preventDefault();
    event.stopPropagation();
    if (calculating) return;
    const unit = event.deltaMode;
    const pixels = event.deltaY * (unit === 1 ? 16 : unit === 2 ? viewport.clientHeight : 1);
    if (!Number.isFinite(pixels) || pixels === 0) return;
    wheelPixels += pixels;
    if (wheelFrame) return;
    wheelFrame = requestAnimationFrame(() => {
      const delta = -wheelPixels / 120;
      wheelPixels = 0;
      wheelFrame = 0;
      // Qt can queue the statechange notification until after this frame.
      if (!editor.state.calculating) instance.zoom(delta);
    });
  }, { capture: true, passive: false, signal: inputListeners.signal });

  return editor;
}

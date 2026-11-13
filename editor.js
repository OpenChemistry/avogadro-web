// SPDX-License-Identifier: BSD-3-Clause
// The wrapper owns no C++ pointers; all messages are plain values.
export class AvogadroEditor extends EventTarget {
  constructor(instance) {
    super();
    this.instance = instance;
    instance.onEditorStateChanged = text => {
      this.dispatchEvent(new CustomEvent('statechange', { detail: JSON.parse(text) }));
    };
  }
  get state() { return JSON.parse(this.instance.editorState()); }
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

const $ = id => document.getElementById(id);
const symbols = 'H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og'.split(' ');
symbols.forEach((symbol, index) => $('element').add(new Option(`${symbol} (${index + 1})`, index + 1)));
$('element').value = '6';
let editor;
let filename = 'Untitled';
let busy = false;
let pickedAtomIndex = -1;
let pickedLabel;
const message = (text, error = false) => { $('status').textContent = text; $('status').dataset.error = String(error); };
const toolHelp = {
  AlignTool: 'Pick the atom to move to the origin, then optionally a second atom to align to the chosen axis.',
  BondCentric: 'Pick a bond, then right-drag one of its atoms to change its length.',
  LabelEditor: 'Click an atom to edit its label.',
  Manipulator: 'Drag an atom to move it. Select several atoms first to move them together.',
  MeasureTool: 'Click up to four atoms to measure distances, angles, and dihedrals. Double-click to clear.',
};

function setupPlugins(state) {
  const tools = new Map(state.tools.map(tool => [tool.id, tool]));
  const order = ['navigate', 'draw', 'select'];
  for (const id of new Set([...order, ...tools.keys()])) {
    const tool = tools.get(id);
    if (!tool) continue;
    const button = document.createElement('button');
    button.dataset.tool = id;
    button.textContent = tool.label;
    button.onclick = () => action(() => editor.setTool(id));
    $('tools').append(button);
  }
  for (const style of state.displayStyles) {
    const label = document.createElement('label');
    label.className = 'check';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.dataset.style = style.id;
    input.onchange = () => action(() => editor.setDisplayStyle(style.id, input.checked), false);
    label.append(input, style.label);
    $('display-styles').append(label);
  }
}

function render(state) {
  $('document-name').textContent = `${filename}${state.modified ? ' *' : ''}`;
  $('counts').textContent = `${state.atomCount} atoms · ${state.bondCount} bonds`;
  $('undo').disabled = !state.canUndo;
  $('redo').disabled = !state.canRedo;
  document.querySelectorAll('[data-tool]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.tool === state.tool)));
  $('draw-options').hidden = state.tool !== 'draw';
  $('align-options').hidden = state.tool !== 'AlignTool';
  const showLabel = state.tool === 'LabelEditor' && state.pickedAtomIndex >= 0;
  if (showLabel && ($('label-options').hidden ||
      pickedAtomIndex !== state.pickedAtomIndex || pickedLabel !== state.pickedLabel)) {
    $('atom-label').value = state.pickedLabel;
  }
  pickedAtomIndex = state.pickedAtomIndex;
  pickedLabel = state.pickedLabel;
  $('label-options').hidden = !showLabel;
  $('tool-help').textContent = toolHelp[state.tool] || '';
  $('tool-help').hidden = !toolHelp[state.tool];
  for (const input of $('display-styles').querySelectorAll('input'))
    input.checked = state.displayStyles.some(style => style.id === input.dataset.style && style.enabled);
  $('element').value = String(state.drawOptions.atomicNumber);
  $('bond').value = String(state.drawOptions.bondOrder);
  $('hydrogens').checked = state.drawOptions.adjustHydrogens;
}
async function confirmReplacement() {
  if (!editor.state.modified) return true;
  const dialog = $('discard-dialog');
  dialog.returnValue = 'cancel';
  const result = new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'discard'), { once: true }));
  dialog.showModal();
  return result;
}
async function action(fn, focus = true) {
  if (busy || !editor) return;
  busy = true;
  try { await fn(); render(editor.state); if (focus) $('viewport').focus(); }
  catch (error) { message(error.message, true); }
  finally { busy = false; }
}

$('new').onclick = () => action(async () => {
  if (await confirmReplacement()) { editor.newMolecule(); filename = 'Untitled'; message(''); }
});
$('open').onclick = () => $('file').click();
$('file').onchange = () => action(async () => {
  const file = $('file').files[0];
  $('file').value = '';
  if (!file) return;
  // Read first, then confirm against the current document. Editing may have
  // continued while the browser was reading the file.
  const text = await file.text();
  if (!(await confirmReplacement())) return;
  const result = editor.loadMolecule(text, file.name.split('.').pop().toLowerCase());
  filename = file.name;
  message(result.notice || 'Molecule opened.');
});
$('download').onclick = () => action(() => {
  const format = $('format').value;
  const text = editor.exportMolecule(format);
  const link = document.createElement('a');
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  link.href = url;
  link.download = `${filename.replace(/\.[^.]+$/, '')}.${format}`;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  // Other exports may lose properties, so only CJSON clears the unsaved marker.
  if (format === 'cjson') editor.markSaved();
  message(format === 'cjson' ? 'Download requested.' : 'Export requested. Use CJSON to preserve Avogadro data.');
});
$('label-options').onsubmit = event => {
  event.preventDefault();
  action(() => { editor.setPickedLabel($('atom-label').value); message(''); });
};
$('align').onclick = () => action(() => { editor.alignPickedAtoms($('align-axis').value); message(''); });
for (const id of ['element', 'bond', 'hydrogens']) $(id).onchange = () => action(() => editor.setDrawOptions({ atomicNumber: Number($('element').value), bondOrder: Number($('bond').value), adjustHydrogens: $('hydrogens').checked }), false);
for (const [id, method] of [['undo', 'undo'], ['redo', 'redo'], ['delete', 'deleteSelection'], ['reset', 'resetCamera']]) $(id).onclick = () => action(() => editor[method]());
$('viewport').addEventListener('contextmenu', event => event.preventDefault());
$('viewport').addEventListener('keydown', event => {
  if (busy || !editor || $('discard-dialog').open) return;
  if ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) {
    event.preventDefault(); event.stopPropagation();
    action(() => event.key.toLowerCase() === 'y' || event.shiftKey ? editor.redo() : editor.undo());
  } else if (event.key === 'Delete' || event.key === 'Backspace') {
    event.preventDefault(); event.stopPropagation(); action(() => editor.deleteSelection());
  }
}, true);
window.addEventListener('beforeunload', event => {
  if (editor?.state.modified) { event.preventDefault(); event.returnValue = ''; }
});

try {
  if (!globalThis.WebAssembly) throw new Error('This browser does not support WebAssembly.');
  if (!globalThis.crossOriginIsolated || !globalThis.SharedArrayBuffer) throw new Error('This build needs cross-origin isolation. Serve it with serve-wasm.py or configure COOP: same-origin and COEP: require-corp.');
  const probe = document.createElement('canvas').getContext('webgl2');
  if (!probe) throw new Error('WebGL 2 is unavailable. Enable browser hardware acceleration or use a supported device.');
  probe.getExtension('WEBGL_lose_context')?.loseContext();
  const instance = await qtLoad({
    qt: { containerElements: [$('viewport')], entryFunction: globalThis.createAvogadroWeb,
      onExit: details => { $('controls').disabled = true; message(`Avogadro stopped: ${details.text || details.code || 'runtime exited'}`, true); } },
    print: text => console.info(text), printErr: text => console.error(text),
  });
  // Capture wheel events before Qt sees them. Combine the events Chrome
  // delivers within a frame and cap the resulting camera movement.
  const viewport = $('viewport');
  let wheelPixels = 0;
  let wheelFrame = 0;
  viewport.addEventListener('wheel', event => {
    event.preventDefault();
    event.stopPropagation();
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
  }, { capture: true, passive: false });
  editor = new AvogadroEditor(instance);
  setupPlugins(editor.state);
  editor.addEventListener('statechange', event => render(event.detail));
  new ResizeObserver(() => instance.qtResizeContainerElement($('viewport'))).observe($('viewport'));
  $('loading').hidden = true; $('controls').disabled = false;
  render(editor.state);
} catch (error) {
  console.error(error);
  $('loading').textContent = error.message;
  message('The editor could not start.', true);
}

// SPDX-License-Identifier: BSD-3-Clause
import { OpenBabelClient } from './openbabel-client.js';
import { openBabelAvailable } from './openbabel-config.js';
// The wrapper owns no C++ pointers; all messages are plain values.
export class AvogadroEditor extends EventTarget {
  constructor(instance) {
    super();
    this.instance = instance;
    this.openBabel = new OpenBabelClient();
    this.openBabelPending = false;
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
  get canUseOpenBabel() {
    return openBabelAvailable && typeof this.instance.loadGeneratedMolecule === 'function' &&
      typeof this.instance.applyPartialCharges === 'function';
  }
  async generate3DFromSmiles(smiles) {
    if (!this.canUseOpenBabel) throw new Error('This build does not include Open Babel.');
    const state = this.state;
    if (this.openBabelPending || state.calculating)
      throw new Error('Wait for the current calculation to finish.');
    this.openBabelPending = true;
    try {
      const result = await this.openBabel.generate3DFromSmiles(smiles);
      return { ...result, revision: state.revision };
    } finally {
      this.openBabelPending = false;
    }
  }
  loadGeneratedMolecule(result) {
    return this.check(JSON.parse(this.instance.loadGeneratedMolecule(result.molfile, result.revision)));
  }
  async calculateGasteigerCharges() {
    if (!this.canUseOpenBabel) throw new Error('This build does not include Open Babel.');
    if (this.openBabelPending) throw new Error('An Open Babel calculation is already running.');
    const state = this.state;
    if (!state.atomCount || state.calculating)
      throw new Error('Open a molecule and finish the current calculation first.');
    const molfile = this.exportMolecule('mol');
    this.openBabelPending = true;
    try {
      const result = await this.openBabel.gasteigerCharges(molfile);
      this.check(JSON.parse(this.instance.applyPartialCharges(state.revision, JSON.stringify(result.charges))));
      return result;
    } finally {
      this.openBabelPending = false;
    }
  }
  check(result) { if (!result.ok) throw new Error(result.error || 'Unable to process this molecule.'); return result; }
  deleteSelection() { this.instance.deleteSelection(); }
  undo() { this.instance.undo(); }
  redo() { this.instance.redo(); }
  resetCamera() { this.instance.resetCamera(); }
  markSaved() { this.instance.markSaved(); }
}

const $ = id => document.getElementById(id);
const icons = {
  new: '<path d="M12 5v14M5 12h14"/>',
  open: '<path d="M3 7V5h7l2 3h9v12H3V7Zm0 3h18"/>',
  undo: '<path d="m8 5-5 5 5 5M3 10h11a6 6 0 0 1 6 6v3"/>',
  redo: '<path d="m16 5 5 5-5 5m5-5H10a6 6 0 0 0-6 6v3"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  delete: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
  fit: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/><circle cx="12" cy="12" r="3"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  shield: '<path d="m12 3 8 3v6c0 4-4 7-8 9-4-2-8-5-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1"/>',
  moon: '<path d="M20 15A9 9 0 0 1 9 4a9 9 0 1 0 11 11Z"/>',
  navigate: '<ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(-35 12 12)"/><circle cx="12" cy="12" r="7"/>',
  draw: '<path d="m4 16-1 5 5-1L21 7l-4-4L4 16Zm10-10 4 4M4 16l4 4"/>',
  select: '<path d="m5 3 14 10-7 1-3 7L5 3Z"/>',
  MeasureTool: '<path d="m3 16 13-13 5 5L8 21l-5-5Zm4-4 3 3m1-7 3 3m1-7 3 3"/>',
  Manipulator: '<path d="M12 2v20M2 12h20m-13-7 3-3 3 3m-6 14 3 3 3-3M5 9l-3 3 3 3m14-6 3 3-3 3"/>',
  AlignTool: '<path d="M4 3v18m0-9h17M8 6h9M8 18h5m4-9 4 3-4 3"/>',
  BondCentric: '<circle cx="5" cy="17" r="3"/><circle cx="19" cy="7" r="3"/><path d="m8 15 8-6M4 7a8 8 0 0 1 9-4m-2-2 2 2-2 2m9 12a8 8 0 0 1-9 4"/>',
  LabelEditor: '<path d="M4 5h16M12 5v15M8 20h8"/>',
  AutoOpt: '<path d="m13 2-9 12h7l-1 8 10-13h-8l1-7Z"/>',
};
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon');
  svg.innerHTML = icons[name] || icons.panel;
  return svg;
}
document.querySelectorAll('[data-icon]').forEach(el => el.prepend(icon(el.dataset.icon)));
let runtimeReady = false;
function setReady(ready) {
  runtimeReady = ready;
  $('controls').disabled = !ready;
  $('document-controls').disabled = !ready;
  $('viewport').inert = !ready;
  $('smiles').disabled = !ready;
  $('generate-3d').disabled = !ready;
  if (!ready) $('smiles-dialog').close();
}
setReady(false);
function applyTheme() {
  const theme = document.documentElement.dataset.theme;
  const label = `Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`;
  $('theme').replaceChildren(icon(theme === 'dark' ? 'sun' : 'moon'));
  $('theme').setAttribute('aria-label', label);
  $('theme').title = label;
  document.querySelector('meta[name="theme-color"]').content = theme === 'dark' ? '#151a21' : '#ffffff';
  if (runtimeReady) {
    document.body.classList.toggle('runtime-fixed-canvas', !editor.setTheme(theme));
  }
}
$('theme').onclick = () => {
  document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem('avogadro-theme', document.documentElement.dataset.theme); } catch {}
  applyTheme();
};
applyTheme();
function showInspector(show) {
  document.body.classList.toggle('inspector-collapsed', !show);
  $('inspector-toggle').setAttribute('aria-expanded', String(show));
}
showInspector(!matchMedia('(max-width: 999px)').matches);
$('inspector-toggle').onclick = () => showInspector(document.body.classList.contains('inspector-collapsed'));
$('inspector-close').onclick = () => { showInspector(false); $('inspector-toggle').focus(); };
const tabs = [...document.querySelectorAll('[role="tab"]')];
function activateTab(tab) {
  for (const candidate of tabs) {
    const selected = candidate === tab;
    candidate.setAttribute('aria-selected', String(selected));
    candidate.tabIndex = selected ? 0 : -1;
    $(candidate.getAttribute('aria-controls')).hidden = !selected;
  }
}
for (const [index, tab] of tabs.entries()) {
  tab.onclick = () => activateTab(tab);
  tab.onkeydown = event => {
    const positions = { ArrowRight: (index + 1) % tabs.length, ArrowLeft: (index + tabs.length - 1) % tabs.length, Home: 0, End: tabs.length - 1 };
    if (!(event.key in positions)) return;
    event.preventDefault();
    const next = tabs[positions[event.key]];
    activateTab(next); next.focus();
  };
}
function closeExport() {
  $('export-menu').hidden = true;
  $('export-toggle').setAttribute('aria-expanded', 'false');
}
$('export-toggle').onclick = () => {
  const open = $('export-menu').hidden;
  $('export-menu').hidden = !open;
  $('export-toggle').setAttribute('aria-expanded', String(open));
  if (open) $('format').focus();
};
document.addEventListener('click', event => {
  if (!event.target.closest('.export-wrapper')) closeExport();
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || $('discard-dialog').open) return;
  if (!$('export-menu').hidden) { closeExport(); $('export-toggle').focus(); }
  else if (matchMedia('(max-width: 999px)').matches && !document.body.classList.contains('inspector-collapsed')) {
    showInspector(false); $('inspector-toggle').focus();
  }
});
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
  draw: 'Place atoms and connect them with bonds. Start with an element below.',
  navigate: 'Drag to rotate, right-drag to pan, and scroll to zoom. Use Fit molecule to reset the view.',
  select: 'Click an atom or drag a rectangle to select. Press Delete to remove the selection.',
  AutoOpt: 'Continuously refine the geometry while you work. Choose a force field, then press Start.',
  AlignTool: 'Pick the atom to move to the origin, then optionally a second atom to align to the chosen axis.',
  BondCentric: 'Pick a bond, then right-drag one of its atoms to change its length.',
  LabelEditor: 'Click an atom to edit its label.',
  Manipulator: 'Drag an atom to move it. Select several atoms first to move them together.',
  MeasureTool: 'Click up to four atoms to measure distances, angles, and dihedrals. Double-click to clear.',
};

const toolTooltip = document.createElement('div');
toolTooltip.className = 'tool-tooltip';
toolTooltip.id = 'tool-tooltip';
toolTooltip.setAttribute('role', 'tooltip');
toolTooltip.hidden = true;
document.body.append(toolTooltip);
function showToolTooltip(button, text) {
  const rect = button.getBoundingClientRect();
  toolTooltip.textContent = text;
  toolTooltip.style.left = `${rect.right + 12}px`;
  toolTooltip.style.top = `${rect.top + 10}px`;
  toolTooltip.hidden = false;
}

async function registerMoleculeTool() {
  const context = document.modelContext ?? navigator.modelContext;
  if (typeof context?.registerTool !== 'function') return;

  await context.registerTool({
    name: 'inspect_molecule',
    description: 'Read the current Avogadro molecule, including unsaved edits. Returns atoms and bond orders for verifying composition and connectivity. Bond endpoints are zero-based atom indices.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    execute() {
      try {
        const { atomCount, bondCount, modified } = editor.state;
        if (atomCount === 0) return { atomCount, bondCount, modified, atoms: [], bonds: [] };

        const molecule = JSON.parse(editor.exportMolecule());
        const atoms = molecule.atoms.elements.number.map(atomicNumber => ({ atomicNumber }));
        const endpoints = molecule.bonds?.connections.index ?? [];
        const bonds = (molecule.bonds?.order ?? []).map((order, index) => ({
          begin: endpoints[2 * index],
          end: endpoints[2 * index + 1],
          order,
        }));
        return { atomCount, bondCount, modified, atoms, bonds };
      } catch {
        return { error: 'Unable to inspect the current molecule.' };
      }
    },
  });
}

function setupPlugins(state) {
  const tools = new Map(state.tools.map(tool => [tool.id, tool]));
  const order = ['navigate', 'draw', 'select'];
  for (const id of new Set([...order, ...tools.keys()])) {
    const tool = tools.get(id);
    if (!tool) continue;
    const button = document.createElement('button');
    button.dataset.tool = id;
    const shortNames = { navigate: 'Navigate', draw: 'Draw', select: 'Select', MeasureTool: 'Measure', Manipulator: 'Move', AlignTool: 'Align', BondCentric: 'Bond', LabelEditor: 'Label', AutoOpt: 'Optimize' };
    const label = document.createElement('span');
    label.className = 'tool-label';
    label.textContent = shortNames[id] || tool.label;
    button.append(icon(id), label);
    button.setAttribute('aria-label', tool.label);
    button.setAttribute('aria-describedby', 'tool-tooltip');
    button.addEventListener('mouseenter', () => showToolTooltip(button, tool.label));
    button.addEventListener('focus', () => showToolTooltip(button, tool.label));
    for (const event of ['mouseleave', 'blur', 'click']) button.addEventListener(event, () => { toolTooltip.hidden = true; });
    button.addEventListener('keydown', event => { if (event.key === 'Escape') toolTooltip.hidden = true; });
    button.onclick = () => { activateTab($('tab-tool')); action(() => editor.setTool(id)); };
    $('tools').append(button);
  }
  $('display-unavailable').hidden = state.displayStyles.length > 0;
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

function renderCalculations(state) {
  const working = state.calculating;
  $('calculations').hidden = !state.canOptimize && !state.canRenderSurfaces && !editor.canUseOpenBabel;
  $('gasteiger-charges').hidden = !editor.canUseOpenBabel;
  $('calculation-unavailable').hidden = !$('calculations').hidden;
  $('smiles-open').hidden = !editor.canUseOpenBabel;
  $('smiles-open').disabled = working || editor.openBabelPending;
  $('smiles').disabled = !runtimeReady || working || editor.openBabelPending;
  $('generate-3d').disabled = !runtimeReady || working || editor.openBabelPending;
  $('force-field-label').hidden = !state.canOptimize;
  $('optimize').hidden = !state.canOptimize;
  $('surface-label').hidden = !state.canRenderSurfaces;
  $('render-surface').hidden = !state.canRenderSurfaces;
  $('optimize').disabled = working || state.atomCount === 0;
  $('render-surface').disabled = working || state.atomCount === 0;
  $('gasteiger-charges').disabled = working || editor.openBabelPending || state.atomCount === 0;
  $('force-field').disabled = working;
  $('surface-type').disabled = working;
  $('orbital').disabled = working;
  $('viewport').inert = state.calculating || !runtimeReady;
  for (const id of ['element', 'bond', 'hydrogens', 'align', 'align-axis', 'atom-label']) $(id).disabled = working;
  $('label-options').querySelector('button').disabled = working;
  for (const id of ['new', 'open', 'download', 'export-toggle', 'delete']) $(id).disabled = working;
  for (const button of $('tools').querySelectorAll('button')) button.disabled = working;
  $('undo').disabled ||= working;
  $('redo').disabled ||= working;
  $('calculation-status').textContent = state.calculationMessage;
  $('calculation-status').dataset.error = String(state.calculationError);

  const type = $('surface-type');
  type.querySelector('[value="renderOrbital"]').disabled = !state.orbitalCount;
  type.querySelector('[value="renderElectronDensity"]').disabled = !state.orbitalCount;
  type.querySelector('[value="renderCube"]').disabled = !state.cubeCount;
  if (type.selectedOptions[0]?.disabled) type.value = 'renderVDW';
  $('orbital-label').hidden = type.value !== 'renderOrbital';

  const orbital = $('orbital');
  const key = `${state.orbitalCount}:${state.homo}`;
  if (orbital.dataset.basis !== key) {
    orbital.dataset.basis = key;
    orbital.replaceChildren();
    for (let index = 1; index <= state.orbitalCount; ++index) {
      const label = index === state.homo ? ' (HOMO)' : index === state.homo + 1 ? ' (LUMO)' : '';
      orbital.add(new Option(`${index}${label}`, index));
    }
    if (state.orbitalCount > 0) {
      const homo = Math.max(1, Math.min(state.homo, state.orbitalCount));
      orbital.value = String(homo);
    }
  }
}

function render(state) {
  $('document-name').textContent = `${filename}${state.modified ? ' *' : ''}`;
  $('document-state').textContent = state.modified ? 'Unsaved changes' : state.atomCount ? 'Molecule ready' : 'New molecule';
  $('document-state').classList.toggle('modified', state.modified);
  $('empty-state').hidden = state.atomCount !== 0;
  $('active-tool').textContent = state.tools.find(tool => tool.id === state.tool)?.label || 'Tool';
  $('canvas-help').textContent = state.tool === 'draw' ? 'Click to add an atom · Drag to create a bond · Scroll to zoom' : (toolHelp[state.tool] || 'Drag to rotate · Scroll to zoom');
  $('counts').textContent = `${state.atomCount} atoms · ${state.bondCount} bonds`;
  $('undo').disabled = !state.canUndo;
  $('redo').disabled = !state.canRedo;
  renderCalculations(state);
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
  for (const input of $('display-styles').querySelectorAll('input')) {
    input.disabled = state.calculating;
    input.checked = state.displayStyles.some(style => style.id === input.dataset.style && style.enabled);
  }
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
  if (busy || !editor || !runtimeReady) return;
  busy = true;
  try { await fn(); render(editor.state); if (focus) $('viewport').focus(); }
  catch (error) { message(error.message, true); }
  finally { busy = false; }
}

$('new').onclick = () => action(async () => {
  if (await confirmReplacement()) { editor.newMolecule(); filename = 'Untitled'; message(''); }
});
$('open').onclick = () => $('file').click();
$('smiles-open').onclick = () => {
  closeExport();
  $('smiles-dialog').showModal();
  $('smiles').focus();
};
$('smiles-cancel').onclick = () => $('smiles-dialog').close();
$('smiles-form').onsubmit = event => {
  event.preventDefault();
  $('smiles-dialog').close();
  action(async () => {
    message('Generating 3D coordinates…');
    const generation = editor.generate3DFromSmiles($('smiles').value);
    render(editor.state);
    try {
      const result = await generation;
      if (editor.state.revision !== result.revision)
        throw new Error('The molecule changed during 3D generation. Run it again.');
      if (!(await confirmReplacement())) { message(''); return; }
      editor.loadGeneratedMolecule(result);
      filename = 'Generated molecule';
      message(result.optimized ? 'Generated 3D molecule with UFF relaxation.'
        : 'Generated 3D molecule. UFF parameters were unavailable for relaxation.');
    } finally {
      render(editor.state);
    }
  });
};
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
  closeExport();
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
$('optimize').onclick = () => action(() => editor.calculate('optimize', { method: $('force-field').value }), false);
$('gasteiger-charges').onclick = () => action(async () => {
  message('Calculating Gasteiger partial charges…');
  const calculation = editor.calculateGasteigerCharges();
  render(editor.state);
  try {
    const result = await calculation;
    message(`Assigned Gasteiger partial charges to ${result.charges.length} atoms.`);
  } finally {
    render(editor.state);
  }
}, false);
$('surface-type').onchange = () => renderCalculations(editor.state);
$('render-surface').onclick = () => action(() => {
  const type = $('surface-type').value;
  const options = { resolution: type === 'renderOrbital' || type === 'renderElectronDensity' ? 0.25 : 0.15 };
  if (type === 'renderOrbital') {
    const orbital = $('orbital').value;
    if (!orbital) throw new Error('Select a molecular orbital.');
    options.orbital = Number(orbital);
  }
  editor.calculate(type, options);
}, false);
$('label-options').onsubmit = event => {
  event.preventDefault();
  action(() => { editor.setPickedLabel($('atom-label').value); message(''); });
};
$('align').onclick = () => action(() => { editor.alignPickedAtoms($('align-axis').value); message(''); });
for (const id of ['element', 'bond', 'hydrogens']) $(id).onchange = () => action(() => editor.setDrawOptions({ atomicNumber: Number($('element').value), bondOrder: Number($('bond').value), adjustHydrogens: $('hydrogens').checked }), false);
for (const [id, method] of [['undo', 'undo'], ['redo', 'redo'], ['delete', 'deleteSelection'], ['reset', 'resetCamera']]) $(id).onclick = () => action(() => editor[method]());
$('viewport').addEventListener('contextmenu', event => event.preventDefault());
$('viewport').addEventListener('keydown', event => {
  if (busy || !editor || !runtimeReady || editor.state.calculating || editor.state.autoOptimizing || $('discard-dialog').open) return;
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
      onExit: details => { setReady(false); closeExport(); message(`Avogadro stopped: ${details.text || details.code || 'runtime exited'}`, true); } },
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
    if (!runtimeReady || editor?.state.calculating) return;
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
  $('loading').hidden = true; setReady(true); applyTheme();
  render(editor.state);
  registerMoleculeTool().catch(error => console.warn('Unable to register the Avogadro WebMCP tool.', error));
} catch (error) {
  console.error(error);
  setReady(false);
  $('loading').dataset.error = 'true';
  $('loading-title').textContent = 'Unable to start Avogadro';
  $('loading-message').textContent = /fetching of the wasm|failed to.*wasm/i.test(error.message)
    ? 'The WebAssembly (WASM) runtime could not be loaded. Reload the page, or check that the editor files are served together.'
    : error.message;
  message('The editor could not start.', true);
}

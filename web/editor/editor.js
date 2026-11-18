// SPDX-License-Identifier: BSD-3-Clause
import { createAvogadroEditor } from './core/avogadro-editor.js';
import { describeImport, fetchMolecule, fileFormat, maxImportBytes, prepareImport, supportsRemoteImport } from './molecule-import.js';
import { createShareLink, decodeSnapshot, parseStartupLink } from './share-link.js';

const $ = id => document.getElementById(id);
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon');
  const use = document.createElementNS(svg.namespaceURI, 'use');
  const id = `icon-${name}`;
  use.setAttribute('href', document.getElementById(id) ? `#${id}` : '#icon-panel');
  svg.append(use);
  return svg;
}
document.querySelectorAll('[data-icon]').forEach(el => el.prepend(icon(el.dataset.icon)));
let runtimeReady = false;
function setReady(ready) {
  runtimeReady = ready;
  $('controls').disabled = !ready;
  $('document-controls').disabled = !ready;
  $('copy-link').hidden = !supportsRemoteImport(location);
  $('copy-link').disabled = !ready;
  $('viewport').inert = !ready;
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
try {
  document.documentElement.dataset.theme = localStorage.getItem('avogadro-theme') === 'light' ? 'light' : 'dark';
} catch {}
applyTheme();
function showInspector(show) {
  document.body.classList.toggle('inspector-collapsed', !show);
  $('inspector-toggle').setAttribute('aria-expanded', String(show));
}
const compactLayout = matchMedia('(max-width: 999px), (max-height: 500px) and (pointer: coarse)');
showInspector(!compactLayout.matches);
compactLayout.addEventListener('change', event => showInspector(!event.matches));
$('inspector-toggle').onclick = () => showInspector(document.body.classList.contains('inspector-collapsed'));
$('inspector-close').onclick = () => { showInspector(false); $('inspector-toggle').focus(); };
const deviceInput = matchMedia('(pointer: coarse)');
deviceInput.addEventListener('change', () => {
  if (runtimeReady) render(editor.state);
});
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
  else if (compactLayout.matches && !document.body.classList.contains('inspector-collapsed')) {
    showInspector(false); $('inspector-toggle').focus();
  }
});
const symbols = 'H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og'.split(' ');
symbols.forEach((symbol, index) => $('element').add(new Option(`${symbol} (${index + 1})`, index + 1)));
$('element').value = '6';
let editor;
let filename = 'Untitled';
let busy = false;
let pendingImport;
let provenance;
const extraImportOrigins = (document.querySelector('meta[name="avogadro-import-origins"]')?.content ?? '').split(/\s+/);
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

const touchToolHelp = {
  draw: 'Tap to add an atom · Drag to bond · Two fingers to pan or zoom',
  navigate: 'Drag to rotate · Two fingers to pan or zoom',
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

async function registerEditorTools() {
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
  $('agent-control').hidden = false;
  const consent = $('allow-agent-edits');
  consent.checked = false;
  consent.addEventListener('change', () => {
    if (!consent.checked) {
      if ($('agent-dialog').open) $('agent-dialog').close('cancel');
      cancelLookup();
    }
  });
  let active = false;
  const string = { type: 'string' };
  const choice = values => ({ type: 'string', enum: values });
  function confirmRequest(prompt) {
    const dialog = $('agent-dialog');
    $('agent-request').textContent = prompt;
    dialog.returnValue = 'cancel';
    return new Promise(resolve => {
      dialog.addEventListener('close', () => resolve(dialog.returnValue === 'allow'), { once: true });
      dialog.showModal();
    });
  }
  $('agent-deny').onclick = () => $('agent-dialog').close('cancel');
  $('agent-approve').onclick = event => {
    if (event.isTrusted) $('agent-dialog').close('allow');
  };

  async function tool(name, description, properties, required, edits, execute) {
    await context.registerTool({
      name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false },
      annotations: { readOnlyHint: !edits },
      async execute(input) {
        if (!input || typeof input !== 'object' || Array.isArray(input) ||
            Object.keys(input).some(key => !Object.hasOwn(properties, key)) ||
            required.some(key => !Object.hasOwn(input, key))) return { error: 'Invalid tool arguments.' };
        for (const [key, value] of Object.entries(input)) {
          const type = properties[key];
          if (type.type === 'array') {
            if (!Array.isArray(value) || value.length !== type.maxItems || value.some(n => !Number.isFinite(n)))
              return { error: 'Invalid tool arguments.' };
            continue;
          }
          if (typeof value !== type.type || type.enum && !type.enum.includes(value) ||
              type.maxLength && value.length > type.maxLength) return { error: 'Invalid tool arguments.' };
        }
        if (!runtimeReady) return { error: 'The editor is unavailable.' };
        if (edits && !consent.checked) return { error: 'Enable agent edits in the Tool inspector for this session.' };
        if (edits && (active || busy || pendingImport || editor.state.calculating)) return { error: 'The editor is busy.' };
        if (edits) active = true;
        try {
          const result = await execute(input);
          if (edits) render(editor.state);
          return result ?? { ok: true };
        } catch (error) {
          return { error: error.message || 'The tool could not complete.' };
        } finally {
          if (edits) active = false;
        }
      },
    });
  }
  async function authorize(prompt) {
    if (!(await confirmRequest(prompt)) || !consent.checked || !runtimeReady || busy || editor.state.calculating)
      throw new Error('Request cancelled.');
  }
  await tool('editor_capabilities', 'List available editor tools, display styles and molecule actions.', {}, [], false, () => {
    const { tools, displayStyles, actions, canOptimize, canRenderSurfaces } = editor.state;
    return { tools, displayStyles, actions, canOptimize, canRenderSurfaces };
  });
  if (typeof editor.instance.captureViewport === 'function')
    await tool('capture_viewport', 'Capture the molecular viewport as a PNG, at most 1024 pixels on either side.', {}, [], false,
      () => editor.captureViewport());
  await tool('set_editor_tool', 'Activate an advertised editing tool.', { id: string }, ['id'], true, ({ id }) => editor.setTool(id));
  await tool('set_editor_theme', 'Change the editor theme.', { theme: choice(['light', 'dark']) }, ['theme'], true, ({ theme }) => {
    document.documentElement.dataset.theme = theme;
    applyTheme();
  });
  await tool('set_display_style', 'Enable or disable an advertised display style.',
    { id: string, enabled: { type: 'boolean' } }, ['id', 'enabled'], true, ({ id, enabled }) => editor.setDisplayStyle(id, enabled));
  await tool('edit_molecule', 'Undo, redo or delete selected atoms in the current document.',
    { operation: choice(['undo', 'redo', 'deleteSelection']) }, ['operation'], true, ({ operation }) => editor[operation]());
  await tool('load_molecule', 'Replace the current molecule after confirmation. Supply molecule text in a supported format.',
    { format: choice(['cjson', 'mol', 'sdf', 'xyz', 'pdb', 'fchk', 'molden', 'cube']), text: { type: 'string', maxLength: maxImportBytes } },
    ['format', 'text'], true, async ({ format, text }) => {
      if (new TextEncoder().encode(text).length > maxImportBytes) throw new Error('Molecule exceeds the input limit.');
      await authorize(`Replace the current molecule with agent-supplied ${format.toUpperCase()} data? Any unsaved edits will be discarded.`);
      installMolecule({ text, format, filename: `Agent molecule.${format}` });
    });
  if (supportsRemoteImport(location))
    await tool('lookup_molecule', 'Look up a molecule with approval for the receiving service and document replacement.',
      { kind: choice(['name', 'cid', 'smiles', 'inchi', 'pdb', 'url']), value: { type: 'string', maxLength: 2048 }, format: string },
      ['kind', 'value'], true, async input => {
        const request = prepareImport(input, location, extraImportOrigins);
        await authorize(`Send “${input.value}” to ${request.url.origin} and open the result in this document?`);
        if (!await importRemote(request)) throw new Error('Lookup cancelled or failed.');
      });
  if (supportsRemoteImport(location) && typeof editor.instance.insertFragment === 'function')
    await tool('insert_fragment', 'Insert a PubChem 3D fragment into the current molecule after approval to send the identifier.',
      { kind: choice(['smiles', 'inchi']), value: { type: 'string', maxLength: 2048 } }, ['kind', 'value'], true,
      async input => {
        const request = prepareImport(input, location);
        await authorize(`Send “${input.value}” to ${request.url.origin} and insert the returned 3D fragment into this molecule?`);
        if (!await importRemote(request, true)) throw new Error('Insertion cancelled or failed.');
      });
  if (editor.state.canOptimize)
    await tool('optimize_geometry', 'Request user approval to optimize the molecular geometry.',
      { method: choice(['UFF', 'LJ']) }, ['method'], true, async ({ method }) => {
        await authorize(`Start geometry optimization with ${method}?`);
        editor.calculate('optimize', { method });
      });
  if (editor.state.canRenderSurfaces)
    await tool('render_molecule_surface', 'Request user approval to compute a molecular surface.',
      { type: choice(['renderVDW', 'renderSolventAccessible', 'renderSolventExcluded', 'renderOrbital', 'renderElectronDensity', 'renderCube']),
        orbital: { type: 'number' } }, ['type'], true, async ({ type, orbital }) => {
        const state = editor.state;
        if (type === 'renderOrbital' ? !Number.isInteger(orbital) || orbital < 1 || orbital > state.orbitalCount :
            orbital !== undefined) throw new Error('Invalid orbital selection.');
        if (type === 'renderElectronDensity' && !state.orbitalCount || type === 'renderCube' && !state.cubeCount)
          throw new Error('Surface data is unavailable.');
        await authorize(`Start the ${type} calculation?`);
        const options = { resolution: ['renderOrbital', 'renderElectronDensity'].includes(type) ? 0.25 : 0.15 };
        if (orbital !== undefined) options.orbital = orbital;
        editor.calculate(type, options);
      });
  await tool('run_molecule_action', 'Run an enabled molecule action. Calculations require a separate user confirmation.',
    { id: string, argument: { type: 'string', maxLength: 32 }, index: { type: 'number' },
      vectors: { type: 'array', items: { type: 'number' }, minItems: 9, maxItems: 9 },
      repeats: { type: 'array', items: { type: 'integer' }, minItems: 3, maxItems: 3 } },
    ['id'], true, async ({ id, ...args }) => {
      const item = editor.state.actions.find(action => action.id === id && action.enabled);
      if (!item) throw new Error('Unavailable action or invalid arguments.');
      const key = ['element', 'residue'].includes(item.argument) ? 'argument' : item.argument;
      if (Object.keys(args).length !== (key ? 1 : 0) || key && !Object.hasOwn(args, key))
        throw new Error('Invalid action arguments.');
      if (item.calculation) await authorize(`Start this calculation now? ${item.label}`);
      return editor.runAction(id, key ? { [item.argument]: args[key] } : {});
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
  $('calculations').hidden = !state.canOptimize && !state.canRenderSurfaces;
  $('calculation-unavailable').hidden = !$('calculations').hidden;
  $('force-field-label').hidden = !state.canOptimize;
  $('optimize').hidden = !state.canOptimize;
  $('surface-label').hidden = !state.canRenderSurfaces;
  $('render-surface').hidden = !state.canRenderSurfaces;
  $('optimize').disabled = working || state.atomCount === 0;
  $('render-surface').disabled = working || state.atomCount === 0;
  $('force-field').disabled = working;
  $('surface-type').disabled = working;
  $('orbital').disabled = working;
  $('viewport').inert = state.calculating || !runtimeReady;
  for (const id of ['element', 'bond', 'hydrogens', 'align', 'align-axis', 'atom-label']) $(id).disabled = working;
  $('label-options').querySelector('button').disabled = working;
  for (const id of ['new', 'open', 'lookup', 'download', 'export-toggle', 'delete']) $(id).disabled = working;
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

function renderActions(actions) {
  const select = $('molecule-action');
  $('molecule-actions').hidden = !actions.length;
  if (!actions.length) return;
  if (select.options.length !== actions.length || actions.some((item, i) => select.options[i].value !== item.id)) {
    const current = select.value;
    select.replaceChildren(...actions.map(item => new Option(item.label, item.id)));
    if (actions.some(item => item.id === current)) select.value = current;
  }
  for (const [i, item] of actions.entries()) select.options[i].disabled = !item.enabled;
  const item = actions.find(item => item.id === select.value);
  $('run-action').disabled = !item?.enabled;
  $('action-argument-label').hidden = !item?.argument;
  const labels = { element: 'Element symbol or number', residue: 'Residue name',
    index: 'Zero-based index', vectors: 'Lattice vectors a, b, c (nine components in Å)',
    repeats: 'Copies along a, b, c (three whole numbers)' };
  $('action-argument-name').textContent = labels[item?.argument] || '';
}
$('molecule-action').onchange = () => {
  const state = editor.state;
  const { argument } = state.actions.find(item => item.id === $('molecule-action').value) || {};
  const defaults = { index: '0', vectors: (state.cellVectors?.length ? state.cellVectors : [3,0,0,0,3,0,0,0,3]).join(' '), repeats: '2 1 1' };
  $('action-argument').value = defaults[argument] || '';
  $('action-result').textContent = '';
  renderActions(state.actions);
};
$('run-action').onclick = () => action(() => {
  const item = editor.state.actions.find(item => item.id === $('molecule-action').value);
  if (!item?.enabled) return;
  const text = $('action-argument').value.trim();
  let value = text;
  if (item.argument === 'index') value = text ? Number(text) : null;
  if (item.argument === 'repeats' || item.argument === 'vectors')
    value = text.split(/[\s,]+/).map(Number);
  const result = editor.runAction(item.id, item.argument ? { [item.argument]: value } : {});
  if (result.properties) {
    const labels = { index: 'Index', atomicNumber: 'Atomic number', formalCharge: 'Formal charge',
      positionAngstrom: 'Position (Å)', begin: 'First atom', end: 'Second atom', order: 'Bond order', lengthAngstrom: 'Length (Å)' };
    $('action-result').textContent = Object.entries(result.properties).map(([key, value]) =>
      `${labels[key] || key}: ${Array.isArray(value) ? value.join(', ') : value}`).join(' · ');
  }
  if (item.calculation) activateTab($('tab-calculations'));
}, false);

function render(state) {
  renderActions(state.actions);
  $('document-name').textContent = `${filename}${state.modified ? ' *' : ''}`;
  $('document-state').textContent = state.modified ? 'Unsaved changes' : state.atomCount ? 'Molecule ready' : 'New molecule';
  $('document-state').classList.toggle('modified', state.modified);
  $('copy-link').disabled = !runtimeReady || !state.atomCount || state.calculating;
  $('empty-state').hidden = state.atomCount !== 0;
  $('active-tool').textContent = state.tools.find(tool => tool.id === state.tool)?.label || 'Tool';
  const mouseHelp = state.tool === 'draw' ? 'Click to add an atom · Drag to create a bond · Scroll to zoom' : (toolHelp[state.tool] || 'Drag to rotate · Scroll to zoom');
  $('canvas-help').textContent = deviceInput.matches ? (touchToolHelp[state.tool] ?? 'Two fingers to pan or zoom') : mouseHelp;
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

async function fingerprint(text) {
  if (!globalThis.crypto?.subtle) return undefined;
  try {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return new Uint8Array(hash).join(',');
  } catch {
    return undefined;
  }
}

function recordProvenance(source, style) {
  provenance = undefined;
  if (!source) return;
  try {
    provenance = { source, style, fingerprint: fingerprint(editor.exportMolecule()) };
  } catch {
    // A molecule that cannot be exported has no shareable snapshot yet.
  }
}

function installMolecule({ text, filename: name, format, source }) {
  const result = editor.loadMolecule(text, format);
  filename = name;
  recordProvenance(source);
  message(result.notice || 'Molecule opened.');
}

function cancelLookup() {
  if (!pendingImport) return;
  pendingImport.abort();
  pendingImport = undefined;
  $('cancel-lookup').hidden = true;
  message('Lookup cancelled.');
}

async function importRemote(request, insert = false) {
  cancelLookup();
  const controller = new AbortController();
  const { signal } = controller;
  pendingImport = controller;
  $('cancel-lookup').hidden = false;
  message(`Fetching molecule from ${request.url.hostname}…`);
  try {
    const molecule = await fetchMolecule(request, signal);
    if (signal.aborted || !runtimeReady) return;
    let installed = false;
    await action(async () => {
      if (!insert && !(await confirmReplacement())) {
        message('Lookup cancelled.');
        return;
      }
      if (signal.aborted || !runtimeReady) return;
      if (insert) {
        editor.insertFragment(molecule.text);
        message('Fragment inserted.');
      } else {
        installMolecule(molecule);
      }
      installed = true;
    });
    return installed;
  } catch (error) {
    if (!signal.aborted) message(error.message, true);
  } finally {
    if (pendingImport === controller) {
      pendingImport = undefined;
      $('cancel-lookup').hidden = true;
    }
  }
}

$('lookup').hidden = !supportsRemoteImport(location);
$('lookup').onclick = () => {
  if (busy) return;
  cancelLookup();
  $('lookup-kind').onchange();
  $('lookup-dialog').showModal();
  $('lookup-value').focus();
};
$('lookup-kind').onchange = () => {
  $('lookup-error').hidden = true;
  const canInsert = typeof editor?.instance.insertFragment === 'function' &&
    ['smiles', 'inchi'].includes($('lookup-kind').value);
  $('insert-fragment-label').hidden = !canInsert;
  $('insert-fragment').checked = false;
  $('lookup-privacy').textContent = describeImport($('lookup-kind').value);
};
$('lookup-kind').onchange();
$('close-lookup').onclick = () => $('lookup-dialog').close();
$('cancel-lookup').onclick = cancelLookup;
$('lookup-form').onsubmit = event => {
  event.preventDefault();
  try {
    const request = prepareImport({ kind: $('lookup-kind').value, value: $('lookup-value').value }, location, extraImportOrigins);
    $('lookup-dialog').close();
    $('lookup-error').hidden = true;
    importRemote(request, !$('insert-fragment-label').hidden && $('insert-fragment').checked);
  } catch (error) {
    $('lookup-error').hidden = false;
    $('lookup-error').textContent = error.message;
  }
};

$('new').onclick = () => action(async () => {
  cancelLookup();
  if (await confirmReplacement()) {
    editor.newMolecule();
    filename = 'Untitled';
    provenance = undefined;
    message('');
  }
});
$('open').onclick = () => {
  cancelLookup();
  $('file').click();
};
function openLocal(file) {
  return action(async () => {
    cancelLookup();
    if (file.size > maxImportBytes) throw new Error('Molecule files are limited to 32 MiB.');
    const format = fileFormat(file.name);
    if (!format) throw new Error('Choose a molecule file with a supported file extension.');
    // Confirm against the live document after the file has been read.
    const text = await file.text();
    if (await confirmReplacement()) installMolecule({ text, filename: file.name, format });
  });
}
$('file').onchange = () => {
  const file = $('file').files[0];
  $('file').value = '';
  if (file) openLocal(file);
};
window.addEventListener('dragover', event => {
  if (!event.dataTransfer.types.includes('Files')) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = runtimeReady && !busy && !editor.state.calculating && document.body.dataset.mode !== 'view' ? 'copy' : 'none';
});
window.addEventListener('drop', event => {
  const { files } = event.dataTransfer;
  if (!event.dataTransfer.types.includes('Files')) return;
  event.preventDefault();
  if (!runtimeReady || busy || editor.state.calculating || document.body.dataset.mode === 'view') return;
  if (files.length === 1) openLocal(files[0]);
  else message('Drop one molecule file at a time.', true);
});
function downloadMolecule(text, format) {
  const link = document.createElement('a');
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  link.href = url;
  link.download = `${filename.replace(/\.[^.]+$/, '')}.${format}`;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('download').onclick = () => action(() => {
  const format = $('format').value;
  closeExport();
  downloadMolecule(editor.exportMolecule(format), format);
  // Other exports may lose properties, so only CJSON clears the unsaved marker.
  if (format === 'cjson') editor.markSaved();
  message(format === 'cjson' ? 'Download requested.' : 'Export requested. Use CJSON to preserve Avogadro data.');
});
$('copy-link').onclick = () => action(async () => {
  const text = editor.exportMolecule();
  const original = provenance;
  let source;
  if (original) {
    const hash = await fingerprint(text);
    if (hash && hash === await original.fingerprint) source = original.source;
  }
  const link = await createShareLink(location, document.body.dataset.mode, { source, style: original?.style, text });
  if (!link) {
    downloadMolecule(text, 'cjson');
    message('The molecule does not fit in a link. CJSON download requested.');
    return;
  }
  try {
    await navigator.clipboard.writeText(link);
    message('Molecule link copied.');
  } catch {
    $('share-link-value').value = link;
    $('copy-link-dialog').showModal();
    $('share-link-value').select();
  }
}, false);
$('optimize').onclick = () => action(() => editor.calculate('optimize', { method: $('force-field').value }), false);
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
  const history = (event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase());
  const deletion = event.key === 'Delete' || event.key === 'Backspace';
  if (!history && !deletion) return;
  if (document.body.dataset.mode === 'view') {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  if (busy || !editor || !runtimeReady || editor.state.calculating || editor.state.autoOptimizing || $('discard-dialog').open) return;
  event.preventDefault();
  event.stopPropagation();
  if (history) action(() => event.key.toLowerCase() === 'y' || event.shiftKey ? editor.redo() : editor.undo());
  else action(() => editor.deleteSelection());
}, true);
async function loadStartupLink() {
  try {
    const settings = parseStartupLink(location, editor.state);
    if (!settings) return;
    if (settings.source?.kind === 'cjson') {
      let installed = false;
      await action(async () => {
        const text = await decodeSnapshot(settings.source.value);
        if (!(await confirmReplacement()) || !runtimeReady) return;
        installMolecule({ text, filename: 'Shared molecule.cjson', format: 'cjson' });
        installed = true;
      }, false);
      if (!installed) return;
    } else if (settings.source) {
      const request = prepareImport(settings.source, location, extraImportOrigins);
      const dialog = $('link-lookup-dialog');
      $('link-lookup-privacy').textContent = request.source.kind === 'url'
        ? `The editor will request this file from ${request.url.hostname}.`
        : describeImport(request.source.kind);
      dialog.returnValue = 'cancel';
      const confirm = new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'fetch'), { once: true }));
      dialog.showModal();
      if (!(await confirm) || !(await importRemote(request))) return;
    }
    if (settings.style) {
      for (const style of editor.state.displayStyles)
        editor.setDisplayStyle(style.id, style.id === settings.style);
      if (provenance) recordProvenance(provenance.source, settings.style);
    }
    if (settings.tool) editor.setTool(settings.tool);
    if (settings.theme) {
      document.documentElement.dataset.theme = settings.theme;
      applyTheme();
    }
    document.body.dataset.mode = settings.mode;
    render(editor.state);
  } catch (error) {
    message(error.message, true);
  }
}

window.addEventListener('beforeunload', event => {
  if (editor?.state.modified) { event.preventDefault(); event.returnValue = ''; }
});

try {
  editor = await createAvogadroEditor($('viewport'), {
    onExit: details => { setReady(false); cancelLookup(); closeExport(); message(`Avogadro stopped: ${details.text || details.code || 'runtime exited'}`, true); },
    print: text => console.info(text), printErr: text => console.error(text),
  });
  setupPlugins(editor.state);
  editor.addEventListener('statechange', event => {
    $('action-result').textContent = '';
    render(event.detail);
  });
  $('loading').hidden = true; setReady(true); applyTheme();
  render(editor.state);
  loadStartupLink();
  registerEditorTools().catch(error => console.warn('Unable to register the Avogadro WebMCP tool.', error));
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

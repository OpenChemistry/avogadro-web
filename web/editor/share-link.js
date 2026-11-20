// SPDX-License-Identifier: BSD-3-Clause
const maxLinkLength = 8192;
const maxSnapshotBytes = 1024 * 1024;
const sourceKeys = ['pdb', 'cid', 'url', 'name', 'smiles', 'cjson'];
const optionKeys = new Set([...sourceKeys, 'type', 'style', 'tool', 'theme', 'mode']);
const styleAliases = new Map([['stick', 'Licorice'], ['sphere', 'Van der Waals'],
  ['line', 'Wireframe'], ['cartoon', 'Cartoons']]);
const toolAliases = new Map([['measure', 'MeasureTool']]);

function advertisedValue(value, options, aliases, label) {
  const name = (aliases.get(value.toLowerCase()) ?? value).toLowerCase();
  const option = options.find(option => option.id.toLowerCase() === name || option.label.toLowerCase() === name);
  if (!option) throw new Error(`The link specifies an unavailable ${label}.`);
  return option.id;
}

export function parseStartupLink({ search, hash }, state) {
  if (search.length + hash.length > maxLinkLength) throw new Error('The molecule link is too long.');
  const values = new Map();
  for (const part of [search.slice(1), hash.slice(1)]) {
    if (/%(?![0-9a-f]{2})/i.test(part)) throw new Error('The molecule link has invalid URL encoding.');
    for (const [key, value] of new URLSearchParams(part)) {
      if (!optionKeys.has(key)) continue;
      if (values.has(key)) throw new Error(`The molecule link specifies ${key} more than once.`);
      if (!value.trim() || value.includes('\uFFFD')) throw new Error(`The molecule link has an invalid ${key} value.`);
      values.set(key, value);
    }
  }
  if (!values.size) return null;
  const sources = sourceKeys.filter(key => values.has(key));
  if (sources.length > 1) throw new Error('Use one molecule source per link.');
  const [kind] = sources;
  const format = values.get('type');
  if (format && kind !== 'url') throw new Error('The type parameter requires a file URL.');

  const theme = values.get('theme');
  if (theme && !['light', 'dark'].includes(theme)) throw new Error('The link specifies an unavailable theme.');
  const mode = values.get('mode') ?? 'edit';
  if (!['edit', 'view'].includes(mode)) throw new Error('Choose edit or view for the link mode.');
  const toolName = values.get('tool') ?? (mode === 'view' ? 'navigate' : undefined);
  const tool = toolName ? advertisedValue(toolName, state.tools, toolAliases, 'tool') : undefined;
  if (mode === 'view' && tool !== 'navigate' && tool !== 'MeasureTool')
    throw new Error('View mode supports Navigate and Measure.');
  if (tool === 'AutoOpt') throw new Error('Select the Optimize tool in the editor to use it.');

  const styleName = values.get('style');
  const style = styleName ? advertisedValue(styleName, state.displayStyles, styleAliases, 'display style') : undefined;
  return {
    source: kind && { kind, value: values.get(kind), format },
    style, tool, theme, mode,
  };
}

export async function decodeSnapshot(snapshot) {
  if (snapshot.length > maxLinkLength || !/^1\.[A-Za-z0-9_-]+$/.test(snapshot))
    throw new Error('The shared CJSON has an invalid format.');
  const base64 = snapshot.slice(2).replaceAll('-', '+').replaceAll('_', '/');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let reader;
  try {
    const compressed = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
    const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'));
    reader = stream.getReader();
    let bytes = 0;
    const parts = [];
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxSnapshotBytes) throw new Error('The shared CJSON exceeds 1 MiB when expanded.');
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join('');
  } finally {
    if (reader) {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}

export async function createShareLink(page, mode, { source, style, text }) {
  const url = new URL(page.href);
  url.search = '';
  const parts = new URLSearchParams();
  if (mode === 'view') parts.set('mode', mode);
  if (source) {
    parts.set(source.kind, source.value);
    if (source.format) parts.set('type', source.format);
    if (style) parts.set('style', style);
  } else {
    if (text.length > maxSnapshotBytes || typeof CompressionStream !== 'function') return null;
    const payload = new TextEncoder().encode(text);
    if (payload.byteLength > maxSnapshotBytes) return null;
    const stream = new Blob([payload]).stream().pipeThrough(new CompressionStream('gzip'));
    const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
    if (compressed.byteLength > maxLinkLength * 3 / 4) return null;
    const encoded = btoa(String.fromCharCode(...compressed)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
    parts.set('cjson', `1.${encoded}`);
  }
  url.hash = parts.toString();
  return url.href.length <= maxLinkLength ? url.href : null;
}

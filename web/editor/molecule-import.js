// SPDX-License-Identifier: BSD-3-Clause
export const maxImportBytes = 32 * 1024 * 1024;
const maxQueryLength = 2048;
const pubchem = 'https://pubchem.ncbi.nlm.nih.gov';
const rcsb = 'https://files.rcsb.org';
const formats = new Set(['cjson', 'mol', 'sdf', 'xyz', 'pdb', 'fchk', 'molden', 'cube']);
const pubchemKinds = new Set(['name', 'cid', 'smiles', 'inchi']);

export const supportsRemoteImport = location => location.protocol === 'https:';
export const fileFormat = name => /\.([^.]+)$/.exec(name)?.[1].toLowerCase() ?? '';

export function describeImport(kind) {
  if (pubchemKinds.has(kind)) return 'Your search term will be sent to PubChem (pubchem.ncbi.nlm.nih.gov).';
  if (kind === 'pdb') return 'The PDB ID will be sent to RCSB PDB (files.rcsb.org).';
  return 'The editor will request this file from the server named in its URL.';
}

export function prepareImport({ kind, value, format }, page, extraOrigins = []) {
  if (!supportsRemoteImport(page)) throw new Error('Network imports require the HTTPS editor.');
  value = value.trim();
  if (!value || value.length > maxQueryLength || /[\x00-\x1f\x7f]/.test(value))
    throw new Error('Enter a valid lookup value of at most 2048 characters.');

  if (kind === 'url') {
    let url;
    try { url = new URL(value); } catch { throw new Error('Enter an absolute HTTPS file URL.'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash)
      throw new Error('Use an HTTPS file URL without credentials or a fragment.');
    if (![page.origin, pubchem, rcsb, ...extraOrigins].includes(url.origin))
      throw new Error('This file URL is outside the approved origins.');
    const filename = url.pathname.split('/').at(-1) || 'Imported molecule';
    const type = format === undefined ? fileFormat(filename) : format.toLowerCase();
    if (!formats.has(type)) throw new Error('Choose a supported molecule file format.');
    return { url, filename, format: type, source: { kind, value: url.href, format: type } };
  }

  if (kind === 'pdb') {
    if (!/^[1-9][a-z0-9]{3}$/i.test(value)) throw new Error('Enter a four-character PDB ID (for example, 1CRN).');
    const id = value.toUpperCase();
    const filename = `${id}.pdb`;
    return { url: new URL(`/download/${filename}`, rcsb), filename, format: 'pdb', source: { kind, value: id } };
  }

  if (!pubchemKinds.has(kind)) throw new Error('Choose a supported lookup method.');
  if (kind === 'cid' && !/^[1-9][0-9]{0,11}$/.test(value)) throw new Error('Enter a positive PubChem CID.');
  if (kind === 'name' && ['.', '..'].includes(value)) throw new Error('Enter a chemical name.');
  if (kind === 'inchi' && !/^InChI=1S?\/.+/.test(value)) throw new Error('Enter a complete InChI identifier.');
  const useBody = kind === 'smiles' || kind === 'inchi';
  const input = useBody ? '' : `/${encodeURIComponent(value)}`;
  const url = new URL(`/rest/pug/compound/${kind}${input}/SDF?record_type=3d`, pubchem);
  const body = useBody ? new URLSearchParams({ [kind]: value }) : undefined;
  return { url, body, filename: 'PubChem structure.sdf', format: 'sdf', source: { kind, value } };
}

export async function fetchMolecule(request, signal) {
  let response;
  try {
    response = await fetch(request.url, {
      signal, redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer',
      method: request.body ? 'POST' : 'GET', body: request.body,
    });
  } catch {
    signal?.throwIfAborted();
    throw new Error(`Could not download from ${request.url.hostname}. Check your connection, file permissions, and whether the URL redirects.`);
  }
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 404 && pubchemKinds.has(request.source.kind))
      throw new Error('PubChem has no matching structure with 3D coordinates.');
    throw new Error(`The server could not return the molecule (HTTP ${response.status}).`);
  }

  if (/^text\/html\b/i.test(response.headers.get('Content-Type') ?? '')) {
    await response.body?.cancel();
    throw new Error('The server returned a web page instead of a molecule file.');
  }
  if (Number(response.headers.get('Content-Length')) > maxImportBytes) {
    await response.body?.cancel();
    throw new Error('Molecule files are limited to 32 MiB.');
  }
  if (!response.body) throw new Error('The server returned an empty file.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let length = 0;
  const parts = [];
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxImportBytes) throw new Error('Molecule files are limited to 32 MiB.');
      parts.push(decoder.decode(value, { stream: true }));
    }
    signal?.throwIfAborted();
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (!length) throw new Error('The server returned an empty file.');
  parts.push(decoder.decode());
  return { text: parts.join(''), filename: request.filename, format: request.format, source: request.source };
}

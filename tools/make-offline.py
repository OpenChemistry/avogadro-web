#!/usr/bin/env python3
# SPDX-License-Identifier: BSD-3-Clause
"""Bundle the single-threaded Avogadro Web runtime into a file-openable HTML page."""

import argparse
import base64
import gzip
from pathlib import Path


def data_url(media_type, content):
    return f"data:{media_type};base64,{base64.b64encode(content).decode('ascii')}"


def bundle(directory):
    html = (directory / "index.html").read_text(encoding="utf-8")
    core = (directory / "core/avogadro-editor.js").read_bytes()
    if b"'wasm_singlethread' !== 'wasm_singlethread'" not in core:
        raise ValueError("The offline page requires a single-threaded build")

    core_url = data_url("text/javascript", core)
    editor = (directory / "editor.js").read_bytes()
    core_specifier = b"'./core/avogadro-editor.js'"
    if core_specifier not in editor:
        raise ValueError("Expected the core module reference in editor.js")
    editor = editor.replace(core_specifier, f"'{core_url}'".encode("ascii"))
    runtime = (directory / "avogadro-web.js").read_bytes()
    # Supply the embedded WASM to Emscripten before Qt starts, avoiding a file URL fetch.
    runtime += b"""
const createRuntime = createAvogadroWeb;
createAvogadroWeb = async config => {
  const payload = document.getElementById('avogadro-wasm');
  const compressed = Uint8Array.from(atob(payload.textContent), char => char.charCodeAt(0));
  payload.remove();
  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'));
  const wasmBinary = new Uint8Array(await new Response(stream).arrayBuffer());
  return createRuntime({ ...config, wasmBinary });
};
"""
    wasm = (directory / "avogadro-web.wasm").read_bytes()
    payload = base64.b64encode(gzip.compress(wasm, mtime=0)).decode("ascii")
    css = data_url("text/css", (directory / "editor.css").read_bytes())
    logo = data_url("image/svg+xml", (directory / "icons/avogadro2.svg").read_bytes())
    qtloader = data_url("text/javascript", (directory / "qtloader.js").read_bytes())
    replacements = {
        'href="editor.css"': f'href="{css}"',
        'src="icons/avogadro2.svg"': f'src="{logo}"',
        'class="brand" href="./"': 'class="brand" href=""',
        '<script src="avogadro-web.js"></script>': (
            f'<script type="application/octet-stream" id="avogadro-wasm">{payload}</script>\n'
            f'    <script src="{data_url("text/javascript", runtime)}"></script>'
        ),
        'src="qtloader.js"': f'src="{qtloader}"',
        'src="editor.js"': f'src="{data_url("text/javascript", editor)}"',
    }
    for original, replacement in replacements.items():
        if html.count(original) != 1:
            raise ValueError(f"Expected one occurrence of {original} in index.html")
        html = html.replace(original, replacement)
    return html


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path, help="directory containing the built web assets")
    args = parser.parse_args()
    html = bundle(args.directory)
    (args.directory / "avogadro-offline.html").write_text(html, encoding="utf-8")


if __name__ == "__main__":
    main()

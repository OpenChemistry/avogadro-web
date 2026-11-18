#!/usr/bin/env python3
# SPDX-License-Identifier: BSD-3-Clause
"""Bundle the single-threaded Avogadro Web runtime into a file-openable HTML page."""

import argparse
import base64
import gzip
import hashlib
import re
from pathlib import Path


def data_url(media_type, content):
    return f"data:{media_type};base64,{base64.b64encode(content).decode('ascii')}"


def bundle(directory):
    html = (directory / "index.html").read_text(encoding="utf-8")
    core = (directory / "core/avogadro-editor.js").read_bytes()

    # The modules ship in one script so file: needs no module fetch.
    editor = (directory / "editor.js").read_bytes()
    for specifier, source in (
        (b"./core/avogadro-editor.js", core),
        (b"./molecule-import.js", (directory / "molecule-import.js").read_bytes()),
        (b"./share-link.js", (directory / "share-link.js").read_bytes()),
    ):
        pattern = rb"^import \{[^\n]+\} from '" + re.escape(specifier) + rb"';$"
        editor, count = re.subn(pattern, lambda match: source, editor, flags=re.MULTILINE)
        if count != 1:
            raise ValueError(f"Expected one editor import of {specifier.decode('ascii')}")
    runtime = (directory / "avogadro-web.js").read_bytes()
    # Supply the embedded WASM to Emscripten before Qt starts, avoiding a file URL fetch.
    runtime += b"""
;(() => {
  const createRuntime = createAvogadroWeb;
  createAvogadroWeb = async config => {
    const payload = document.getElementById('avogadro-wasm');
    const compressed = Uint8Array.from(atob(payload.textContent), char => char.charCodeAt(0));
    payload.remove();
    const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'));
    const wasmBinary = new Uint8Array(await new Response(stream).arrayBuffer());
    return createRuntime({ ...config, wasmBinary });
  };
})();
"""
    wasm = (directory / "avogadro-web.wasm").read_bytes()
    payload = base64.b64encode(gzip.compress(wasm, mtime=0)).decode("ascii")
    css = (directory / "editor.css").read_bytes()
    logo = data_url("image/svg+xml", (directory / "icons/avogadro2.svg").read_bytes())
    qtloader = (directory / "qtloader.js").read_bytes()

    def inline(source, tag):
        text = source.decode("utf-8").replace("\r\n", "\n").replace("\r", "\n")
        if f"</{tag}" in text.lower():
            raise ValueError(f"Unexpected closing {tag} tag in bundled source")
        return text

    def csp_hash(source):
        digest = hashlib.sha256(source.encode("utf-8")).digest()
        return "'sha256-" + base64.b64encode(digest).decode("ascii") + "'"

    runtime, qtloader, editor = (inline(script, "script") for script in (runtime, qtloader, editor))
    css = inline(css, "style")
    scripts = " ".join(csp_hash(script) for script in (runtime, qtloader, editor))
    # Retain the pinned Qt viewport stylesheet allowed by the hosted editor.
    qt_style = re.search(r"style-src 'self' ('sha256-[A-Za-z0-9+/=]+');", html)
    if not qt_style:
        raise ValueError("Expected the Qt viewport stylesheet hash in index.html")
    policy = (
        f"default-src 'none'; script-src {scripts} 'wasm-unsafe-eval'; "
        f"style-src {csp_hash(css)} {qt_style[1]}; img-src data: blob:; "
        "connect-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'"
    )
    html, count = re.subn(
        r'(<meta http-equiv="Content-Security-Policy" content=")[^"]+(")',
        lambda match: match[1] + policy + match[2],
        html,
    )
    if count != 1:
        raise ValueError("Expected one Content-Security-Policy in index.html")
    replacements = {
        '<link rel="stylesheet" href="editor.css" />': f"<style>{css}</style>",
        'src="icons/avogadro2.svg"': f'src="{logo}"',
        'class="brand" href="./"': 'class="brand" href=""',
        '<script src="avogadro-web.js"></script>': (
            f'<script type="application/octet-stream" id="avogadro-wasm">{payload}</script>\n'
            f"    <script>{runtime}</script>"
        ),
        '<script src="qtloader.js"></script>': f"<script>{qtloader}</script>",
        '<script type="module" src="editor.js"></script>': f'<script type="module">{editor}</script>',
    }
    for original, replacement in replacements.items():
        if html.count(original) != 1:
            raise ValueError(f"Expected one occurrence of {original} in index.html")
        html = html.replace(original, replacement)
    return html


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path, help="directory containing the built web assets")
    parser.add_argument("--kit", required=True, choices=["wasm_singlethread"], help="configured Qt WASM kit")
    args = parser.parse_args()
    html = bundle(args.directory)
    (args.directory / "avogadro-offline.html").write_text(html, encoding="utf-8")


if __name__ == "__main__":
    main()

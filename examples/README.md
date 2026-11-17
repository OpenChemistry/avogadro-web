# Avogadro Web integration examples

These directories are reserved for future examples built on the reusable
`core/avogadro-editor.js` module and its packaged WASM runtime.

- `webpage/` can show a molecule supplied by a host page, let visitors
  rotate and zoom, and export Chemical JSON. The host needs WebGL 2 and a
  cross-origin-isolated page that can load the runtime assets.
- `jupyter/` can let students create or edit molecules in a JupyterLab
  notebook and bring the result back into Python for a computational lab.
  The inline viewer prototype on `codex/jupyter-inline-viewer` serves the
  runtime from the local Jupyter server with cross-origin isolation.
- `chrome-extension/` can open a packaged viewport on a dedicated extension
  page and work with files the user selects. A Manifest V3 extension can
  bundle the runtime locally, declare the
  [cross-origin isolation headers](https://developer.chrome.com/docs/extensions/reference/manifest/cross-origin-embedder-policy),
  and [enable WASM in its extension-page policy](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy).

See [hosting Avogadro Web](../README.md#host-your-application) for the runtime
requirements and the [Avogadro discussion](https://discuss.avogadro.cc/t/web-avogadro-cc/7590/8)
for the classroom use cases.

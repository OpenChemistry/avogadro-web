# Self-hosting Avogadro Web

Serve the application over HTTPS (or localhost during development) with
cross-origin isolation. Configure the server to send:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: same-origin
```

Serve `.wasm` as `application/wasm`. If serving the optional compressed WASM
file, send `Content-Encoding: gzip` only for gzip-compressed bytes. Keep the
runtime files together and preserve the `core/` subdirectory alongside them.
For a core-only deployment, supply your own host page and serve those files.
The included full editor also uses `index.html`, `editor.js`, `editor.css`,
and `icons/avogadro2.svg`.
A plain `python -m http.server` does not supply the required isolation headers;
use `serve-wasm.py` for local development.

The editor is hosted at <https://web.avogadro.cc/>, a GitHub Pages site behind
Cloudflare, which adds the isolation headers.

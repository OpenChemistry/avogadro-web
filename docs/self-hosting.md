# Self-hosting Avogadro Web

For local editing, extract the single-threaded ZIP and open
`avogadro-offline.html` directly from disk. The file contains the editor and
its runtime. Use the separate `index.html` and runtime files for hosting.

Serve either build over HTTPS or on loopback during development. The
multithreaded build needs cross-origin isolation. Configure its server to send
these headers.

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: same-origin
```

The single-threaded build works on a static server without isolation headers.
Use it to embed the full editor or a custom viewport in a page hosted on a
different origin, such as a Jupyter notebook or a course page. Host the
single-threaded package on your server and point the iframe at its page.

```html
<iframe
  src="https://your-editor.example/index.html"
  title="Avogadro molecular editor"
  width="960"
  height="640"
></iframe>
```

The editor host must allow framing by the parent origin. If you set a
Content Security Policy with `frame-ancestors`, include the parent origin.
The parent page's policies must also allow the iframe and its scripts to run.

Serve `.wasm` as `application/wasm`. If serving the optional compressed WASM
file, send `Content-Encoding: gzip` only for gzip-compressed bytes. Keep the
runtime files together and preserve the `core/` subdirectory alongside them.
For a core-only deployment, supply your own host page and serve those files.
The included full editor also uses `index.html`, `editor.js`, `editor.css`,
and `icons/avogadro2.svg`.
For local development, run `python3 serve-wasm.py` for the multithreaded build
or `python3 -m http.server --bind 127.0.0.1` for the single-threaded build.

The multithreaded editor is hosted at <https://web.avogadro.cc/>, a GitHub Pages
site behind Cloudflare, which adds the isolation headers.

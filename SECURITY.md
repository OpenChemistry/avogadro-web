# Security policy

## Reporting an issue

Use the repository's [private vulnerability report form](https://github.com/OpenChemistry/avogadro-web/security/advisories/new).
Include the browser, the package's build-manifest.json and the affected operation.
Share sensitive files only through a private channel. If the form is unavailable,
contact an Avogadro maintainer privately to arrange a report.

## Editor and host boundaries

The hosted editor loads its scripts, styles and WASM from its own origin.
The CSP in `web/editor/index.html` applies on static hosts. WebAssembly requires
`wasm-unsafe-eval`. The build disables Emscripten dynamic JavaScript execution.
Qt 6.11.1 inserts one fixed stylesheet into the viewport shadow root. The CSP
authorizes its SHA-256 digest. When updating Qt, inspect changes to that stylesheet
before updating its digest. The threaded kit can load same-origin and blob workers.

The single-file editor embeds scripts and styles and authorizes the exact inline
contents with hashes generated during packaging. It disables connections and
workers. A Chromium smoke test monitors CSP violations during editing in all
three configurations and checks the standalone file for external requests.

Files may contain untrusted names, text and parser input. The editor checks the
local file size before reading it (32 MiB maximum). Keep chemistry parsing in
avogadrolibs and keep file contents, names and errors out of HTML and code sinks.

## Input rules for integrations

- Remote molecule import may use same-origin HTTPS, PubChem at
  `https://pubchem.ncbi.nlm.nih.gov`, and RCSB at `https://files.rcsb.org`.
  Validate the URL, scheme, origin and absence of credentials before fetching.
  Reject redirects or validate each destination before sending a request.
  Enforce the 32 MiB limit on streamed, decoded bytes, including responses
  without a Content-Length header. Encode query components and identify the
  receiving service before sending a name, identifier or SMILES string.
  Self-hosters extending these origins must update the application allowlist
  and the static CSP together.
- Treat a share fragment like an untrusted file. Bound both the encoded input
  and the decompressed output before retaining them. Accept only tools, styles
  and modes that the current runtime supports.
- A host-page API must check sender origin, source window and message schema.
  Send molecule data only to an explicit target origin. Calculations requested
  by a link, host or agent require a user action.

## Maintainer settings

Enable private vulnerability reporting in the repository security settings and
verify the report form while signed in as a non-maintainer. Review dependency
updates and toolchain pins before publishing the WASM packages.

Serve the official editor on its dedicated origin. Review domain-wide cookies
with the owners of sibling services. Set COOP and COEP for the threaded package
as described in the [hosting guide](docs/self-hosting.md). An embedding policy
using frame-ancestors requires an HTTP response header. Configure that header
with the intended embed hosts and verify the deployed response after changes.

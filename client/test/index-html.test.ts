// Pins the one line of `client/src/index.html` that cannot be checked by any type
// or lint rule and whose absence is invisible until someone deep-links.
//
// The Angular CLI emits relative bundle URLs (`src="main-<hash>.js"`). With no
// `<base href="/">`, a direct load of a route deeper than one segment —
// `/risk/admin`, or `/risk/` with a trailing slash — makes the browser resolve
// `main-*.js` against the route path. The Worker's SPA fallback answers that 404
// with `index.html` (`content-type: text/html`), the ES module fails its MIME
// check, Angular never bootstraps, and the page is blank. The build stays green
// and the route still works when reached by in-app navigation, so nothing else
// catches it.
//
// A plain file read, not a DOM test: this file is Angular-free by design (see
// select-options.test.ts and DEFERRED.md).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const indexHtml = readFileSync(
  fileURLToPath(new URL('../src/index.html', import.meta.url)),
  'utf8',
);

describe('index.html', () => {
  it('declares <base href="/"> so nested routes resolve their bundles from the root', () => {
    expect(indexHtml).toMatch(/<base\s+href=(["'])\/\1\s*\/?>/);
  });
});

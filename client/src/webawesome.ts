// Central Web Awesome component registry. Importing a component's module is a
// side effect that defines its custom element. We import every component the app
// uses from one place (loaded once in main.ts) so each is registered exactly
// once and the bundler can't tree-shake a component that's only referenced from
// a template (templates aren't statically analysed for custom-element usage).
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/button-group/button-group.js';
import '@awesome.me/webawesome/dist/components/callout/callout.js';
import '@awesome.me/webawesome/dist/components/dialog/dialog.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/input/input.js';
import '@awesome.me/webawesome/dist/components/option/option.js';
import '@awesome.me/webawesome/dist/components/select/select.js';
import '@awesome.me/webawesome/dist/components/spinner/spinner.js';
import '@awesome.me/webawesome/dist/components/tag/tag.js';

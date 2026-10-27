# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Tabby is a terminal emulator / SSH / serial client: an Electron app whose UI is TypeScript + Angular 15, bundled with Webpack. Almost everything is implemented as plugins (the `tabby-*` directories). See `HACKING.md` for the full contributor guide.

## Commands

Use Yarn. Each plugin, `app/` and `web/` has its own `package.json`/`yarn.lock`; the root `postinstall` (`scripts/install-deps.mjs`) runs `yarn install` in every one of them, applies `patch-package` patches, and rebuilds native modules for Electron. On Linux, system packages are needed first (see `HACKING.md`).

```sh
yarn                      # install all deps (root + app + web + every plugin)
yarn run build            # build:typings, then webpack each package in turn (scripts/build-modules.mjs)
yarn run watch            # dev rebuild of app + builtin plugins (TABBY_DEV=1)
yarn start                # run Electron in dev mode (loads plugins from the source checkout)

# If an installed Tabby is running, `yarn start` hands off to it (single-instance lock on the
# shared ~/.config/tabby) and exits immediately. Use a separate profile instead:
TABBY_DEV=1 node_modules/.bin/electron app -d --inspect --user-data-dir=$HOME/.config/tabby-dev
yarn run lint             # eslint over */src and */lib
yarn run build:typings    # tsc per plugin via <plugin>/tsconfig.typings.json — also acts as the typecheck
yarn run test:unit        # node --test for tabby-terminal/tabby-electron tests
yarn run test:ssh-term    # node --test for tabby-ssh tests
```

Run a single test file:

```sh
node --import ./scripts/test-register.mjs --test tabby-terminal/test/sessionOutputBuffer.test.ts
node --experimental-strip-types --test tabby-ssh/test/terminalType.test.ts
```

Tests use `node:test` + `node:assert/strict` and import `.ts` sources directly. `scripts/test-register.mjs` installs hooks (`scripts/test-hooks.mjs`) that transpile TS with the project's TypeScript, resolve extension-less imports, and replace `tabby-core` with a tiny stub — the real `tabby-core` is the whole Angular app and can't load outside Electron. So only plugin internals with no Angular/Electron dependencies are unit-testable; keep testable logic in plain functions/classes.

CI (`.github/workflows/build.yml`) runs: test:ssh-term, test:unit, build:typings, lint.

Dev loop: keep `yarn run watch` running and reload the window (Ctrl+Shift+R) after renderer/plugin changes; changes in `app/lib` (main process) need an app restart.

On Linux, Electron aborts with a SUID sandbox error until `node_modules/electron/dist/chrome-sandbox` is `root:root` mode `4755` (`sudo chown root:root … && sudo chmod 4755 …`); this resets whenever Electron is reinstalled. Under Wayland, `x11 ... Bad window` rejections and `Failed to call BindShortcuts` in the log are harmless (the global hotkey just doesn't register).

Installers: after `yarn run build`, run `node scripts/prepackage-plugins.mjs` then `node scripts/build-{windows,linux,macos}.mjs` (output in `dist/`).

## Architecture

- **`app/`** — the Electron shell. `app/lib/` is the main process (windows, PTY spawning via `pty.ts`, global hotkeys, config saving, IPC handlers `app:*`, plugin discovery). `app/src/` is the renderer bootstrap: `plugins.ts` finds and `require`s plugins, `app.module.ts` builds the root Angular module from them. Two webpack configs: `webpack.config.main.mjs` (main) and `webpack.config.mjs` (renderer).
- **`web/`** + **`tabby-web`** — the browser build (SSH/SFTP/Telnet only, no local shells). `tabby-web-demo` is a demo plugin for it.
- **Plugins** — each `tabby-*` dir is an npm package whose default export is an Angular `NgModule`, built by its own `webpack.config.mjs` that calls the shared `webpack.plugin.config.mjs` (UMD output to `<plugin>/dist`). A package is loaded only if its `package.json` has the `tabby-plugin` keyword. The list of builtin plugins and build order lives in `scripts/vars.mjs` (`builtinPlugins`, `allPackages`) — update it when adding a plugin.
- **Shared modules at runtime** — `app/src/plugins.ts` patches `require` so all plugins share one copy of Angular, ng-bootstrap, rxjs, ngx-toastr and the core plugins (`tabby-core`, `tabby-local`, `tabby-settings`, `tabby-terminal`). Plugins import each other by package name (`import { … } from 'tabby-core'`); in dev, `node_modules/tabby-*` are symlinks to the source dirs.
- **Extension points** — functionality is contributed via Angular providers, mostly `multi: true` (e.g. `ToolbarButtonProvider`, `ProfileProvider`, `ConfigProvider`, `HotkeyProvider`, `CommandProvider`, `TabContextMenuItemProvider`, `TabRecoveryProvider`, `Theme`). Public APIs are in each plugin's `src/api.ts` / `src/api/` — chiefly `tabby-core`, `tabby-terminal`, `tabby-local`, `tabby-settings`.
- **Platform abstraction** — `tabby-core` defines abstract services (`PlatformService`, `HostAppService`, `HostWindowService`, `FileProvider`, …); `tabby-electron` (`ElectronPlatformService` etc.) and `tabby-web` provide the implementations. Core/terminal/ssh code must go through these, not call Electron or Node APIs directly, so it keeps working in the web build.
- **Profiles & sessions** — connection types (`tabby-local`, `tabby-ssh`, `tabby-serial`, `tabby-telnet`) each register a `ProfileProvider` and a tab component built on `tabby-terminal`'s base terminal tab + `BaseSession`; `tabby-terminal` owns the xterm.js frontend, middleware (output processing, login scripts, etc.) and terminal decorators.
- **Config** — YAML; defaults come from `ConfigProvider`s (e.g. `tabby-core/src/configDefaults*.yaml`, per-platform variants), merged by `ConfigService`.

## Conventions

- Components are `foo.component.ts` + `foo.component.pug` (template) + `foo.component.scss`. Only `*component.scss` / `theme*.scss` are loaded as component strings; other `.scss` is injected globally.
- Style is enforced by ESLint with `plugin:@typescript-eslint/all` (with exceptions in `.eslintrc.yml`): 4-space indent, no semicolons, no `public` modifier (but explicit accessibility on constructor parameter properties), no duplicate imports.
- i18n: wrap user-facing strings in `this.translate.instant(_('…'))` in TS or the `translate` pipe in pug; `yarn run i18n:extract` regenerates `locale/app.pot`. Translations come from Crowdin — don't edit `locale/*.po` by hand.
- Dependency fixes to third-party packages go in `patches/` (patch-package), not into `node_modules`.
- PR template asks contributors to state the level of AI involvement.

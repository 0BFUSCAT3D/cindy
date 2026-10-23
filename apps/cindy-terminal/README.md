# Cindy Terminal

The terminal host runs on Node without Electron or a display server. `cindy`
opens the TUI; `cindy serve` runs the foreground host. Profiles isolate accounts,
models, tasks, plugins and device identities. Use `--profile <name>` consistently
when managing a host. `cindy --help` lists the available commands.

Development builds use `pnpm --filter cindy-terminal build`, then
`node apps/cindy-terminal/dist/cli.js`. Platform packages include Node and native
dependencies; build them on the target OS with `scripts/package-runtime.mjs`.
The platform acceptance workflow checks the packaged executable, PTY, WebRTC and
resident service. This package is under development; a passing smoke test does
not establish full Desktop/Mobile feature parity.

## Headless plugin browser

The host, login and model configuration do not need a browser on the server.
Plugins that execute browser code use a separate, ephemeral Chromium sandbox.
Cindy first looks for system Chrome/Edge/Chromium, then downloads its pinned
Chromium on demand. It never opens the user's personal browser profile.

```sh
cindy browser status
cindy browser install
cindy browser check
cindy doctor
```

`status` only locates an existing executable. `install` prepares the browser and
checks it. `check` runs the actual sandbox with a blank page and no external
request. `doctor` also reports browser readiness without downloading anything.
These commands take `--profile` and `--json`.

On Linux, install the distribution's browser runtime dependencies if the check
reports `BROWSER_SYSTEM_DEPENDENCIES_MISSING`. A system browser package usually
installs those dependencies together. Run the host as a normal user; root is not
a supported Chromium sandbox identity.

Ubuntu 23.10+ can restrict user namespaces for a downloaded Chromium binary.
If the check reports `BROWSER_SANDBOX_UNAVAILABLE`, an administrator can review
and install the exact-binary AppArmor profile:

```sh
cindy browser sandbox-profile > cindy-terminal-chromium.apparmor
sudo install -m 644 cindy-terminal-chromium.apparmor /etc/apparmor.d/cindy-terminal-chromium
sudo apparmor_parser -r /etc/apparmor.d/cindy-terminal-chromium
cindy browser check
```

Use the same Cindy profile for each command. Regenerate the policy if the browser
executable path changes. The rule permits that executable to create user
namespaces; review ownership and write access to the executable and its parents
before installing it. It does not disable the system-wide restriction or
Chromium's sandbox. See the
[Chromium AppArmor documentation](https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md).

## Remote credentials

TUI plugin credential forms submit through a local protected controller. The
controller pins the target device identity and installed plugin revision, then
uses the existing signed, encrypted settings exchange. The target's original
credential endpoint owns persistence. Generic remote resource actions reject
raw credential submissions. Unsupported peers must be upgraded for that form;
there is no plaintext fallback.

Ordinary CLI actions accept JSON from `--stdin`; keep secrets out of shell
arguments, scripts checked into Git, and task messages. Plugin HTML settings and
declarative credential forms use the same target vault.

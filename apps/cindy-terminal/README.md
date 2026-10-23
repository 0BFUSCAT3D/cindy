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

## Provider authorization

In the TUI, choose Models → Add provider, choose a preset and select OAuth
when offered. The provider can then be connected from its configuration menu.
`cindy providers login --provider <id>` opens the same login surface;
`--device <id>` performs authorization on the selected remote host. Device-code
providers show an authorization URL and code. For browser callbacks completed
on another computer, paste the final callback URL into the masked input.
The existing encrypted controller exchange carries that input to the host.
Access and refresh tokens stay in its account-scoped encrypted vault.

`cindy providers status --provider <id>` reports connection state;
`cindy providers logout --provider <id>` disconnects that saved provider.
`cindy providers login --provider openai` uses the official Codex device-code
login. It works through the same protected remote configuration surface. The
host keeps its OpenAI login in the current Cindy account's encrypted vault and
routes Codex, Claude Code and Pi through a private proxy. It does not reuse or
modify `~/.codex` credentials.

`cindy providers login claude-code` connects an existing official Claude CLI
subscription, or launches `claude auth login --claudeai` in the foreground.
Claude credentials stay exclusively in the CLI's default credential store.
`cindy providers logout claude-code` revokes Cindy's permission to use that login;
it does not log out the CLI. A different Cindy account must explicitly connect.
The native Pi CLI's own `/login` remains available through the engine menu.

Engine installation, updates and repairs can target another terminal host with
`cindy engines list|install|update|repair [engine] --device <id>`. The Models
page advertises the same engine controls when the selected host supports them.
Installations continue on that host if the controller disconnects; a failed
installation preserves the previous executable. Switching Cindy accounts aborts
that account's pending installation. Reopening the engine page shows its result.

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

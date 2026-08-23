# chromium-castctl helper architecture

`chromium-castctl` is intentionally dependency-free and public-marketplace friendly. The executable in `bin/chromium-castctl` is only a thin CLI wrapper; the implementation lives in `lib/chromium-castctl/` so review can focus on one responsibility at a time.

## Module map

| Module | Responsibility | Security boundary |
| --- | --- | --- |
| `commands.js` | CLI parsing, command dispatch, state-lock scope, background helper spawning | Decides which commands may mutate local controller state |
| `state.js` / `paths.js` / `fs-private.js` | Private XDG paths, atomic state writes, busy UI state, operation lock | Local state ownership, symlink/non-directory refusal, lock ownership |
| `process-identity.js` / `chromium-processes.js` | `/proc` identity reads, launch identity records, verified process matching | Process ownership before reuse or signaling |
| `chromium.js` | Isolated profile lifecycle, Chromium startup/reuse/cleanup, DevTools readiness | Private profile, loopback DevTools address, failure cleanup |
| `cdp.js` | Bounded CDP HTTP/WebSocket client, page target lookup, CDP URL validation | CDP access is loopback-only and size-limited |
| `discovery.js` / `sinks.js` | Avahi parsing, receiver normalization, duplicate/ambiguous target handling | Receiver names and ids are untrusted input |
| `cast.js` | `Cast.*` CDP operations and cleanup on CDP setup failure | Single place that starts/stops desktop mirroring |
| `status.js` / `format.js` / `doctor.js` | Status collection, Waybar JSON/terminal output, diagnostics | UI protocol escaping and stale-state reporting |

Installer and validation support remains outside the Node helper: `install.sh`, `scripts/validate-plugin.sh`, `scripts/check-actions-pinned.sh`, and `test/fixtures/dummy-chromium-cast` exercise packaging and workflow behavior without adding runtime dependencies.

## End-to-end flow

```mermaid
flowchart TD
  UI[Quickshell widget / Waybar / CLI] --> BIN[bin/chromium-castctl]
  BIN --> CMD[commands.js]
  CMD --> LOCK[state.js operation lock]
  LOCK --> DISC[discovery.js Avahi hints]
  LOCK --> CHR[chromium.js controller lifecycle]
  LOCK --> CAST[cast.js Cast operations]
  CHR --> CDP[cdp.js loopback CDP]
  CAST --> CDP
  CDP --> BACKEND[Chromium Cast backend]
  BACKEND --> PORTAL[Wayland/Hyprland portal + PipeWire]
  CMD --> STATE[state.json / ui-state.json]
  STATE --> FORMAT[format.js status JSON/text]
  FORMAT --> UI
```

## Discovery and selection

1. Quickshell calls `chromium-castctl sinks --json`; legacy CLI/Waybar can call `pick` or `sinks`.
2. `commands.js` acquires the operation lock before commands that inspect or mutate controller state.
3. `pick` asks `discovery.js` for Avahi `_googlecast._tcp` hints first. Avahi results are only hints; Chromium discovery remains authoritative before casting.
4. `sinks.js` normalizes every receiver name/id, rejects control and bidi record-boundary characters, caps list/name/id lengths, and marks duplicate friendly names ambiguous instead of silently selecting one.
5. Quickshell consumes structured JSON. Legacy Walker input is generated only after normalization and ambiguity checks.

## Chromium controller lifecycle

```mermaid
flowchart TD
  Need[command needs Chromium?] --> Reuse[getReusableBrowser]
  Reuse --> VerifyState{state matches profile version, audio mode, private profile?}
  VerifyState -- no --> Discard[discard state browser + cleanup profile processes]
  VerifyState -- yes --> VerifyProc{pid/start time/profile/process group verified?}
  VerifyProc -- no --> Discard
  VerifyProc -- yes --> VerifyCDP{CDP reachable on 127.0.0.1 same port?}
  VerifyCDP -- yes --> Existing[reuse controller]
  VerifyCDP -- no --> Discard
  Discard --> Launch[launchChromium]
  Launch --> Fresh[reset isolated profile + write profile version]
  Fresh --> Token[launch with private launch token]
  Token --> Identity[persist browser identity from /proc]
  Identity --> ActivePort[read DevToolsActivePort]
  ActivePort --> WaitCDP[wait for CDP readiness]
  WaitCDP --> Minimize[minimize page target when possible]
  Minimize --> Running[write state.json]
```

`chromium.js` launches a headless controller with `--user-data-dir=<private profile>`, `--remote-debugging-address=127.0.0.1`, and `--remote-debugging-port=0`. `chromium-processes.js` records both the configured executable and observed browser executable/device/inode during startup so later cleanup can distinguish the helper's controller from unrelated processes spoofing a profile argument.

## CDP connection and Cast operations

- `cdp.js` fetches `/json/list`, creates an `about:blank` page if needed, and accepts only `ws://127.0.0.1:<expected-port>/...` CDP WebSocket URLs without credentials.
- HTTP responses and WebSocket messages are bounded so hostile or broken CDP responses fail deterministically.
- `cast.js` is the only module sending `Cast.enable`, `Cast.startDesktopMirroring`, or `Cast.stopCasting`.
- `start` updates `lastActiveSink` only after Chromium accepts `Cast.startDesktopMirroring`. The Wayland portal prompt is still owned by Chromium/xdg-desktop-portal-hyprland and is not bypassed.
- `stop` tries every active sink, clears local active state, then closes the isolated Chromium controller even if one stop request fails.

## State, locks, and failure cleanup

```mermaid
flowchart TD
  Command[mutating/status command] --> Acquire[acquire operation.lock]
  Acquire --> Owner[owner.json pid + processStartTime + nonce]
  Owner --> Work[run command]
  Work --> Success[release lock]
  Work --> Failure[release lock in finally]
  Failure --> Cleanup{where did it fail?}
  Cleanup --> LaunchFail[launch failure: discard verified browser + clear state]
  Cleanup --> CDPFail[CDP setup failure: shutdown controller]
  Cleanup --> StatusFail[status failure: clear stale state]
  Cleanup --> StopFail[stop failure: still attempt local cleanup]
```

State files are private to the user under XDG data/state/cache roots. Atomic writes go through `fs-private.js`, directories are created with private permissions, and unsafe non-directory/symlink paths are refused where the helper creates private directories. Locks with a verified owner are stale only when that process is gone or no longer has the recorded start time; incomplete or invalid lock records are reclaimed only after the stale timeout.

Security-relevant parse and lifecycle errors use explicit error classes/codes from `errors.js` rather than message-text matching. For example, an oversized `DevToolsActivePort` file is classified as `cdp_devtools_active_port_too_large`, and wait logic branches on that sentinel code.

## UI data flow

```mermaid
flowchart LR
  QS[Chromecast.qml Quickshell] -->|sinks --json/start/stop/status| BIN[chromium-castctl]
  WB[Waybar module] -->|status --waybar| BIN
  BIN --> Busy[ui-state.json busy label]
  Busy --> Signal[pkill -RTMIN+12 waybar]
  BIN --> JSON[format.js escaped JSON/text]
  JSON --> QS
  JSON --> WB
```

Quickshell should continue to consume `sinks --json`; newline-delimited receiver names are legacy UI input only after normalization. Waybar JSON escapes receiver text for tooltip/text fields and renders busy state from `ui-state.json` without launching Chromium.

## Dependency-free tradeoffs

Avoiding runtime npm dependencies helps marketplace review: there is no package lock to audit, no transitive supply-chain drift, and the helper can run from a plugin checkout with only Node, Chromium, Avahi, and the desktop portal stack installed.

The tradeoff is that the helper owns small local implementations that dependencies might otherwise provide: atomic file writes, process identity checks, lock takeover, bounded HTTP response reads, WebSocket RPC bookkeeping, receiver normalization, and terminal/UI escaping. These local pieces must stay small, tested, and easy to inspect; do not broaden them into general-purpose frameworks.

Responsibilities intentionally delegated outside this project:

- Chromium: Google Cast discovery inside the browser, media routing, CDP Cast implementation, and the desktop capture request.
- xdg-desktop-portal-hyprland / Omarchy / PipeWire: user consent, screen selection, capture transport, and shell UI hosting.
- Avahi: fast mDNS hints only, never final casting authority.
- Waybar/Quickshell: rendering the helper's already-escaped or structured status output.

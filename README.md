# Omarchy Chromecast / chromium-castctl

[![CI](https://github.com/HackXIt/omarchy-chromecast/actions/workflows/ci.yml/badge.svg)](https://github.com/HackXIt/omarchy-chromecast/actions/workflows/ci.yml)

This repository is primarily an **Omarchy Quattro** shell plugin for desktop casting to Chromecast. It also keeps a dependency-free `chromium-castctl` helper CLI for legacy/pre-Quattro Omarchy setups that used Waybar or direct command-line integration.

On Omarchy Quattro, the plugin provides a native Quickshell bar widget and popup UI for choosing targets, starting/stopping desktop mirroring, and refreshing targets. Diagnostics open in an Omarchy floating terminal so the full command output stays readable and waits for the user before closing. The bundled `chromium-castctl` helper controls Chromium's built-in Google Cast backend over the Chrome DevTools Protocol (CDP).

Chromium performs the actual casting. This project only launches an isolated Chromium control instance and sends CDP Cast commands.

This project was vibe-coded from the practical need to have a simple "cast this desktop" button in Omarchy without building a full media-router implementation. The tradeoff is a slower UX: discovery, the isolated Chromium controller, CDP commands, and the Wayland portal prompt can take a moment. In exchange, the implementation stays small and relies on Chromium's already-existing casting capabilities instead of reimplementing them.

## Showcase

<p align="center">
  <img src="assets/screenshots/screen-selection.png" alt="Selecting an Omarchy screen or output to cast" width="820">
</p>

<p align="center">
  <img src="assets/screenshots/idle.png" alt="Chromecast widget idle state with available target" width="360">
  <img src="assets/screenshots/casting-active.png" alt="Chromecast widget active casting state" width="360">
</p>

<p align="center">
  <img src="assets/screenshots/doctor.png" alt="Chromecast doctor diagnostics running in a floating terminal" width="820">
</p>

## Safety properties

- Uses a fresh isolated Chromium profile at `~/.local/share/chromium-castctl/chromium-profile/` for each new control-browser launch.
- Does **not** modify the user's normal Chromium profile or Chromium installation.
- Binds DevTools to `127.0.0.1` only.
- Launches the isolated Chromium control instance headless by default; no Chromium window should appear.
- Does **not** bypass Wayland/Hyprland portal confirmation.
- Does **not** edit Waybar config automatically.
- Omarchy plugin mode does **not** require Walker; target selection happens in the Quickshell popup.

## Requirements

### Omarchy Quattro plugin mode

- Omarchy Quattro / `omarchy-shell` for the native Quickshell widget UI.
- `node` with built-in `fetch` and `WebSocket`.
- `chromium` on `PATH`.
- `avahi-browse` for fast live Chromecast target discovery; without it, target discovery falls back to slower Chromium discovery.
- Hyprland portal stack for desktop capture:
  - `xdg-desktop-portal-hyprland.service`
  - `hyprland-preview-share-picker`
  - PipeWire and PipeWire Pulse services

### Legacy/pre-Quattro CLI and Waybar mode

- The same `node`, `chromium`, Avahi, and portal stack requirements as plugin mode.
- Optional: `walker` for the legacy CLI `pick` command.
- Optional: Waybar if you want to wire `status --waybar` or `waybar-toggle` into a pre-Quattro bar.

Check the local machine for Quattro plugin mode with:

```bash
./bin/chromium-castctl doctor --quickshell
```

## Install on Omarchy Quattro

This is the recommended path for current Omarchy. `omarchy plugin add` clones the repository as a shell plugin; it does **not** run `install.sh`. The plugin calls the bundled helper at `bin/chromium-castctl` directly.

From a published repository:

```bash
omarchy plugin add https://github.com/HackXIt/omarchy-chromecast --enable
omarchy bar move hackxit.chromecast --section right --after omarchy.network
```

For local development, copy or symlink this repository into:

```text
~/.config/omarchy/plugins/hackxit.chromecast
```

Then rescan/restart the shell:

```bash
omarchy-shell shell rescanPlugins
omarchy restart shell
```

The plugin uses the bundled helper at `bin/chromium-castctl` by default. Override the helper path only if you have a separate development checkout:

```json
{ "id": "hackxit.chromecast", "castctl": "/path/to/chromium-castctl" }
```

Remove the plugin with:

```bash
omarchy plugin remove hackxit.chromecast
```

## Optional legacy/pre-Quattro CLI install

This path is only for direct CLI usage or older/pre-Quattro Omarchy setups that still use Waybar integration. It is not needed for the Quattro plugin above.

For using `chromium-castctl` directly outside the plugin, from this regular clone:

```bash
./install.sh
command -v chromium-castctl
chromium-castctl doctor
```

`install.sh` symlinks `bin/chromium-castctl` to `~/.local/bin/chromium-castctl` and optionally installs a Waybar icon font for legacy/pre-Quattro Waybar integration. It does not install or enable the Omarchy Quattro plugin.

## Usage

```bash
chromium-castctl doctor --quickshell
chromium-castctl doctor
chromium-castctl sinks
chromium-castctl pick
chromium-castctl start Wohnzimmer
chromium-castctl status
chromium-castctl status --waybar
chromium-castctl stop
chromium-castctl toggle
chromium-castctl quit-browser
```

Known local Chromecast target from exploration:

```text
Wohnzimmer
```

Typical flow:

1. Open the Chromecast bar widget and click **Refresh targets** if needed.
2. Choose a target from the popup.
3. Approve the Wayland/Hyprland screen-share portal prompt.
4. Click **Stop casting** in the popup to stop casting and close the headless Chromium control browser.

Use **Run doctor** from the popup to open diagnostics in a floating terminal. Legacy CLI users can run `chromium-castctl pick` to choose a sink in Walker.

Lifecycle notes:

- `status` and `status --waybar` never launch Chromium.
- `sinks` launches Chromium with a fresh isolated profile for discovery, then closes it again if no cast is active.
- `pick` uses live Avahi/mDNS discovery first so Walker can open quickly. When Avahi finds targets, it starts the headless Chromium control browser in the background while Walker is open, then reuses or waits for that browser after a sink is selected. If Avahi finds no targets, it falls back to Chromium discovery.
- `waybar-toggle` marks the module busy, signals Waybar, then runs toggle work in the background so the bar can repaint immediately.
- `stop` stops active casts and closes the isolated Chromium control browser.

## First-run portal prompt

The first desktop cast may open `hyprland-preview-share-picker`. Select the monitor/screen and confirm. This is expected and should not be bypassed.

If `~/.config/hypr/xdph.conf` contains:

```ini
screencopy {
    allow_token_by_default = true
    custom_picker_binary = hyprland-preview-share-picker
}
```

then portal restore tokens may reduce future prompts, depending on Chromium and portal behavior.

## Legacy/pre-Quattro Waybar integration

This repository includes `waybar-module.jsonc` and `waybar-style.css` for older Omarchy or other Waybar-based desktops. Omarchy Quattro users should prefer the native plugin widget and normally do not need this section.


```jsonc
"custom/chromecast": {
  "exec": "chromium-castctl status --waybar",
  "return-type": "json",
  "interval": 5,
  "signal": 12,
  "on-click": "chromium-castctl waybar-toggle",
  "on-click-right": "chromium-castctl stop",
  "tooltip": true
}
```

Manual integration after validating the CLI:

1. Back up `~/.config/waybar/config.jsonc` and `~/.config/waybar/style.css`.
2. Add `custom/chromecast` to the desired Waybar module list.
3. Add the module config above to the Waybar config.
4. Add this CSS so the Chromecast glyph uses the local OTF while labels still fall back to the normal Waybar font:

```css
@keyframes chromecast-busy {
  to {
    color: #e0af68;
  }
}

#custom-chromecast {
  min-width: 12px;
  margin-right: 13px;
  font-family: "Chromium Castctl Icons", "JetBrainsMono Nerd Font";
}

#custom-chromecast.busy {
  animation-name: chromecast-busy;
  animation-duration: 0.7s;
  animation-timing-function: ease-in-out;
  animation-iteration-count: infinite;
  animation-direction: alternate;
}

#custom-chromecast.active {
  color: #9ece6a;
}
```

5. Restart Waybar:

```bash
omarchy restart waybar
```

Do not edit Waybar before `chromium-castctl doctor`, `sinks`, `start`, `stop`, and `status --waybar` have been manually validated.

## Waybar JSON

Idle:

```json
{"text":"","class":"idle","tooltip":"Chromecast: idle"}
```

Busy/discovering:

```json
{"text":" ...","class":"busy","tooltip":"Discovering Chromecast targets…"}
```

Active:

```json
{"text":" Wohnzimmer","class":"active","tooltip":"Casting to Wohnzimmer"}
```

## Paths

```text
profile: ~/.local/share/chromium-castctl/chromium-profile/
state:   ~/.local/state/chromium-castctl/state.json
log:     ~/.cache/chromium-castctl/chromium.log
binary:  ~/.local/bin/chromium-castctl
font:    ~/.local/share/fonts/chromium-castctl/chromium-castctl-icons.otf
```

## Troubleshooting

Run:

```bash
chromium-castctl doctor
chromium-castctl status
chromium-castctl sinks
```

If Chromium launches but CDP is unavailable, inspect:

```bash
~/.cache/chromium-castctl/chromium.log
```

If the isolated headless browser is running but you are not casting, close it with:

```bash
chromium-castctl quit-browser
```

If state becomes stale, the next command removes stale state automatically. To reset manually:

```bash
rm -f ~/.local/state/chromium-castctl/state.json
```

To remove the isolated Chromium profile and force a clean control browser:

```bash
rm -rf ~/.local/share/chromium-castctl/chromium-profile
```

This does not touch the normal Chromium profile.

If no sinks are found, confirm that Chromium's Cast menu can see the Chromecast and that this machine and the Chromecast are on the same network.

## Audio caveat

By default the tool launches Chromium with only:

```text
--enable-features=MediaRouter
```

Chromium's native system-audio loopback feature previously muted local audio on this machine, so it is opt-in for testing:

```bash
CHROMIUM_CASTCTL_CAST_AUDIO=1 chromium-castctl start Wohnzimmer
```

That opt-in adds:

```text
PulseaudioLoopbackForCast
```

Audio must be validated empirically by starting a cast and playing system audio. v1 intentionally does not add a separate ffmpeg/PipeWire audio pipeline.

## Development

Run tests with Node's built-in test runner and validate the plugin manifest:

```bash
./scripts/validate-plugin.sh .
node --test
node --check bin/chromium-castctl
bash -n install.sh scripts/validate-plugin.sh
```

The GitHub Actions workflow runs these checks on pushes and pull requests. The Node test suite starts a dependency-free dummy Chromium/CDP Cast backend and exercises the same helper workflows the Quickshell plugin uses: target discovery, start, active status, stop, and idle status.

Omarchy Marketplace verification is separate: the marketplace must scan and record the exact listed commit before it can display `Verified`.

No npm dependencies are required. Full visual Quickshell/Omarchy shell interaction still needs manual validation on an Omarchy desktop.

For bugs and focused feature requests, use [GitHub Issues](https://github.com/HackXIt/omarchy-chromecast/issues). Keep pull requests small and include the validation commands you ran.

## Releases

Releases are tag-driven. The tag version must match `manifest.json`.

```bash
git switch main
git pull --ff-only upstream main
git tag -a v0.1.0 -m "v0.1.0"
git push upstream v0.1.0
```

Pushing a `v*.*.*` tag runs the release workflow, validates the plugin/helper, and publishes a GitHub Release with source archives.

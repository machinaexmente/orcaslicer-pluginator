# Pluginator

A standalone browser for [OrcaSlicer](https://github.com/SoftFever/OrcaSlicer) plugins with one-click install. It needs no Orca Cloud login.

```
Pluginator.cmd            Windows: double-click
./pluginator.sh           Linux / macOS (./pluginator.sh --desktop-entry adds it to the app menu)
npm install && npm start  anywhere
```

It opens in its own window. Browse or search the catalogue, open a plugin, and press **Install into OrcaSlicer**. Restart OrcaSlicer, then turn on or configure the plugin in its Plugins dialog.

## Platform support

- **Windows**: tested.
- **Linux**: tested with the Flathub OrcaSlicer (`com.orcaslicer.OrcaSlicer`), the install OrcaSlicer recommends. AppImage and distro builds use `~/.config/OrcaSlicer`, which is also detected.
- **macOS**: the data folder, process detection and build filtering have defaults, but they are untested.

Contributions are welcome: open an issue or a pull request.

## How it works

### Why it doesn't use Orca Cloud

OrcaSlicer 2.5's plugin browser reads from `api.orcaslicer.com`. Every endpoint it uses (`/api/v1/plugins/subscriptions`, `/mine`, `/explore`, `/download`) returns `401 missing_authorization` without an account token. See [`OrcaCloudServiceAgent.cpp`](https://github.com/SoftFever/OrcaSlicer/blob/main/src/slic3r/Utils/OrcaCloudServiceAgent.cpp) and [`CloudPluginService.cpp`](https://github.com/SoftFever/OrcaSlicer/blob/main/src/slic3r/plugin/CloudPluginService.cpp).

### Where the catalogue comes from

The catalogue is [OrcaBits](https://github.com/triluch/orcabits), a public, community-curated registry of OrcaSlicer plugins hosted on GitHub. Each plugin is one YAML file. Pluginator downloads the whole registry as a single tarball (no API quota), caches it for 6 hours, and labels a plugin one-click installable when its listed method is `python` or `wheel`.

### How a plugin's file is found

The registry only links the plugin's repository, so Pluginator looks for the actual file in this order:

1. `.py` / `.whl` assets on the latest GitHub release. Pluginator tries the API first and falls back to the release HTML pages when the anonymous 60 requests/hour limit runs out. If the release publishes a `SHA256SUMS` file (or GitHub asset digests), the download is checked against it.
2. Otherwise, `.py` files with a PEP 723 `[tool.orcaslicer.plugin]` block, or committed `.whl` files, in the source tree. It checks the release tag first, then the default branch.

Builds for other operating systems or CPUs are filtered out. This covers both standard wheel tags and Orca-Cloud-style names like `name_win_x86_64.py`. In testing, 122 of the 127 one-click entries resolved to a file on Windows, and 121 on Linux x86_64. The other five ship no prebuilt file, ship Linux/macOS builds only, or publish only to Orca Cloud.

### How a plugin is installed

Pluginator does exactly what OrcaSlicer's own install-from-file does (`plugin_loader::install_plugin` in [`PluginLoader.cpp`](https://github.com/SoftFever/OrcaSlicer/blob/main/src/slic3r/plugin/PluginLoader.cpp)):

```
<data dir>/orca_plugins/<escaped file name>/<file name>
<data dir>/orca_plugins/<escaped file name>/.install_state.json   (installed_from: "local", enabled: true, all permissions off)
```

- The existing folder is backed up and restored if the install fails.
- Reinstalling keeps your enabled/capability choices but resets permissions, the same as Orca does.
- When an update changes the file name, the old folder is removed.
- OrcaSlicer still asks for permissions at runtime, and it installs a plugin's Python dependencies with its bundled `uv` the first time the plugin loads.

The default data folder is `%APPDATA%\OrcaSlicer` on Windows and `~/Library/Application Support/OrcaSlicer` on macOS (untested). On Linux, Pluginator looks in these folders and uses the one with the newest OrcaSlicer version:

| Install | Data folder |
|---|---|
| Flatpak | `~/.var/app/com.orcaslicer.OrcaSlicer/config/OrcaSlicer` |
| Flatpak, old app id | `~/.var/app/io.github.softfever.OrcaSlicer/config/OrcaSlicer` |
| AppImage / distro package | `$XDG_CONFIG_HOME/OrcaSlicer` (usually `~/.config/OrcaSlicer`) |

If it finds more than one, Settings lists them so you can switch. You can also type any folder there, for portable installs. Plugins installed through Orca Cloud live in `orca_plugins/_subscribed/` and are left alone.

## Notes

- Plugins are unreviewed third-party Python code that runs inside OrcaSlicer. The details panel links to each file's source before you install it.
- Setting `GITHUB_TOKEN` is optional. It only raises the GitHub API limit; the HTML fallback works without it.
- The server listens only on `127.0.0.1`. It rejects other `Host` headers and any write that doesn't carry the `X-Pluginator` header.
- Pluginator's own state lives in `%APPDATA%\pluginator` (`~/.config/pluginator` elsewhere): settings, install records and the catalogue cache.
- On Linux and macOS it opens in a Chromium-based browser's app window if one is installed (including Flatpak Chromium, Chrome, Edge, Brave and Vivaldi), and otherwise in your default browser.
- Python plugins need OrcaSlicer 2.5 or newer.

## License

Pluginator is licensed under the [GNU GPL v3](LICENSE). It is an independent tool and contains no OrcaSlicer code. It only follows OrcaSlicer's on-disk plugin layout. [OrcaSlicer](https://github.com/SoftFever/OrcaSlicer) itself is licensed under the GNU AGPL v3.

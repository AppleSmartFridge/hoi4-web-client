# HOI4 Link web client

A browser map for a Hearts of Iron IV game running **hoi4link**: the political map with live borders, country names, cosmetic tags and the in-game date, straight from the game.

## How it works
This repository holds only the page (HTML, CSS and JavaScript). It contains **no game files and no map data**. The map is built from the host's own HOI4 install and stays on the host's PC; after you sign in with the token, hoi4link sends it over the connection and your browser caches it.

## Connecting
1. On the PC running the game: install hoi4link, then build the map data once (and again after changing mods):
   ```
   python tools/mapgen/build_map.py
   ```
   It copies the result to `<game>\hoi4link\mapdata`, where the game sends it from.
2. Start HOI4 and open the page.
3. **On the game's PC:** connect to `ws://127.0.0.1:8787` with the token from `<game>\hoi4link\config.json`.
4. **Friends:** the page is served over https, so browsers only let it reach another PC over `wss://`. On the game's PC, with Tailscale installed and signed in, run
   ```
   tailscale serve --bg 8787
   ```
   and give friends `wss://<pc-name>.<tailnet>.ts.net` plus the token. Only people on your tailnet can reach it.

The first time you connect, Chrome and Edge ask whether this site may access devices on your local network: choose **Allow**. If you refused it once, allow it again from the icon left of the address bar → Site settings → Local network access.

The token controls your game: share it like a password. To revoke it, delete the `token` line in `config.json` and restart the game.

## Source
Built from the HOI4WebClient project's `web/app` folder by `scripts/publish_web.ps1`. Hearts of Iron IV is a trademark of Paradox Interactive; this project isn't affiliated with Paradox.

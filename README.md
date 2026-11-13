# OOO trip companion

The OOO trip companion app: https://thewanderingjay101-cmd.github.io/OOO-trip-companion/

`index.html` is the whole front end, a static page served by GitHub Pages. It talks to a Google Apps Script web app as a small JSON API (POST `{"fn", "args"}` as `text/plain`), which reads each trip's itinerary doc and expense sheet and checks the trip PIN on the server. The page holds no trip data and no PINs, only the API link.

- `?trip=<key>&k=<key>` or `?ks=<trip>:<key>,...` open trips this device has unlocked (the page adds these to its own link after a correct PIN, so a Home Screen icon opens without the PIN).
- `?add=1` shows the PIN box to open another trip. `?setup=1` shows Add to Home Screen steps and removes itself from the link.
- `apple-touch-icon.png` and `icon-512.png` are the Home Screen and browser icons.

`index.html` is generated from the app's template (`build_appscript.py` writes `pages/index.html`); edit the template and rebuild rather than editing this file by hand.

The interface is written for travellers: no mention of Google Drive, sheets or how data is read. What each screen shows (header, Home Screen steps, currency toggle, Settle up and Balances) is described in the project's `kansai-mobile/README.md`, under "What the screens show".

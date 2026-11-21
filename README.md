# Just Follow (trip companion)

The Just Follow trip companion app (formerly OOO): one phone page for every trip, opened with a trip PIN.

- **App link to share (GitHub Pages, no Google banner):** https://thewanderingjay101-cmd.github.io/OOO-trip-companion/
  (the address keeps the old name so existing links and Home Screen icons keep working)
- **Beta (test backend, test data only):** https://thewanderingjay101-cmd.github.io/OOO-trip-companion/beta/
- **Backend (Google Apps Script web app):** https://script.google.com/macros/s/AKfycbwpoGwMWlE_InveJ3rCfw1H_9yewjGpVEWfT-dUrU4Cd0sDZ38SUswcaOFjjyUA1y16/exec

**This repo is the source of truth** for the app's code (since 21 Nov 2026): the page template, the Apps Script backend, the build script and this README. The copy in the project files (`kansai-mobile/`) is the old working copy and is no longer edited. The repo is public, so it never holds PINs, the Trips sheet's id or anything else private: those stay in Google (script properties and the private Trips sheet).

## Repo layout

| Path | What it is |
|---|---|
| `index.html` | The live front end, served by GitHub Pages. **Generated**: never edit by hand. |
| `beta/index.html` | The beta front end: same app, talks to the test backend. **Generated**. |
| `app/template.html` | The page itself (markup, styles, scripts). Edit this, then rebuild. |
| `app/appscript/` | The Apps Script backend: `Code.js`, `Members.js`, `Parser.js`, `Changes.js`, `appsscript.json`, and the generated `Index.html` (the Apps Script copy of the page). |
| `app/build_appscript.py` | Builds `index.html`, `beta/index.html` and `app/appscript/Index.html` from the template (plus `project-import.json`, not committed). |
| `app/beta.json` | The test backend's /exec link (`{"api": "..."}`); blank shows a "not connected yet" page at /beta/. |
| `app/build_data.py`, `app/render_page.py` | Offline tools: turn saved snapshots of a trip's doc and sheet into data and render a page from them (for debugging the parser; they never touch live files). `build_data.py` holds the same parsing logic as `Parser.js`: keep them in sync. |
| `tests/smoke_test.py` | Checks the generated files match a fresh build, every script parses, and the beta page keeps its device storage apart. |
| `tests/parser_parity_test.py` | Runs `Parser.js` and `build_data.py` on a small made-up doc (built in the test) and checks they give the same plan and trip data, with and without the optional booking lines. |
| `tests/backend_test.js` | Runs the backend in Node against in-memory fakes of Google's services (Trips sheet, Members sheet, sessions, error log, inbox naming). No network, no real files. |
| `.github/workflows/backend.yml` | Runs both tests on every PR; updates the test backend on each PR; deploys the live backend when JY presses Run. |
| `*.png` | Icons: `just-follow-180.png` (apple-touch-icon), `just-follow-512.png`; `apple-touch-icon.png` / `icon-512.png` are the old suitcase, kept for old pages. |

## Build and test

```
python3 -I app/build_appscript.py   # after any change to app/template.html, app/beta.json or app/appscript/*.js
python3 -I tests/smoke_test.py
python3 -I tests/parser_parity_test.py
node tests/backend_test.js
```

Commit the rebuilt `index.html`, `beta/index.html` and `app/appscript/Index.html` with the change; the smoke test fails if they are out of date. A change only to `app/template.html` goes live when the PR merges (GitHub Pages updates in a minute or two). A change to `app/appscript/` also needs the backend deployed (see "Deploying the backend").

## Test backend and /beta/ (never test on live files)

Nothing is ever tested against live trip files. The test setup is a second, separate copy of everything:

- Drive folder **"02 Holiday Itineraries / 00 Trip Companion (private) / Just Follow test (private)"** (private, does not inherit sharing). It holds copies of the Kansai itinerary doc and expense sheet ("TEST Kansai ...") and a **"TEST Just Follow Trips"** sheet with one test trip (key `test-kansai`, name "TEST Kansai") and a test PIN. Never put a real PIN in it.
- Apps Script project **"Just Follow test"** (set up 21 Nov 2026; its /exec link is in `app/beta.json`): a copy of the live project, deployed as its own web app (Execute as: Me, Who has access: Anyone). Script properties: `TRIPS_SHEET` = the TEST Trips sheet's id, `APP_ENV` = `test`, and no `TRIP_*` or `INBOX_*` properties (delete any that the copy brought over, or the test backend would open live trips and write to live inboxes).
- `APP_ENV = test` makes the backend name its own files so they can't be mistaken for live ones: the test inbox is "TEST <trip> Inbox (beta)" (the scheduled inbox run only looks at titles ending "Trip Inbox", and also skips anything starting "TEST"), and the Members sheet is "TEST Just Follow Members". `testMembers` only runs there.
- `/beta/` is built from the same template, pointed at the test backend's /exec link (`app/beta.json`). It shows a "BETA · TEST DATA" badge, is called "JF Beta" on the Home Screen, and keeps its device storage under a `jfbeta:` prefix, so trying it never changes the saved trips, PINs or Home Screen keys of the live app on the same phone.
- With deploys automated, every PR updates the test backend, so `/beta/` (once the PR is merged, or via the PR's `beta/index.html`) runs the new code against test data first.

## Deploying the backend

Automated (chosen by JY, 21 Nov 2026), with GitHub Actions and clasp (`.github/workflows/backend.yml`):
- Every PR: both tests run. If the PR comes from this repo and the test project is set up, the PR's `app/appscript/` is pushed to the **test** project and its web app deployment gets a New version (same test /exec link).
- Live: Actions > Backend > Run workflow (branch `main`), with a short note. It pushes `app/appscript/` to the **live** project and deploys a New version of the existing deployment, so the /exec link never changes. It only runs from `main`, only when pressed.
- One-time setup (JY): turn on the Apps Script API at https://script.google.com/home/usersettings; on a computer run `npx @google/clasp@2.4.2 login` and sign in as the account that owns the projects; add the contents of `~/.clasprc.json` as repo secret `CLASPRC_JSON`; add repo variables `TEST_SCRIPT_ID`, `TEST_DEPLOYMENT_ID`, `LIVE_SCRIPT_ID`, `LIVE_DEPLOYMENT_ID` (script id: Project Settings > IDs; deployment id: Deploy > Manage deployments, the `AKfy...` id). Treat the clasp token like a password: it can change any Apps Script project of that account. Optionally add an Environment called `live` with JY as required reviewer, so a live deploy also needs an approval click.
- Before the first deploy of the repo's `Code.js` to live: add script property `TRIPS_SHEET` (the Trips sheet's id) to the live project. The repo keeps `TRIPS_SHEET_ID` blank because the repo is public; without the property the app shows "not set up" for everyone.
- By hand (fallback): paste the changed files into the editor (`Code.js` -> Code.gs, `Members.js` -> Members.gs, `Parser.js` -> Parser.gs, `Changes.js` -> Changes.gs, `app/appscript/Index.html` -> Index, `appsscript.json`), Save, then Deploy > Manage deployments > pencil > Version: New version > Deploy (keeps the same link). Never "New deployment": that makes a new /exec link.
- Ship backend first, then the page, when a change touches both.

## The app's own data sheet, sessions and error log (Members.js)

- **"Just Follow Members"**: a private spreadsheet the backend creates itself the first time it is needed (drive.file scope, like the inboxes), id in script property `MEMBERS_SHEET`. Run `setupMembers` once from the editor to create it now and log its link; then move it into "00 Trip Companion (private)" (the script can't pick its folder). The test backend makes its own "TEST Just Follow Members".
- Tabs (columns matched by header name): People, Members, Sessions, Trip settings, Join requests, Votes, Ballots, Notification settings, Profiles, Error log. They are only ever added; nothing moves, clears or rebuilds a tab. A missing tab is added back by `setupMembers`.
- Organisers: an optional **Organiser email** column at the end of the Trips sheet (header-matched, so nothing else moves). Each organiser is seeded as a People row and an "Organiser" Members row for that trip by `setupMembers`, and by `warmUp` every 6 hours once the sheet exists. The email is never sent to the page.
- Sessions (for email sign-in, later): `newSession_(email)` returns a random token and stores only its SHA-256 hash; `checkSession_(token)` is cached for 10 minutes so checking it on every call costs a cache read; `endSession_(token)` signs out. Nothing uses sessions yet, so opening a trip is exactly as fast as before (openTrip, refreshTrip and the inbox calls never read this sheet).
- Error log: every unexpected server error (not wrong PINs, lockouts and the like) is written to the Error log tab with a reference code like `JF-7KQ2MX`, the function, the trip key and the stack. The API answer carries it as `ref`, so the page can show it on an error screen (task 17). Logging never throws.
- `testMembers` (test backend only; it refuses to run on live because it writes test rows) checks the tabs, a session from the sheet and from the cache, sign-out, and an error row with its code.

## How the two halves fit (since 13 Nov 2026)

- Front end: one static page, `index.html` in this repo (served by GitHub Pages, free). It is built from the same `app/template.html` as the Apps Script page, so both look and behave the same. It holds no trip data and no PINs; only the backend's /exec link.
- Backend: the Apps Script project. `doPost` is a small JSON API: the page POSTs `{"fn": ..., "args": [...]}` as `text/plain` (a CORS "simple" request, so no preflight, which Apps Script can't answer) and gets `{"ok": true, "result": ...}` or `{"ok": false, "error": "wrong" | "locked" | "needpin" | "setup" | "busy" | "empty" | "error"}` (an unexpected `error` also carries `ref`, its Error log reference code). Only `openTrip`, `refreshTrip`, `getInbox` and `postInbox` can be called, with exactly the same PIN, key and lockout checks as before. Apps Script answers through a redirect to googleusercontent.com, which `fetch` follows (both hops send `Access-Control-Allow-Origin: *`).
- The deployment must stay Execute as: Me, Who has access: Anyone (no Google sign-in), or the API calls fail. The page sends no cookies (`credentials: 'omit'`), so being signed in to several Google accounts no longer matters.
- Trip data, PINs, the Trips sheet and the inboxes stay in Google exactly as before. The Trips sheet stays private: only the script reads it.
- Portable on purpose: the page only knows `callServer(fn, args)` (top of the script in template.html). Moving to another host (e.g. Cloudflare Pages) means copying `index.html` and the icons; moving the backend (e.g. Supabase) means a new endpoint that answers the same four calls in the same shape.
- The old /exec page keeps working for anyone with that link, so nothing breaks. Its "Add OOO to Home Screen" link now leads to the new front end.

- One Apps Script project serves every trip, deployed as web app: Execute as Me, access Anyone. One Home Screen icon covers all trips.
- Nobody sees a trip, not even its name, until they enter that trip's PIN. Share the plain link plus the trip's PIN: the PIN alone decides which trip opens. `?trip=<key>` asks for that one trip's PIN (optional; the plain link is enough).
- A device remembers each trip it has unlocked. Next time the plain link opens the current one of those (else the next upcoming, else the latest past), and the Me tab's "Other trips" lists only the other trips that device has unlocked. Nothing else is ever listed, so companions only see the trips you gave them a PIN for. You see all your trips once you've entered each PIN on your phone.
- Trips can share a PIN on purpose (same travellers, or you're happy for them to see both). Typing a shared PIN unlocks every trip with that PIN on that device: the current or next one opens and the rest appear under "Other trips". `testRead` logs which trips share a PIN. Give a trip its own PIN to keep it separate.
- Reads each trip's itinerary doc and expense sheet live (read-only scopes via the Docs and Sheets advanced services). Never writes to them. Doc or sheet edits show within about a minute, no redeploy needed.

## Trips live in the Trips sheet (no Apps Script step to add one)

Trips are rows in the private Google Sheet "Trip Companion Trips" (tab Trips; its link is in the project instructions, never in this public repo), in the folder "02 Holiday Itineraries/00 Trip Companion (private)". That folder does not inherit the parent folder's sharing, so the sheet stays private to JY: it holds the PINs. Never share it.

Columns (matched by header name): Key | Name | Start | End | Doc | Sheet | PIN | Time zone | Place | Notes, and optionally Organiser email at the end (see Members.js below). The tab is formatted as plain text so dates and PINs (e.g. 0123) stay as typed.

- Key: e.g. `27-03-tokyo`; left blank it is made from Start and Name. Doc and Sheet take an id or a full link. A row without a PIN is ignored, so a trip can be prepared before it goes live.
- Adding or editing a row shows in the app within about a minute (the trip list is cached 60 s). No editor visit, no redeploy. Claude can add the row directly.
- The app finds the sheet through script property `TRIPS_SHEET` (its id). `TRIPS_SHEET_ID` in Code.js is only a fallback and is blank in this public repo; the live project's pasted copy still has it filled in until the next backend deploy.

Script properties still work as a fallback (Project Settings > Script properties); if a key is in both, the sheet wins. Property `TRIP_<key>`, for example `TRIP_26-11-kansai`, with value:

```
name=Kansai; start=2026-11-11; end=2026-11-20; doc=<doc id>; sheet=<sheet id>; pin=<PIN>; tz=Asia/Tokyo; place=Japan
```

- Required: name, start, end (YYYY-MM-DD), doc, sheet, pin. Optional: tz (default Asia/Singapore), place (shown in the local time hint).
- Adding a trip needs no code change and no redeploy. `testRead` in the editor (optional) logs how many trips the sheet gave and checks each trip's files.
- The doc must follow the Itinerary V2 layout (day headings "11 November 2026 Wednesday", 3-column tables). The sheet must have Expenses, Summary and Settlement tabs like the Kansai sheet.
- Home Screen: phones forget the saved PIN when a Home Screen app is closed, so after a correct PIN the page puts the keys in its link: `?trip=<key>&k=<key>` when the device has one trip, or `?ks=<trip>:<key>,<trip>:<key>` when it has several (no trip named, so the icon opens the current trip and lists the rest under Other trips). Add to Home Screen *after* unlocking every trip you want on it, and the icon opens without asking. Treat that link like the PIN: share the plain link, not your Home Screen one.
- Switching trips: the Me tab's "Other trips" lists the other trips this device (or icon link) has unlocked, and always has "Open another trip with its PIN" (`?add=1`), which shows the PIN box without auto-opening a saved trip.
- Change a trip's pin to revoke saved PINs and Home Screen links (re-add the icon after); that trip also drops off those devices' "Other trips" lists. The old `TRIP_PIN` property is no longer used.
- Lockout: 20 wrong PINs in 10 minutes (on the plain link, across everyone; on a `?trip=` link, per trip) blocks PIN entry for 10 minutes. Saved device keys never count as wrong tries.
- Server calls (via `google.script.run` on the Apps Script page, via `doPost` from the GitHub page): `openTrip(key, cred, saved)` opens a trip from a typed PIN, a Home Screen key or the device's saved keys and returns the trip plus `mine` (the trips this device may list). `unlock` is kept only for pages opened before 11 Nov 2026.
- Pull down at the top of the page to refresh: it re-reads the doc and sheet on the spot (`refreshTrip`), skipping the 1-minute cache.

## Tabs and the chat bar (upgrade task 4, 21 Nov 2026)

Five tabs in one row: **Group, Bookings, Plan (in the middle), Expenses, Me**. The open tab has a yellow pill behind its icon. Links: `#group`, `#bookings`, `#plan`, `#expenses`, `#me`, `#requests`; old links still work (`#trip` opens Bookings, `#inbox` opens My requests).
- **Group** (replaces the top of the old Trip tab): the trip header "<Trip> · N travellers", the Overview (intro, days and nights, hotels, travellers), Recent changes (the last 5 inbox messages marked Done, with "See all messages") and People (the expense sheet's travellers, "(you)" beside this phone's name). Open votes go at the top in task 14; the red dot on the Group tab (`#group-dot`) is for them.
- **Bookings**: four cards on top (task 5, see "Bookings tab"), then the old Trip tab's Flights, Hotels and Car rental under "All bookings".
- **Plan** and **Expenses**: unchanged.
- **Me**: "Who are you?" (this phone's name, used for messages), Other trips and "Open another trip with its PIN", Add to Home Screen, Night mode.
- **Chat bar** (`#chatbar`): sits above the tab bar on every tab except Me, whenever the page can reach the backend. Its hint reads "Suggest a change to the trip…" on Group, Bookings, Plan and My requests, and "Log an expense…" on Expenses (JY, 21 Nov 2026). Typing and Send (or Enter) posts to the trip inbox with `postInbox`, exactly as the old Inbox form did. If this phone hasn't picked a name yet, a "Who are you?" sheet asks first and then sends. The bar is drawn once and only updated (`drawChat`), so a re-render never interrupts typing. Its height is kept in `--chat-h` so the page's last lines stay clear of it.
- **Clock button** on the chat bar opens **My requests** (`#requests`, task 11): only the messages sent under this phone's "Who are you?" name (after email sign-in, task 7, it becomes the signed-in person), newest first, with All / Open / Finished. Each shows its status and the reason: Waiting ("Will be applied by about 1pm", from the 9am / 1pm / 5pm runs), Voting (task 14), Question for you (inbox Status Pending or Needs JY; the run's question, with Reply, which puts "Replying to …" above the chat bar), Done (the run's answer if any, else when it was applied) and Not done (inbox Status Skipped, with the run's one-line reason). The red number is how many of them are still open (Waiting, Voting or Question for you). Everyone's finished changes stay on Group's Recent changes. No inbox column was needed for this: it uses From, Status, Reply and Done at.
- The inbox is loaded once in the background after the trip opens (and again on pull-to-refresh), so the badge and Recent changes fill in without opening My requests.
- Nothing on the backend changed for this: the same four calls, the same inbox sheet.

## Bookings tab (upgrade task 5, 21 Nov 2026)

Four cards at the top, worked out from the plan and today's date in the trip's time zone (`bookingCards` in template.html). Nothing to set up: they work for every trip, and get richer when the doc has the optional lines below.
- **Tonight** (dark card): the hotel whose stay covers tonight, "Night N of M", check-in time (the "Check-in to hotel" row, or the hotel's own "Check-in:" line), the booking code, and Map, Call and Copy local address buttons. Before the trip it shows the first night instead. Map uses the row's Maps link, else a search for the local address or the hotel name.
- **Car rental**: number of cars, then "Pick up Thu 12 Nov, 10am" before pick-up ("in N days"), "Picked up" with the return time and a Call button during the rental, "Returned" after. Uses the "Collect car" and "Return car" rows.
- **Next flight** (or ferry): the next leg that hasn't left yet, with "today / tomorrow / in N days", times, booking code and the online check-in line. The last leg is called "Flight home".
- **Still to book**: rows marked To book from today on; tapping one opens that day in Plan. "All set" with the ducklings when there are none.

Optional lines in the itinerary doc, on the flight's Departure row, the "Check-in to hotel" row or the "Collect car" row, italic like the other info lines (plain also works):
- `Booking code: KB-48213` (also "Booking ref", "Confirmation code/number", "Ref")
- `Phone: +81 78 325 8111`
- `Address (local): 神戸市中央区波止場町5-6`
- `Online check-in: Thu 19 Nov 10:05`

Parser.js reads them into a `book` object on that flight, hotel or car (`{code, phone, address, checkin}`, only the ones present; no `book` key when there are none, so older trips parse exactly as before). They are kept out of the flight number and out of the hotel and car notes in "All bookings". `build_data.py` does the same; `tests/parser_parity_test.py` checks both agree.

## Changes since this morning (upgrade task 13, 21 Nov 2026)

- `Changes.js`: the first fresh read of a trip each day (in the trip's time zone) keeps a **morning snapshot** of the parsed plan and expense rows. Every later fresh read compares with it and sends `changes: {since, list}` with the trip data. Each change is `{date, name, kind, text, at}`: kind `moved` ("Kobe Gyu Ramen moved 18:00 → 19:00"), `edited`, `added`, `removed`, `replaced` (a new stop at an old stop's time) or `expense` ("JPY 3,200 Lunch logged, paid by KA"). `at` is when the change was first seen (HH:mm, trip time).
- The snapshot is one script property per trip, `SNAP_<key>`, holding only short fingerprints (stop names, times and 6-character hashes; about 3.5 KB for a 10-day trip). It is rewritten only when the day rolls over or a new change is first seen. A change that is undone drops off the list. If the expense list is too long to fit, only plan changes are tracked. A damaged property is simply replaced.
- It runs inside `getTripData_` after the doc and sheet are read, so opening from the cache costs nothing extra, and any error there is logged and ignored (the trip still opens). Changes show within the 1-minute cache, or at once with pull-to-refresh.
- "This morning" starts at the first read after midnight. With the `warmUp` trigger on (every 10 minutes during a trip), that is just after midnight, so changes made by the 9am run show up. Without it, it is the first time anyone opens the trip that day.
- Page: a dark "N changes since this morning" card at the top of Plan (first 3, "See" lists all with the time and day; a change on another day opens that day). Changed cards say "Changed 10:12" next to their kind. A copy kept from an earlier day never shows that day's changes.
- No new permissions and no new files: script properties only.

## What the screens show (UI polish, 13 Nov 2026)

The app is written for travellers, not for us: no mention of Google Drive, sheets or "reads live" anywhere in the interface.
- Header: the trip name and dates are the big title ("Kansai · 11–20 Nov 2026"); the tab (Group, Bookings, Plan, Expenses, Me) is the small line above it; My requests has "Only you see this list" there. Group's title is "<Trip> · N travellers", Me's is this phone's name. The grey line under the title is only used for short status ("Checking for changes…"); when the page was updated shows once, in the footer ("Updated/Loaded …, Japan time · Pull down to refresh"). The app never links to or names the itinerary doc or expense sheet (no footer links either, 13 Nov 2026); JY opens those from Drive.
- Group tab (the Trip tab until 21 Nov 2026): the Overview starts with the doc's intro text (no repeated doc title or date line, since the header already shows them) and has no Itinerary doc / Expense sheet buttons; the small links in the footer are the way to the files. The Overview stat reads "10 days" with "9 nights" on its own line. Bookings tab: Hotels show "Check in <day> · <time>" and "Check out <day> · <time>": the times come from the plan (the "Check-in to hotel" row, and the first row mentioning check-out before the next hotel's check-in), and a hotel's own info lines "Check-in: 3pm" / "Check-out time: 11am" win when the doc has them. With no check-out row, only the date shows (the next hotel's check-in day, or the trip's last day). Car rental is sorted from the doc's car lines, for any trip: the rental company (a line ending in "Car Rental"/"Rent-a-car") as a small line under the heading, then two small cards like the Overview stats: number of cars with each model (from "<Model> - <price>" lines; prices aren't shown, they are in the expense sheet) and insurance (the word before "insurance" as the big text, e.g. "Full", the rest underneath); then Pick up with the "Pick-up Time:" beside the date (else the itinerary time) and the "Location:" under it; Return as "Fri 20 Nov · 08:00"; every other line plus the doc's notes go under Notes. "Add Just Follow to your Home Screen" (Me tab) is its own section with two numbered steps (tap Set up the icon, then the iPhone / Android steps) and a button to the `?setup=1` screen.
- Expenses tab: "Amounts in" with a currency toggle once at the top (stored per trip on the device). The other currency is the most common non-base currency in the Expenses tab; its rate is the average of the sheet's own conversions (sum of amounts / sum of base amounts on those rows), so no extra data or backend change is needed. Trips with only base-currency expenses show "Amounts in SGD" with no toggle.
- Settle up: By group / By person toggle and the bar chart of net balances; the transfers are under "Who pays whom".
- Expenses list (last section, titled "Expenses"): every expense row, newest first, 5 rows then a Show more / Show less button. Each row: description, amount in the chosen currency, then date · category · paid by, plus the original amount when it was paid in a foreign currency and the view is in the base currency.
- Balances: own By group / By person toggle (stored per trip on the device). Each row is the name on one line (never wrapped) and, under it, a full-width two-sided bar from a centre line: what they paid to the left (light bar), their share to the right (dark accent bar), both on one scale. The amount sits inside its bar when the bar is wide enough (58% of its half or more), otherwise just past the bar's end, so small bars aren't stretched. A zero amount shows no bar and no label.

## Brand look and wording (Just Follow, 15 Nov 2026)

The app follows the Just Follow brand guidelines (Notion "Brand guidelines – Just Follow", direction B2 Ducklings). Only the page changed (template.html); parsing, server calls and trip data are untouched, and it works the same for every trip.
- Colours are tokens at the top of app/template.html: warm off-white background #FCFAF6 (toned down from brand sand #FFF4E8, which read too peach in the app, JY 15 Nov), white cards, night ink #1B2340 for text, buttons and the selected day, duckling yellow #F6B92B for "now" (Today pill, today's day chip, the card happening now) and the paid bars, deep coral #B23E1C for anything still to book, and deep coral / pond teal for owes / gets back in Settle up. The app never names the colours in its wording (JY, 15 Nov). Settle up has an "Owes | Gets back" header over the bars, in the same format as Balances' "Paid | Share" (no colour legend sentence). Bright coral #F2643D is only for the route trail (too low contrast for small text). Dark mode is a soft navy (#3A4470 background, #46517F cards; JY found deeper navies too dark, 15 Nov); chips and stat tiles use their own tokens (--chip, --on-chip) so they stand out in dark mode (lighter blue #5F6BA0 with white text) with yellow highlights.
- Fonts: Bricolage Grotesque (ExtraBold) for headings, times and amounts; Inter for text; Noto Sans JP for Japanese names. Cards 20 px corners with a light shadow, buttons 14 px.
- Drive, walk and transit rows in the Plan show as a coral dotted trail (left border), not a dashed box.
- Tone: the app's own wording is a little playful ("Lining up the ducklings…", "Got it. Logged. Quack.", "No messages yet. All quiet on the pond.", "Take a 10-minute paddle", "Rounding up the latest…", footer "We plan. You just follow.", an "All set" chip on a day with nothing left to book). Anything from the itinerary doc or expense sheet, booking labels, money and error messages stay plain. Don't add puns to itinerary content.
- The PIN and setup messages say "your organiser" instead of naming JY.
- Mascot ducks (JY, 15 Nov): `DUCKS(kind, height)` in the first script of template.html draws small inline ducks (`row` mother + three ducklings, `kids` three ducklings, `pair` mother + duckling, `one` a duckling). Used only in the app's own moments: a wandering duckling in the "N to book" chip, three ducklings in the "All set" chip, a duck and duckling on the coral trail above the footer tagline, the duck line on the opening splash, and beside the empty inbox ("All quiet on the pond") and empty expenses messages. Never on itinerary cards.
- Night mode (JY, 16 Nov 2026): the last section of the Me tab (the Trip tab until 21 Nov 2026), "Night mode", has an Auto / Light / Dark toggle. Auto follows the phone's setting (the default). Light or Dark is saved on that device only (localStorage `jf-theme`) and set as `<html data-theme>`, which the colour tokens honour; a small script at the top of the page applies it before the first paint and also sets the status bar colour (theme-color) on the GitHub page. The PIN screen follows the saved choice too.
- Travellers are listed as People on the Group tab (21 Nov 2026); until then the Trip tab showed their initials in one even row.
- Name and icon (16 Nov 2026, during Kansai): the app is called Just Follow and its icon is a mother duck and duckling on night ink. See "App name and icon". The GitHub Pages address still says OOO-trip-companion and stays until a new domain (justfollow.app) is set up, because changing it would change the link everyone uses.

## Opening fast

Reading the itinerary doc and expense sheet takes a few seconds, so the app avoids doing it while you wait:
- Two caches per trip: a fresh copy (60 s) and a last good copy (6 h, the CacheService maximum). `openTrip(key, cred, saved, true)` returns the fresh copy, else the last good one flagged `stale`. The page shows it at once ("Checking for changes…" under the title), then calls `openTrip(..., false)` in the background and swaps in the fresh data. Older pages call `openTrip` with 3 arguments and get the old behaviour.
- Home Screen links carry trip keys (`k` / `ks`), so `doGet` checks them and, if the trip is cached, puts it straight into the page (`boot.pre`, via `preloadTrip_`). That skips a whole server round trip: the plan shows as soon as the page loads. `doGet` never reads the doc or sheet itself (cache only), so a cold cache costs nothing extra.
- While opening from saved keys, the page shows a splash (inline duck icon, "Lining up the ducklings…") instead of the PIN box. Google Fonts load without blocking the first paint.
- Optional, recommended during a trip: a time-driven trigger on `warmUp` (Triggers > Add trigger > function warmUp, event source Time-driven, Minutes timer, Every 10 minutes). It re-reads every trip that is on now or starts within 14 days, so the last good copy is never more than 10 minutes old and Google keeps the script warm (a script nobody has run for a while takes a few extra seconds to start). It only reads; it never writes to trip files. No new permissions.
- GitHub page: there is no `doGet` to preload, so the page keeps the last trip it opened in the device's localStorage (`ooo-last`, only after a correct PIN or key) and shows it at once, flagged stale, while it asks the backend for fresh data. If that trip's PIN was changed, the background check fails, the copy is deleted and the PIN box comes back. Pull-to-refresh also updates the copy.
- What still takes time and can't be removed: Google starting the script and the redirect from script.google.com to the googleusercontent sandbox (about 1 to 3 s together), plus on iPhone the hop through the launcher page.
- Keep it fast: don't add slow work to `doGet` or before the first paint (no doc or sheet reads there), keep trip data small enough to cache (gzip+base64 under 95 KB; a bigger trip silently skips the cache), and keep the `warmUp` trigger on while travelling.

## App name and icon

- Name: Just Follow (was "OOO" until 16 Nov 2026). On the GitHub page it is set in template.html (`<title>`, the header, the splash, "Add Just Follow to your Home Screen") and in build_appscript.py (`apple-mobile-web-app-title`, the label under the iPhone Home Screen icon). `APP_NAME` in Code.js is the Apps Script page's title.
- Icon: a mother duck and duckling on night ink #1B2340 (brand guidelines, no gradient). Source `app/icon/just-follow.svg`; PNGs `just-follow-180.png` (apple-touch-icon) and `just-follow-512.png` (browser and Android) at the repo root next to index.html. The same drawing is inline in template.html (`LOGO`) for the splash and the Home Screen steps. The icon files have new names on purpose, so phones and browsers don't keep showing a cached suitcase; the old `apple-touch-icon.png` / `icon-512.png` stay in the repo for pages opened before the change.
- Changing the name or icon never breaks anything that is saved: the app link, PINs, Home Screen links (`ks` / `k` keys) and the device storage keys (`trip-<key>-pin`, `ooo-last`) stay the same. Keep those storage key names as they are, or every device would ask for its PIN again.
- Home Screen icons already added keep the old picture and label (phones copy them when the icon is added) and keep working. To get the new ones, delete the icon, open the plain link in Safari or Chrome (enter the PIN if asked), unlock the trips, and add it again.
- Apps Script page (rarely used, not updated during Kansai): `APP_NAME` in Code.js already says Just Follow and its Index is rebuilt from template.html, but it only changes once Code.js and Index are re-pasted and a New version is deployed. Its favicon is still the suitcase (`APP_ICON_URL`, a PNG in Drive "00 Trip Companion (private)/trip-companion-icon.png", shared "Anyone with the link"; script property `APP_ICON` overrides) until a duck PNG is uploaded there and the URL updated. The iPhone ignores that favicon anyway, because Apps Script cannot set apple-touch-icon.
- Before 16 Nov 2026 the icon was a suitcase on a navy gradient (`app/icon/trip-companion.svg`).
- The GitHub page is now the app itself, with its own apple-touch-icon, so the iPhone shows the app icon and the page opens full screen from the Home Screen (no Safari bars, no banner). Old Home Screen icons made from the launcher open the new page directly (same link, same `ks` keys). The page puts `?trip=&k=` or `?ks=` in its own link after a correct PIN, like the Apps Script page did, so an icon added after unlocking opens without the PIN. `?setup=1` shows Add to Home Screen steps on the page and drops itself from the link.
- Before 13 Nov 2026 (history): launcher page `launcher/` (index.html + apple-touch-icon.png), hosted on GitHub Pages at `LAUNCHER_URL` (https://thewanderingjay101-cmd.github.io/OOO-trip-companion/, repo thewanderingjay101-cmd/OOO-trip-companion; script property `LAUNCHER` overrides, empty hides the link). The Trip tab's "Add OOO to Home Screen" opens `<launcher>?setup=1&ks=...`: the page shows Add to Home Screen steps and drops `setup=1` from its link, so the saved icon forwards straight to the app with the same `ks` keys. The launcher holds only the app link, never PINs. Its icon on the "Opening your trip…" screen is an inline SVG: an `<img>` there was cut off by the redirect and showed as a broken "?" box on iPhone (fixed 13 Nov 2026). It also preconnects to script.google.com to save a little time.

## If the app won't open ("Unable to open the file at this time")

This Google Drive error page on script.google.com means Google couldn't match the link to a live web app deployment. Usual causes:
- The deployment the link points to was archived or replaced. A change shipped as *New deployment* gets a new /exec link, and old links stop working once the old one is archived. Always ship with Manage deployments > pencil > New version, which keeps the link.
- The link got altered, e.g. `/u/1/` or `/a/<domain>/` inserted by being signed in to several Google accounts. Open the plain link in a Private tab to check. Seen on JY's iPhone on 12 Nov 2026: Safari failed while a Private tab worked, so the deployment was fine and Safari's Google sign-in was the cause. Fix: sign out of the extra Google accounts in Safari (or clear script.google.com website data), or use the Home Screen icon, which keeps its own sign-in separate from Safari.

Fix: in the editor, Deploy > Manage deployments, copy the active Web app URL. If it differs from the one at the top of this file, update this README and `APP_URL` in `app/build_appscript.py`, rebuild, and merge the new `index.html`.
Prevention: everyone opens the app through the GitHub page (https://thewanderingjay101-cmd.github.io/OOO-trip-companion/). If the /exec link ever changes, only that page needs updating; Home Screen icons made from it keep working.
On the GitHub page, "Could not load the trip" on every PIN usually means the backend has no `doPost` yet (code not pasted, or saved without deploying a New version) or the deployment's access isn't "Anyone".

## Parsing notes

Ferries: the parser calls every Departure/Arrival a Flight; the page (`markFerries`, `FERRY_RE` in template.html) shows a boat icon and "Ferry" for a leg whose name, info or details mention ferry, boat, catamaran, jetty, pier or cruise, and for an Arrival right after a ferry Departure. The Bookings tab heading becomes Flights, Ferries or Flights & ferries. No doc changes needed.
Back-up Food List entries with an italic "For: 12 Nov lunch; 14 Nov dinner" line are attached to that day's matching meal card as backups ("For: general" = not attached). Bullet nesting levels and blank lines in the doc drive the sub-bullets on cards.
Travel time between stops is the first notes line starting "Drive:", "Grab:" or "Taxi:" (optionally "Drive from X:"). The app shows the mode: "Drive" keeps the old wording ("About X driving"), while "Grab:"/"Taxi:" show "by Grab"/"by Taxi" on cards and in the day header. Use "Grab:" for trips without a car. Every stop's travel time gets its own row above the stop card (`legHtml`), styled like the doc's own Drive rows: "Drive to <stop>" (or "Grab to"/"Taxi to"), the time, and the route button (to first-choice parking when there is one). The stop card then keeps only its Parking and Maps buttons, so drives look the same whether the doc has a separate Drive row or a "Drive:" line under the stop.


## Inbox (trip members send expenses, changes and comments)

- Since 21 Nov 2026 people send from the chat bar above the tab bar, and the clock button opens My requests (see "Tabs and the chat bar"). Until then a chat button at the top right opened an Inbox tab. People pick their name once on each phone (from the expense sheet's travellers, on Me or when they first send).
- Messages go to a separate "<Trip> Trip Inbox" spreadsheet that the script creates itself (scope `drive.file`, so the itinerary doc and expense sheet stay read-only to the app). Its id is in script property `INBOX_<key>`. The inbox is created automatically the first time anyone opens the trip in the app (or on the first message), so a new trip needs no setup step. `setupInboxes` still exists to create all of them at once and log their links.
- Columns: Time | From | Message | Status (Waiting / Done / Pending / Skipped) | Reply | Done at | Re. The app shows Status and Reply to everyone. Inboxes made before 11 Nov 2026 need the header "Re" in G1 (Kansai has it).
- A scheduled Claude task runs every 4 hours, on the hour at 9am, 1pm and 5pm in the active trip's time zone (JY's choice, 13 Nov 2026), with quiet hours 9pm to 9am every day (JY's rule, 12 Nov 2026; manual runs JY asks for still go ahead). The schedule's time zone is switched to each trip's Time zone column when that trip starts, and the prompt also skips any scheduled run that lands in quiet hours. Each run applies every Waiting message to the live expense sheet and itinerary doc (JY chose fully automatic on 10 Nov 2026), then fills in Status and Done at. It never deletes or clears anything. Its prompt is kept in the project files (`kansai-mobile/inbox-run-prompt.md`); it skips inboxes whose title starts with "TEST".
- Applied messages just get a "Done" tag with no Reply (JY, 11 Nov 2026). When something is unclear, the run marks it "Pending" and puts its question in Reply. Pending messages show a Reply button: tapping it starts the next chat message as an answer ("Replying to ..."), which is saved with Re = the Pending message's row, and the next run applies both together. Old "Needs JY" rows display like Pending.
- The inbox works on both the GitHub page and the old Apps Script page.
- Server call: `postInbox(key, cred, from, text, re)`; `re` is optional, so pages opened before the update still work.

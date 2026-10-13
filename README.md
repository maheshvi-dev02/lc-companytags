# Company Lens for LeetCode

A Chrome and Firefox extension that shows which companies are associated with the LeetCode problem you're viewing. Tags use a bundled snapshot and background updates from [liquidslr/leetcode-company-wise-problems](https://github.com/liquidslr/leetcode-company-wise-problems).

## Install

The `dist` folders are ready to load. Node is only needed to rebuild the source.

### Chrome (127+)

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Choose **Load unpacked** and select the **dist/chrome** folder next to this README.
4. Open or reload a [LeetCode problem](https://leetcode.com/problems/two-sum/).

### Firefox (140+)

1. Open `about:debugging#/runtime/this-firefox`.
2. Choose **Load Temporary Add-on**.
3. Select **dist/firefox/manifest.json**.
4. Open or reload a LeetCode problem. Grant LeetCode site access if Firefox prompts.

Firefox removes temporary extensions when it restarts. For permanent installation, the Firefox ZIP must be submitted for Mozilla signing or publication on Firefox Add-ons. The ZIP is a build artifact, not a signed XPI. Chrome can retain the unpacked extension. Neither build is published to an extension store.

## Use

A compact **Company Lens** bar with a complete rounded border appears below the problem title and tags, before the description. Each company chip shows its logo, name and source frequency score. All companies are ordered by descending score and scroll horizontally in one row; the bar stays in the page layout without covering your code or description. Tab through company buttons or scroll sideways to reach more companies. Click a company logo or name to open that company's questions in the full-page Explorer, using the selected time window and highest frequency first. Source links remain available inside the Explorer. Names and frequency scores use larger text for easier reading.

Click the small **open-window icon** beside the time-window caption in the company bar to open the native toolbar popup. If your browser prevents opening the popup from a page, the icon provides guidance to use Company Lens in the browser toolbar. The compact icon supports mouse and keyboard activation and follows the page's light/dark theme. The popup's company practice view also has a small expand icon beside Back to companies. It opens the same company in the full-page Explorer with its selected time window, difficulty, topic, and sort order.

Click the **Company Lens toolbar icon** for detailed information. The popup offers the time-window filter, ranks, company search, practice questions, sync progress, **Refresh**, and the switch to show or hide the inline bar. Its company list previews five results; **Show all** expands the list and **Show fewer** restores the preview. Use the filter icon beside **Frequency score** to choose highest/lowest frequency or company name A–Z/Z–A. The chosen order is remembered, and search and expansion keep working with it. Dataset status uses plain text beside a small dot: green for ready, blue for syncing, amber for saved data that needs attention or an update, and gray before syncing. Pin the extension icon in your browser toolbar for easy access. The popup and explorer use a neutral light/dark palette, a shared scale for labels and scores, and matching rounded controls. List headers place the label or result count on the left and the compact sort icon at the right edge in both the popup and explorer. Both screens use the same dataset status dots. Orange LeetCode icon links open the corresponding problem or problem list, with tooltips and accessible labels.

Open **Explore dataset** in the toolbar popup to search the whole cached dataset from any website. **Problems** finds a question by title or slug and shows all recorded companies, ranked by frequency. **Companies** finds any company, including companies without a tag on the current problem, and opens all its recorded questions. Company question lists retain source ranks and frequency order, with difficulty/topic filters, title search, and **Load more** to reach every result. For example, searching Acko shows its source questions even though it has no Two Sum tag. Searches run locally and work with the bundled snapshot offline.

In the Explorer's **Problems** tab, combine title search with **Difficulty** and a searchable **Topics** selector. Select several topics and use **Match any** to include problems with either topic, or **Match all** to require every selected topic. **By topic** organizes matching problems into collapsible groups with complete selected-window counts. Expand one topic, **Expand all**, or **Collapse all**; each group's **Load more** reaches the rest of its questions. Problems with multiple topics appear in each relevant group, while the overall count counts each problem once. These filters and groups work offline with your saved dataset. The same multi-topic controls and **List / By topic** views are available in each company's full-page question list. Company topic choices and counts come from that company's selected time window; filtering preserves the original source frequency scores and ranks.

The company filter in the toolbar popup searches only the current problem’s tags; **Explore dataset** searches the whole collection.

**Acceptance** appears beside difficulty in explorer and company practice question lists, and beneath the current problem title in the toolbar popup. Hover over the acceptance text for its meaning, or activate it with a click, tap, or Enter to read the explanation. This is the problem’s overall LeetCode submission acceptance rate, shared across companies. The inline company bar continues to show company logos, names and frequency.

A small green **Completed on LeetCode** check appears beside problem titles in Explorer lists, company questions, and topic groups when your signed-in LeetCode account reports an accepted submission. Keep a signed-in LeetCode tab open in the same browser profile; refresh that tab after updating the extension. Completion is independent of company and interview time window. It is checked separately after dataset rows appear, refreshed when you return to Explorer and periodically while it is visible. If the account is signed out or cannot be checked, the extension shows a short status message and does not invent a completion result.

Use **Status: All problems / Solved / Not solved** in Problems, company questions, topic groups, and popup company practice. Status combines with difficulty, topics, search, sorting, and the selected time window. Filtering applies before pagination and topic counts, so matching problems beyond the first page remain reachable. Solved includes accepted submissions; Not solved includes only problems LeetCode explicitly reports as not accepted or not attempted. Unknown statuses are excluded from both filtered views. All problems continues to use the saved dataset offline; status-filtered views require a signed-in LeetCode tab and refresh when you return to the extension. Only the display preference is saved; account progress remains in memory.

Use the **filter icon** above each explorer list to change its order. The popup and explorer use the same compact icon, and its tooltip names the current sort. Companies can be ordered by name (A–Z or Z–A) or by most/fewest questions in the selected window. Problems can be ordered by search relevance, name, difficulty (easy to hard or hard to easy), or most/fewest associated companies. Company question lists also support highest/lowest frequency, and a problem’s company list supports frequency, name and question count. Counts follow the selected time window; source frequency scores and company ranks keep their original meaning. Sorting applies to all matching results before pagination, and each list’s sort preference is saved on your device. Explorer dropdowns use rounded menus that follow the light/dark theme, with keyboard navigation and click-outside dismissal.

Company logos appear beside names in the inline bar, popup, explorer and company practice headings. Logos are bundled in the extension and work offline, with no calls to third-party logo services while you browse. Companies without a verified asset, or whose image cannot load, show a small initials badge. The bundled catalog includes 277 verified company logos (103 of the 115 companies listed for Two Sum in the current snapshot). Logo credits and source details are included in `extension/logos/catalog.json`.

Choose a **Time window** in the toolbar popup: 30 days, 3 months, 6 months, older than 6 months, or all time. Each company shows its frequency score and the problem's rank within that company's selected list. Tied scores share a rank, and missing scores appear last without an invented value.

Use **Practice** beside a company in the toolbar popup to browse its questions in the selected window. The filter icon opens sorting by frequency, title, difficulty, or the number of companies associated with each question; highest frequency is the default. Difficulty and topic filters work together with the selected order. The first page shows 20 questions; **Load more** adds the next 20 and **Show all** loads every matching question into the scrollable list. The current LeetCode problem is included and marked **Current problem**. Filter by difficulty or topic, then follow a question to LeetCode. Rankings refer to the full company list, so filtering can leave gaps or start at a rank above #1. Equal scores share a rank.

New installations show companies immediately from a compressed snapshot packaged with the extension, including all five windows, scores, ranks, and practice lists. No GitHub download is required before using it. Problem-page tags use a compact local lookup and read only the selected problem’s small cache bucket. They do not need to wake the background worker or reload the full question dataset. The complete cache remains available for searches, practice lists and background updates. Older installations prepare this lookup once when the extension is updated. The source date and a **Bundled snapshot** label identify its freshness; bundled data is not presented as today's interview activity.

The extension checks the latest GitHub revision in the background. If it matches the snapshot, only one metadata request is needed. Initial downloads, migrations, and replacement of an older bundled snapshot use one commit-pinned repository ZIP; later refreshes download only changed company files. Archive entries are verified against the GitHub tree's blob hashes and ZIP checksums before the complete dataset replaces the previous cache. If archive download or decoding fails, a bounded rolling queue downloads the individual CSVs instead.

Completed file groups use compact resume checkpoints, rather than rewriting the growing parsed dataset after each batch. Status updates preserve the company/practice lists and active controls. Closing the popup does not stop syncing; browser restarts resume interrupted work. Cached results remain available offline and after failed refreshes. Daily checks run while the browser is running.

The extension supports LeetCode.com, LeetCode.cn, contest problem URLs, and navigation between problems without reloading the tab. Refresh an already-open LeetCode tab after installing or reloading the extension.

## What the tags mean

The extension matches each CSV's **Link** column to the problem URL and uses the **Frequency** column as a source score. Companies are ordered by descending score, then alphabetically for ties. These values are not documented interview counts or probabilities, and comparisons between companies may not use a common scale. Scores are displayed without a percentage sign.

Acceptance comes from the source CSV’s **Acceptance Rate** column and measures accepted submissions divided by total submissions for a problem across LeetCode users. It is a snapshot value, not a company interview pass rate or a percentage for the selected interview time window. The verified source revision has a [reported scaling error](https://github.com/liquidslr/leetcode-company-wise-problems/issues/49); the parser corrects that revision’s known format to percentages. Missing, invalid, or ambiguous formats show **Acceptance unavailable**. See [LeetCode’s description of submission statistics](https://support.leetcode.com/hc/en-us/articles/360012016874-Start-your-Coding-Practice).

The five source files are **1. Thirty Days.csv**, **2. Three Months.csv**, **3. Six Months.csv**, **4. More Than Six Months.csv**, and **5. All.csv**. Time windows are relative to the repository's snapshot, not today's date. The source date and selected window are available in the bar and toolbar popup.

These are public, community-maintained associations, not verified interview records or a live feed from LeetCode. A missing tag means the repository has no matching record, not that the company has never asked the question. The source revision/date and last successful sync are exposed in the UI. Live sync means the latest state of this repository; the repository itself may be dated.

## Privacy and permissions

- **storage:** keeps the company index, sync progress, and display preferences on your device.
- **unlimitedStorage:** allows the local cache and a pending refresh to hold all five time windows without the browser's small default extension-storage limit.
- **alarms:** schedules daily checks and resumes interrupted downloads.
- **LeetCode sites:** displays the inline bar, reads problem slugs, and uses an existing signed-in LeetCode tab to request account-specific completion statuses. It does not read submitted source code, passwords, cookie values, or session-token values.
- **api.github.com / raw.githubusercontent.com / codeload.github.com:** downloads repository metadata, changed CSV files, and compressed repository archives. Requests are restricted in code to the named public repository, omit credentials, and do not include your current problem URL or browsing history. GitHub receives normal connection information, including your IP address.

There is no analytics, application server, Company Lens account, API key, paid LeetCode endpoint, or remotely executed code. An existing LeetCode sign-in is used only for completion checks. CSV data is treated as data and rendered as text. A compressed copy of the public company/problem metadata is included for first-install results. The bundled snapshot records its original source commit and date; background updates fetch newer repository contents.

Completed-status requests go only to the LeetCode origin of the selected open tab. LeetCode receives the requested problem slugs, and the browser handles its normal session cookies. The extension uses the returned username in memory to keep accounts separate; the username and completion results are not written to persistent storage or sent to GitHub. Firefox declares authentication information, website content, and website activity for this feature in its built-in data disclosure; these declarations do not add new website or browser API permissions. See [Mozilla's data-consent taxonomy](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/).

## Build and test

Requires Node.js 20.12+ (for native raw-DEFLATE decoding). No npm dependencies or package installation are needed.

```powershell
cd C:\Users\Mahesh\Other_Code\leetcode-company-tags
npm run build
npm test
```

Source lives in `extension/`; `scripts/build.mjs` creates both manifests, unpacked folders and ZIPs using only Node built-ins, with checked-in PNG brand icon exports. Builds use the checked-in snapshot and do not need network access. Before preparing a new release, run `npm run snapshot` to regenerate it from the latest commit-pinned source archive, then build and test. Snapshot generation validates all five complete windows and creates a provenance/checksum manifest. After rebuilding, reload the extension in the browser and refresh LeetCode.

Optional checks:

```powershell
npm run verify:live
npm run test:browser
npm run test:topics
npm run test:company-topics
npm run test:completion
npm run test:completion-filters
npm run test:firefox
```

`verify:live` downloads the real dataset into the ignored `output/live-source` directory and validates the resulting index. Add `-- --fresh` to exercise the initial ZIP path without reusing its existing verification cache. `test:browser` first verifies a fresh install using the packaged snapshot with GitHub networking blocked, then checks the actual Chromium extension against deterministic local page fixtures. It needs an existing Playwright installation and Chromium binary; use `PLAYWRIGHT_MODULE` and `CHROMIUM_EXECUTABLE` to select them. `node scripts/smoke.mjs --live` additionally verifies a real GitHub refresh after `verify:live` has populated its cache.

`test:topics` is a focused Chromium check of the packaged Problems Explorer using the bundled snapshot with GitHub networking blocked. It verifies topic any/all matching, difficulty, complete group counts, pagination, collapse/expand, retry, delayed responses, navigation restoration, keyboard controls, and light/dark layouts at desktop and narrow widths. It uses the same `PLAYWRIGHT_MODULE` and `CHROMIUM_EXECUTABLE` overrides and saves reports/screenshots under `output/playwright`.

`test:company-topics` checks company-specific topic catalogs, any/all matching, original scores and ranks, grouped pagination, retry, delayed responses, and Back navigation. It then runs the global topic checks using the same offline Chromium setup and runtime overrides.

`test:completion` uses isolated LeetCode HTML and read-only GraphQL fixtures through the actual content-script/background/Explorer pipeline. It verifies accepted-only markers, account changes, signed-out and unavailable states, delayed replies, paging, groups, Back navigation, and responsive layouts without submitting solutions or changing a real account. It uses the existing Playwright/Chromium runtime overrides.

`test:completion-filters` verifies full-result solved/not-solved filtering before paging, topic counts, combined filters, popup practice, account changes, and unavailable statuses through the actual extension pipeline with controlled read-only LeetCode responses.

`test:firefox` installs the actual temporary add-on in an isolated Firefox profile, blocks GitHub networking, and seeds deterministic fixtures. It first verifies offline results on a fresh install, then verifies the inline problem bar and packaged popup using Playwright and Mozilla's localhost debugging protocol, including all five windows, practice filters, inline placement, horizontal scrolling, and bar recreation. It needs an existing Playwright installation and compatible Firefox binary; set `PLAYWRIGHT_MODULE` and `FIREFOX_EXECUTABLE` to select them. Reports and preview screenshots are saved under `output/playwright`; fixture previews are not captures of the live LeetCode site. Nothing is installed in your normal browser profiles.

## Troubleshooting

- **Background update is still running:** the bundled or previous complete snapshot stays usable. Keep the browser running to finish the update; the popup can be closed. If the archive host is unavailable, the CSV fallback takes longer.
- **Network or GitHub limit error:** cached tags remain available. Retry later with Refresh. No access token is required.
- **No company records:** verify that the problem exists in the source repository. New or renamed problems may not be present.
- **No company bar:** enable it in the toolbar popup, grant site access, then reload the problem description. The bar waits for the description header and does not appear over other tabs or non-problem pages.
- **Source schema changed:** a failed refresh keeps the previous complete index. Update the parser before accepting a different CSV layout.

## References

- [Source repository](https://github.com/liquidslr/leetcode-company-wise-problems)
- [Chrome extension service worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)
- [Mozilla cross-browser extension guide](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Build_a_cross_browser_extension)
- [Firefox temporary installation](https://extensionworkshop.com/documentation/develop/temporary-installation-in-firefox/)

## Brand assets

The Company Lens mark combines a company tag with a simple office building, representing companies associated with coding interview questions. The image-generated PNG master, its generation prompt, and 16/32/48/128 px toolbar/store icon exports live in `extension/icons/`; the 512 px PNG is available for larger store artwork. The mark uses a simple building outline without windows or punched tag holes. Builds copy these assets directly so the toolbar and popup/explorer headers use the same mark.

# Company Lens for LeetCode

A Chrome and Firefox extension that shows which companies are associated with the LeetCode problem you're viewing. Tags use a bundled snapshot and background updates from [liquidslr/leetcode-company-wise-problems](https://github.com/liquidslr/leetcode-company-wise-problems).

## Install

The `dist` folders are ready to load. Node is only needed to rebuild the source.

### Chrome (120+)

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

The **Company Lens** panel appears on a problem page. It shows the top five companies by source frequency score; **Show all** expands the list and **Show fewer** restores the compact view. Search includes companies hidden from the preview. Collapse the panel while coding to a small square bubble with the lens icon and company count, such as **115+**. Click anywhere on the bubble, or focus it and press Enter/Space, to reopen the full panel. The toolbar popup provides the same company view, controls whether the panel is shown, and offers **Refresh**.

Choose a **Time window**: 30 days, 3 months, 6 months, older than 6 months, or all time. Each company shows its frequency score and the problem's rank within that company's selected list. Tied scores share a rank, and missing scores appear last without an invented value.

Use **Practice** beside a company to browse more questions from that company in the selected window, sorted by source frequency. Filter the practice list by difficulty or topic, then follow a question to LeetCode. Rankings refer to the full company list, even when filters are applied.

New installations show companies immediately from a compressed snapshot packaged with the extension, including all five windows, scores, ranks, and practice lists. No GitHub download is required before using it. The source date and a **Bundled snapshot** label identify its freshness; bundled data is not presented as today's interview activity.

The extension checks the latest GitHub revision in the background. If it matches the snapshot, only one metadata request is needed. Initial downloads, migrations, and replacement of an older bundled snapshot use one commit-pinned repository ZIP; later refreshes download only changed company files. Archive entries are verified against the GitHub tree's blob hashes and ZIP checksums before the complete dataset replaces the previous cache. If archive download or decoding fails, a bounded rolling queue downloads the individual CSVs instead.

Completed file groups use compact resume checkpoints, rather than rewriting the growing parsed dataset after each batch. Status updates preserve the company/practice lists and active controls. Closing the popup does not stop syncing; browser restarts resume interrupted work. Cached results remain available offline and after failed refreshes. Daily checks run while the browser is running.

The extension supports LeetCode.com, LeetCode.cn, contest problem URLs, and navigation between problems without reloading the tab. Refresh an already-open LeetCode tab after installing or reloading the extension.

## What the tags mean

The extension matches each CSV's **Link** column to the problem URL and uses the **Frequency** column as a source score. Companies are ordered by descending score, then alphabetically for ties. These values are not documented interview counts or probabilities, and comparisons between companies may not use a common scale. Scores are displayed without a percentage sign.

The five source files are **1. Thirty Days.csv**, **2. Three Months.csv**, **3. Six Months.csv**, **4. More Than Six Months.csv**, and **5. All.csv**. Time windows are relative to the repository's snapshot, not today's date. The source date remains visible in the panel.

These are public, community-maintained associations, not verified interview records or a live feed from LeetCode. A missing tag means the repository has no matching record, not that the company has never asked the question. The source revision/date and last successful sync are exposed in the UI. Live sync means the latest state of this repository; the repository itself may be dated.

## Privacy and permissions

- **storage:** keeps the company index, sync progress, and display preferences on your device.
- **unlimitedStorage:** allows the local cache and a pending refresh to hold all five time windows without the browser's small default extension-storage limit.
- **alarms:** schedules daily checks and resumes interrupted downloads.
- **LeetCode sites:** displays the panel and reads the problem slug from the URL. It does not read your solution, submissions, or credentials.
- **api.github.com / raw.githubusercontent.com / codeload.github.com:** downloads repository metadata, changed CSV files, and compressed repository archives. Requests are restricted in code to the named public repository, omit credentials, and do not include your current problem URL or browsing history. GitHub receives normal connection information, including your IP address.

There is no analytics, application server, account, API key, paid LeetCode endpoint, or remotely executed code. CSV data is treated as data and rendered as text. A compressed copy of the public company/problem metadata is included for first-install results. The bundled snapshot records its original source commit and date; background updates fetch newer repository contents.

## Build and test

Requires Node.js 20.12+ (for native raw-DEFLATE decoding). No npm dependencies or package installation are needed.

```powershell
cd C:\Users\Mahesh\Other_Code\leetcode-company-tags
npm run build
npm test
```

Source lives in `extension/`; `scripts/build.mjs` creates both manifests, PNG icons, unpacked folders, and ZIPs using only Node built-ins. Builds use the checked-in snapshot and do not need network access. Before preparing a new release, run `npm run snapshot` to regenerate it from the latest commit-pinned source archive, then build and test. Snapshot generation validates all five complete windows and creates a provenance/checksum manifest. After rebuilding, reload the extension in the browser and refresh LeetCode.

Optional checks:

```powershell
npm run verify:live
npm run test:browser
npm run test:firefox
```

`verify:live` downloads the real dataset into the ignored `output/live-source` directory and validates the resulting index. Add `-- --fresh` to exercise the initial ZIP path without reusing its existing verification cache. `test:browser` first verifies a fresh install using the packaged snapshot with GitHub networking blocked, then checks the actual Chromium extension against deterministic local page fixtures. It needs an existing Playwright installation and Chromium binary; use `PLAYWRIGHT_MODULE` and `CHROMIUM_EXECUTABLE` to select them. `node scripts/smoke.mjs --live` additionally verifies a real GitHub refresh after `verify:live` has populated its cache.

`test:firefox` installs the actual temporary add-on in an isolated Firefox profile, blocks GitHub networking, and seeds deterministic fixtures. It first verifies offline results on a fresh install, then verifies the problem panel and packaged popup using Playwright and Mozilla's localhost debugging protocol, including all five windows, practice filters, and panel recreation. It needs an existing Playwright installation and compatible Firefox binary; set `PLAYWRIGHT_MODULE` and `FIREFOX_EXECUTABLE` to select them. Reports and preview screenshots are saved under `output/playwright`; fixture previews are not captures of the live LeetCode site. Nothing is installed in your normal browser profiles.

## Troubleshooting

- **Background update is still running:** the bundled or previous complete snapshot stays usable. Keep the browser running to finish the update; the popup can be closed. If the archive host is unavailable, the CSV fallback takes longer.
- **Network or GitHub limit error:** cached tags remain available. Retry later with Refresh. No access token is required.
- **No company records:** verify that the problem exists in the source repository. New or renamed problems may not be present.
- **No panel:** enable it in the toolbar popup, grant site access, then reload the problem page.
- **Source schema changed:** a failed refresh keeps the previous complete index. Update the parser before accepting a different CSV layout.

## References

- [Source repository](https://github.com/liquidslr/leetcode-company-wise-problems)
- [Chrome extension service worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)
- [Mozilla cross-browser extension guide](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Build_a_cross_browser_extension)
- [Firefox temporary installation](https://extensionworkshop.com/documentation/develop/temporary-installation-in-firefox/)

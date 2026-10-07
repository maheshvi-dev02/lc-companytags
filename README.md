# Company Lens for LeetCode

A Chrome and Firefox extension that shows which companies are associated with the LeetCode problem you're viewing. Tags come directly from [liquidslr/leetcode-company-wise-problems](https://github.com/liquidslr/leetcode-company-wise-problems).

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

The **Company Lens** panel appears on a problem page. It shows the top five companies by source frequency score; **Show all** expands the list and **Show fewer** restores the compact view. Search includes companies hidden from the preview. You can collapse the whole panel while coding. The toolbar popup provides the same company view, controls whether the panel is shown, and offers **Refresh**.

Choose a **Time window**: 30 days, 3 months, 6 months, older than 6 months, or all time. Each company shows its frequency score and the problem's rank within that company's selected list. Tied scores share a rank, and missing scores appear last without an invented value.

Use **Practice** beside a company to browse more questions from that company in the selected window, sorted by source frequency. Filter the practice list by difficulty or topic, then follow a question to LeetCode. Rankings refer to the full company list, even when filters are applied.

The first sync downloads five sets of company lists and may take several minutes, depending on the network. Progress is shown. Once synced, problem lookups use the local cache and work offline. Refresh checks the current repository revision; daily checks keep it up to date while the browser is running. A later check downloads only changed company files. Reopening the browser resumes interrupted work. Upgrading from 1.0 keeps the previous all-time company tags visible while a one-time download adds frequency and time-window data.

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
- **api.github.com / raw.githubusercontent.com:** downloads repository metadata and CSV files. Requests are restricted in code to the named public repository, omit credentials, and do not include your current problem URL or browsing history. GitHub receives normal connection information, including your IP address.

There is no analytics, application server, account, API key, paid LeetCode endpoint, or remotely executed code. CSV data is treated as data and rendered as text. The public repository contents are fetched at runtime; no copy of its dataset is redistributed with the extension.

## Build and test

Requires Node.js 20+. No npm dependencies or package installation are needed.

```powershell
cd C:\Users\Mahesh\Other_Code\leetcode-company-tags
npm run build
npm test
```

Source lives in `extension/`; `scripts/build.mjs` creates both manifests, PNG icons, unpacked folders, and ZIPs using only Node built-ins. After rebuilding, reload the extension in the browser and refresh LeetCode.

Optional checks:

```powershell
npm run verify:live
npm run test:browser
```

`verify:live` downloads the real dataset into the ignored `output/live-source` directory and validates the resulting index. `test:browser` checks the actual Chromium extension against a local page fixture, with GitHub networking blocked. It needs an existing Playwright installation and Chromium binary; use `PLAYWRIGHT_MODULE` and `CHROMIUM_EXECUTABLE` to select them. `node scripts/smoke.mjs --live` additionally verifies a real GitHub refresh after `verify:live` has populated its cache.

The optional `node scripts/firefox-smoke.mjs` uses Mozilla's localhost debugging protocol to install a temporary add-on in an isolated Firefox profile. Set `FIREFOX_EXECUTABLE` for a compatible Playwright Firefox binary. It may report partial verification when GitHub limits prevent a first sync. Reports and preview screenshots are saved under `output/playwright`; fixture previews are not captures of the live LeetCode site. Nothing is installed in your normal browser profiles.

## Troubleshooting

- **First sync is still running:** the upstream dataset contains hundreds of separate CSVs. Keep the browser running; the popup can be closed.
- **Network or GitHub limit error:** cached tags remain available. Retry later with Refresh. No access token is required.
- **No company records:** verify that the problem exists in the source repository. New or renamed problems may not be present.
- **No panel:** enable it in the toolbar popup, grant site access, then reload the problem page.
- **Source schema changed:** a failed refresh keeps the previous complete index. Update the parser before accepting a different CSV layout.

## References

- [Source repository](https://github.com/liquidslr/leetcode-company-wise-problems)
- [Chrome extension service worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)
- [Mozilla cross-browser extension guide](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Build_a_cross_browser_extension)
- [Firefox temporary installation](https://extensionworkshop.com/documentation/develop/temporary-installation-in-firefox/)

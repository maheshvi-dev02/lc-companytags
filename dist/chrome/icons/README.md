# Bundled icons

## LeetCode link icon

`leetcode.svg` is a locally bundled LeetCode identification mark used for outbound problem links. It contains only static SVG path geometry with the brand-orange fill `#FFA116`; it never loads external resources.

Source: [Simple Icons 16.34.0](https://github.com/simple-icons/simple-icons/tree/98820a4dc8c363ca72fa2c0d294ea4a0a9bba75d), immutable revision `98820a4dc8c363ca72fa2c0d294ea4a0a9bba75d`.

Original asset: https://raw.githubusercontent.com/simple-icons/simple-icons/98820a4dc8c363ca72fa2c0d294ea4a0a9bba75d/icons/leetcode.svg

Upstream brand source: https://leetcode.com/store

Simple Icons is released under CC0-1.0; its complete license and disclaimer are included in `../logos/simple-icons-current-license.md` and `../logos/simple-icons-current-disclaimer.md`. LeetCode's brand rights remain with their owner. Company Lens is not affiliated with or endorsed by LeetCode.

Packaged SVG SHA-256: `7ea4bbaa2a779ee65859305be3a3e1ab462030bec10d653f446c69c4be42ed8a`

## Company Lens brand mark

`company-lens.svg` is original geometric artwork created for Company Lens. One orange company tag contains an ivory office-building glyph on a charcoal rounded tile. The mark expresses company labels attached to problems; it uses no LeetCode or company brand geometry, coding brackets, lens, text, gradients, shadows, or decorative effects.

The master has a `0 0 128 128` view box. The tile is `#242424`, the tag is `#FFAA3B`, and the building is `#FFF2DC`. Its exterior corners remain transparent. Geometry and contrast are deliberately simple enough for the browser's 16-pixel toolbar icon.

Checked-in PNG exports: `16.png`, `32.png`, `48.png`, `128.png`, and `company-lens-512.png`. Every PNG is rendered directly from the SVG master, rather than resized from a smaller raster image. Browser manifests use the numbered exports; headers can use the SVG; the 512-pixel export is available for store artwork.

Reproduction: render the SVG in a square viewport at the target size with a transparent page background and device scale factor 1. The checked-in exports used the existing headless Chromium SVG renderer, with no external resources or added dependencies. Capture only the SVG element, omitting the page background. The 128-pixel and native 16-pixel exports were visually inspected to confirm the tag silhouette, windows, door, and punched tag hole remain clear.

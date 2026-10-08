# Bundled icons

## LeetCode link icon

`leetcode.svg` is a locally bundled LeetCode identification mark used for outbound problem links. It contains only static SVG path geometry with the brand-orange fill `#FFA116`; it never loads external resources.

Source: [Simple Icons 16.34.0](https://github.com/simple-icons/simple-icons/tree/98820a4dc8c363ca72fa2c0d294ea4a0a9bba75d), immutable revision `98820a4dc8c363ca72fa2c0d294ea4a0a9bba75d`.

Original asset: https://raw.githubusercontent.com/simple-icons/simple-icons/98820a4dc8c363ca72fa2c0d294ea4a0a9bba75d/icons/leetcode.svg

Upstream brand source: https://leetcode.com/store

Simple Icons is released under CC0-1.0; its complete license and disclaimer are included in `../logos/simple-icons-current-license.md` and `../logos/simple-icons-current-disclaimer.md`. LeetCode's brand rights remain with their owner. Company Lens is not affiliated with or endorsed by LeetCode.

Packaged SVG SHA-256: `7ea4bbaa2a779ee65859305be3a3e1ab462030bec10d653f446c69c4be42ed8a`

## Company Lens brand mark

`company-lens.png` is the final raster master produced by the built-in OpenAI image generator (`image_gen`, with `transparent_background: true`). The original generated PNG is preserved byte-for-byte: no tracing, redrawing, recoloring, cropping or visual edits were applied. The exact generation prompt is saved in `company-lens-prompt.txt`.

The composition is an orange company tag with a clipped upper-right corner, containing a simple ivory office-building outline and doorway on a neutral charcoal rounded tile. It has no tag hole, windows, dots, text, company mark or copied LeetCode geometry. The prompt specified charcoal `#242424`, orange `#FFAA3B` and ivory `#FFF2DC`; the generated raster includes subtle tonal variation and is retained as generated.

Master dimensions: **1254 × 1254 pixels**. Its PNG alpha includes fully transparent exterior corners and fully opaque artwork. Master SHA-256: `0b9e109990b63ff62ad0eb186bad031bfbeba55e94ecce95701e53e28f7c7bd7`.

Checked-in size exports: `16.png`, `32.png`, `48.png`, `128.png`, and `company-lens-512.png`. Browser manifests use the numbered exports, headers use `128.png` displayed at 32 pixels, and the 512-pixel export is available for store artwork. The full generated master is source artwork; runtime code uses the small exports. There is no editable SVG master or SVG trace for this brand mark.

Reproduction: decode `company-lens.png` with the existing Chromium image decoder, create a transparent HTML Canvas at the target square dimensions, set `imageSmoothingEnabled = true` and `imageSmoothingQuality = 'high'`, draw the original image directly with `drawImage(image, 0, 0, size, size)`, and export `canvas.toDataURL('image/png')`. Every size is derived directly from the unchanged master. Browser resampling preserves the source alpha; it does not replace or visually edit the generated artwork. Native 16-pixel and 128-pixel exports were visually inspected, and all exports were checked for dimensions, transparency and PNG integrity.

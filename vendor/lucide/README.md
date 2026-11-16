All interface icons come from **Lucide 1.72.0**, pinned in `manifest.json`.
The logo uses [Waypoints](https://lucide.dev/icons/waypoints).

Official source package: https://www.npmjs.com/package/lucide-static/v/1.72.0
SVG sources are preserved in `icons/`. See `LICENSE` for the ISC license.

Run `npm run icons` in the source checkout to rebuild `page/icons.js`, the logo
and the package icon metadata from these SVGs. The generator changes only size,
stroke width, color and theme behavior; paths remain Lucide's originals.
The resulting small bundle works offline without an icon font or runtime dependency.

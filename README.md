# New England leaf-on composite viewer

A browser viewer for the New England leaf-on Landsat composites, 2000 to 2025.
One real observation per pixel per year, with a provenance view that shows where
that observation is thin or was borrowed from a neighbouring year.

Live demo: https://kentstephen.github.io/ne-landsat-composite-browser-viewer/

## Sources

- Dataset on Source Cooperative: https://source.coop/kentstephen/landsat-mosaics-new-england
- Pipeline and upload code: https://github.com/kentstephen/ne-landsat-temporal-composite

## Run locally

```
npm install
npm run dev
```

Opens on http://localhost:5173/ against the public store. Pass `?src=<zarr url>`
to point the viewer at another copy of the pyramid.

Built with deck.gl, deck.gl-zarr, zarrita, and MapLibre.

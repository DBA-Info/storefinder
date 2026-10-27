# Death By Audio Dealer Locator

A static site that helps people find a shop near them that carries Death By Audio merchandise.
Visitors type a city, address, or ZIP/postal code (or click **Use my location**) and get a list of
stores sorted by distance, plus a map.

No build step and no server code: everything in `public/` (`index.html`, `app.js`, `styles.css`,
`data/stores.csv`) is served as static files by Cloudflare Workers.

## Run locally

```sh
npm install
npm start            # wrangler dev, serves public/ at http://localhost:8787
```

(Opening `index.html` directly from disk won't work because the browser blocks loading the CSV over `file://`.)

## Deployment (Cloudflare Workers)

The site is live at https://storefinder.deathbyaudiocustom.workers.dev/.

Cloudflare Workers Builds is connected to this repo: **every push to `main` deploys automatically**
(it runs `npx wrangler deploy` using `wrangler.jsonc`). Build logs are in the Cloudflare dashboard under
Workers & Pages → `storefinder` → Deployments.

`.github/workflows/check.yml` runs on pushes and pull requests to check the change would deploy cleanly
(`wrangler deploy --dry-run`); it doesn't publish anything.

To use your own domain, add it under the Worker's **Settings → Domains & Routes** in the Cloudflare dashboard.
To deploy by hand: `npx wrangler login` then `npm run deploy`.

## Updating the store list

1. Export the store list from StoreMapper (or a spreadsheet) as CSV.
2. Fill in map coordinates and write it to `public/data/stores.csv`:

   ```sh
   npm install
   npm run geocode -- ~/Downloads/new-store-list.csv
   ```

   This keeps any `latitude`/`longitude` already in the file and fills in the rest offline from US ZIP
   codes, Canadian postal codes, or the city name. Positions are approximate (postal-code or
   city level), which is enough for "stores near me". The `geo_source` column records how each row was
   located. Stores the script can't place are printed at the end; type their `latitude`/`longitude`
   into `public/data/stores.csv` by hand. To pin any store exactly, do the same.
3. Commit `public/data/stores.csv` and push to `main`; the site redeploys automatically.

Rows with `hidden` set to `1`/`true`/`yes` are not shown.

### CSV columns

Header names are matched loosely (case and punctuation don't matter). Recognized columns:
`Name` (required), `address` (may span several lines), `address2`, `city`, `state`, `zip`, `country`,
`phone`, `email`, `url`/`website`, `Instagram`, `latitude`, `longitude`, `hidden`. Other columns are ignored.

## How search works

US ZIP codes and Canadian postal codes are looked up on the site itself from `public/data/postal.json`
(rebuild with `npm run build-postal`). Everything else (city names, addresses, other countries' postal codes) is turned into coordinates with OpenStreetMap's free
[Nominatim](https://nominatim.org/) service, then stores are sorted by straight-line distance. Map tiles
come from OpenStreetMap. Both are fine for a low-traffic site; if traffic grows, switch to a paid
geocoding/tile provider by changing `GEOCODE_URL` and the tile layer in `public/app.js`.

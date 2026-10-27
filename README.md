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

`.github/workflows/deploy.yml` deploys automatically:

- **Push to `main`** → deploys to Cloudflare (`wrangler deploy`, config in `wrangler.jsonc`).
- **Pull request** → checks that it would deploy (`wrangler deploy --dry-run`), without publishing.
- It can also be run by hand from the repo's **Actions** tab.

One-time setup, in the GitHub repo under **Settings → Secrets and variables → Actions**, add:

| Secret | Where to get it |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Cloudflare dashboard → My Profile → API Tokens → Create Token → "Edit Cloudflare Workers" template |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare dashboard → Workers & Pages → Account ID (right-hand side) |

After the first deploy the site is live at `https://dba-storefinder.<your-subdomain>.workers.dev`. To use your
own domain, add it under the Worker's **Settings → Domains & Routes** in the Cloudflare dashboard.

To deploy by hand instead: `npx wrangler login` then `npm run deploy`.

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

The visitor's search text is turned into coordinates with OpenStreetMap's free
[Nominatim](https://nominatim.org/) service, then stores are sorted by straight-line distance. Map tiles
come from OpenStreetMap. Both are fine for a low-traffic site; if traffic grows, switch to a paid
geocoding/tile provider by changing `GEOCODE_URL` and the tile layer in `public/app.js`.

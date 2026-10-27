#!/usr/bin/env node
// Builds public/data/postal.json: US ZIP codes and Canadian postal-code prefixes
// (first 3 characters) -> [lat, lng, "City, ST"]. The site uses it to look up
// postal-code searches without calling an online geocoder.
//
//   npm run build-postal

const fs = require("fs");
const path = require("path");
const zipcodes = require("zipcodes");

const out = {};
for (const [code, z] of Object.entries(zipcodes.codes)) {
  if (z.latitude == null || z.longitude == null) continue;
  const label = z.country === "US" ? `${z.city}, ${z.state}` : z.city.replace(/\s*\(.*$/, "") + `, ${z.state}`;
  out[code] = [Math.round(z.latitude * 100) / 100, Math.round(z.longitude * 100) / 100, label];
}

const file = path.join(__dirname, "..", "public", "data", "postal.json");
fs.writeFileSync(file, JSON.stringify(out));
console.log(`Wrote ${Object.keys(out).length} postal codes to ${file} (${fs.statSync(file).size} bytes)`);

#!/usr/bin/env node
// Fills in latitude/longitude for every store in a StoreMapper-style CSV, offline.
//
//   npm install
//   npm run geocode -- path/to/export.csv            # writes public/data/stores.csv
//
// Rows that already have coordinates are kept as-is. Otherwise:
//   1. US ZIP / Canadian postal code -> postal-code centroid
//   2. Anything else -> best matching city (GeoNames, pop. > 1000) in the address's country
// Coordinates are approximate (postal-code or city level), which is plenty for
// "stores near me". To pin a store exactly, type its latitude/longitude into the CSV.
// The `geo_source` column records how each row was located.

const fs = require("fs");
const path = require("path");
const Papa = require("papaparse");
const zipcodes = require("zipcodes");
const cities = require("all-the-cities");
const countries = require("i18n-iso-countries");
countries.registerLocale(require("i18n-iso-countries/langs/en.json"));

const [input, output = path.join(__dirname, "..", "public", "data", "stores.csv")] = process.argv.slice(2);
if (!input) {
  console.error("Usage: npm run geocode -- <input.csv> [output.csv]");
  process.exit(1);
}

const COUNTRY_ALIASES = {
  austraila: "AU",
  uk: "GB", "united kingdom": "GB", england: "GB", scotland: "GB", wales: "GB", "northern ireland": "GB",
  usa: "US", "u.s.a.": "US", "united states": "US", us: "US",
  netherland: "NL", holland: "NL", "the netherlands": "NL",
  uae: "AE", "south korea": "KR", korea: "KR", russia: "RU", "czech republic": "CZ", czechia: "CZ",
};
const US_STATE_NAMES = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO", connecticut: "CT",
  delaware: "DE", "district of columbia": "DC", florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL",
  indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
  massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS", missouri: "MO", montana: "MT",
  nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA",
  "rhode island": "RI", "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT",
  vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
  "puerto rico": "PR",
};
const US_STATES = new Set(Object.values(US_STATE_NAMES));
const US_STATE_RE = new RegExp(
  `(?:^|[,\\s])(${[...US_STATES].join("|")}|${Object.keys(US_STATE_NAMES).join("|")})\\.?,?(?:\\s+(\\d{5})(?:-\\d{4})?)?(?:,?\\s*(?:usa|us|united states))?\\s*$`,
  "i"
);

// Local-language names and spelling variants -> the name used in the city list.
const CITY_ALIASES = {
  torino: "turin", warszawa: "warsaw", praha: "prague", lisboa: "lisbon", "den haag": "the hague",
  bruxelles: "brussels", munchen: "munich", frankfurt: "frankfurt am main", roma: "rome", napoli: "naples",
  milano: "milan", firenze: "florence", genova: "genoa", wien: "vienna", kobenhavn: "copenhagen",
  aaslt: "aalst", winterhur: "winterthur", cdmx: "mexico city", "st veit an der glan": "sankt veit an der glan",
  bizkaia: "bilbao", brooklyn: "new york city", manhattan: "new york city", queens: "new york city",
  "staten island": "new york city", bronx: "new york city", galway: "claregalway", "paleo faliro": "palaio faliro",
  caba: "buenos aires", barcelone: "barcelona", "vendin les bithune": "vendin les bethune",
  "saint laurent de var": "saint laurent du var", rizal: "antipolo",
  // Small towns missing from the city list -> nearest town that is in it.
  erpent: "namur", latsia: "nicosia", giebenach: "liestal", rain: "luzern", rivera: "lugano",
  "muelheim an der ruhr": "essen", risskov: "arhus", tregueux: "saint brieuc", dedemsvaart: "hardenberg",
  stathelle: "porsgrunn", skulestadmo: "voss", holmbridge: "holmfirth", "north gorley": "fordingbridge",
};

const fold = (s) => s.replace(/[łŁ]/g, "l").replace(/[øØ]/g, "o").replace(/ß/g, "ss").replace(/[æÆ]/g, "ae").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

// Index cities by country -> folded name -> candidates.
const cityIndex = new Map();
for (const c of cities) {
  if (!cityIndex.has(c.country)) cityIndex.set(c.country, new Map());
  const byName = cityIndex.get(c.country);
  for (const n of [c.name, ...String(c.altName || "").split(",")]) {
    const key = fold(n);
    if (!key) continue;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(c);
  }
}

// Returns { state, zip } when a line ends in a US state (abbreviation or name), optionally with a ZIP.
function parseUS(lines) {
  for (const line of [...lines].reverse()) {
    const m = line.replace(/\(.*?\)/g, "").trim().match(US_STATE_RE);
    if (!m) continue;
    // Abbreviations must be upper case so words like "in" or "me" don't count.
    const st = m[1].length === 2 ? (m[1] === m[1].toUpperCase() ? m[1] : null) : US_STATE_NAMES[m[1].toLowerCase()];
    if (st) return { state: st, zip: m[2] || null };
  }
  return null;
}

function detectCountry(lines) {
  if (parseUS(lines)) return "US";
  for (const line of [...lines].reverse()) {
    // Check the whole line, then each comma-separated piece, then trailing words.
    const pieces = [line, ...line.split(",").reverse()];
    const words = fold(line).split(" ");
    for (let n = Math.min(4, words.length); n >= 1; n--) pieces.push(words.slice(-n).join(" "));
    for (const p of pieces) {
      const key = fold(p).replace(/\b\d+\b/g, "").trim();
      if (!key) continue;
      if (COUNTRY_ALIASES[key]) return COUNTRY_ALIASES[key];
      const code = countries.getAlpha2Code(key, "en");
      if (code) return code;
    }
  }
  const tail = lines.slice(-2).join(" ");
  const m = tail.match(/\b([A-Z]{2})\s+(\d{5})(-\d{4})?\b/);
  if (m && US_STATES.has(m[1])) return "US";
  if (/\b([A-Z]{2})\s+[A-Z]\d[A-Z]\s?\d[A-Z]\d\b/.test(tail)) return "CA";
  return null;
}

function postalLookup(lines, country) {
  const text = lines.join(" ");
  const us = country === "US" && parseUS(lines);
  if (us && us.zip) {
    const z = zipcodes.lookup(us.zip);
    if (z) return { lat: z.latitude, lng: z.longitude, source: "zip" };
  }
  if (country === "CA" || !country) {
    const m = text.toUpperCase().match(/\b([A-Z]\d[A-Z])\s?\d[A-Z]\d\b/);
    if (m) {
      const z = zipcodes.lookup(m[1]);
      if (z) return { lat: z.latitude, lng: z.longitude, source: "postal" };
    }
  }
  return null;
}

function cityLookup(lines, country) {
  const byName = cityIndex.get(country);
  if (!byName) return null;
  const state = country === "US" ? (parseUS(lines) || {}).state : null;
  const find = (name) => {
    const list = (byName.get(CITY_ALIASES[name] || name) || []).filter((c) => !state || c.adminCode === state);
    return list.sort((a, b) => b.population - a.population)[0];
  };
  let best = null;
  // Prefer later lines (city usually follows the street), and longer names.
  lines.forEach((line, lineNo) => {
    const words = fold(line).split(" ").filter((w) => !/\d/.test(w));
    for (let i = 0; i < words.length; i++) {
      for (let n = Math.min(6, words.length - i); n >= 1; n--) {
        const city = find(words.slice(i, i + n).join(" "));
        if (!city) continue;
        const score = lineNo * 10 + n * 3 + Math.log10(city.population + 1);
        if (!best || score > best.score) best = { city, score };
      }
    }
  });
  if (!best) return null;
  const [lng, lat] = best.city.loc.coordinates;
  return { lat, lng, source: `city:${best.city.name}` };
}

const text = fs.readFileSync(input, "utf8").replace(/^﻿/, "");
const parsed = Papa.parse(text, { header: true, skipEmptyLines: "greedy" });
const fields = parsed.meta.fields;
const latKey = fields.find((f) => /^lat(itude)?$/i.test(f)) || "latitude";
const lngKey = fields.find((f) => /^(lng|lon|long|longitude)$/i.test(f)) || "longitude";
const outFields = [...new Set([...fields, latKey, lngKey, "geo_source"])];

const misses = [];
const counts = {};
for (const row of parsed.data) {
  if (row[latKey] && row[lngKey] && !isNaN(row[latKey]) && !isNaN(row[lngKey])) {
    row.geo_source = row.geo_source || "csv";
  } else {
    const lines = String(row.address || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const country = detectCountry(lines);
    const hit = postalLookup(lines, country) || (country && cityLookup(lines, country));
    if (hit) {
      row[latKey] = hit.lat.toFixed(5);
      row[lngKey] = hit.lng.toFixed(5);
      row.geo_source = hit.source;
    } else {
      row.geo_source = "";
      misses.push(`${row.Name || row.name} | ${lines.join(" / ")}${country ? ` [${country}]` : ""}`);
    }
  }
  const kind = (row.geo_source || "missing").split(":")[0];
  counts[kind] = (counts[kind] || 0) + 1;
}

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, Papa.unparse(parsed.data, { columns: outFields }) + "\n");
console.log(`Wrote ${parsed.data.length} stores to ${output}`, counts);
if (misses.length) {
  console.log(`\nCould not locate ${misses.length} store(s); add latitude/longitude by hand:`);
  for (const m of misses) console.log("  - " + m);
}

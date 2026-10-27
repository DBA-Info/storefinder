// Death By Audio dealer locator.
// Loads stores from data/stores.csv, geocodes the visitor's search with
// OpenStreetMap Nominatim, and lists stores sorted by distance.

const CSV_URL = "data/stores.csv";
const POSTAL_URL = "data/postal.json";
const GEOCODE_URL = "https://nominatim.openstreetmap.org/search";

// Accepted header names for each field (compared lowercase, ignoring spaces/punctuation).
const FIELD_ALIASES = {
  name: ["name", "store", "storename", "dealer", "dealername", "business", "shop", "company"],
  address: ["address", "address1", "street", "streetaddress", "addressline1"],
  address2: ["address2", "addressline2", "suite", "unit"],
  city: ["city", "town", "locality"],
  state: ["state", "province", "region", "stateprovince", "county"],
  zip: ["zip", "zipcode", "postal", "postalcode", "postcode"],
  country: ["country", "countrycode"],
  phone: ["phone", "phonenumber", "telephone", "tel"],
  email: ["email", "emailaddress"],
  instagram: ["instagram"],
  hidden: ["hidden"],
  website: ["website", "url", "web", "site", "link"],
  lat: ["lat", "latitude"],
  lng: ["lng", "lon", "long", "longitude"],
};

const els = {
  form: document.getElementById("search-form"),
  query: document.getElementById("query"),
  locate: document.getElementById("locate"),
  radius: document.getElementById("radius"),
  status: document.getElementById("status"),
  results: document.getElementById("results"),
};

let stores = [];
let origin = null; // { lat, lng, label }
let originMarker = null;
const markers = new Map();

const map = L.map("map", { worldCopyJump: true, preferCanvas: true }).setView([39.8, -98.6], 4);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

const STORE_STYLE = { radius: 7, color: "#0d0d0d", weight: 2, fillColor: "#e10600", fillOpacity: 0.9 };

const normalizeKey = (k) => k.toLowerCase().replace(/[^a-z0-9]/g, "");

function buildHeaderMap(headers) {
  const lookup = {};
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    const match = headers.find((h) => aliases.includes(normalizeKey(h)));
    if (match) lookup[field] = match;
  }
  return lookup;
}

function toStore(row, headerMap, index) {
  const get = (f) => (headerMap[f] ? String(row[headerMap[f]] ?? "").trim() : "");
  const lat = parseFloat(get("lat"));
  const lng = parseFloat(get("lng"));
  let website = get("website");
  if (website && !/^https?:\/\//i.test(website)) website = "https://" + website;
  let instagram = get("instagram");
  if (instagram && !/^https?:\/\//i.test(instagram)) instagram = "https://instagram.com/" + instagram.replace(/^@/, "");
  return {
    id: index,
    name: get("name").replace(/\s*\n\s*/g, " / "),
    // Addresses may span several lines; keep each line for display.
    addressLines: [get("address"), get("address2")].join("\n").split(/\r?\n/).map((l) => l.trim()).filter(Boolean),
    city: get("city"),
    state: get("state"),
    zip: get("zip"),
    country: get("country"),
    phone: get("phone"),
    email: get("email"),
    instagram,
    website,
    hidden: /^(1|true|yes|y|x)$/i.test(get("hidden")),
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
  };
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function addressLines(s) {
  const cityState = [s.city, s.state].filter(Boolean).join(", ");
  const locality = [cityState, s.zip].filter(Boolean).join(" ");
  return [...s.addressLines, locality, s.country].filter(Boolean);
}

// Lines like "(By Appt. Only)" or "Online only" are notes, not part of a mappable address.
const isNote = (line) => /^\(.*\)$|appt|appointment|online|reverb shop/i.test(line);

function fullAddress(s) {
  return addressLines(s).filter((l) => !isNote(l)).join(", ");
}

// Great-circle distance in miles.
function distanceMiles(a, b) {
  const R = 3958.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function setStatus(msg) {
  els.status.textContent = msg;
}

async function loadStores() {
  const res = await fetch(CSV_URL, { cache: "no-cache" });
  if (!res.ok) throw new Error(`Could not load ${CSV_URL} (${res.status})`);
  const text = await res.text();
  const parsed = Papa.parse(text, { header: true, skipEmptyLines: "greedy" });
  const headerMap = buildHeaderMap(parsed.meta.fields || []);
  if (!headerMap.name) throw new Error("stores.csv needs a 'name' column");
  return parsed.data
    .map((row, i) => toStore(row, headerMap, i))
    .filter((s) => s.name && !s.hidden)
    .map((s, i) => ({ ...s, id: i }));
}

function addMarkers() {
  const withCoords = stores.filter((s) => s.lat !== null);
  for (const s of withCoords) {
    const directions = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(fullAddress(s) || `${s.lat},${s.lng}`)}`;
    const popup = `<strong>${escapeHtml(s.name)}</strong>${escapeHtml(fullAddress(s))}<br><a href="${directions}" target="_blank" rel="noopener">Directions</a>`;
    const m = L.circleMarker([s.lat, s.lng], STORE_STYLE).addTo(map).bindPopup(popup);
    m.on("click", () => highlight(s.id, false));
    markers.set(s.id, m);
  }
  if (withCoords.length) {
    map.fitBounds(L.latLngBounds(withCoords.map((s) => [s.lat, s.lng])), { padding: [30, 30], maxZoom: 10 });
  }
}

function renderList(list) {
  els.results.innerHTML = "";
  for (const s of list) {
    const li = document.createElement("li");
    li.className = "store";
    li.dataset.id = s.id;
    const dist = s.distance != null ? `<span class="distance">${s.distance < 10 ? s.distance.toFixed(1) : Math.round(s.distance)} mi</span>` : "";
    const directions = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(fullAddress(s) || `${s.lat},${s.lng}`)}`;
    const links = [
      s.phone && `<a href="tel:${escapeHtml(s.phone.replace(/[^\d+]/g, ""))}">${escapeHtml(s.phone)}</a>`,
      s.email && `<a href="mailto:${escapeHtml(s.email)}">Email</a>`,
      s.website && `<a href="${escapeHtml(s.website)}" target="_blank" rel="noopener">Website</a>`,
      s.instagram && `<a href="${escapeHtml(s.instagram)}" target="_blank" rel="noopener">Instagram</a>`,
      (s.addressLines.length || s.lat !== null) && `<a href="${directions}" target="_blank" rel="noopener">Directions</a>`,
    ].filter(Boolean).join("");
    li.innerHTML = `
      <h2><span>${escapeHtml(s.name)}</span>${dist}</h2>
      <address>${addressLines(s).map(escapeHtml).join("<br>")}</address>
      ${links ? `<div class="links">${links}</div>` : ""}`;
    li.addEventListener("click", (e) => {
      if (e.target.closest("a")) return;
      highlight(s.id, true);
    });
    els.results.appendChild(li);
  }
}

function highlight(id, panMap) {
  for (const el of els.results.querySelectorAll(".store")) {
    el.classList.toggle("active", Number(el.dataset.id) === id);
  }
  const active = els.results.querySelector(`.store[data-id="${id}"]`);
  if (active && !panMap) active.scrollIntoView({ block: "nearest", behavior: "smooth" });
  const m = markers.get(id);
  if (m && panMap) {
    map.setView(m.getLatLng(), Math.max(map.getZoom(), 12));
    m.openPopup();
  }
}

// Lists stores near `origin`; `extra` (stores without coordinates that match the search) go first.
function showNearby(extra = []) {
  if (!origin) return;
  const radius = Number(els.radius.value);
  const located = stores
    .filter((s) => s.lat !== null)
    .map((s) => ({ ...s, distance: distanceMiles(origin, s) }))
    .sort((a, b) => a.distance - b.distance);
  const inRange = located.filter((s) => s.distance <= radius);

  if (originMarker) originMarker.remove();
  originMarker = L.circleMarker([origin.lat, origin.lng], {
    radius: 9, color: "#e10600", weight: 3, fillColor: "#fff", fillOpacity: 1,
  }).addTo(map).bindTooltip("You searched here");

  if (inRange.length) {
    setStatus(`${inRange.length} store${inRange.length === 1 ? "" : "s"} near ${origin.label}`);
    renderList([...extra, ...inRange]);
    const pts = [[origin.lat, origin.lng], ...inRange.slice(0, 10).map((s) => [s.lat, s.lng])];
    map.fitBounds(L.latLngBounds(pts), { padding: [40, 40], maxZoom: 12 });
  } else {
    const nearest = located.slice(0, 5);
    setStatus(nearest.length
      ? `No stores within ${radius} mi of ${origin.label}. Here are the closest:`
      : "No stores found.");
    renderList([...extra, ...nearest]);
    if (nearest.length) {
      map.fitBounds(L.latLngBounds([[origin.lat, origin.lng], ...nearest.map((s) => [s.lat, s.lng])]), { padding: [40, 40] });
    }
  }
}

// Stores without coordinates can still be found by matching the typed text.
function textMatches(q) {
  const needle = q.toLowerCase();
  return stores.filter((s) => s.lat === null && [s.name, fullAddress(s)].join(" ").toLowerCase().includes(needle));
}

// US ZIP codes and Canadian postal codes are looked up locally (data/postal.json):
// free-text geocoders often mismatch a bare number like "11201" to another country.
let postalTable = null;
async function postalLookup(q) {
  const t = q.trim().toUpperCase();
  const us = t.match(/^(\d{5})(?:-\d{4})?$/);
  const ca = t.match(/^([A-Z]\d[A-Z])(?:\s?\d[A-Z]\d)?$/);
  const key = us ? us[1] : ca ? ca[1] : null;
  if (!key) return null;
  postalTable = postalTable || fetch(POSTAL_URL).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  const hit = (await postalTable)[key];
  return hit ? { lat: hit[0], lng: hit[1], label: `${q.trim()} (${hit[2]})` } : null;
}

// The visitor's country from their browser language (e.g. "en-US" -> "us"), if it has one.
function browserCountry() {
  for (const lang of navigator.languages || [navigator.language]) {
    const m = /-([a-z]{2})$/i.exec(lang || "");
    if (m) return m[1].toLowerCase();
  }
  return null;
}

async function nominatim(q, countrycodes) {
  const params = new URLSearchParams({ format: "json", limit: "1", q });
  if (countrycodes) params.set("countrycodes", countrycodes);
  const res = await fetch(`${GEOCODE_URL}?${params}`, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error("Location lookup failed");
  const [hit] = await res.json();
  return hit || null;
}

async function geocode(q) {
  const local = await postalLookup(q);
  if (local) return local;
  // A bare number is ambiguous worldwide (22405 is a ZIP in Virginia and a postcode in South Korea),
  // so look in the visitor's own country first.
  const country = /^[\d\s-]+$/.test(q) ? browserCountry() : null;
  const hit = (country && (await nominatim(q, country))) || (await nominatim(q));
  if (!hit) return null;
  // Show where the search landed, e.g. "22405 (Fredericksburg, United States)", so a bad match is obvious.
  const parts = String(hit.display_name || "").split(", ");
  const place = parts.length > 1 ? `${parts[0]}, ${parts[parts.length - 1]}` : parts[0];
  return { lat: parseFloat(hit.lat), lng: parseFloat(hit.lon), label: place && place !== q ? `${q} (${place})` : q };
}

els.form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = els.query.value.trim();
  if (!q) return;
  setStatus(`Looking up “${q}”…`);
  try {
    const loc = await geocode(q);
    if (loc) {
      origin = loc;
      showNearby(textMatches(q));
    } else {
      const extra = textMatches(q);
      setStatus(extra.length ? `Stores matching “${q}”:` : `Couldn't find “${q}”. Try a city or postal code.`);
      renderList(extra);
    }
  } catch (err) {
    setStatus(err.message);
  }
});

els.locate.addEventListener("click", () => {
  if (!navigator.geolocation) {
    setStatus("Your browser doesn't support location lookup.");
    return;
  }
  setStatus("Finding your location…");
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      origin = { lat: pos.coords.latitude, lng: pos.coords.longitude, label: "your location" };
      els.query.value = "";
      showNearby();
    },
    () => setStatus("Couldn't get your location. Try typing a city or postal code."),
    { timeout: 10000 }
  );
});

els.radius.addEventListener("change", () => showNearby());

loadStores()
  .then((list) => {
    stores = list;
    addMarkers();
    const missing = stores.filter((s) => s.lat === null).length;
    setStatus(`${stores.length} stores. Search to find the closest.` + (missing ? ` (${missing} without map coordinates)` : ""));
    renderList(stores.slice().sort((a, b) => a.name.localeCompare(b.name)));
  })
  .catch((err) => setStatus(err.message));

// ============================================
// AffordTrip API Server (Railway) v3.1.0
// With price caching for scalability
// ============================================
const express = require("express");
const cors = require("cors");
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const DUFFEL_API_KEY = process.env.DUFFEL_API_KEY;

// ============================================
// PRICE CACHE — 1 hour TTL
// ============================================
const cache = {};
const CACHE_TTL = 60 * 60 * 1000;

function cacheKey(origin, dest, date, returnDate) {
  return origin + "-" + dest + "-" + date + "-" + (returnDate || "ow");
}

function getCached(key) {
  const entry = cache[key];
  if (!entry) return null;
  if (Date.now() - entry.time > CACHE_TTL) { delete cache[key]; return null; }
  return entry.data;
}

function setCache(key, data) {
  cache[key] = { data, time: Date.now() };
  if (Math.random() < 0.01) {
    const now = Date.now();
    Object.keys(cache).forEach(function(k) { if (now - cache[k].time > CACHE_TTL) delete cache[k]; });
  }
}

// ============================================
// Health Check
// ============================================
app.get("/", function(req, res) {
  res.json({ status: "ok", service: "AffordTrip API", version: "3.1.0", platform: "railway", cacheSize: Object.keys(cache).length, timestamp: new Date().toISOString() });
});
app.get("/health", function(req, res) {
  res.json({ status: "ok", version: "3.1.0", platform: "railway", cacheSize: Object.keys(cache).length });
});

// ============================================
// Search Duffel with cache
// ============================================
async function searchDuffel(origin, dest, date, returnDate) {
  const key = cacheKey(origin, dest, date, returnDate);
  const cached = getCached(key);
  if (cached) return Object.assign({}, cached, { fromCache: true });

  const slices = [{ origin: origin, destination: dest, departure_date: date }];
  if (returnDate) slices.push({ origin: dest, destination: origin, departure_date: returnDate });

  try {
    const r = await fetch("https://api.duffel.com/air/offer_requests", {
      method: "POST",
      headers: { Authorization: "Bearer " + DUFFEL_API_KEY, "Content-Type": "application/json", "Duffel-Version": "v2" },
      body: JSON.stringify({ data: { slices: slices, passengers: [{ type: "adult" }], cabin_class: "economy" } })
    });
    const data = await r.json();

    if (data.errors) {
      const result = { destination: dest, price: null, error: data.errors[0] && data.errors[0].message };
      setCache(key, result);
      return result;
    }

    const offers = data.data && data.data.offers || [];
    offers.sort(function(a, b) { return parseFloat(a.total_amount) - parseFloat(b.total_amount); });
    const cheapest = offers[0];
    const result = {
      destination: dest,
      price: cheapest ? parseFloat(cheapest.total_amount) : null,
      currency: cheapest ? cheapest.total_currency : null,
      airline: cheapest && cheapest.owner ? cheapest.owner.name : null,
      isRoundTrip: slices.length > 1
    };
    setCache(key, result);
    return result;
  } catch (e) {
    return { destination: dest, price: null, error: e.message };
  }
}

// ============================================
// Multi-destination flight prices (with cache)
// ============================================
app.post("/api/flights/multi", async function(req, res) {
  try {
    const body = req.body;
    const origin = body.origin, destinations = body.destinations, date = body.date, returnDate = body.returnDate;
    if (!origin || !destinations || !date) return res.status(400).json({ error: "Missing fields" });

    const batch = destinations.slice(0, 5);
    const results = await Promise.allSettled(batch.map(function(dest) { return searchDuffel(origin, dest, date, returnDate); }));
    const prices = results.map(function(r) { return r.status === "fulfilled" ? r.value : { destination: "unknown", price: null }; });

    res.json({ success: true, origin: origin, date: date, returnDate: returnDate || null, prices: prices });
  } catch (err) {
    res.status(500).json({ error: "Multi-search failed: " + err.message });
  }
});

// ============================================
// Single flight search
// ============================================
app.post("/api/flights", async function(req, res) {
  try {
    const body = req.body;
    if (!body.origin || !body.destination || !body.date) return res.status(400).json({ error: "Missing fields" });

    const slices = [{ origin: body.origin, destination: body.destination, departure_date: body.date }];
    if (body.returnDate) slices.push({ origin: body.destination, destination: body.origin, departure_date: body.returnDate });

    const passengers = [];
    for (var i = 0; i < (body.passengers || 1); i++) passengers.push({ type: "adult" });

    const r = await fetch("https://api.duffel.com/air/offer_requests", {
      method: "POST",
      headers: { Authorization: "Bearer " + DUFFEL_API_KEY, "Content-Type": "application/json", "Duffel-Version": "v2" },
      body: JSON.stringify({ data: { slices: slices, passengers: passengers, cabin_class: body.cabin || "economy" } })
    });
    const data = await r.json();
    if (data.errors) return res.status(502).json({ error: data.errors[0] && data.errors[0].message });

    const offers = (data.data && data.data.offers || []).slice(0, 20).map(function(offer) {
      var slice = offer.slices && offer.slices[0];
      var segs = slice && slice.segments || [];
      return {
        price: parseFloat(offer.total_amount), currency: offer.total_currency,
        airline: offer.owner && offer.owner.name, stops: segs.length - 1, isRoundTrip: slices.length > 1
      };
    });
    offers.sort(function(a, b) { return a.price - b.price; });
    res.json({ success: true, offers: offers });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// Hotel & Flight booking links
// ============================================
app.post("/api/hotels", function(req, res) {
  var city = req.body.city;
  if (!city) return res.status(400).json({ error: "Missing city" });
  res.json({ success: true, links: {
    booking: "https://www.booking.com/searchresults.html?ss=" + encodeURIComponent(city),
    skyscanner: "https://www.skyscanner.net/hotels?q=" + encodeURIComponent(city)
  }});
});

app.post("/api/book-flight", function(req, res) {
  res.json({ success: true, links: {
    skyscanner: "https://www.skyscanner.net/transport/flights/" + encodeURIComponent(req.body.origin || "") + "/" + encodeURIComponent(req.body.destination || ""),
    google: "https://www.google.com/travel/flights?q=flights+" + encodeURIComponent((req.body.origin || "") + " to " + (req.body.destination || ""))
  }});
});

// ============================================
// City Image (Wikipedia, cached)
// ============================================
app.get("/api/image", async function(req, res) {
  try {
    var city = req.query.city;
    if (!city) return res.status(400).json({ error: "Missing city" });

    var imgKey = "img-" + city;
    var cached = getCached(imgKey);
    if (cached && cached.url) return res.redirect(302, cached.url);

    var wikiRes = await fetch("https://en.wikipedia.org/api/rest_v1/page/summary/" + encodeURIComponent(city), {
      headers: { "User-Agent": "AffordTrip/1.0" }
    });
    var wikiData = await wikiRes.json();
    var imageUrl = (wikiData.thumbnail && wikiData.thumbnail.source) || (wikiData.originalimage && wikiData.originalimage.source);

    if (imageUrl) {
      setCache(imgKey, { url: imageUrl });
      return res.redirect(302, imageUrl);
    }
    res.status(404).json({ error: "No image" });
  } catch (err) {
    res.status(404).json({ error: "Failed" });
  }
});

// ============================================
// Start
// ============================================
app.listen(PORT, function() {
  console.log("AffordTrip API v3.1.0 running on port " + PORT);
});

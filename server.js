const express = require("express");
const cors = require("cors");
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const SERPAPI_KEY = process.env.SERPAPI_KEY;

// Cache — 6 hour TTL
const cache = {};
const CACHE_TTL = 3 * 60 * 60 * 1000;

function getCached(key) {
  var entry = cache[key];
  if (!entry) return null;
  if (Date.now() - entry.time > CACHE_TTL) { delete cache[key]; return null; }
  return entry.data;
}

function setCache(key, data) {
  cache[key] = { data: data, time: Date.now() };
  if (Math.random() < 0.01) {
    var now = Date.now();
    Object.keys(cache).forEach(function(k) { if (now - cache[k].time > CACHE_TTL) delete cache[k]; });
  }
}

// Health
app.get("/", function(req, res) {
  res.json({ status: "ok", version: "5.2.0", engine: "serpapi", cacheSize: Object.keys(cache).length });
});
app.get("/health", function(req, res) {
  res.json({ status: "ok", version: "5.2.0", cacheSize: Object.keys(cache).length });
});

// ── Helper: get week key for aggressive caching (Mon-Sun) ──
function getWeekKey(dateStr) {
  var d = dateStr ? new Date(dateStr) : new Date();
  var day = d.getDay();
  var diff = d.getDate() - day + (day === 0 ? -6 : 1); // Monday
  var monday = new Date(d.setDate(diff));
  return monday.toISOString().substring(0, 10);
}

// ── Helper: parse SerpApi destinations ──
var skipWords = ["national park", "state park", "resort", "mountain", "volcano", "canyon", "forest", "wilderness", "monument", "memorial", "scenic", "trail"];
function parseDestinations(serpData, currency) {
  return (serpData.destinations || []).filter(function(d) {
    if (!d.name && !d.title) return false;
    var name = (d.name || d.title || "").toLowerCase();
    for (var i = 0; i < skipWords.length; i++) {
      if (name.indexOf(skipWords[i]) >= 0) return false;
    }
    return true;
  }).map(function(d) {
    var flightPrice = null, airline = null, airlineCode = null;
    var stops = null, duration = null, depAirport = null, arrAirport = null;
    if (d.flights && d.flights.length > 0) {
      // Find cheapest flight
      var cheapest = d.flights[0];
      for (var j = 1; j < d.flights.length; j++) {
        if (d.flights[j].price && (!cheapest.price || d.flights[j].price < cheapest.price)) {
          cheapest = d.flights[j];
        }
      }
      var f = cheapest;
      flightPrice = f.price; airline = f.airline; airlineCode = f.airline_code;
      stops = f.number_of_stops; duration = f.duration;
      depAirport = f.departure_airport ? f.departure_airport.id : null;
      arrAirport = f.arrival_airport ? f.arrival_airport.id : null;
    }
    if (!flightPrice && d.flight_price) flightPrice = d.flight_price;
    if (!flightPrice && d.extracted_flight_price) flightPrice = d.extracted_flight_price;
    if (!flightPrice && d.price) flightPrice = d.price;
    return {
      city: d.name || d.title, country: d.country, coordinates: d.gps_coordinates,
      thumbnail: d.thumbnail, flightPrice: flightPrice, currency: currency,
      airline: airline, airlineCode: airlineCode, stops: stops, duration: duration,
      departureAirport: depAirport, arrivalAirport: arrAirport,
      startDate: d.start_date || null, endDate: d.end_date || null,
      googleFlightsLink: d.google_flights_link || null, description: d.description || null
    };
  });
}

// ── Helper: fetch one SerpApi region with timeout ──
function fetchRegion(baseUrl, regionId) {
  var url = baseUrl + (regionId ? "&arrival_area_id=" + encodeURIComponent(regionId) : "");
  var controller = new AbortController();
  var timeout = setTimeout(function(){ controller.abort(); }, 30000);
  return fetch(url, { signal: controller.signal })
    .then(function(r) { clearTimeout(timeout); return r.json(); })
    .catch(function(err) { clearTimeout(timeout); console.log("Region fetch failed:", err.message); return { destinations: [] }; });
}

// ── Helper: dedup destinations by city name (keep cheapest flight) ──
function dedup(destinations) {
  var seen = {};
  var result = [];
  destinations.forEach(function(d) {
    var key = (d.city || "").toLowerCase().trim();
    if (!key) return;
    if (seen[key]) {
      // Keep the one with cheaper flight
      if (d.flightPrice && (!seen[key].flightPrice || d.flightPrice < seen[key].flightPrice)) {
        var idx = result.indexOf(seen[key]);
        if (idx >= 0) result[idx] = d;
        seen[key] = d;
      }
    } else {
      seen[key] = d;
      result.push(d);
    }
  });
  return result;
}

// Region map
var regionMap = {
  "europe": "/m/02j9z",
  "asia": "/m/0j0k",
  "americas": "/m/0j2v0",
  "south_america": "/m/06n3y",
  "africa": "/m/0dg3n1",
  "oceania": "/m/05nrg",
  "morocco": "/m/04wgh"
};

// US airport region codes
var usRegions = ["NAM", "CAM", "SAM"];

// Weekly cache — 7 day TTL
var WEEKLY_TTL = 3 * 60 * 60 * 1000;

// Main search endpoint
app.all("/api/explore", async function(req, res) {
  try {
    var origin = req.query.origin || (req.body && req.body.origin);
    var date = req.query.date || (req.body && req.body.date);
    var returnDate = req.query.return || (req.body && req.body.returnDate);
    var currency = req.query.currency || (req.body && req.body.currency) || "GBP";
    var stops = req.query.stops || (req.body && req.body.stops) || "any";
    var vibe = req.query.vibe || (req.body && req.body.vibe) || "any";
    var region = req.query.region || (req.body && req.body.region) || "any";
    var depRegion = req.query.depRegion || (req.body && req.body.depRegion) || "";

    if (!origin) return res.status(400).json({ error: "Missing origin" });

    // ── Aggressive weekly cache for USA multi-region searches ──
    var isUSA = usRegions.indexOf(depRegion) >= 0;
    var weekKey = getWeekKey(date);
    var weeklyCacheK = "weekly-" + origin + "-" + weekKey + "-" + currency + "-" + stops;

    if (isUSA && region === "any") {
      var weeklyCached = cache[weeklyCacheK];
      if (weeklyCached && (Date.now() - weeklyCached.time < WEEKLY_TTL)) {
        console.log("Weekly cache hit:", weeklyCacheK, weeklyCached.data.length, "destinations");
        return res.json({ success: true, fromCache: true, total: weeklyCached.data.length, destinations: weeklyCached.data });
      }
    }

    // ── Standard 6hr cache ──
    var cacheK = "explore-" + origin + "-" + (date || "flex") + "-" + (returnDate || "flex") + "-" + currency + "-" + stops + "-" + vibe + "-" + region;
    var cached = getCached(cacheK);
    if (cached) return res.json({ success: true, fromCache: true, total: cached.length, destinations: cached });

    // Build base SerpApi URL (no region yet)
    var baseUrl = "https://serpapi.com/search.json?engine=google_travel_explore"
      + "&departure_id=" + encodeURIComponent(origin)
      + "&currency=" + encodeURIComponent(currency)
      + "&hl=en&type=1"
      + "&api_key=" + SERPAPI_KEY;

    if (date) baseUrl += "&outbound_date=" + encodeURIComponent(date);
    if (returnDate) baseUrl += "&return_date=" + encodeURIComponent(returnDate);
    if (stops === "direct") baseUrl += "&stops=1";
    else if (stops === "1stop") baseUrl += "&stops=2";

    var vibeMap = { "beach": "/m/0b3yr", "outdoors": "/g/11bc58l13w", "culture": "/m/03g3w", "skiing": "/m/071k0" };
    if (vibe !== "any" && vibeMap[vibe]) baseUrl += "&interest=" + encodeURIComponent(vibeMap[vibe]);

    // ── USA multi-region search: 4 calls + Morocco = 5 total ──
    if (isUSA && region === "any") {
      // Rotate 4th region: Europe on even days, Asia on odd days
      var dayOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0)) / 86400000);
      var rotatingRegion = (dayOfYear % 2 === 0) ? regionMap["europe"] : regionMap["asia"];
      var rotatingLabel = (dayOfYear % 2 === 0) ? "europe" : "asia";

      console.log("USA multi-region search from", origin, "| rotating:", rotatingLabel);

      var calls = [
        fetchRegion(baseUrl, null),                         // No filter (nearby/popular)
        fetchRegion(baseUrl, regionMap["americas"]),         // Americas (North + Central + Caribbean)
        fetchRegion(baseUrl, regionMap["south_america"]),    // South America specifically
        fetchRegion(baseUrl, rotatingRegion),                // Europe or Asia (rotating)
        fetchRegion(baseUrl, regionMap["morocco"])           // Morocco
      ];

      var results = await Promise.all(calls);
      var allDests = [];
      results.forEach(function(serpData, i) {
        var label = ["no-filter", "americas", "south_america", rotatingLabel, "morocco"][i];
        var parsed = parseDestinations(serpData, currency);
        console.log("  " + label + ":", parsed.length, "destinations");
        allDests = allDests.concat(parsed);
      });

      var destinations = dedup(allDests);
      console.log("USA total after dedup:", destinations.length);

      // Save to both weekly cache and standard cache
      cache[weeklyCacheK] = { data: destinations, time: Date.now() };
      setCache(cacheK, destinations);

      return res.json({ success: true, fromCache: false, origin: origin, total: destinations.length, destinations: destinations });
    }

    // ── Standard search (non-USA or specific region requested) ──
    // When region is "any", also fetch Morocco in parallel
    if (region === "any") {
      console.log("Standard + Morocco search from", origin);
      var calls = [
        fetchRegion(baseUrl, null),
        fetchRegion(baseUrl, regionMap["morocco"])
      ];
      var results = await Promise.all(calls);
      var allDests = [];
      results.forEach(function(serpData) {
        allDests = allDests.concat(parseDestinations(serpData, currency));
      });
      var destinations = dedup(allDests);
      console.log("Standard total after dedup:", destinations.length);
      setCache(cacheK, destinations);
      return res.json({ success: true, fromCache: false, origin: origin, total: destinations.length, destinations: destinations });
    }

    // Specific region requested
    if (regionMap[region]) {
      baseUrl += "&arrival_area_id=" + encodeURIComponent(regionMap[region]);
    }

    console.log("SerpApi URL:", baseUrl.replace(SERPAPI_KEY, "***"));

    var controller = new AbortController();
    var timeout = setTimeout(function(){ controller.abort(); }, 30000);
    var serpRes = await fetch(baseUrl, { signal: controller.signal });
    clearTimeout(timeout);
    var serpData = await serpRes.json();

    if (serpData.error) {
      console.log("SerpApi error:", serpData.error);
      return res.status(502).json({ error: "SerpApi error: " + serpData.error });
    }

    var destinations = parseDestinations(serpData, currency);

    setCache(cacheK, destinations);
    res.json({ success: true, fromCache: false, origin: origin, total: destinations.length, destinations: destinations });
  } catch (err) {
    console.log("Explore error:", err.name, err.message);
    if(err.name === "AbortError") {
      res.status(504).json({ error: "SerpApi timeout — try again", success: false, destinations: [] });
    } else {
      res.status(500).json({ error: "Explore failed: " + err.message, success: false, destinations: [] });
    }
  }
});

// Debug endpoint — returns raw SerpApi response
app.get("/api/explore/debug", async function(req, res) {
  try {
    var origin = req.query.origin || "LHR";
    var currency = req.query.currency || (req.body && req.body.currency) || "GBP";

    var url = "https://serpapi.com/search.json?engine=google_travel_explore"
      + "&departure_id=" + encodeURIComponent(origin)
      + "&currency=" + encodeURIComponent(currency)
      + "&hl=en&type=1"
      + "&api_key=" + SERPAPI_KEY;

    var controller2 = new AbortController();
    var timeout2 = setTimeout(function(){ controller2.abort(); }, 30000);
    var serpRes = await fetch(url, { signal: controller2.signal });
    clearTimeout(timeout2);
    var serpData = await serpRes.json();
    res.json(serpData);
  } catch (err) {
    res.status(err.name==="AbortError"?504:500).json({ error: err.message });
  }
});

// Hotel & Flight booking links
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

// City Image
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
    if (imageUrl) { setCache(imgKey, { url: imageUrl }); return res.redirect(302, imageUrl); }
    res.status(404).json({ error: "No image" });
  } catch (err) { res.status(404).json({ error: "Failed" }); }
});

// Multiple images from Wikipedia article
app.get("/api/images", async function(req, res) {
  try {
    var city = req.query.city;
    var count = parseInt(req.query.count) || 4;
    if (!city) return res.status(400).json({ error: "Missing city" });
    var imgKey = "imgs2-" + city + "-" + count;
    var cached = getCached(imgKey);
    if (cached) return res.json({ success: true, images: cached });

    // Get images from the Wikipedia article itself (much better quality)
    var url = "https://en.wikipedia.org/w/api.php?action=query&titles="
      + encodeURIComponent(city)
      + "&prop=images&imlimit=20&format=json";

    var wikiRes = await fetch(url, { headers: { "User-Agent": "AffordTrip/1.0" } });
    var data = await wikiRes.json();
    var fileNames = [];
    if (data.query && data.query.pages) {
      Object.values(data.query.pages).forEach(function(page) {
        if (page.images) {
          page.images.forEach(function(img) {
            var t = img.title.toLowerCase();
            // Skip logos, icons, flags, maps, SVGs, coat of arms, commons icons, portraits
            if (t.match(/\.svg|flag|logo|icon|coat.of.arms|commons|wikisource|wikidata|map.*\d|symbol|seal|emblem|stub|edit.*button|ambox|question.book|text.document|portrait|mayor|governor|president|minister|official|headshot|mugshot|face|bust|statue.*of/i)) return;
            fileNames.push(img.title);
          });
        }
      });
    }

    // Now get actual image URLs for the best candidates
    var images = [];
    var batch = fileNames.slice(0, Math.min(fileNames.length, 10));
    if (batch.length > 0) {
      var imgUrl = "https://en.wikipedia.org/w/api.php?action=query&titles="
        + batch.map(function(f){ return encodeURIComponent(f); }).join("|")
        + "&prop=imageinfo&iiprop=url|size|mime&iiurlwidth=800&format=json";

      var imgRes = await fetch(imgUrl, { headers: { "User-Agent": "AffordTrip/1.0" } });
      var imgData = await imgRes.json();
      if (imgData.query && imgData.query.pages) {
        Object.values(imgData.query.pages).forEach(function(page) {
          if (images.length >= count) return;
          if (page.imageinfo && page.imageinfo[0]) {
            var info = page.imageinfo[0];
            // Only JPEG/PNG photos, skip small images, portraits, and non-landscape
            if (info.mime && info.mime.match(/jpeg|png/) && info.width > 600 && info.height > 300 && info.width > info.height) {
              images.push(info.thumburl || info.url);
            }
          }
        });
      }
    }
    setCache(imgKey, images);
    res.json({ success: true, images: images });
  } catch (err) {
    res.json({ success: true, images: [] });
  }
});

app.listen(PORT, function() { console.log("AffordTrip API v5.2.0 on port " + PORT); });

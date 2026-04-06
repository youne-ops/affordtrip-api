const express = require("express");
const cors = require("cors");
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const SERPAPI_KEY = process.env.SERPAPI_KEY;

// Cache — 6 hour TTL
const cache = {};
const CACHE_TTL = 6 * 60 * 60 * 1000;

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
  res.json({ status: "ok", version: "4.1.0", engine: "serpapi", cacheSize: Object.keys(cache).length });
});
app.get("/health", function(req, res) {
  res.json({ status: "ok", version: "4.1.0", cacheSize: Object.keys(cache).length });
});

// Main search endpoint
app.all("/api/explore", async function(req, res) {
  try {
    var origin = req.query.origin || (req.body && req.body.origin);
    var date = req.query.date || (req.body && req.body.date);
    var returnDate = req.query.return || (req.body && req.body.returnDate);
    var currency = req.query.currency || (req.body && req.body.currency) || "GBP";

    if (!origin) return res.status(400).json({ error: "Missing origin" });

    var cacheK = "explore-" + origin + "-" + (date || "flex") + "-" + (returnDate || "flex") + "-" + currency;
    var cached = getCached(cacheK);
    if (cached) return res.json({ success: true, fromCache: true, total: cached.length, destinations: cached });

    // Build SerpApi URL — no gl parameter, let Google auto-detect
    var url = "https://serpapi.com/search.json?engine=google_travel_explore"
      + "&departure_id=" + encodeURIComponent(origin)
      + "&currency=" + encodeURIComponent(currency)
      + "&hl=en"
      + "&api_key=" + SERPAPI_KEY;

    // Add dates if provided
    if (date) url += "&outbound_date=" + encodeURIComponent(date);
    if (returnDate) url += "&return_date=" + encodeURIComponent(returnDate);

    console.log("SerpApi URL:", url.replace(SERPAPI_KEY, "***"));

    var serpRes = await fetch(url);
    var serpData = await serpRes.json();

    // Log raw response for debugging
    console.log("SerpApi response keys:", Object.keys(serpData));
    console.log("Destinations count:", serpData.destinations ? serpData.destinations.length : 0);
    if (serpData.destinations && serpData.destinations[0]) {
      console.log("First destination:", JSON.stringify(serpData.destinations[0]).substring(0, 500));
    }
    if (serpData.error) {
      console.log("SerpApi error:", serpData.error);
      return res.status(502).json({ error: "SerpApi error: " + serpData.error });
    }

    // Parse destinations
    var skipWords = ["national park", "state park", "resort", "mountain", "volcano", "canyon", "forest", "wilderness", "monument", "memorial", "scenic", "trail"];
    var destinations = (serpData.destinations || []).filter(function(d) {
      // Skip destinations without a name
      if (!d.name && !d.title) return false;
      var name = (d.name || d.title || "").toLowerCase();
      // Skip non-city destinations (parks, resorts, etc.)
      for (var i = 0; i < skipWords.length; i++) {
        if (name.indexOf(skipWords[i]) >= 0) return false;
      }
      return true;
    }).map(function(d) {
      // Flight price might be at different levels depending on the API response
      var flightPrice = null;
      var airline = null;
      var airlineCode = null;
      var stops = null;
      var duration = null;
      var depAirport = null;
      var arrAirport = null;

      // Check if flights array exists and has data
      if (d.flights && d.flights.length > 0) {
        var f = d.flights[0];
        flightPrice = f.price;
        airline = f.airline;
        airlineCode = f.airline_code;
        stops = f.number_of_stops;
        duration = f.duration;
        depAirport = f.departure_airport ? f.departure_airport.id : null;
        arrAirport = f.arrival_airport ? f.arrival_airport.id : null;
      }

      // Also check for price at destination level (some responses have it here)
      if (!flightPrice && d.flight_price) flightPrice = d.flight_price;
      if (!flightPrice && d.extracted_flight_price) flightPrice = d.extracted_flight_price;
      if (!flightPrice && d.price) flightPrice = d.price;

      return {
        city: d.name || d.title,
        country: d.country,
        coordinates: d.gps_coordinates,
        thumbnail: d.thumbnail,
        flightPrice: flightPrice,
        currency: currency,
        airline: airline,
        airlineCode: airlineCode,
        stops: stops,
        duration: duration,
        departureAirport: depAirport,
        arrivalAirport: arrAirport,
        startDate: d.start_date || null,
        endDate: d.end_date || null,
        googleFlightsLink: d.google_flights_link || null,
        description: d.description || null
      };
    });

    setCache(cacheK, destinations);
    res.json({ success: true, fromCache: false, origin: origin, total: destinations.length, destinations: destinations });
  } catch (err) {
    console.log("Explore error:", err);
    res.status(500).json({ error: "Explore failed: " + err.message });
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
      + "&hl=en"
      + "&api_key=" + SERPAPI_KEY;

    var serpRes = await fetch(url);
    var serpData = await serpRes.json();
    res.json(serpData);
  } catch (err) {
    res.status(500).json({ error: err.message });
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

app.listen(PORT, function() { console.log("AffordTrip API v4.1.0 on port " + PORT); });

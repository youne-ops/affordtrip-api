// ============================================
// AffordTrip API Server (Railway) v4.0.0
// Powered by SerpApi Google Travel Explore
// 1 API call = all destinations + prices
// ============================================
const express = require("express");
const cors = require("cors");
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const SERPAPI_KEY = process.env.SERPAPI_KEY;

// ============================================
// CACHE — 6 hour TTL
// ============================================
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

// ============================================
// Health Check
// ============================================
app.get("/", function(req, res) {
  res.json({ status: "ok", service: "AffordTrip API", version: "4.0.0", platform: "railway", engine: "serpapi", cacheSize: Object.keys(cache).length, timestamp: new Date().toISOString() });
});
app.get("/health", function(req, res) {
  res.json({ status: "ok", version: "4.0.0", engine: "serpapi", cacheSize: Object.keys(cache).length });
});

// ============================================
// MAIN ENDPOINT: Search flights to everywhere
// GET /api/explore?origin=LHR&date=2026-07-15&return=2026-07-20&budget=1500&currency=GBP
// Returns: all destinations with prices in ONE call
// ============================================
app.get("/api/explore", async function(req, res) {
  try {
    var origin = req.query.origin;
    var date = req.query.date;
    var returnDate = req.query.return;
    var budget = req.query.budget;
    var currency = req.query.currency || "GBP";

    if (!origin) return res.status(400).json({ error: "Missing origin" });

    // Build cache key
    var cacheK = "explore-" + origin + "-" + (date || "flex") + "-" + (returnDate || "flex") + "-" + currency;
    var cached = getCached(cacheK);
    if (cached) {
      return res.json({ success: true, fromCache: true, destinations: cached });
    }

    // Build SerpApi URL
    var url = "https://serpapi.com/search.json?engine=google_travel_explore"
      + "&departure_id=" + encodeURIComponent(origin)
      + "&currency=" + encodeURIComponent(currency)
      + "&hl=en&gl=uk"
      + "&api_key=" + SERPAPI_KEY;

    // Add dates if provided
    if (date) url += "&outbound_date=" + encodeURIComponent(date);
    if (returnDate) url += "&return_date=" + encodeURIComponent(returnDate);

    // Add budget filter if provided
    if (budget) url += "&max_price=" + encodeURIComponent(budget);

    var serpRes = await fetch(url);
    var serpData = await serpRes.json();

    if (serpData.error) {
      return res.status(502).json({ error: "SerpApi error: " + serpData.error });
    }

    // Parse destinations
    var destinations = (serpData.destinations || []).map(function(d) {
      var cheapestFlight = d.flights && d.flights[0];
      return {
        city: d.name,
        country: d.country,
        coordinates: d.gps_coordinates,
        thumbnail: d.thumbnail,
        flightPrice: cheapestFlight ? cheapestFlight.price : null,
        currency: currency,
        airline: cheapestFlight ? cheapestFlight.airline : null,
        airlineCode: cheapestFlight ? cheapestFlight.airline_code : null,
        stops: cheapestFlight ? cheapestFlight.number_of_stops : null,
        duration: cheapestFlight ? cheapestFlight.duration : null,
        departureAirport: cheapestFlight && cheapestFlight.departure_airport ? cheapestFlight.departure_airport.id : null,
        arrivalAirport: cheapestFlight && cheapestFlight.arrival_airport ? cheapestFlight.arrival_airport.id : null,
        startDate: d.start_date || null,
        endDate: d.end_date || null,
        googleFlightsLink: d.google_flights_link || null,
        allFlights: (d.flights || []).map(function(f) {
          return {
            price: f.price,
            airline: f.airline,
            stops: f.number_of_stops,
            duration: f.duration,
            cheapest: f.cheapest_flight || false
          };
        })
      };
    });

    // Cache results
    setCache(cacheK, destinations);

    res.json({
      success: true,
      fromCache: false,
      origin: origin,
      total: destinations.length,
      destinations: destinations
    });

  } catch (err) {
    res.status(500).json({ error: "Explore search failed: " + err.message });
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
  console.log("AffordTrip API v4.0.0 (SerpApi) running on port " + PORT);
});

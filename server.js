// ============================================
// AffordTrip API Server (Railway)
// ============================================
const express = require("express");
const cors = require("cors");
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const DUFFEL_API_KEY = process.env.DUFFEL_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// ============================================
// Health Check
// ============================================
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "AffordTrip API",
    version: "3.0.0",
    platform: "railway",
    features: ["round-trip-flights", "multi-destination", "ai-matching", "city-images"],
    timestamp: new Date().toISOString(),
  });
});
app.get("/health", (req, res) => {
  res.json({ status: "ok", version: "3.0.0", platform: "railway" });
});

// ============================================
// Flight Search (single destination, round-trip)
// ============================================
app.post("/api/flights", async (req, res) => {
  try {
    const { origin, destination, date, returnDate, passengers = 1, cabin = "economy" } = req.body;
    if (!origin || !destination || !date) {
      return res.status(400).json({ error: "Missing required fields: origin, destination, date" });
    }

    const passengerList = Array.from({ length: passengers }, () => ({ type: "adult" }));
    const slices = [{ origin, destination, departure_date: date }];
    if (returnDate) slices.push({ origin: destination, destination: origin, departure_date: returnDate });

    const duffelRes = await fetch("https://api.duffel.com/air/offer_requests", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${DUFFEL_API_KEY}`,
        "Content-Type": "application/json",
        "Duffel-Version": "v2",
      },
      body: JSON.stringify({ data: { slices, passengers: passengerList, cabin_class: cabin } }),
    });

    const duffelData = await duffelRes.json();
    if (duffelData.errors) {
      return res.status(502).json({ error: duffelData.errors[0]?.message || "Duffel API error" });
    }

    const offers = (duffelData.data?.offers || []).slice(0, 20).map((offer) => {
      const slice = offer.slices?.[0];
      const segments = slice?.segments || [];
      const firstSeg = segments[0];
      const lastSeg = segments[segments.length - 1];
      return {
        id: offer.id,
        price: parseFloat(offer.total_amount),
        currency: offer.total_currency,
        airline: { name: offer.owner?.name, code: offer.owner?.iata_code, logo: offer.owner?.logo_symbol_url },
        departure: { airport: firstSeg?.origin?.iata_code, city: firstSeg?.origin?.city_name, time: firstSeg?.departing_at },
        arrival: { airport: lastSeg?.destination?.iata_code, city: lastSeg?.destination?.city_name, time: lastSeg?.arriving_at },
        duration: slice?.duration,
        stops: segments.length - 1,
        isRoundTrip: slices.length > 1,
        expiresAt: offer.expires_at,
      };
    });

    offers.sort((a, b) => a.price - b.price);
    res.json({ success: true, origin, destination, date, returnDate: returnDate || null, isRoundTrip: slices.length > 1, total_offers: offers.length, offers });
  } catch (err) {
    res.status(500).json({ error: "Flight search failed: " + err.message });
  }
});

// ============================================
// Multi-destination flight prices (round-trip)
// ============================================
app.post("/api/flights/multi", async (req, res) => {
  try {
    const { origin, destinations, date, returnDate, passengers = 1 } = req.body;
    if (!origin || !destinations || !date) {
      return res.status(400).json({ error: "Missing required fields: origin, destinations, date" });
    }

    const batch = destinations.slice(0, 5);
    const results = await Promise.allSettled(
      batch.map(async (dest) => {
        try {
          const slices = [{ origin, destination: dest, departure_date: date }];
          if (returnDate) slices.push({ origin: dest, destination: origin, departure_date: returnDate });

          const r = await fetch("https://api.duffel.com/air/offer_requests", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${DUFFEL_API_KEY}`,
              "Content-Type": "application/json",
              "Duffel-Version": "v2",
            },
            body: JSON.stringify({
              data: { slices, passengers: [{ type: "adult" }], cabin_class: "economy" },
            }),
          });
          const data = await r.json();
          const cheapest = data.data?.offers?.sort((a, b) => parseFloat(a.total_amount) - parseFloat(b.total_amount))[0];
          return {
            destination: dest,
            price: cheapest ? parseFloat(cheapest.total_amount) : null,
            currency: cheapest?.total_currency || null,
            airline: cheapest?.owner?.name || null,
            isRoundTrip: slices.length > 1,
          };
        } catch (e) {
          return { destination: dest, price: null, error: e.message };
        }
      })
    );

    const prices = results.map((r) => (r.status === "fulfilled" ? r.value : { destination: "unknown", price: null, error: r.reason }));
    res.json({ success: true, origin, date, returnDate: returnDate || null, prices });
  } catch (err) {
    res.status(500).json({ error: "Multi-search failed: " + err.message });
  }
});

// ============================================
// Claude AI — Budget Matching
// ============================================
app.post("/api/match", async (req, res) => {
  try {
    const { budget, days, travelers, origin, style, vibes, currency } = req.body;

    const prompt = `You are AffordTrip's travel advisor. A user wants to travel.

Budget: ${currency || "GBP"} ${budget} total
Days: ${days}
Travelers: ${travelers}
Flying from: ${origin}
Travel style: ${style}
Vibes they want: ${(vibes || []).join(", ")}

Suggest 5-8 destinations they can afford. For each destination, provide:
- City and country
- Estimated daily cost (accommodation + food + transport + activities)
- Estimated round-trip flight cost per person from their origin
- Total estimated trip cost
- A one-line reason why it's a great match

IMPORTANT: Only suggest destinations where the total trip cost is UNDER their budget.

Respond ONLY in this JSON format, no other text:
{
  "destinations": [
    {
      "city": "Bangkok",
      "country": "Thailand",
      "flag": "🇹🇭",
      "dailyCost": 45,
      "flightCost": 380,
      "totalCost": 695,
      "reason": "Incredible street food and temples at unbeatable prices"
    }
  ]
}`;

    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 1024, messages: [{ role: "user", content: prompt }] }),
    });

    const claudeData = await claudeRes.json();
    const text = claudeData.content?.[0]?.text || "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return res.json({ success: true, ...parsed });
    }
    res.status(500).json({ error: "Could not parse AI response" });
  } catch (err) {
    res.status(500).json({ error: "AI matching failed: " + err.message });
  }
});

// ============================================
// Hotel Booking Links
// ============================================
app.post("/api/hotels", async (req, res) => {
  try {
    const { city, checkin, checkout, guests = 1 } = req.body;
    if (!city) return res.status(400).json({ error: "Missing required field: city" });

    const bookingUrl = `https://www.booking.com/searchresults.html?ss=${encodeURIComponent(city)}&checkin=${checkin || ""}&checkout=${checkout || ""}&group_adults=${guests}&no_rooms=1`;
    const skyscannerUrl = `https://www.skyscanner.net/hotels?q=${encodeURIComponent(city)}&checkin=${checkin || ""}&checkout=${checkout || ""}&guests=${guests}`;

    res.json({ success: true, city, links: { booking: bookingUrl, skyscanner: skyscannerUrl } });
  } catch (err) {
    res.status(500).json({ error: "Hotel link generation failed: " + err.message });
  }
});

// ============================================
// Flight Booking Links
// ============================================
app.post("/api/book-flight", async (req, res) => {
  try {
    const { origin, destination, date } = req.body;
    const skyscannerUrl = `https://www.skyscanner.net/transport/flights/${encodeURIComponent(origin)}/${encodeURIComponent(destination)}/${date ? date.replace(/-/g, "").slice(2) : ""}`;
    const googleUrl = `https://www.google.com/travel/flights?q=flights+from+${encodeURIComponent(origin)}+to+${encodeURIComponent(destination)}+on+${date || ""}`;
    res.json({ success: true, links: { skyscanner: skyscannerUrl, google: googleUrl } });
  } catch (err) {
    res.status(500).json({ error: "Booking link generation failed: " + err.message });
  }
});

// ============================================
// City Image (via Wikipedia)
// ============================================
app.get("/api/image", async (req, res) => {
  try {
    const city = req.query.city;
    if (!city) return res.status(400).json({ error: "Missing city parameter" });

    const wikiUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(city)}`;
    const wikiRes = await fetch(wikiUrl, {
      headers: { "User-Agent": "AffordTrip/1.0 (travel app)" },
    });
    const wikiData = await wikiRes.json();
    const imageUrl = wikiData.thumbnail?.source || wikiData.originalimage?.source;

    if (imageUrl) {
      return res.redirect(302, imageUrl);
    }
    res.status(404).json({ error: "No image found" });
  } catch (err) {
    res.status(404).json({ error: "Image fetch failed" });
  }
});

// ============================================
// Start Server
// ============================================
app.listen(PORT, () => {
  console.log(`AffordTrip API running on port ${PORT}`);
});

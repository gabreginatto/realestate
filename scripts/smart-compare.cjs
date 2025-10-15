const { GoogleGenerativeAI } = require("@google/generative-ai");
const fs = require('fs');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite" });

// Load data
const vivaData = require('../data/vivaprimeimoveis/listings/all-listings.json');
const coelhoData = require('../data/coelhodafonseca/listings/all-listings.json');

console.log('\n🧠 SMART COMPARISON (Area → Price → Beds → AI)\n');
console.log(`Vivaprimeimoveis: ${vivaData.total_listings} listings`);
console.log(`Coelho da Fonseca: ${coelhoData.total_listings} listings\n`);

// Helper: Parse area from string (e.g., "397m²" → 397)
function parseArea(areaStr) {
  if (!areaStr) return null;
  const match = String(areaStr).match(/(\d+(?:\.\d+)?)/);
  return match ? parseFloat(match[1]) : null;
}

// Helper: Parse price (e.g., "R$ 4.500.000,00" → 4500000)
function parsePrice(priceStr) {
  if (!priceStr) return null;
  const match = String(priceStr).match(/[\d.,]+/);
  if (!match) return null;
  return parseFloat(match[0].replace(/\./g, '').replace(',', '.'));
}

// Helper: Check if two values are within tolerance
function withinTolerance(val1, val2, tolerance = 0.20) {
  if (!val1 || !val2) return false;
  const diff = Math.abs(val1 - val2);
  const avg = (val1 + val2) / 2;
  return (diff / avg) <= tolerance;
}

// Step 1: Index Coelho listings by area ranges
console.log('📊 STEP 1: Indexing by constructed area...\n');

const coelhoByArea = {};
coelhoData.listings.forEach(listing => {
  // Parse area from features string (e.g., "4 dorms / 4 suítes / 8 vagas / 950 m² construída")
  const match = listing.features.match(/(\d+(?:\.\d+)?)\s*m²\s*construída/i);
  if (match) {
    const area = parseFloat(match[1]);
    const bucket = Math.floor(area / 50) * 50; // 50m² buckets
    if (!coelhoByArea[bucket]) coelhoByArea[bucket] = [];
    coelhoByArea[bucket].push({
      ...listing,
      parsedArea: area,
      parsedPrice: parsePrice(listing.price),
      parsedDorms: parseInt(listing.features.match(/(\d+)\s*dorms?/i)?.[1] || 0),
      parsedSuites: parseInt(listing.features.match(/(\d+)\s*suítes?/i)?.[1] || 0)
    });
  }
});

console.log(`✓ Created ${Object.keys(coelhoByArea).length} area buckets for Coelho\n`);

// Step 2: For each Viva listing, find candidates
console.log('🔍 STEP 2: Finding candidates using filters...\n');

const allCandidates = [];
let totalFiltered = 0;

// Tracking statistics
const skipReasons = {
  noArea: 0,
  noAreaMatches: 0,
  tooManyCandidates: 0,
  noStrongCandidates: 0,
  queued: 0
};
const skippedListings = {
  noArea: [],
  noAreaMatches: [],
  tooManyCandidates: [],
  noStrongCandidates: []
};

vivaData.listings.forEach((vivaListing, idx) => {
  const vivaArea = parseArea(vivaListing.detailedData.specs.area_construida);
  const vivaPrice = parsePrice(vivaListing.price);
  const vivaDorms = vivaListing.detailedData.specs.dormitorios;
  const vivaSuites = vivaListing.detailedData.specs.suites;

  console.log(`[${idx + 1}/${vivaData.total_listings}] Viva ${vivaListing.propertyCode}`);
  console.log(`  Area: ${vivaArea}m² | Price: R$ ${(vivaPrice/1000000).toFixed(1)}M | ${vivaDorms}d/${vivaSuites}s`);

  if (!vivaArea) {
    console.log(`  ⚠️  No area data - skipping\n`);
    skipReasons.noArea++;
    skippedListings.noArea.push({
      code: vivaListing.propertyCode,
      price: vivaListing.price,
      specs: vivaListing.detailedData.specs
    });
    return;
  }

  // Find relevant area buckets (check current bucket and adjacent ones)
  const bucket = Math.floor(vivaArea / 50) * 50;
  const relevantBuckets = [bucket - 50, bucket, bucket + 50];

  let candidates = [];
  relevantBuckets.forEach(b => {
    if (coelhoByArea[b]) {
      candidates = candidates.concat(coelhoByArea[b]);
    }
  });

  // Filter 1: Area tolerance (±20%)
  candidates = candidates.filter(c => withinTolerance(vivaArea, c.parsedArea, 0.20));
  console.log(`  Filter 1 (Area ±20%): ${candidates.length} matches`);

  if (candidates.length === 0) {
    console.log(`  ✗ No area matches\n`);
    skipReasons.noAreaMatches++;
    skippedListings.noAreaMatches.push({
      code: vivaListing.propertyCode,
      price: vivaListing.price,
      area: vivaArea,
      bucket: bucket,
      specs: vivaListing.detailedData.specs
    });
    return;
  }

  // Filter 2: Price tolerance (±20%)
  if (vivaPrice) {
    const priceMatches = candidates.filter(c =>
      c.parsedPrice && withinTolerance(vivaPrice, c.parsedPrice, 0.20)
    );
    if (priceMatches.length > 0) {
      candidates = priceMatches;
      console.log(`  Filter 2 (Price ±20%): ${candidates.length} matches`);
    } else {
      console.log(`  Filter 2 (Price ±20%): 0 matches (keeping area matches)`);
    }
  }

  // Filter 3: Bedrooms/Suites match (exact or ±1)
  if (vivaDorms) {
    const bedroomMatches = candidates.filter(c =>
      Math.abs(c.parsedDorms - vivaDorms) <= 1
    );
    if (bedroomMatches.length > 0) {
      candidates = bedroomMatches;
      console.log(`  Filter 3 (Bedrooms ±1): ${candidates.length} matches`);
    } else {
      console.log(`  Filter 3 (Bedrooms ±1): 0 matches (keeping previous)`);
    }
  }

  if (candidates.length > 0 && candidates.length <= 5) {
    console.log(`  ✓ ${candidates.length} strong candidates → queuing for AI analysis`);
    skipReasons.queued++;
    allCandidates.push({
      viva: vivaListing,
      coelhoCandidates: candidates.slice(0, 3) // Max 3 candidates per listing
    });
    totalFiltered += candidates.length;
  } else if (candidates.length > 5) {
    console.log(`  ⚠️  Too many candidates (${candidates.length}) - need tighter filters`);
    skipReasons.tooManyCandidates++;
    skippedListings.tooManyCandidates.push({
      code: vivaListing.propertyCode,
      price: vivaListing.price,
      area: vivaArea,
      candidatesCount: candidates.length,
      specs: vivaListing.detailedData.specs
    });
  } else {
    console.log(`  ✗ No strong candidates`);
    skipReasons.noStrongCandidates++;
    skippedListings.noStrongCandidates.push({
      code: vivaListing.propertyCode,
      price: vivaListing.price,
      area: vivaArea,
      specs: vivaListing.detailedData.specs
    });
  }

  console.log('');
});

console.log(`\n═══════════════════════════════════════════════════════════════\n`);
console.log(`📊 Filter Summary:`);
console.log(`   Total Viva listings: ${vivaData.total_listings}`);
console.log(`   Listings with candidates: ${allCandidates.length}`);
console.log(`   Total candidates for AI: ${totalFiltered}`);
console.log(`   Avoided API calls: ${vivaData.total_listings - allCandidates.length}\n`);

console.log(`📋 Detailed Breakdown:`);
console.log(`   ✓ Queued for AI analysis: ${skipReasons.queued}`);
console.log(`   ✗ No area data: ${skipReasons.noArea}`);
console.log(`   ✗ No area matches: ${skipReasons.noAreaMatches}`);
console.log(`   ✗ Too many candidates (>5): ${skipReasons.tooManyCandidates}`);
console.log(`   ✗ No strong candidates: ${skipReasons.noStrongCandidates}\n`);

console.log(`   TOTAL: ${skipReasons.queued + skipReasons.noArea + skipReasons.noAreaMatches + skipReasons.tooManyCandidates + skipReasons.noStrongCandidates}\n`);

// Show details of skipped listings
if (skipReasons.noArea > 0) {
  console.log(`\n⚠️  SKIPPED: No Area Data (${skipReasons.noArea} listings):`);
  skippedListings.noArea.forEach(l => {
    console.log(`   - ${l.code}: ${l.price} | Area: ${l.specs.area_construida}`);
  });
}

if (skipReasons.noAreaMatches > 0) {
  console.log(`\n⚠️  SKIPPED: No Area Matches (${skipReasons.noAreaMatches} listings):`);
  skippedListings.noAreaMatches.forEach(l => {
    console.log(`   - ${l.code}: ${l.price} | Area: ${l.area}m² (bucket: ${l.bucket})`);
  });
}

if (skipReasons.tooManyCandidates > 0) {
  console.log(`\n⚠️  SKIPPED: Too Many Candidates (${skipReasons.tooManyCandidates} listings):`);
  skippedListings.tooManyCandidates.forEach(l => {
    console.log(`   - ${l.code}: ${l.price} | Area: ${l.area}m² | Candidates: ${l.candidatesCount}`);
  });
}

if (skipReasons.noStrongCandidates > 0) {
  console.log(`\n⚠️  SKIPPED: No Strong Candidates (${skipReasons.noStrongCandidates} listings):`);
  skippedListings.noStrongCandidates.forEach(l => {
    console.log(`   - ${l.code}: ${l.price} | Area: ${l.area}m²`);
  });
}

console.log(`\n`);

// Step 3: Use AI only for final candidates
(async () => {
console.log('🤖 STEP 3: Using AI for final verification...\n');

const finalMatches = [];

for (const item of allCandidates) {
  const viva = item.viva;
  const candidates = item.coelhoCandidates;

  console.log(`Analyzing Viva ${viva.propertyCode} with ${candidates.length} candidates...`);

  const prompt = `Compare this property with candidates to find the EXACT SAME property listed on different websites.

VIVA LISTING:
- Code: ${viva.propertyCode}
- Price: ${viva.price}
- Area: ${viva.detailedData.specs.area_construida} construída, ${viva.detailedData.specs.area_total} total
- Bedrooms: ${viva.detailedData.specs.dormitorios} dorms, ${viva.detailedData.specs.suites} suites
- Description: ${viva.detailedData.description.substring(0, 200)}

CANDIDATES:
${candidates.map((c, i) => `[${i}] ${c.propertyCode}: ${c.price}, ${c.features}, Desc: ${c.description.substring(0, 100)}`).join('\n')}

Return JSON array with matches ONLY if you're confident it's the SAME property (not just similar):
[{"index": 0, "confidence": 0.95, "reason": "Exact area, price, and features match"}]

If no strong match (confidence < 0.75), return: []`;

  try {
    const result = await model.generateContent(prompt);
    const responseText = result.response.text();
    const jsonMatch = responseText.match(/\[[\s\S]*\]/);

    if (jsonMatch) {
      const matches = JSON.parse(jsonMatch[0]);
      if (matches.length > 0) {
        matches.forEach(m => {
          const coelho = candidates[m.index];
          console.log(`  ✓ MATCH FOUND: Coelho ${coelho.propertyCode} (${(m.confidence * 100).toFixed(0)}%) - ${m.reason}`);

          finalMatches.push({
            viva: {
              code: viva.propertyCode,
              url: viva.url,
              price: viva.price,
              specs: viva.detailedData.specs
            },
            coelho: {
              code: coelho.propertyCode,
              url: coelho.url,
              price: coelho.price,
              features: coelho.features
            },
            confidence: m.confidence,
            reason: m.reason
          });
        });
      } else {
        console.log(`  ✗ No confident matches`);
      }
    }
  } catch (e) {
    console.log(`  ❌ Error: ${e.message}`);
  }

  await new Promise(resolve => setTimeout(resolve, 1000));
}

console.log(`\n\n═══════════════════════════════════════════════════════════════\n`);
console.log(`🎯 FINAL RESULTS:\n`);
console.log(`Total matches found: ${finalMatches.length}\n`);

finalMatches.forEach(m => {
  console.log(`✓ Viva ${m.viva.code} ↔ Coelho ${m.coelho.code} (${(m.confidence * 100).toFixed(0)}%)`);
  console.log(`  Viva: ${m.viva.price} - ${m.viva.url}`);
  console.log(`  Coelho: ${m.coelho.price} - ${m.coelho.url}`);
  console.log(`  Reason: ${m.reason}\n`);
});

// Save results
const outputFile = 'data/smart-matches.json';
fs.writeFileSync(outputFile, JSON.stringify({
  generated_at: new Date().toISOString(),
  approach: 'Smart filtering (Area → Price → Beds → AI)',
  total_viva_listings: vivaData.total_listings,
  listings_with_candidates: allCandidates.length,
  api_calls_made: allCandidates.length,
  api_calls_saved: vivaData.total_listings - allCandidates.length,
  total_matches: finalMatches.length,
  skip_reasons: skipReasons,
  skipped_details: skippedListings,
  matches: finalMatches
}, null, 2));

console.log(`💾 Saved to: ${outputFile}\n`);
})();

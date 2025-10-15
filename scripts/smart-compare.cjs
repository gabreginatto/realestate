const { GoogleGenerativeAI } = require("@google/generative-ai");
const fs = require('fs');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite" });

// Load data
const vivaData = require('../data/vivaprimeimoveis/listings/all-listings.json');
const coelhoData = require('../data/coelhodafonseca/listings/all-listings.json');

console.log('\n🧠 SMART COMPARISON v2 (Multi-Block Index + Composite Scoring)\n');
console.log(`Vivaprimeimoveis: ${vivaData.total_listings} listings`);
console.log(`Coelho da Fonseca: ${coelhoData.total_listings} listings\n`);

// ============================================================================
// NORMALIZATION & TOKEN HELPERS
// ============================================================================

const STOPWORDS_PT = new Set("de,da,do,em,para,com,um,uma,os,as,e,ou,a,o,no,na,por,entre,dos,das,nos,nas,ao,aos,à,às,pelo,pela,pelos,pelas,num,numa,nuns,numas".split(","));

function normalizeInt(x) {
  if (x === undefined || x === null) return null;
  const m = String(x).match(/(\d+(?:[\.,]\d+)?)/);
  if (!m) return null;
  return Math.round(parseFloat(m[1].replace(/\./g,'').replace(',', '.')));
}

function parseAreaM2(s) {
  if (!s) return null;
  const m = String(s).match(/(\d+(?:[\.,]\d+)?)\s*m²/i);
  if (!m) return null;
  // Handle both Brazilian (123.456,78) and international (123,456.78) formats
  const num = m[1];
  // If it has both . and ,, it's Brazilian format: remove dots, replace comma with dot
  if (num.includes('.') && num.includes(',')) {
    return parseFloat(num.replace(/\./g, '').replace(',', '.'));
  }
  // If it only has comma, replace with dot
  if (num.includes(',')) {
    return parseFloat(num.replace(',', '.'));
  }
  // If it only has dot, keep as-is (it's a decimal point, not thousands separator)
  return parseFloat(num);
}

function parseAreaFromFeatures(featuresStr) {
  if (!featuresStr) return null;
  const m = featuresStr.match(/(\d+(?:[\.,]\d+)?)\s*m²\s*construída/i);
  if (!m) return null;
  const num = m[1];
  // Handle both Brazilian (123.456,78) and international (123,456.78) formats
  if (num.includes('.') && num.includes(',')) {
    return parseFloat(num.replace(/\./g, '').replace(',', '.'));
  }
  if (num.includes(',')) {
    return parseFloat(num.replace(',', '.'));
  }
  return parseFloat(num);
}

function parsePriceBRL(priceStr) {
  if (!priceStr) return null;
  const m = String(priceStr).match(/[\d\.,]+/);
  if (!m) return null;
  return parseFloat(m[0].replace(/\./g,'').replace(',', '.'));
}

function tokenizeFeatures(str) {
  if (!str) return new Set();
  return new Set(
    str
      .toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // strip accents
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter(w => w && !STOPWORDS_PT.has(w) && w.length > 2)
  );
}

function jaccard(a, b) {
  const inter = new Set([...a].filter(x => b.has(x)));
  const uni = new Set([...a, ...b]);
  return uni.size ? inter.size / uni.size : 0;
}

function expSim(a, b, relScale = 0.08) {
  if (a == null || b == null) return 0;
  const M = Math.max(a, b);
  if (M === 0) return 0;
  const d = Math.abs(a - b);
  return Math.exp(- d / (relScale * M));
}

// ============================================================================
// LEGACY HELPERS (kept for compatibility)
// ============================================================================

function parseArea(areaStr) {
  return parseAreaM2(areaStr);
}

function parsePrice(priceStr) {
  return parsePriceBRL(priceStr);
}

// ============================================================================
// STEP 1: PRECOMPUTE NORMALIZED FIELDS
// ============================================================================

console.log('📊 STEP 1: Normalizing data and computing features...\n');

// Build normalized copies for VIVA
const vivaN = vivaData.listings.map(x => {
  const specs = x?.detailedData?.specs || {};
  const built = parseAreaM2(specs.area_construida);
  const lot = parseAreaM2(specs.area_total);
  const price = parsePriceBRL(x.price);
  const beds = normalizeInt(specs.dormitorios);
  const suites = normalizeInt(specs.suites);
  const baths = normalizeInt(specs.banheiros);
  const park = normalizeInt(specs.vagas);
  const text = (x?.detailedData?.description || "") + " " + (x?.title || "");
  return {
    raw: x,
    code: x.propertyCode,
    url: x.url,
    built, lot, price, beds, suites, baths, park,
    pricePerM2: built ? price / built : null,
    feats: tokenizeFeatures(text)
  };
});

// Build normalized copies for COELHO
const coelhoN = coelhoData.listings.map(x => {
  const built = parseAreaFromFeatures(x.features);
  const price = parsePriceBRL(x.price);
  const beds = normalizeInt(x.features?.match(/(\d+)\s*dorms?/i)?.[1]);
  const suites = normalizeInt(x.features?.match(/(\d+)\s*su[ií]tes?/i)?.[1]);
  const park = normalizeInt(x.features?.match(/(\d+)\s*vagas?/i)?.[1]);
  const baths = null; // rarely explicit in features
  return {
    raw: x,
    code: x.propertyCode,
    url: x.url,
    built, lot: null, price, beds, suites, baths, park,
    pricePerM2: built ? price / built : null,
    feats: tokenizeFeatures((x.description || "") + " " + (x.features || ""))
  };
});

console.log(`✓ Normalized ${vivaN.length} VIVA listings`);
console.log(`✓ Normalized ${coelhoN.length} COELHO listings\n`);

// ============================================================================
// STEP 2: MULTI-BLOCK INVERTED INDICES
// ============================================================================

console.log('📊 STEP 2: Building multi-block indices...\n');

// Rounders
const roundTo = (x, step) => (x == null ? null : Math.round(x / step) * step);

// Helper to add to map
function mapPush(map, key, val) {
  const k = JSON.stringify(key);
  if (!map.has(k)) map.set(k, []);
  map.get(k).push(val);
}

// Inverted indices: each block → key → array of indices
const idxA = new Map(); // (beds, suites, round(built,10))
const idxB = new Map(); // (beds, round(built,25), park)
const idxC = new Map(); // (beds, topFeat)
const idxP = new Map(); // price band index: round(pricePerM2, 1000)

coelhoN.forEach((r, i) => {
  // A: strong structural
  mapPush(idxA, [r.beds ?? -1, r.suites ?? -1, roundTo(r.built, 10)], i);

  // B: looser area + parking
  mapPush(idxB, [r.beds ?? -1, roundTo(r.built, 25), r.park ?? -1], i);

  // C: features
  const topFeat = [...r.feats].slice(0, 1); // a single "signature" token
  mapPush(idxC, [r.beds ?? -1, topFeat[0] || ""], i);

  // P: price per m² band
  mapPush(idxP, [roundTo(r.pricePerM2 ?? -1, 1000)], i);
});

console.log(`✓ Created ${idxA.size} blocks in Index A (structural)`);
console.log(`✓ Created ${idxB.size} blocks in Index B (area+parking)`);
console.log(`✓ Created ${idxC.size} blocks in Index C (features)`);
console.log(`✓ Created ${idxP.size} blocks in Index P (price/m²)\n`);

// ============================================================================
// CANDIDATE GATHERING (union across blocks)
// ============================================================================

function gatherCandidates(v) {
  const cand = new Set();

  // A: strict structural neighbors
  const aKeys = [
    [v.beds ?? -1, v.suites ?? -1, roundTo(v.built, 10)],
    [v.beds ?? -1, v.suites ?? -1, roundTo((v.built ?? 0) + 10, 10)],
    [v.beds ?? -1, v.suites ?? -1, roundTo((v.built ?? 0) - 10, 10)]
  ];
  aKeys.forEach(k => (idxA.get(JSON.stringify(k)) || []).forEach(i => cand.add(i)));

  // B: looser area + parking neighbors
  const bKeys = [
    [v.beds ?? -1, roundTo(v.built, 25), v.park ?? -1],
    [v.beds ?? -1, roundTo((v.built ?? 0) + 25, 25), v.park ?? -1],
    [v.beds ?? -1, roundTo((v.built ?? 0) - 25, 25), v.park ?? -1]
  ];
  bKeys.forEach(k => (idxB.get(JSON.stringify(k)) || []).forEach(i => cand.add(i)));

  // C: features signature
  const sig = [...v.feats][0] || "";
  const cKey = [v.beds ?? -1, sig];
  (idxC.get(JSON.stringify(cKey)) || []).forEach(i => cand.add(i));

  // P: price per m² band neighbors (if available)
  if (v.pricePerM2 != null) {
    const pKeys = [
      [roundTo(v.pricePerM2, 1000)],
      [roundTo(v.pricePerM2 * 1.1, 1000)],
      [roundTo(v.pricePerM2 * 0.9, 1000)]
    ];
    pKeys.forEach(k => (idxP.get(JSON.stringify(k)) || []).forEach(i => cand.add(i)));
  }

  return [...cand];
}

// ============================================================================
// COMPOSITE SCORING
// ============================================================================

function scorePair(v, c) {
  // numeric sims (0..1)
  const sBuilt = expSim(v.built, c.built, 0.06);           // tighter on m²
  const sLot   = expSim(v.lot, c.lot, 0.10);               // often missing; harmless
  const sPpm2  = expSim(v.pricePerM2, c.pricePerM2, 0.12);
  const sBeds  = (v.beds != null && c.beds != null) ? (v.beds === c.beds ? 1 : Math.abs(v.beds - c.beds) === 1 ? 0.6 : 0) : 0.4;
  const sSuite = (v.suites != null && c.suites != null) ? (v.suites === c.suites ? 1 : Math.abs(v.suites - c.suites) === 1 ? 0.6 : 0) : 0.4;
  const sPark  = (v.park != null && c.park != null) ? (v.park === c.park ? 1 : Math.abs(v.park - c.park) === 1 ? 0.6 : 0) : 0.4;
  const sFeat  = jaccard(v.feats, c.feats);

  // weights (sum ~1.0) - redistributed lot weight to built and ppm2 since Coelho lacks lot
  const W = {
    built: 0.25,  // increased from 0.22
    lot:   0.03,  // reduced from 0.08 (Coelho doesn't have this)
    ppm2:  0.21,  // increased from 0.18
    beds:  0.10,
    suite: 0.08,
    park:  0.06,
    feat:  0.27   // slight adjustment
  };

  const score =
    W.built * sBuilt +
    W.lot   * sLot +
    W.ppm2  * sPpm2 +
    W.beds  * sBeds +
    W.suite * sSuite +
    W.park  * sPark +
    W.feat  * sFeat;

  // sanity gates (reject clearly off) - tightened price threshold to 25%
  const hardReject =
    (v.price != null && c.price != null && Math.abs(v.price - c.price) / ((v.price + c.price) / 2) > 0.25) ||
    (v.built != null && c.built != null && Math.abs(v.built - c.built) / Math.max(v.built, c.built) > 0.25 && sFeat < 0.3);

  return hardReject ? -1 : score;
}

// ============================================================================
// STEP 3: FIND CANDIDATES WITH TOP-K SCORING
// ============================================================================

console.log('🔍 STEP 3: Finding candidates using multi-block search + scoring...\n');

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

const K = 3; // Top-K candidates for AI

vivaN.forEach((v, idx) => {
  console.log(`[${idx + 1}/${vivaN.length}] Viva ${v.code}`);
  console.log(`  Area: ${v.built}m² | Price: R$ ${(v.price/1000000).toFixed(1)}M | ${v.beds}d/${v.suites}s`);

  if (!v.built) {
    console.log(`  ⚠️  No area data - skipping\n`);
    skipReasons.noArea++;
    skippedListings.noArea.push({
      code: v.code,
      price: v.raw.price,
      specs: v.raw.detailedData?.specs
    });
    return;
  }

  // 1) Gather candidates from all blocks
  const candidateIndices = gatherCandidates(v);
  console.log(`  Block search: ${candidateIndices.length} initial candidates`);

  if (candidateIndices.length === 0) {
    console.log(`  ✗ No candidates from any block\n`);
    skipReasons.noAreaMatches++;
    skippedListings.noAreaMatches.push({
      code: v.code,
      price: v.raw.price,
      area: v.built,
      specs: v.raw.detailedData?.specs
    });
    return;
  }

  // 2) Tighten with quick numeric tolerances
  const tightened = candidateIndices.filter(i => {
    const c = coelhoN[i];
    const areaOK = v.built == null || c.built == null || Math.abs(v.built - c.built) / Math.max(v.built, c.built) <= 0.18;
    const ppm2OK = v.pricePerM2 == null || c.pricePerM2 == null || Math.abs(v.pricePerM2 - c.pricePerM2) / Math.max(v.pricePerM2, c.pricePerM2) <= 0.30;
    return areaOK && ppm2OK;
  });
  console.log(`  After numeric filters: ${tightened.length} candidates`);

  // 3) Score & sort
  const scored = tightened
    .map(i => ({ i, s: scorePair(v, coelhoN[i]) }))
    .filter(x => x.s >= 0) // drop hard rejections
    .sort((a, b) => b.s - a.s);

  console.log(`  After scoring: ${scored.length} candidates (removed ${tightened.length - scored.length} hard rejects)`);

  if (scored.length === 0) {
    console.log(`  ✗ No strong candidates after scoring\n`);
    skipReasons.noStrongCandidates++;
    skippedListings.noStrongCandidates.push({
      code: v.code,
      price: v.raw.price,
      area: v.built,
      specs: v.raw.detailedData?.specs
    });
  } else {
    // 4) Pick Top-K for AI
    const top = scored.slice(0, K);
    const topScores = top.map(t => t.s.toFixed(3)).join(', ');
    console.log(`  ✓ Top ${top.length} candidates (scores: ${topScores}) → queuing for AI\n`);

    skipReasons.queued++;
    allCandidates.push({
      viva: v.raw,
      coelhoCandidates: top.map(t => coelhoN[t.i].raw),
      // Include scores for debugging
      _scored: top.map(t => ({ code: coelhoN[t.i].code, score: +t.s.toFixed(3) }))
    });
    totalFiltered += top.length;
  }
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
  approach: 'Multi-block indexing + Composite scoring + Top-K selection (v2)',
  total_viva_listings: vivaData.total_listings,
  listings_with_candidates: allCandidates.length,
  api_calls_made: allCandidates.length,
  api_calls_saved: vivaData.total_listings - allCandidates.length,
  total_matches: finalMatches.length,
  skip_reasons: skipReasons,
  skipped_details: skippedListings,
  matches: finalMatches.map(m => ({
    ...m,
    // Include deterministic scores if available (from _scored)
    candidateScores: allCandidates.find(c => c.viva.propertyCode === m.viva.code)?._scored
  }))
}, null, 2));

console.log(`💾 Saved to: ${outputFile}\n`);
})();

require('dotenv').config();
const { GoogleGenerativeAI } = require("@google/generative-ai");
const fs = require('fs');
const path = require('path');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite" });

// Load data
const vivaData = require('../data/vivaprimeimoveis/listings/all-listings.json');
const coelhoData = require('../data/coelhodafonseca/listings/all-listings.json');
const matchesData = require('../data/smart-matches.json');

console.log('\n👻 GHOST LISTING MATCHER - Finding missed matches using price-only filtering\n');

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function imageToBase64(imagePath) {
  const imageBuffer = fs.readFileSync(imagePath);
  return imageBuffer.toString('base64');
}

/**
 * RELAXED RECALL PROMPT - For finding ghost matches among previously unmatched listings
 * More permissive than the strict version to maximize recall
 */
function getGeometricPrompt(vivaCode, coelhoCode) {
  return `Task: You will receive two mosaic images (each a 2×3 or 3×3 grid of listing photos) representing two candidate properties from different websites. Decide whether both mosaics depict the same real-estate property.

RELAXED MATCHING MODE - Maximize recall for ghost matches

Use only exterior evidence. If a tile shows interiors, ignore it except when a distinct exterior reflection or view is visible through windows.

Do not narrate chain-of-thought. Return only short, observable evidence.

Prefer stable, structural cues that are unlikely to change between shoots: roofline geometry, façade materials, window grid pattern, balcony/railing shape, pool geometry/coping, driveway, fence/wall layout, staircases visible from outside, distinctive trees/landscaping, terrain slope, street poles/wires, gate/garage placement, lot shape.

Discount unstable cues: furniture, color grading, lens/crop differences, small plants, cars, weather, time of day, water color, watermark text.

RELAXED TOLERANCE: Be permissive with minor differences. Only reject on clear, irreconcilable contradictions (e.g., round pool vs rectangular lap pool, flat roof vs steep gabled roof, completely different lot layouts).

If exterior evidence is sparse, lean toward "possible match" when there are ANY strong structural anchors (pool shape, unique facade features, etc.).

Tile indexing (if needed): left→right, top→bottom (0-based).
Assume mosaics may mix interior/exterior tiles.

Inputs

imageA: VIVA ${vivaCode}

imageB: Coelho ${coelhoCode}

(You may be given more than two images in some calls. Only compare the first two.)

What to extract (feature checklist)

From the exterior tiles only, inspect and record:

Pool (if present): shape (rectangle/round/kidney/other), corners (right-angled vs rounded), approximate aspect ratio, coping material color, location in frame (e.g., bottom band), relation to house (parallel, offset), presence of spa/kiddie pool.

Façade & openings: window grid pattern (pane divisions), floor-to-ceiling glass vs framed windows, door positions, balcony style, railings, wood/stone/plaster mix, color tones (high-level only).

Roofline & massing: flat vs gabled, parapets, overhangs, multi-volume composition.

Hardscape & boundary: deck wood vs tile, driveway type, front wall/fence, gate/garage layout, steps/staircases visible from outside.

Site context: street slope, curb geometry, sidewalk, recurring poles/wires, distinctive trees/palms and spacing.

Camera geometry: repeated vantage angles (e.g., same façade shot angle), horizon/vanishing lines that align between sets.

Confusers: similar style but conflicting specifics (e.g., pool shape mismatch, window grid mismatch, different boundary walls).

Decision rubric (RELAXED FOR GHOST MATCHING)

Compute an internal similarity score (0–1) emphasizing exterior invariants:

Pool geometry & placement — 0.22 (slightly reduced to be more forgiving)

Window/grid & façade pattern — 0.20

Roofline/massing — 0.15

Boundary/hardscape layout — 0.15

Site/streetscape cues — 0.14

Vantage consistency (angles/lines) — 0.14

Confidence mapping (RELAXED):

>= 0.70 → match=true (high confidence)

0.55–0.69 → possible match, lean toward match=true (medium confidence)

0.40–0.54 → uncertain, default to match=false (low confidence)

< 0.40 → clear mismatch

If a single strong contradiction exists (e.g., round vs rectangular pool AND other features contradict, OR one has flat roof vs the other gabled AND facade contradicts), cap the final score at 0.40.

Output JSON schema
{
  "match": true,
  "confidence": 0.00,
  "score_breakdown": {
    "pool": 0.00,
    "facade_windows": 0.00,
    "roof_massing": 0.00,
    "boundary_hardscape": 0.00,
    "site_streetscape": 0.00,
    "vantage_consistency": 0.00
  },
  "exterior_tiles_used": {
    "A": [0,2,3],
    "B": [1,2,5]
  },
  "key_evidence": [
    "Short bullet evidence referencing exterior cues only (e.g., 'A[5] and B[2]: same round pool with stone coping ring; identical placement vs façade').",
    "…"
  ],
  "contradictions": [
    "List any strong conflicts. If none, return an empty array."
  ]
}


Notes:

match is true if exterior invariants align reasonably well (score >= 0.55 in relaxed mode) and no strong contradiction exists.

Keep key_evidence to 3–6 short bullets.

If there are no valid exterior tiles, set match=false, confidence<=0.4, explain briefly in contradictions.`;
}

async function compareMosaics(vivaCode, coelhoCode, retries = 2) {
  const vivaMosaicPath = path.join(process.cwd(), 'data', 'mosaics', 'viva', `${vivaCode}.png`);
  const coelhoMosaicPath = path.join(process.cwd(), 'data', 'mosaics', 'coelho', `${coelhoCode}.png`);

  if (!fs.existsSync(vivaMosaicPath) || !fs.existsSync(coelhoMosaicPath)) {
    return {
      match: false,
      confidence: 0,
      reason: 'Mosaic file(s) not found',
      error: true
    };
  }

  const vivaBase64 = imageToBase64(vivaMosaicPath);
  const coelhoBase64 = imageToBase64(coelhoMosaicPath);
  const prompt = getGeometricPrompt(vivaCode, coelhoCode);

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const result = await model.generateContent([
        prompt,
        { inlineData: { mimeType: 'image/png', data: vivaBase64 } },
        { inlineData: { mimeType: 'image/png', data: coelhoBase64 } }
      ]);

      const responseText = result.response.text();
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);

      if (!jsonMatch) {
        if (attempt < retries) {
          await new Promise(resolve => setTimeout(resolve, 2000));
          continue;
        }
        return { match: false, confidence: 0, reason: 'Failed to parse Gemini response', error: true };
      }

      const parsed = JSON.parse(jsonMatch[0]);
      return {
        match: parsed.decision?.match ?? parsed.match ?? false,
        confidence: parsed.decision?.confidence ?? parsed.confidence ?? 0,
        reason: parsed.reason || 'No reason provided',
        _full: parsed,
        error: false
      };
    } catch (error) {
      if ((error.message.includes('429') || error.message.includes('quota')) && attempt < retries) {
        console.log(`      Rate limit hit, waiting 30 seconds...`);
        await new Promise(resolve => setTimeout(resolve, 30000));
        continue;
      }
      if (attempt === retries) {
        return { match: false, confidence: 0, reason: `API error: ${error.message}`, error: true };
      }
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }
}

function parsePriceBRL(priceStr) {
  if (!priceStr) return null;
  const m = String(priceStr).match(/[\d\.,]+/);
  if (!m) return null;
  return parseFloat(m[0].replace(/\./g,'').replace(',', '.'));
}

// ============================================================================
// STEP 1: Identify unmatched listings
// ============================================================================

console.log('📊 STEP 1: Identifying unmatched listings...\n');

const matchedVivaCodes = new Set(matchesData.matches.map(m => m.viva.code));
const matchedCoelhoCodes = new Set(matchesData.matches.map(m => m.coelho.code));

const unmatchedViva = vivaData.listings.filter(listing => !matchedVivaCodes.has(listing.propertyCode));
const unmatchedCoelho = coelhoData.listings.filter(listing => !matchedCoelhoCodes.has(listing.propertyCode));

console.log(`✓ Unmatched VIVA listings: ${unmatchedViva.length}/${vivaData.total_listings}`);
console.log(`✓ Unmatched Coelho listings: ${unmatchedCoelho.length}/${coelhoData.total_listings}\n`);

// ============================================================================
// STEP 2: Build price-based candidates
// ============================================================================

console.log('📊 STEP 2: Building price-based candidate pairs (±10%)...\n');

const ghostCandidates = [];

unmatchedViva.forEach((vivaListing, idx) => {
  const vivaPrice = parsePriceBRL(vivaListing.price);

  if (!vivaPrice) {
    console.log(`[${idx + 1}/${unmatchedViva.length}] VIVA ${vivaListing.propertyCode} - No price, skipping`);
    return;
  }

  const priceMin = vivaPrice * 0.9;
  const priceMax = vivaPrice * 1.1;

  const candidates = unmatchedCoelho.filter(coelhoListing => {
    const coelhoPrice = parsePriceBRL(coelhoListing.price);
    if (!coelhoPrice) return false;
    return coelhoPrice >= priceMin && coelhoPrice <= priceMax;
  });

  if (candidates.length > 0) {
    console.log(`[${idx + 1}/${unmatchedViva.length}] VIVA ${vivaListing.propertyCode} - ${candidates.length} candidates in price range R$ ${(priceMin/1000000).toFixed(1)}M - ${(priceMax/1000000).toFixed(1)}M`);

    ghostCandidates.push({
      viva: vivaListing,
      coelhoCandidates: candidates
    });
  } else {
    console.log(`[${idx + 1}/${unmatchedViva.length}] VIVA ${vivaListing.propertyCode} - 0 candidates in price range`);
  }
});

const totalPairs = ghostCandidates.reduce((sum, item) => sum + item.coelhoCandidates.length, 0);

console.log(`\n✓ Found ${ghostCandidates.length} VIVA listings with ghost candidates`);
console.log(`✓ Total ghost pairs to test: ${totalPairs}\n`);

// ============================================================================
// STEP 3: Visual verification
// ============================================================================

(async () => {
  console.log('👻 STEP 3: Ghost listing visual verification...\n');

  const ghostMatches = [];
  const ghostRejected = [];
  const ghostErrors = [];

  let pairIndex = 0;

  for (const item of ghostCandidates) {
    const viva = item.viva;
    const candidates = item.coelhoCandidates;

    console.log(`\n📍 VIVA ${viva.propertyCode} - Testing ${candidates.length} ghost candidates...`);

    for (const coelho of candidates) {
      pairIndex++;
      console.log(`  [${pairIndex}/${totalPairs}] Testing VIVA ${viva.propertyCode} ↔ Coelho ${coelho.propertyCode}...`);

      const visualResult = await compareMosaics(viva.propertyCode, coelho.propertyCode);

      if (visualResult.error) {
        console.log(`    ⚠️  Visual verification error: ${visualResult.reason}`);
        ghostErrors.push({
          viva: {
            code: viva.propertyCode,
            url: viva.url,
            price: viva.price,
            specs: viva.detailedData?.specs
          },
          coelho: {
            code: coelho.propertyCode,
            url: coelho.url,
            price: coelho.price,
            features: coelho.features
          },
          visual_error: visualResult.reason
        });
      } else if (visualResult.match) {
        console.log(`    ✅ GHOST MATCH FOUND (${(visualResult.confidence * 100).toFixed(0)}%)`);
        console.log(`       ${visualResult.reason}`);
        ghostMatches.push({
          viva: {
            code: viva.propertyCode,
            url: viva.url,
            price: viva.price,
            specs: viva.detailedData?.specs
          },
          coelho: {
            code: coelho.propertyCode,
            url: coelho.url,
            price: coelho.price,
            features: coelho.features
          },
          visual_confidence: visualResult.confidence,
          visual_reason: visualResult.reason
        });
      } else {
        console.log(`    ❌ Not a match (${(visualResult.confidence * 100).toFixed(0)}%): ${visualResult.reason}`);
        ghostRejected.push({
          viva: {
            code: viva.propertyCode,
            url: viva.url,
            price: viva.price,
            specs: viva.detailedData?.specs
          },
          coelho: {
            code: coelho.propertyCode,
            url: coelho.url,
            price: coelho.price,
            features: coelho.features
          },
          visual_confidence: visualResult.confidence,
          visual_reason: visualResult.reason
        });
      }

      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  console.log(`\n═══════════════════════════════════════════════════════════════\n`);
  console.log(`👻 GHOST LISTING VERIFICATION COMPLETE\n`);
  console.log(`Total ghost pairs tested: ${totalPairs}`);
  console.log(`✅ Ghost matches found: ${ghostMatches.length}`);
  console.log(`❌ Rejected: ${ghostRejected.length}`);
  console.log(`⚠️  Errors: ${ghostErrors.length}\n`);

  // ============================================================================
  // STEP 4: Generate markdown report
  // ============================================================================

  console.log('📄 Generating markdown report...\n');

  let markdown = `# 👻 Ghost Listing Matches

This report shows potential matches found among previously unmatched listings using price-only filtering (±10%).

**Generated**: ${new Date().toISOString()}
**Approach**: Price-based ghost matching with comprehensive visual verification

---

## Summary

- **Unmatched VIVA listings tested**: ${unmatchedViva.length}
- **Unmatched Coelho listings available**: ${unmatchedCoelho.length}
- **Total ghost pairs tested**: ${totalPairs}
- **Ghost matches found**: ${ghostMatches.length}
- **Rejected pairs**: ${ghostRejected.length}
- **Errors**: ${ghostErrors.length}

---

`;

  if (ghostMatches.length > 0) {
    markdown += `## ✅ Ghost Matches Found (${ghostMatches.length})\n\n`;

    ghostMatches.sort((a, b) => b.visual_confidence - a.visual_confidence);

    ghostMatches.forEach((match, idx) => {
      markdown += `### ${idx + 1}. VIVA ${match.viva.code} ↔ Coelho ${match.coelho.code}\n\n`;
      markdown += `**Visual Confidence**: ${(match.visual_confidence * 100).toFixed(0)}%\n\n`;
      markdown += `**Reason**: ${match.visual_reason}\n\n`;

      markdown += `#### VIVA Listing\n`;
      markdown += `- **Code**: ${match.viva.code}\n`;
      markdown += `- **Price**: ${match.viva.price}\n`;
      markdown += `- **URL**: ${match.viva.url}\n`;
      if (match.viva.specs) {
        markdown += `- **Specs**:\n`;
        Object.entries(match.viva.specs).forEach(([key, value]) => {
          if (value) markdown += `  - ${key}: ${value}\n`;
        });
      }

      markdown += `\n#### Coelho Listing\n`;
      markdown += `- **Code**: ${match.coelho.code}\n`;
      markdown += `- **Price**: ${match.coelho.price}\n`;
      markdown += `- **URL**: ${match.coelho.url}\n`;
      markdown += `- **Features**: ${match.coelho.features || 'N/A'}\n`;

      markdown += `\n**Mosaic Comparison**:\n`;
      markdown += `- VIVA mosaic: \`data/mosaics/viva/${match.viva.code}.png\`\n`;
      markdown += `- Coelho mosaic: \`data/mosaics/coelho/${match.coelho.code}.png\`\n\n`;
      markdown += `---\n\n`;
    });
  } else {
    markdown += `## ✅ Ghost Matches Found\n\nNo ghost matches were found.\n\n`;
  }

  // Write markdown file
  const mdPath = path.join(__dirname, '..', 'GHOST-LISTING-MATCHES.md');
  fs.writeFileSync(mdPath, markdown);

  // Save JSON results
  const jsonPath = 'data/ghost-matches.json';
  fs.writeFileSync(jsonPath, JSON.stringify({
    generated_at: new Date().toISOString(),
    approach: 'Price-based ghost matching (±10%) with visual verification (relaxed prompt)',
    unmatched_viva_count: unmatchedViva.length,
    unmatched_coelho_count: unmatchedCoelho.length,
    total_ghost_pairs_tested: totalPairs,
    ghost_matches_found: ghostMatches.length,
    ghost_rejected: ghostRejected.length,
    ghost_errors: ghostErrors.length,
    matches: ghostMatches,
    rejected_pairs: ghostRejected,
    error_pairs: ghostErrors
  }, null, 2));

  console.log(`✅ Markdown report saved to: ${mdPath}`);
  console.log(`✅ JSON results saved to: ${jsonPath}\n`);
})();

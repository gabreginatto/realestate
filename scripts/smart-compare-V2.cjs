require('dotenv').config();
const { GoogleGenerativeAI } = require("@google/generative-ai");
const fs = require('fs');
const path = require('path');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite" });

// Load data
const vivaData = require('../data/vivaprimeimoveis/listings/all-listings.json');
const coelhoData = require('../data/coelhodafonseca/listings/all-listings.json');

console.log('\n🧠 SMART COMPARISON V8 (Denoised Features + Exact Price + Ratio Index + Proportional Gathering)\n');
console.log(`Vivaprimeimoveis: ${vivaData.total_listings} listings`);
console.log(`Coelho da Fonseca: ${coelhoData.total_listings} listings\n`);

// ============================================================================
// MOSAIC VISUAL VERIFICATION HELPERS
// ============================================================================

/**
 * Convert image file to base64
 */
function imageToBase64(imagePath) {
  const imageBuffer = fs.readFileSync(imagePath);
  return imageBuffer.toString('base64');
}

/**
 * Get comprehensive per-tile prompt for visual comparison
 */
function getGeometricPrompt(vivaCode, coelhoCode) {
  return `Task: You will receive two mosaic images (each a 2×3 or 3×3 grid of listing photos) representing two candidate properties from different websites. Decide whether both mosaics depict the same real-estate property.

Very important rules

Use only exterior evidence. If a tile shows interiors, ignore it except when a distinct exterior reflection or view is visible through windows.

Do not narrate chain-of-thought. Return only short, observable evidence.

Prefer stable, structural cues that are unlikely to change between shoots: roofline geometry, façade materials, window grid pattern, balcony/railing shape, pool geometry/coping, driveway, fence/wall layout, staircases visible from outside, distinctive trees/landscaping, terrain slope, street poles/wires, gate/garage placement, lot shape.

Discount unstable cues: furniture, color grading, lens/crop differences, small plants, cars, weather, time of day, water color, watermark text.

If exterior evidence is insufficient, return "match": false with low confidence and explain briefly.

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

Decision rubric

Compute an internal similarity score (0–1) emphasizing exterior invariants:

Pool geometry & placement — 0.25

Window/grid & façade pattern — 0.20

Roofline/massing — 0.15

Boundary/hardscape layout — 0.15

Site/streetscape cues — 0.15

Vantage consistency (angles/lines) — 0.10

Confidence mapping:

>= 0.85 → high

0.70–0.84 → medium

0.55–0.69 → low-medium

< 0.55 → low

If a single strong contradiction exists (e.g., round vs rectangular pool, one has flat roof vs the other gabled, front fence layout clearly different), cap the final score at 0.35.

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

match is true only if exterior invariants align and no strong contradiction exists.

Keep key_evidence to 3–6 short bullets.

If there are no valid exterior tiles, set match=false, confidence<=0.4, explain briefly in contradictions.`;
}

/**
 * Compare two mosaics using visual AI verification
 */
async function compareMosaics(vivaCode, coelhoCode, retries = 2) {
  const vivaMosaicPath = path.join(process.cwd(), 'data', 'mosaics', 'viva', `${vivaCode}.png`);
  const coelhoMosaicPath = path.join(process.cwd(), 'data', 'mosaics', 'coelho', `${coelhoCode}.png`);

  // Check if both mosaics exist
  if (!fs.existsSync(vivaMosaicPath) || !fs.existsSync(coelhoMosaicPath)) {
    return {
      match: false,
      confidence: 0,
      reason: 'Mosaic file(s) not found',
      error: true
    };
  }

  // Convert images to base64
  const vivaBase64 = imageToBase64(vivaMosaicPath);
  const coelhoBase64 = imageToBase64(coelhoMosaicPath);

  const prompt = getGeometricPrompt(vivaCode, coelhoCode);

  // Retry logic for API errors
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const result = await model.generateContent([
        prompt,
        {
          inlineData: {
            mimeType: 'image/png',
            data: vivaBase64
          }
        },
        {
          inlineData: {
            mimeType: 'image/png',
            data: coelhoBase64
          }
        }
      ]);

      const responseText = result.response.text();

      // Extract JSON from response
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        if (attempt < retries) {
          await new Promise(resolve => setTimeout(resolve, 2000));
          continue;
        }
        return {
          match: false,
          confidence: 0,
          reason: 'Failed to parse Gemini response',
          error: true
        };
      }

      const parsed = JSON.parse(jsonMatch[0]);

      // Flatten the decision object to root level for compatibility
      return {
        match: parsed.decision?.match ?? parsed.match ?? false,
        confidence: parsed.decision?.confidence ?? parsed.confidence ?? 0,
        reason: parsed.reason || 'No reason provided',
        // Keep the full parsed response for debugging
        _full: parsed,
        error: false
      };

    } catch (error) {
      // If rate limit, wait longer
      if ((error.message.includes('429') || error.message.includes('quota')) && attempt < retries) {
        console.log(`      Rate limit hit, waiting 30 seconds...`);
        await new Promise(resolve => setTimeout(resolve, 30000));
        continue;
      }

      // If last attempt, return error
      if (attempt === retries) {
        return {
          match: false,
          confidence: 0,
          reason: `API error: ${error.message}`,
          error: true
        };
      }

      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }
}

// ============================================================================
// BROKER-SPEAK STOP-LIST (V8 IMPROVEMENT #1)
// ============================================================================

const BROKER_SPEAK = new Set([
  // Generic marketing
  'excelente oportunidade', 'oportunidade única', 'não perca', 'imperdível',
  'agende sua visita', 'agende visita', 'entre em contato', 'fale conosco',
  'fale com nosso corretor', 'ligue agora', 'whatsapp',

  // Location fluff
  'excelente localização', 'ótima localização', 'localização privilegiada',
  'localização nobre', 'região nobre', 'bairro nobre',

  // Generic descriptors
  'imóvel de alto padrão', 'alto padrão', 'luxo', 'sofisticação',
  'acabamento de primeira', 'fino acabamento', 'acabamento impecável',
  'projeto moderno', 'arquitetura moderna', 'design contemporâneo',

  // Condition
  'em perfeito estado', 'ótimo estado', 'excelente estado de conservação',
  'pronto para morar', 'pronta entrega',

  // Investment talk
  'ótimo investimento', 'valorização garantida', 'ótima rentabilidade',

  // Vague features
  'amplo espaço', 'muito espaçoso', 'ambientes amplos',
  'muita luz natural', 'bem iluminado', 'ventilação natural',

  // Call to action
  'consulte-nos', 'mais informações', 'entre em contato para mais detalhes',
  'visite já', 'confira', 'confira mais fotos'
]);

const STOPWORDS_PT = new Set("de,da,do,dos,das,em,para,com,um,uma,os,as,e,ou,a,o,no,na,por,entre,nos,nas,ao,aos,à,às,pelo,pela,pelos,pelas,num,numa,nuns,numas,que,é,são,foi,está,ser,ter,tem,mais,muito,muito,bem,casa,imovel,imóvel,propriedade,venda,alugar,comprar".split(","));

// ============================================================================
// STRUCTURED FEATURE EXTRACTION (V8 IMPROVEMENT #1)
// ============================================================================

/**
 * Extract boolean features from text (specific, structural keywords)
 */
function extractStructuredFeatures(text) {
  if (!text) return {};

  const lower = text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  return {
    has_pool: /piscina/.test(lower),
    has_heated_pool: /piscina\s+(aquecida|climatizada)/.test(lower),
    has_gourmet: /(espaco|área)\s+gourmet|churrasqueira/.test(lower),
    has_office: /(escritorio|home\s*office)/.test(lower),
    has_wine_cellar: /adega/.test(lower),
    has_sauna: /sauna/.test(lower),
    has_gym: /(academia|sala\s+de\s+ginastica)/.test(lower),
    has_cinema: /(sala\s+de\s+cinema|home\s*theater)/.test(lower),
    has_solar: /(energia\s+solar|fotovoltaic|placas?\s+solares?)/.test(lower),
    has_generator: /gerador/.test(lower),
    has_well: /(poco|poço)\s+artesiano/.test(lower),
    has_elevator: /elevador/.test(lower),
    has_high_ceiling: /(pe|pé).direito\s+(duplo|alto)/.test(lower),
    has_garden: /jardim/.test(lower),
    has_balcony: /(varanda|sacada)/.test(lower),
    has_terrace: /terraco/.test(lower),
    has_garage: /garagem/.test(lower),
    has_security: /(portaria|seguranca)\s+24/.test(lower)
  };
}

/**
 * Create a feature signature hash for indexing
 */
function featureSignature(features) {
  // Only use the most distinctive features for the index
  const key = [
    features.has_pool ? 'P' : '',
    features.has_heated_pool ? 'H' : '',
    features.has_gourmet ? 'G' : '',
    features.has_office ? 'O' : '',
    features.has_wine_cellar ? 'W' : '',
    features.has_sauna ? 'S' : '',
    features.has_gym ? 'Y' : '',
    features.has_solar ? 'L' : '',
    features.has_elevator ? 'E' : '',
    features.has_high_ceiling ? 'C' : ''
  ].join('');

  return key || 'NONE';
}

/**
 * Calculate feature similarity (Jaccard on boolean features)
 */
function featureSimilarity(f1, f2) {
  const keys = new Set([...Object.keys(f1), ...Object.keys(f2)]);
  let intersection = 0;
  let union = 0;

  for (const key of keys) {
    const v1 = f1[key] || false;
    const v2 = f2[key] || false;
    if (v1 || v2) union++;
    if (v1 && v2) intersection++;
  }

  return union > 0 ? intersection / union : 0;
}

// ============================================================================
// NORMALIZATION & DENOISING HELPERS (V8 IMPROVEMENT #1)
// ============================================================================

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
  const num = m[1];
  if (num.includes('.') && num.includes(',')) {
    return parseFloat(num.replace(/\./g, '').replace(',', '.'));
  }
  if (num.includes(',')) {
    return parseFloat(num.replace(',', '.'));
  }
  return parseFloat(num);
}

function parseAreaFromFeatures(featuresStr) {
  if (!featuresStr) return null;
  const m = featuresStr.match(/(\d+(?:[\.,]\d+)?)\s*m²\s*construída/i);
  if (!m) return null;
  const num = m[1];
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

/**
 * Denoise text by removing broker-speak and stopwords (V8 IMPROVEMENT #1)
 */
function denoiseText(str) {
  if (!str) return "";

  let text = str.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  // Remove broker-speak phrases (must happen before tokenization)
  for (const phrase of BROKER_SPEAK) {
    text = text.replace(new RegExp(phrase, 'g'), ' ');
  }

  // Tokenize and remove stopwords
  return text
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(w => w && !STOPWORDS_PT.has(w) && w.length > 2)
    .join(" ");
}

/**
 * Legacy tokenizer kept for compatibility
 */
function tokenizeFeatures(str) {
  if (!str) return new Set();
  return new Set(denoiseText(str).split(/\s+/).filter(Boolean));
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
// STEP 1: PRECOMPUTE NORMALIZED FIELDS (V8 IMPROVEMENTS)
// ============================================================================

console.log('📊 STEP 1: Normalizing data and extracting structured features...\n');

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
  const denoised = denoiseText(text);
  const structuredFeats = extractStructuredFeatures(text);

  return {
    raw: x,
    code: x.propertyCode,
    url: x.url,
    built, lot, price, beds, suites, baths, park,
    pricePerM2: built ? price / built : null,
    feats: tokenizeFeatures(text),
    denoisedText: denoised,
    structuredFeats,
    featSig: featureSignature(structuredFeats)
  };
});

// Build normalized copies for COELHO
const coelhoN = coelhoData.listings.map(x => {
  const built = parseAreaFromFeatures(x.features);
  const price = parsePriceBRL(x.price);
  const beds = normalizeInt(x.features?.match(/(\d+)\s*dorms?/i)?.[1]);
  const suites = normalizeInt(x.features?.match(/(\d+)\s*su[ií]tes?/i)?.[1]);
  const park = normalizeInt(x.features?.match(/(\d+)\s*vagas?/i)?.[1]);
  const baths = normalizeInt(x.features?.match(/(\d+)\s*banheiros?/i)?.[1]);

  const text = (x.description || "") + " " + (x.features || "");
  const denoised = denoiseText(text);
  const structuredFeats = extractStructuredFeatures(text);

  return {
    raw: x,
    code: x.propertyCode,
    url: x.url,
    built, lot: null, price, beds, suites, baths, park,
    pricePerM2: built ? price / built : null,
    feats: tokenizeFeatures(text),
    denoisedText: denoised,
    structuredFeats,
    featSig: featureSignature(structuredFeats)
  };
});

console.log(`✓ Normalized ${vivaN.length} VIVA listings`);
console.log(`✓ Normalized ${coelhoN.length} COELHO listings`);
console.log(`✓ Extracted structured features (pool, gourmet, office, etc.)`);
console.log(`✓ Denoised text (removed broker-speak)\n`);

// ============================================================================
// STEP 2: MULTI-BLOCK INVERTED INDICES (V8 IMPROVEMENTS)
// ============================================================================

console.log('📊 STEP 2: Building improved multi-block indices...\n');

// Rounders
const roundTo = (x, step) => (x == null ? null : Math.round(x / step) * step);

// Helper to add to map
function mapPush(map, key, val) {
  const k = JSON.stringify(key);
  if (!map.has(k)) map.set(k, []);
  map.get(k).push(val);
}

// Inverted indices
const idxA = new Map(); // (beds, suites, round(built,10)) - KEPT
const idxB = new Map(); // (beds, round(built,25), park) - KEPT
const idxC = new Map(); // (beds, featSig) - IMPROVED with structured features
const idxE = new Map(); // (price, round(built,20)) - NEW: Exact price index
const idxR = new Map(); // (beds_baths_ratio, built_lot_ratio) - NEW: Ratio index

coelhoN.forEach((r, i) => {
  // A: strong structural (unchanged)
  mapPush(idxA, [r.beds ?? -1, r.suites ?? -1, roundTo(r.built, 10)], i);

  // B: looser area + parking (unchanged)
  mapPush(idxB, [r.beds ?? -1, roundTo(r.built, 25), r.park ?? -1], i);

  // C: IMPROVED feature signature index
  mapPush(idxC, [r.beds ?? -1, r.featSig], i);

  // E: NEW exact price index (replacing old Index P)
  if (r.price != null && r.built != null) {
    mapPush(idxE, [r.price, roundTo(r.built, 20)], i);
  }

  // R: NEW ratio index
  const bedBathRatio = (r.beds != null && r.baths != null && r.baths > 0)
    ? roundTo(r.beds / r.baths, 0.5)
    : null;
  const builtLotRatio = (r.built != null && r.lot != null && r.lot > 0)
    ? roundTo(r.built / r.lot, 0.1)
    : null;

  if (bedBathRatio != null || builtLotRatio != null) {
    mapPush(idxR, [bedBathRatio ?? -1, builtLotRatio ?? -1], i);
  }
});

console.log(`✓ Index A (structural): ${idxA.size} blocks`);
console.log(`✓ Index B (area+parking): ${idxB.size} blocks`);
console.log(`✓ Index C (feature signature): ${idxC.size} blocks [IMPROVED]`);
console.log(`✓ Index E (exact price): ${idxE.size} blocks [NEW]`);
console.log(`✓ Index R (ratios): ${idxR.size} blocks [NEW]\n`);

// ============================================================================
// CANDIDATE GATHERING (V8 IMPROVEMENT #4: Proportional)
// ============================================================================

function gatherCandidates(v) {
  const cand = new Set();

  // A: strict structural neighbors (PROPORTIONAL ±8%)
  if (v.built != null) {
    const minBuilt = roundTo(v.built * 0.92, 10);
    const maxBuilt = roundTo(v.built * 1.08, 10);
    for (let b = minBuilt; b <= maxBuilt; b += 10) {
      const key = [v.beds ?? -1, v.suites ?? -1, b];
      (idxA.get(JSON.stringify(key)) || []).forEach(i => cand.add(i));
    }
  } else {
    // Fallback if no built area
    const aKeys = [
      [v.beds ?? -1, v.suites ?? -1, roundTo(v.built, 10)]
    ];
    aKeys.forEach(k => (idxA.get(JSON.stringify(k)) || []).forEach(i => cand.add(i)));
  }

  // B: looser area + parking neighbors (PROPORTIONAL ±8%)
  if (v.built != null) {
    const minBuilt = roundTo(v.built * 0.92, 25);
    const maxBuilt = roundTo(v.built * 1.08, 25);
    for (let b = minBuilt; b <= maxBuilt; b += 25) {
      const key = [v.beds ?? -1, b, v.park ?? -1];
      (idxB.get(JSON.stringify(key)) || []).forEach(i => cand.add(i));
    }
  } else {
    const bKeys = [
      [v.beds ?? -1, roundTo(v.built, 25), v.park ?? -1]
    ];
    bKeys.forEach(k => (idxB.get(JSON.stringify(k)) || []).forEach(i => cand.add(i)));
  }

  // C: IMPROVED feature signature
  const cKey = [v.beds ?? -1, v.featSig];
  (idxC.get(JSON.stringify(cKey)) || []).forEach(i => cand.add(i));

  // E: NEW exact price index (±0.1% price variation)
  if (v.price != null && v.built != null) {
    const priceVariations = [
      v.price,
      Math.round(v.price * 1.001),
      Math.round(v.price * 0.999)
    ];
    const builtVariations = [
      roundTo(v.built, 20),
      roundTo(v.built * 1.02, 20),
      roundTo(v.built * 0.98, 20)
    ];

    for (const p of priceVariations) {
      for (const b of builtVariations) {
        const key = [p, b];
        (idxE.get(JSON.stringify(key)) || []).forEach(i => cand.add(i));
      }
    }
  }

  // R: NEW ratio index
  const bedBathRatio = (v.beds != null && v.baths != null && v.baths > 0)
    ? roundTo(v.beds / v.baths, 0.5)
    : null;
  const builtLotRatio = (v.built != null && v.lot != null && v.lot > 0)
    ? roundTo(v.built / v.lot, 0.1)
    : null;

  if (bedBathRatio != null || builtLotRatio != null) {
    // Search nearby ratios
    const ratioKeys = [
      [bedBathRatio ?? -1, builtLotRatio ?? -1],
      [bedBathRatio != null ? bedBathRatio + 0.5 : -1, builtLotRatio ?? -1],
      [bedBathRatio != null ? bedBathRatio - 0.5 : -1, builtLotRatio ?? -1]
    ];
    ratioKeys.forEach(k => (idxR.get(JSON.stringify(k)) || []).forEach(i => cand.add(i)));
  }

  return [...cand];
}

// ============================================================================
// COMPOSITE SCORING (V8: Using structured features instead of Jaccard)
// ============================================================================

function scorePair(v, c) {
  // numeric sims (0..1)
  const sBuilt = expSim(v.built, c.built, 0.06);
  const sLot   = expSim(v.lot, c.lot, 0.10);
  const sPpm2  = expSim(v.pricePerM2, c.pricePerM2, 0.12);
  const sBeds  = (v.beds != null && c.beds != null) ? (v.beds === c.beds ? 1 : Math.abs(v.beds - c.beds) === 1 ? 0.6 : 0) : 0.4;
  const sSuite = (v.suites != null && c.suites != null) ? (v.suites === c.suites ? 1 : Math.abs(v.suites - c.suites) === 1 ? 0.6 : 0) : 0.4;
  const sPark  = (v.park != null && c.park != null) ? (v.park === c.park ? 1 : Math.abs(v.park - c.park) === 1 ? 0.6 : 0) : 0.4;

  // V8 IMPROVEMENT: Use structured feature similarity instead of random text
  const sFeat = featureSimilarity(v.structuredFeats, c.structuredFeats);

  // weights (sum ~1.0)
  const W = {
    built: 0.25,
    lot:   0.03,
    ppm2:  0.21,
    beds:  0.10,
    suite: 0.08,
    park:  0.06,
    feat:  0.27   // Now based on actual structural features!
  };

  const score =
    W.built * sBuilt +
    W.lot   * sLot +
    W.ppm2  * sPpm2 +
    W.beds  * sBeds +
    W.suite * sSuite +
    W.park  * sPark +
    W.feat  * sFeat;

  // sanity gates
  const hardReject =
    (v.price != null && c.price != null && Math.abs(v.price - c.price) / ((v.price + c.price) / 2) > 0.10) ||
    (v.built != null && c.built != null && Math.abs(v.built - c.built) / Math.max(v.built, c.built) > 0.08 && sFeat < 0.3);

  return hardReject ? -1 : score;
}

// ============================================================================
// STEP 3: FIND CANDIDATES WITH TOP-K SCORING
// ============================================================================

console.log('🔍 STEP 3: Finding candidates using improved indices + scoring...\n');

const allCandidates = [];
let totalFiltered = 0;

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
  console.log(`  Features: ${v.featSig}`);

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

  // 1) Gather candidates from all blocks (now with improved indices)
  const candidateIndices = gatherCandidates(v);
  console.log(`  Improved block search: ${candidateIndices.length} initial candidates`);

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

  // 2) Tighten with price-based adaptive tolerances
  const tightened = candidateIndices.filter(i => {
    const c = coelhoN[i];

    const priceDiff = (v.price != null && c.price != null)
      ? Math.abs(v.price - c.price) / Math.max(v.price, c.price)
      : null;

    // SPECIAL CASE: Price < 5% different
    if (priceDiff != null && priceDiff <= 0.05) {
      const builtDiff = (v.built != null && c.built != null)
        ? Math.abs(v.built - c.built) / Math.max(v.built, c.built)
        : null;
      const lotDiff = (v.lot != null && c.lot != null)
        ? Math.abs(v.lot - c.lot) / Math.max(v.lot, c.lot)
        : null;

      const atLeastOneAreaMatches =
        (builtDiff != null && builtDiff <= 0.08) ||
        (lotDiff != null && lotDiff <= 0.08);

      const bedsMatch = v.beds == null || c.beds == null || Math.abs(v.beds - c.beds) <= 1;
      const suitesMatch = v.suites == null || c.suites == null || Math.abs(v.suites - c.suites) <= 1;
      const parkMatch = v.park == null || c.park == null || Math.abs(v.park - c.park) <= 1;

      return atLeastOneAreaMatches && bedsMatch && suitesMatch && parkMatch;
    }

    // GENERAL CASE
    const priceOK = priceDiff == null || priceDiff <= 0.10;
    const areaTolerance = 0.08;
    const areaOK = v.built == null || c.built == null ||
      Math.abs(v.built - c.built) / Math.max(v.built, c.built) <= areaTolerance;

    return priceOK && areaOK;
  });
  console.log(`  After price/area filters: ${tightened.length} candidates`);

  // 3) Filter by suite count (±1)
  const suiteFiltered = tightened.filter(i => {
    const c = coelhoN[i];
    if (v.suites == null || c.suites == null) return true;
    return Math.abs(v.suites - c.suites) <= 1;
  });
  if (suiteFiltered.length < tightened.length) {
    console.log(`  After suite filter (±1): ${suiteFiltered.length} candidates`);
  }

  // 4) Score & sort
  const scored = suiteFiltered
    .map(i => ({ i, s: scorePair(v, coelhoN[i]) }))
    .filter(x => x.s >= 0)
    .sort((a, b) => b.s - a.s);

  console.log(`  After scoring: ${scored.length} candidates`);

  if (scored.length === 0) {
    console.log(`  ✗ No strong candidates\n`);
    skipReasons.noStrongCandidates++;
    skippedListings.noStrongCandidates.push({
      code: v.code,
      price: v.raw.price,
      area: v.built,
      specs: v.raw.detailedData?.specs
    });
  } else {
    // 5) Pick Top-K
    const top = scored.slice(0, K);
    const topScores = top.map(t => t.s.toFixed(3)).join(', ');
    console.log(`  ✓ Top ${top.length} candidates (scores: ${topScores}) → queuing for AI\n`);

    skipReasons.queued++;
    allCandidates.push({
      viva: v.raw,
      coelhoCandidates: top.map(t => coelhoN[t.i].raw),
      _scored: top.map(t => ({ code: coelhoN[t.i].code, score: +t.s.toFixed(3) }))
    });
    totalFiltered += top.length;
  }
});

console.log(`\n═══════════════════════════════════════════════════════════════\n`);
console.log(`📊 V8 Filter Summary:`);
console.log(`   Total Viva listings: ${vivaData.total_listings}`);
console.log(`   Listings with candidates: ${allCandidates.length}`);
console.log(`   Total candidates for AI: ${totalFiltered}`);
console.log(`   Avoided API calls: ${vivaData.total_listings - allCandidates.length}\n`);

console.log(`📋 Detailed Breakdown:`);
console.log(`   ✓ Queued for AI: ${skipReasons.queued}`);
console.log(`   ✗ No area data: ${skipReasons.noArea}`);
console.log(`   ✗ No area matches: ${skipReasons.noAreaMatches}`);
console.log(`   ✗ Too many candidates: ${skipReasons.tooManyCandidates}`);
console.log(`   ✗ No strong candidates: ${skipReasons.noStrongCandidates}\n`);

// ============================================================================
// STEP 4: VISUAL MOSAIC VERIFICATION
// ============================================================================

(async () => {
console.log(`🖼️  STEP 4: Visual verification with mosaics...\n`);

const finalMatches = [];
const visualRejected = [];
const visualErrors = [];

const totalPairs = allCandidates.reduce((sum, item) => sum + item.coelhoCandidates.length, 0);
let pairIndex = 0;

for (const item of allCandidates) {
  const viva = item.viva;
  const candidates = item.coelhoCandidates;

  console.log(`\n📍 VIVA ${viva.propertyCode} - Testing ${candidates.length} candidates...`);

  for (let candidateIdx = 0; candidateIdx < candidates.length; candidateIdx++) {
    pairIndex++;
    const coelho = candidates[candidateIdx];
    const score = item._scored[candidateIdx];

    console.log(`  [${pairIndex}/${totalPairs}] Testing VIVA ${viva.propertyCode} ↔ Coelho ${coelho.propertyCode} (score: ${score.score})...`);

    const visualResult = await compareMosaics(viva.propertyCode, coelho.propertyCode);

    if (visualResult.error) {
      console.log(`    ⚠️  Visual verification error: ${visualResult.reason}`);
      visualErrors.push({
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
        deterministic_score: score.score,
        visual_error: visualResult.reason
      });
    } else if (visualResult.match) {
      console.log(`    ✅ VISUAL MATCH CONFIRMED (${(visualResult.confidence * 100).toFixed(0)}%)`);
      console.log(`       ${visualResult.reason}`);
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
        deterministic_score: score.score,
        visual_confidence: visualResult.confidence,
        visual_reason: visualResult.reason
      });
    } else {
      console.log(`    ❌ Not a match (${(visualResult.confidence * 100).toFixed(0)}%): ${visualResult.reason}`);
      visualRejected.push({
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
        deterministic_score: score.score,
        visual_confidence: visualResult.confidence,
        visual_reason: visualResult.reason
      });
    }

    await new Promise(resolve => setTimeout(resolve, 2000));
  }
}

console.log(`\n═══════════════════════════════════════════════════════════════\n`);
console.log(`📊 V8 VISUAL VERIFICATION COMPLETE\n`);
console.log(`Total pairs tested: ${totalPairs}`);
console.log(`✅ Matches found: ${finalMatches.length}`);
console.log(`❌ Rejected: ${visualRejected.length}`);
console.log(`⚠️  Errors: ${visualErrors.length}\n`);

console.log(`\n═══════════════════════════════════════════════════════════════\n`);
console.log(`🎯 FINAL RESULTS:\n`);
console.log(`Total matches found: ${finalMatches.length}\n`);

finalMatches.forEach(m => {
  console.log(`✓ 🖼️  Viva ${m.viva.code} ↔ Coelho ${m.coelho.code}`);
  console.log(`  Deterministic score: ${m.deterministic_score}`);
  console.log(`  Visual confidence: ${(m.visual_confidence * 100).toFixed(0)}%`);
  console.log(`  Visual reason: ${m.visual_reason}`);
  console.log(`  Viva: ${m.viva.price} - ${m.viva.url}`);
  console.log(`  Coelho: ${m.coelho.price} - ${m.coelho.url}\n`);
});

// Save results
const outputFile = 'data/smart-matches-v8.json';
fs.writeFileSync(outputFile, JSON.stringify({
  generated_at: new Date().toISOString(),
  approach: 'V8: Denoised features + Exact price index + Ratio index + Proportional gathering',
  total_viva_listings: vivaData.total_listings,
  listings_with_candidates: allCandidates.length,
  total_visual_api_calls: totalPairs,
  matches_found: finalMatches.length,
  visual_rejected: visualRejected.length,
  visual_errors: visualErrors.length,
  skip_reasons: skipReasons,
  skipped_details: skippedListings,
  rejected_pairs: visualRejected,
  error_pairs: visualErrors,
  matches: finalMatches
}, null, 2));

console.log(`💾 Saved to: ${outputFile}\n`);
console.log(`📊 V8 Improvements Applied:`);
console.log(`   ✓ Denoised text (removed broker-speak)`);
console.log(`   ✓ Structured feature extraction (pool, gourmet, etc.)`);
console.log(`   ✓ Feature signature index (Index C)`);
console.log(`   ✓ Exact price index (Index E, replaced Index P)`);
console.log(`   ✓ Ratio index (Index R)`);
console.log(`   ✓ Proportional candidate gathering (±8%)\n`);

console.log(`📊 Final Breakdown:`);
console.log(`   ✓ Matches: ${finalMatches.length}`);
console.log(`   ✗ Visual rejected: ${visualRejected.length}`);
console.log(`   ⚠️  Errors: ${visualErrors.length}`);
console.log(`   ✗ No candidates: ${skipReasons.noStrongCandidates}\n`);
})();

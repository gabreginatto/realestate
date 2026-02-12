const fs = require('fs');
const path = require('path');

// Load compound configuration
const COMPOUNDS = require('../config/compounds.json');
const compoundId = process.env.COMPOUND || COMPOUNDS.defaultCompound;
const compound = COMPOUNDS.compounds[compoundId];
if (!compound) {
  console.error(`Unknown compound: ${compoundId}. Available: ${Object.keys(COMPOUNDS.compounds).join(', ')}`);
  process.exit(1);
}
console.log(`Compound: ${compound.displayName} (${compoundId})\n`);

// Load data
const vivaData = require(`../data/${compoundId}/vivaprimeimoveis/listings/all-listings.json`);
const coelhoData = require(`../data/${compoundId}/coelhodafonseca/listings/all-listings.json`);

console.log('\n🧠 DETERMINISTIC MATCHER (No AI - Pure Algorithm)\n');
console.log(`Vivaprimeimoveis: ${vivaData.total_listings} listings`);
console.log(`Coelho da Fonseca: ${coelhoData.total_listings} listings\n`);

// ============================================================================
// BROKER-SPEAK STOP-LIST
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
// STRUCTURED FEATURE EXTRACTION
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
// NORMALIZATION & DENOISING HELPERS
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
 * Denoise text by removing broker-speak and stopwords
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
// STEP 1: PRECOMPUTE NORMALIZED FIELDS
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
// STEP 2: MULTI-BLOCK INVERTED INDICES
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
const idxA = new Map(); // (beds, suites, round(built,10))
const idxB = new Map(); // (beds, round(built,25), park)
const idxC = new Map(); // (beds, featSig)
const idxE = new Map(); // (price, round(built,20))
const idxR = new Map(); // (beds_baths_ratio, built_lot_ratio)

coelhoN.forEach((r, i) => {
  // A: strong structural
  mapPush(idxA, [r.beds ?? -1, r.suites ?? -1, roundTo(r.built, 10)], i);

  // B: looser area + parking
  mapPush(idxB, [r.beds ?? -1, roundTo(r.built, 25), r.park ?? -1], i);

  // C: feature signature index
  mapPush(idxC, [r.beds ?? -1, r.featSig], i);

  // E: exact price index
  if (r.price != null && r.built != null) {
    mapPush(idxE, [r.price, roundTo(r.built, 20)], i);
  }

  // R: ratio index
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
console.log(`✓ Index C (feature signature): ${idxC.size} blocks`);
console.log(`✓ Index E (exact price): ${idxE.size} blocks`);
console.log(`✓ Index R (ratios): ${idxR.size} blocks\n`);

// ============================================================================
// CANDIDATE GATHERING (Proportional)
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

  // C: feature signature
  const cKey = [v.beds ?? -1, v.featSig];
  (idxC.get(JSON.stringify(cKey)) || []).forEach(i => cand.add(i));

  // E: exact price index (±5% price variation)
  if (v.price != null && v.built != null) {
    const priceVariations = [
      v.price,
      Math.round(v.price * 1.05),  // +5%
      Math.round(v.price * 0.95)   // -5%
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

  // R: ratio index
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
// COMPOSITE SCORING (Using structured features)
// ============================================================================

function scorePair(v, c) {
  // numeric sims (0..1)
  const sBuilt = expSim(v.built, c.built, 0.06);
  const sLot   = expSim(v.lot, c.lot, 0.10);
  const sPpm2  = expSim(v.pricePerM2, c.pricePerM2, 0.12);
  const sBeds  = (v.beds != null && c.beds != null) ? (v.beds === c.beds ? 1 : Math.abs(v.beds - c.beds) === 1 ? 0.6 : 0) : 0.4;
  const sSuite = (v.suites != null && c.suites != null) ? (v.suites === c.suites ? 1 : Math.abs(v.suites - c.suites) === 1 ? 0.6 : 0) : 0.4;
  const sPark  = (v.park != null && c.park != null) ? (v.park === c.park ? 1 : Math.abs(v.park - c.park) === 1 ? 0.6 : 0) : 0.4;

  // Use structured feature similarity
  const sFeat = featureSimilarity(v.structuredFeats, c.structuredFeats);

  // weights (sum ~1.0)
  const W = {
    built: 0.25,
    lot:   0.03,
    ppm2:  0.21,
    beds:  0.10,
    suite: 0.08,
    park:  0.06,
    feat:  0.27
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
  noStrongCandidates: 0,
  queued: 0
};

const K = 3; // Top-K candidates

vivaN.forEach((v, idx) => {
  console.log(`[${idx + 1}/${vivaN.length}] Viva ${v.code}`);
  console.log(`  Area: ${v.built}m² | Price: R$ ${(v.price/1000000).toFixed(1)}M | ${v.beds}d/${v.suites}s`);
  console.log(`  Features: ${v.featSig}`);

  if (!v.built) {
    console.log(`  ⚠️  No area data - skipping\n`);
    skipReasons.noArea++;
    return;
  }

  // 1) Gather candidates from all blocks
  const candidateIndices = gatherCandidates(v);
  console.log(`  Block search: ${candidateIndices.length} initial candidates`);

  if (candidateIndices.length === 0) {
    console.log(`  ✗ No candidates from any block\n`);
    skipReasons.noAreaMatches++;
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
  } else {
    // 5) Pick Top-K
    const top = scored.slice(0, K);
    const topScores = top.map(t => t.s.toFixed(3)).join(', ');
    console.log(`  ✓ Top ${top.length} candidates (scores: ${topScores})\n`);

    skipReasons.queued++;
    allCandidates.push({
      viva: {
        code: v.code,
        url: v.url,
        price: v.raw.price,
        built: v.built,
        beds: v.beds,
        suites: v.suites,
        park: v.park,
        features: v.featSig
      },
      candidates: top.map(t => ({
        code: coelhoN[t.i].code,
        url: coelhoN[t.i].url,
        price: coelhoN[t.i].raw.price,
        built: coelhoN[t.i].built,
        beds: coelhoN[t.i].beds,
        suites: coelhoN[t.i].suites,
        park: coelhoN[t.i].park,
        features: coelhoN[t.i].featSig,
        score: +t.s.toFixed(3)
      }))
    });
    totalFiltered += top.length;
  }
});

console.log(`\n═══════════════════════════════════════════════════════════════\n`);
console.log(`📊 DETERMINISTIC MATCHING COMPLETE\n`);
console.log(`   Total Viva listings: ${vivaData.total_listings}`);
console.log(`   Listings with candidates: ${allCandidates.length}`);
console.log(`   Total candidate pairs: ${totalFiltered}\n`);

console.log(`📋 Breakdown:`);
console.log(`   ✓ Queued: ${skipReasons.queued}`);
console.log(`   ✗ No area data: ${skipReasons.noArea}`);
console.log(`   ✗ No area matches: ${skipReasons.noAreaMatches}`);
console.log(`   ✗ No strong candidates: ${skipReasons.noStrongCandidates}\n`);

// Save results
const outputFile = `data/${compoundId}/deterministic-matches.json`;
fs.writeFileSync(outputFile, JSON.stringify({
  generated_at: new Date().toISOString(),
  approach: 'Deterministic: Denoised features + Exact price index + Ratio index + Proportional gathering',
  total_viva_listings: vivaData.total_listings,
  listings_with_candidates: allCandidates.length,
  total_candidate_pairs: totalFiltered,
  skip_reasons: skipReasons,
  candidate_pairs: allCandidates
}, null, 2));

console.log(`💾 Saved to: ${outputFile}\n`);
console.log(`🎯 Next step: Use Human-in-the-Loop interface to review these ${totalFiltered} candidate pairs\n`);

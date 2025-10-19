require('dotenv').config();
const { GoogleGenerativeAI } = require("@google/generative-ai");
const fs = require('fs');
const path = require('path');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite" });

function imageToBase64(imagePath) {
  const imageBuffer = fs.readFileSync(imagePath);
  return imageBuffer.toString('base64');
}

function getGeometricPrompt(vivaCode, coelhoCode) {
  return `You are a real-estate photo matcher. Compare two 3×3 mosaics:
- Image A = VIVA ${vivaCode}
- Image B = Coelho ${coelhoCode}

EVALUATE ONLY EXTERIOR TILES. Ignore all interiors, décor, and color/finish differences.
If you are given lists of exterior tile indices, prioritize those tiles; otherwise infer which tiles are exterior.

For EACH exterior tile, extract these features (set to "unknown" if unclear):
  pool_shape ∈ {rectangle, L, T, circle, oval, kidney, none, unknown}
  corners_right ∈ {0..4, unknown}
  steps_location ∈ {none, inside-corner, side-mid, end, unknown}
  orientation_vs_house ∈ {parallel, perpendicular, angled, unknown}
  surround_geometry ∈ {straight_coping, raised_planter_wall, privacy_greenwall, glass_guardrail, pergola_beam, unknown}
  relative_position ∈ {between_house_and_wall, courtyard, corner_of_lot, rooftop, unknown}
  facade_window_pattern ∈ {matches, differs, unknown}           // window count/grouping/alignment on the pool-facing facade
  balcony_terrace_geometry ∈ {matches, differs, unknown}
  elevation_signs: {continuous_parapet_at_pool_edge: true|false,
                    adjacent_rooftops_same_height: true|false,
                    no_ground_around_pool: true|false}

AGGREGATION RULES (apply BEFORE scoring):
- Build an image-level aggregate for A and B by majority/consensus across their exterior tiles.
- Elevation: only label an image as "rooftop" if at least TWO elevation_signs are true for that image. If cues conflict, set elevation to "unknown". Do not infer rooftop solely from camera vantage point.

FEATURE EQUIVALENCE (A vs B):
- Produce a comparison summary with these labels:
  shape: same|different|unknown
  corners: same|similar|different|unknown          // "similar" = ±1 corner
  steps: same|different|unknown                    // treat occlusion as unknown
  orientation: same|different|unknown
  surround: same|different|unknown
  position: same|different|unknown
  facade_or_balcony: match|no_match|unknown        // "match" if facade_window_pattern or balcony_terrace_geometry is a strong match
  elevation_corroborated: same|different|unknown   // "same" or "different" only if corroborated per rules above

SCORING (computed by you; report values):
Use 1 for "same/match", 0.5 for "unknown/uncertain" (except elevation unknown = 0), 0 for "different".
Let:
  shape_score         = {same:1, different:0, unknown:0.5}
  corners_score       = {same:1, similar:1, different:0, unknown:0.5}
  orientation_score   = {same:1, different:0, unknown:0.5}
  surround_score      = {same:1, different:0, unknown:0.5}
  position_score      = {same:1, different:0, unknown:0.5}
  steps_score_soft    = {same:1, different:0.25, unknown:0.5}
  facade_balcony_score= {match:1, no_match:0, unknown:0.5}
  elevation_score     = {same:1, different:0, unknown:0}

Compute:
  S = 0.45*shape_score
    + 0.12*corners_score
    + 0.15*orientation_score
    + 0.16*surround_score
    + 0.07*position_score
    + 0.05*steps_score_soft
    + 0.05*facade_balcony_score
    + 0.05*elevation_score

MULTI-VIEW CONSISTENCY BONUS:
- If at least TWO distinct exterior tiles in each image independently support the same pool + facade cues, add +0.05 to S (cap at 1.0). Report whether this bonus was applied.

DECISION:
- match = true if S ≥ 0.72, else false.
- confidence = clamp(0.35 + 0.6*S (+0.05 if bonus applied), 0, 1).

OUTPUT JSON ONLY (no prose outside the JSON):
{
  "tiles": {
    "A": [
      {"idx": int, "isExterior": true|false,
       "pool_shape": "...", "corners_right": 0|1|2|3|4|"unknown",
       "steps_location": "...",
       "orientation_vs_house": "...",
       "surround_geometry": "...",
       "relative_position": "...",
       "facade_window_pattern": "matches|differs|unknown",
       "balcony_terrace_geometry": "matches|differs|unknown",
       "elevation_signs": {
         "continuous_parapet_at_pool_edge": true|false,
         "adjacent_rooftops_same_height": true|false,
         "no_ground_around_pool": true|false
       }
      }
      // ...one object per tile 0..8
    ],
    "B": [
      // same structure for Image B tiles
    ]
  },
  "aggregate": {
    "A": {
      "pool_shape": "...",
      "corners_right": 0|1|2|3|4|"unknown",
      "steps_location": "...",
      "orientation_vs_house": "...",
      "surround_geometry": "...",
      "relative_position": "...",
      "facade_window_pattern": "matches|differs|unknown",
      "balcony_terrace_geometry": "matches|differs|unknown",
      "elevation_context": "rooftop|ground_level_with_city_view|ground_level_no_view|split-level|unknown"
    },
    "B": {
      "pool_shape": "...",
      "corners_right": 0|1|2|3|4|"unknown",
      "steps_location": "...",
      "orientation_vs_house": "...",
      "surround_geometry": "...",
      "relative_position": "...",
      "facade_window_pattern": "matches|differs|unknown",
      "balcony_terrace_geometry": "matches|differs|unknown",
      "elevation_context": "rooftop|ground_level_with_city_view|ground_level_no_view|split-level|unknown"
    }
  },
  "feature_equivalence": {
    "shape": "same|different|unknown",
    "corners": "same|similar|different|unknown",
    "steps": "same|different|unknown",
    "orientation": "same|different|unknown",
    "surround": "same|different|unknown",
    "position": "same|different|unknown",
    "facade_or_balcony": "match|no_match|unknown",
    "elevation_corroborated": "same|different|unknown"
  },
  "scoring": {
    "shape_score": number,
    "corners_score": number,
    "orientation_score": number,
    "surround_score": number,
    "position_score": number,
    "steps_score_soft": number,
    "facade_balcony_score": number,
    "elevation_score": number,
    "multi_view_bonus": 0 or 0.05,
    "S": number
  },
  "decision": {
    "match": true|false,
    "confidence": number
  },
  "reason": "One or two sentences about pool geometry and fixed exterior cues that determined the outcome."
}`;
}

(async () => {
  const vivaCode = '4657';
  const coelhoCode = '429709';

  const vivaMosaicPath = path.join(process.cwd(), 'data', 'mosaics', 'viva', `${vivaCode}.png`);
  const coelhoMosaicPath = path.join(process.cwd(), 'data', 'mosaics', 'coelho', `${coelhoCode}.png`);

  console.log('🖼️  Testing NEW POOL-FOCUSED prompt');
  console.log('   VIVA 4657 ↔ Coelho 429709');
  console.log('='.repeat(70));
  console.log('');

  const vivaBase64 = imageToBase64(vivaMosaicPath);
  const coelhoBase64 = imageToBase64(coelhoMosaicPath);

  const prompt = getGeometricPrompt(vivaCode, coelhoCode);

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

  console.log('EXACT GEMINI API RESPONSE:');
  console.log('='.repeat(70));
  console.log(responseText);
  console.log('='.repeat(70));
})();

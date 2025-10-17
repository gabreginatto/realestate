require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite' });

/**
 * Convert image file to base64
 */
function imageToBase64(imagePath) {
  const imageBuffer = fs.readFileSync(imagePath);
  return imageBuffer.toString('base64');
}

/**
 * IMPROVED PROMPT - Focus on geometric shapes and structural features
 */
function getImprovedPrompt(vivaCode, coelhoCode) {
  return `You are a real estate property comparison expert. I am showing you two photo mosaics (3x2 grids of 6 photos each) of two properties listed on different real estate websites.

Your task: Determine if these two mosaics show THE SAME PROPERTY or DIFFERENT PROPERTIES.

IMAGE 1: Property mosaic from VIVA Prime Imóveis (code: ${vivaCode})
IMAGE 2: Property mosaic from Coelho da Fonseca (code: ${coelhoCode})

CRITICAL: Focus on GEOMETRIC SHAPES and STRUCTURAL FEATURES, NOT surface details like colors or materials.

Look for these SHAPE-BASED features:

1. **POOL SHAPE & LAYOUT**:
   - What is the exact SHAPE of the pool? (rectangular, L-shaped, circular, kidney-shaped, etc.)
   - What is the pool's POSITION relative to the house?
   - What SURROUNDS the pool? (deck shape, patio layout, grass areas)
   - Are there STEPS or LEDGES within the pool? Where are they positioned?

2. **ARCHITECTURAL GEOMETRY**:
   - What is the SHAPE of the roof? (flat, gabled, hipped, multi-level)
   - What is the LAYOUT of windows? (count, positioning, grouping patterns)
   - What is the SHAPE of doors, archways, or entryways?
   - Are there BALCONIES or TERRACES? What are their shapes and positions?

3. **DISTINCTIVE STRUCTURAL FEATURES**:
   - STAIRCASE SHAPE: Internal or external stairs - what is their shape, direction, railing pattern?
   - COLUMNS or PILLARS: Where are they? What shape?
   - OUTDOOR STRUCTURES: Pergolas, gazebos, outdoor kitchens - what are their shapes?
   - COURTYARD or PATIO: What is the layout pattern?

4. **SPATIAL RELATIONSHIPS**:
   - How is the pool positioned relative to the house entrance?
   - What is the LAYOUT of the backyard/outdoor area?
   - Where are outdoor living areas positioned relative to the pool?

IGNORE these surface-level details:
- ❌ Paint colors or wall finishes (white vs beige, red brick vs painted)
- ❌ Tile colors in pools (blue vs white tiles)
- ❌ Furniture colors or styles
- ❌ Landscaping colors (different plants, grass vs gravel)
- ❌ Interior decoration or finishes

FOCUS on these structural matches:
- ✅ Pool has the SAME SHAPE (even if tile color differs)
- ✅ Stairs have the SAME GEOMETRY (even if material/color differs)
- ✅ Windows are in the SAME POSITIONS (even if frame color differs)
- ✅ Outdoor structures have the SAME LAYOUT (even if furniture/decor differs)

EXAMPLE:
- If both have an L-shaped pool with stairs on the left side, surrounded by a wooden deck on one side and grass on the other → LIKELY SAME PROPERTY
- If both have a spiral staircase in the same corner of the living room → LIKELY SAME PROPERTY
- If one has a rectangular pool and the other has a circular pool → DIFFERENT PROPERTIES

Respond in JSON format:
{
  "match": true/false,
  "confidence": 0.0-1.0,
  "reason": "Brief explanation focusing on GEOMETRIC comparisons (2-3 sentences)",
  "geometric_features_analyzed": {
    "pool_shape": "description of pool geometry",
    "staircase_geometry": "description of staircase shape/position if visible",
    "architectural_layout": "description of building geometry",
    "spatial_relationships": "description of how elements are positioned relative to each other"
  },
  "key_matching_shapes": ["list of specific geometric features that match"] or null if no match
}

Be LESS strict than before. If the GEOMETRIC SHAPES match, consider it the same property even if colors/materials differ.`;
}

/**
 * Compare two mosaics with improved prompt and retry logic
 */
async function compareMosaicsImproved(vivaCode, coelhoCode, retries = 3) {
  const vivaMosaicPath = path.join(process.cwd(), 'data', 'mosaics', 'viva', `${vivaCode}.png`);
  const coelhoMosaicPath = path.join(process.cwd(), 'data', 'mosaics', 'coelho', `${coelhoCode}.png`);

  // Check if both mosaics exist
  if (!fs.existsSync(vivaMosaicPath)) {
    return {
      match: false,
      confidence: 0,
      reason: `VIVA mosaic not found for property ${vivaCode}`,
      error: true
    };
  }

  if (!fs.existsSync(coelhoMosaicPath)) {
    return {
      match: false,
      confidence: 0,
      reason: `Coelho mosaic not found for property ${coelhoCode}`,
      error: true
    };
  }

  // Convert images to base64
  const vivaBase64 = imageToBase64(vivaMosaicPath);
  const coelhoBase64 = imageToBase64(coelhoMosaicPath);

  const prompt = getImprovedPrompt(vivaCode, coelhoCode);

  // Retry logic for API errors
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`      Attempt ${attempt}/${retries}...`);

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
        console.error(`      Failed to parse JSON from Gemini response`);
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
      return {
        ...parsed,
        error: false
      };

    } catch (error) {
      console.error(`      Error on attempt ${attempt}: ${error.message}`);

      // If rate limit, wait longer
      if (error.message.includes('429') || error.message.includes('quota')) {
        if (attempt < retries) {
          console.log(`      Rate limit hit, waiting 60 seconds before retry...`);
          await new Promise(resolve => setTimeout(resolve, 60000));
          continue;
        }
      }

      // If last attempt, return error
      if (attempt === retries) {
        return {
          match: false,
          confidence: 0,
          reason: `API error after ${retries} attempts: ${error.message}`,
          error: true
        };
      }

      // Wait before retry
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}

/**
 * Main revalidation function
 */
async function revalidatePairs() {
  console.log('============================================================');
  console.log('🔄 RE-VALIDATING REJECTED PAIRS WITH IMPROVED PROMPT');
  console.log('============================================================\n');

  // Pairs to revalidate (identified by user as potentially incorrect rejections)
  const pairsToRevalidate = [
    { viva: '12252', coelho: '681867', issue: 'Same pool format (colonial vs modern facade)' },
    { viva: '16117', coelho: '628299', issue: 'Same pool with grass and tiles around it' },
    { viva: '7597', coelho: '358601', issue: 'API error - need to retry' },
    { viva: '6930', coelho: '395513', issue: 'Staircase is the same in both' },
    // Also revalidate other rejected pairs to see if improved prompt helps
    { viva: '17266', coelho: '422399', issue: 'Different architectural styles claimed' },
    { viva: '14138', coelho: '352803', issue: 'Different designs claimed' },
    { viva: '14502', coelho: '671661', issue: 'Different finishes claimed' },
    { viva: '9624', coelho: '670241', issue: 'Photos vs renderings claimed' }
  ];

  console.log(`📊 Total pairs to revalidate: ${pairsToRevalidate.length}\n`);

  const results = [];
  let nowMatch = 0;
  let stillRejected = 0;
  let errors = 0;

  for (let i = 0; i < pairsToRevalidate.length; i++) {
    const pair = pairsToRevalidate[i];

    console.log(`[${i + 1}/${pairsToRevalidate.length}] VIVA ${pair.viva} ↔ Coelho ${pair.coelho}`);
    console.log(`   Issue: ${pair.issue}`);

    const comparison = await compareMosaicsImproved(pair.viva, pair.coelho);

    if (comparison.error) {
      console.log(`   ⚠️  ERROR: ${comparison.reason}\n`);
      errors++;
    } else if (comparison.match) {
      console.log(`   ✅ NOW MATCHES (${(comparison.confidence * 100).toFixed(0)}% confidence)`);
      console.log(`   Reason: ${comparison.reason}`);
      if (comparison.key_matching_shapes) {
        console.log(`   Matching shapes: ${comparison.key_matching_shapes.join(', ')}`);
      }
      console.log();
      nowMatch++;
    } else {
      console.log(`   ❌ STILL REJECTED (${(comparison.confidence * 100).toFixed(0)}% confidence)`);
      console.log(`   Reason: ${comparison.reason}\n`);
      stillRejected++;
    }

    results.push({
      viva_code: pair.viva,
      coelho_code: pair.coelho,
      original_issue: pair.issue,
      new_assessment: comparison
    });

    // Rate limiting: wait between requests
    if (i < pairsToRevalidate.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }

  console.log('\n============================================================');
  console.log('📊 RE-VALIDATION SUMMARY');
  console.log('============================================================');
  console.log(`Total pairs revalidated: ${pairsToRevalidate.length}`);
  console.log(`✅ Now matches (were rejected before): ${nowMatch}`);
  console.log(`❌ Still rejected: ${stillRejected}`);
  console.log(`⚠️  Errors: ${errors}`);
  console.log('============================================================\n');

  // Save results
  const outputPath = path.join(process.cwd(), 'data', 'revalidation-results.json');
  const output = {
    generated_at: new Date().toISOString(),
    approach: 'Geometric shape-focused prompt with retry logic',
    total_revalidated: pairsToRevalidate.length,
    now_matches: nowMatch,
    still_rejected: stillRejected,
    errors: errors,
    results: results
  };

  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`💾 Results saved to: ${outputPath}\n`);

  // Print newly matched pairs
  if (nowMatch > 0) {
    console.log('🎉 NEWLY MATCHED PAIRS (were rejected before):');
    console.log('============================================================');
    results.forEach((r, idx) => {
      if (!r.new_assessment.error && r.new_assessment.match) {
        console.log(`\n${idx + 1}. VIVA ${r.viva_code} ↔ Coelho ${r.coelho_code}`);
        console.log(`   Original issue: ${r.original_issue}`);
        console.log(`   New confidence: ${(r.new_assessment.confidence * 100).toFixed(0)}%`);
        console.log(`   Reason: ${r.new_assessment.reason}`);
        if (r.new_assessment.key_matching_shapes) {
          console.log(`   Matching shapes: ${r.new_assessment.key_matching_shapes.join(', ')}`);
        }
      }
    });
  }
}

// Run revalidation
revalidatePairs().catch(console.error);

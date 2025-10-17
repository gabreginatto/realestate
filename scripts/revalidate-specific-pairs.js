require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

/**
 * Convert image file to base64
 */
function imageToBase64(imagePath) {
  const imageBuffer = fs.readFileSync(imagePath);
  return imageBuffer.toString('base64');
}

/**
 * Improved prompt focusing on structural features
 */
const IMPROVED_PROMPT = `You are a real estate property comparison expert. I am showing you two photo mosaics (3x2 grids of 6 photos each) of two properties listed on different real estate websites.

Your task: Determine if these two mosaics show THE SAME PROPERTY or DIFFERENT PROPERTIES.

IMAGE 1: Property mosaic from VIVA Prime Imóveis (code: {vivaCode})
IMAGE 2: Property mosaic from Coelho da Fonseca (code: {coelhoCode})

CRITICAL INSTRUCTIONS - Focus on STRUCTURAL and ARCHITECTURAL features:

1. **POOL SHAPE & POSITION**: Compare the exact geometric shape of the pool (circular, rectangular, irregular, L-shaped, etc.) and its position relative to the house. Pool tile colors or furniture can differ, but the SHAPE should be identical.

2. **ARCHITECTURAL ELEMENTS**: Look for unique structural features:
   - Staircase design (spiral, straight, curved, materials)
   - Window arrangements and sizes
   - Roof style and angles
   - Building facade structure (not just color)
   - Balcony or terrace shapes
   - Archways or columns

3. **SPATIAL LAYOUT**: Compare how rooms and outdoor spaces are arranged relative to each other. The floor plan should match.

4. **DISTINCTIVE STRUCTURAL FEATURES**: Unique elements like:
   - Built-in furniture or shelving
   - Fireplace locations
   - Kitchen island shapes
   - Bathroom layouts

IGNORE these minor differences (properties can be the same even if these differ):
- ❌ Tile colors or patterns
- ❌ Wall paint colors
- ❌ Furniture styles or placement
- ❌ Landscaping or plants
- ❌ Decorative elements
- ❌ Lighting fixtures

THINK STEP BY STEP:
1. First, identify the pool shape in both images (if present)
2. Then, identify 2-3 unique structural features (stairs, windows, etc.)
3. Check if these structural features match
4. Make your decision based on structural similarities, not cosmetic ones

Respond in JSON format:
{
  "match": true/false,
  "confidence": 0.0-1.0,
  "reason": "Brief explanation focusing on structural features (2-3 sentences)",
  "pool_shape_match": "description of pool shape comparison or 'no pool visible'",
  "key_structural_features": ["list 2-3 structural features you compared"]
}

Remember: Properties can be the SAME even if they have different furniture, paint colors, or tile colors. Focus on the STRUCTURE and SHAPE of fixed architectural elements.`;

/**
 * Compare two mosaics using Gemini with improved prompt and retry logic
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

  const prompt = IMPROVED_PROMPT.replace('{vivaCode}', vivaCode).replace('{coelhoCode}', coelhoCode);

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
        console.error(`Failed to parse JSON from Gemini response for ${vivaCode} vs ${coelhoCode}`);
        console.error('Response:', responseText);
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
        error: false,
        attempt: attempt
      };

    } catch (error) {
      if (error.message.includes('429') && attempt < retries) {
        // Rate limit error - wait and retry
        const waitTime = 60; // 60 seconds
        console.log(`   ⏳ Rate limit hit. Waiting ${waitTime}s before retry ${attempt + 1}/${retries}...`);
        await new Promise(resolve => setTimeout(resolve, waitTime * 1000));
        continue;
      }

      console.error(`Error comparing mosaics for ${vivaCode} vs ${coelhoCode} (attempt ${attempt}/${retries}):`, error.message);

      if (attempt === retries) {
        return {
          match: false,
          confidence: 0,
          reason: `API error after ${retries} attempts: ${error.message}`,
          error: true
        };
      }
    }
  }
}

/**
 * Pairs to revalidate based on manual review
 */
const PAIRS_TO_REVALIDATE = [
  {
    viva: '12252',
    coelho: '681867',
    reason: 'User says pool format is the same, Gemini rejected'
  },
  {
    viva: '16117',
    coelho: '628299',
    reason: 'User says same pool with grass and tiles, Gemini rejected'
  },
  {
    viva: '7597',
    coelho: '358601',
    reason: 'API error - needs retry'
  },
  {
    viva: '6930',
    coelho: '395513',
    reason: 'User says staircase is the same, Gemini rejected'
  }
];

/**
 * Main revalidation function
 */
async function revalidatePairs() {
  console.log('============================================================');
  console.log('🔄 RE-VALIDATING PAIRS WITH IMPROVED PROMPT');
  console.log('============================================================\n');
  console.log(`📊 Total pairs to revalidate: ${PAIRS_TO_REVALIDATE.length}\n`);

  const results = [];

  for (let i = 0; i < PAIRS_TO_REVALIDATE.length; i++) {
    const pair = PAIRS_TO_REVALIDATE[i];

    console.log(`[${i + 1}/${PAIRS_TO_REVALIDATE.length}] Comparing VIVA ${pair.viva} ↔ Coelho ${pair.coelho}`);
    console.log(`   Original issue: ${pair.reason}`);

    const comparison = await compareMosaicsImproved(pair.viva, pair.coelho);

    if (comparison.error) {
      console.log(`   ❌ ERROR: ${comparison.reason}\n`);
    } else if (comparison.match) {
      console.log(`   ✅ NOW CONFIRMED as match (${(comparison.confidence * 100).toFixed(0)}% confidence)`);
      console.log(`   Pool shape: ${comparison.pool_shape_match || 'N/A'}`);
      console.log(`   Reason: ${comparison.reason}\n`);
    } else {
      console.log(`   ❌ STILL REJECTED (${(comparison.confidence * 100).toFixed(0)}% confidence)`);
      console.log(`   Pool shape: ${comparison.pool_shape_match || 'N/A'}`);
      console.log(`   Reason: ${comparison.reason}\n`);
    }

    results.push({
      viva: pair.viva,
      coelho: pair.coelho,
      original_issue: pair.reason,
      new_assessment: comparison
    });

    // Rate limiting: wait 3 seconds between API calls
    if (i < PAIRS_TO_REVALIDATE.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }

  // Summary
  const nowMatches = results.filter(r => !r.new_assessment.error && r.new_assessment.match).length;
  const stillRejected = results.filter(r => !r.new_assessment.error && !r.new_assessment.match).length;
  const errors = results.filter(r => r.new_assessment.error).length;

  console.log('\n============================================================');
  console.log('📊 REVALIDATION SUMMARY');
  console.log('============================================================');
  console.log(`Total pairs revalidated: ${PAIRS_TO_REVALIDATE.length}`);
  console.log(`✅ Now confirmed as matches: ${nowMatches}`);
  console.log(`❌ Still rejected: ${stillRejected}`);
  console.log(`⚠️  Errors: ${errors}`);
  console.log('============================================================\n');

  // Save results
  const outputPath = path.join(process.cwd(), 'data', 'revalidation-results.json');
  const output = {
    generated_at: new Date().toISOString(),
    improved_prompt_used: true,
    total_pairs: PAIRS_TO_REVALIDATE.length,
    now_matches: nowMatches,
    still_rejected: stillRejected,
    errors: errors,
    results: results
  };

  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`💾 Results saved to: ${outputPath}\n`);

  // Show changed results
  console.log('\n🔍 PAIRS THAT CHANGED STATUS:');
  console.log('============================================================');
  results.forEach((r, idx) => {
    if (!r.new_assessment.error && r.new_assessment.match) {
      console.log(`\n${idx + 1}. VIVA ${r.viva} ↔ Coelho ${r.coelho}`);
      console.log(`   Was: REJECTED`);
      console.log(`   Now: ✅ MATCH (${(r.new_assessment.confidence * 100).toFixed(0)}% confidence)`);
      console.log(`   Pool: ${r.new_assessment.pool_shape_match}`);
      console.log(`   Features: ${r.new_assessment.key_structural_features?.join(', ')}`);
      console.log(`   Reason: ${r.new_assessment.reason}`);
    }
  });
}

// Run revalidation
revalidatePairs().catch(console.error);

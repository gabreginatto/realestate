require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

/**
 * Load matches from smart-matches.json
 */
function loadMatches() {
  const matchesPath = path.join(process.cwd(), 'data', 'smart-matches.json');
  const data = JSON.parse(fs.readFileSync(matchesPath, 'utf-8'));
  return data.matches;
}

/**
 * Convert image file to base64
 */
function imageToBase64(imagePath) {
  const imageBuffer = fs.readFileSync(imagePath);
  return imageBuffer.toString('base64');
}

/**
 * Compare two mosaics using Gemini
 */
async function compareMosaics(vivaCode, coelhoCode) {
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

  const prompt = `You are a real estate property comparison expert. I am showing you two photo mosaics (3x2 grids of 6 photos each) of two properties listed on different real estate websites.

Your task: Determine if these two mosaics show THE SAME PROPERTY or DIFFERENT PROPERTIES.

IMAGE 1: Property mosaic from VIVA Prime Imóveis (code: ${vivaCode})
IMAGE 2: Property mosaic from Coelho da Fonseca (code: ${coelhoCode})

Look for:
1. **Architectural features**: Same building facade, windows, doors, roof style
2. **Interior design**: Same flooring, wall colors, kitchen/bathroom fixtures, ceiling design
3. **Distinctive features**: Pools, balconies, staircases, unique architectural elements
4. **Outdoor areas**: Gardens, patios, landscaping, external walls/fences

IMPORTANT:
- Properties in the same neighborhood may look similar but are NOT the same
- Focus on UNIQUE identifying features that prove these are the exact same property
- Even if rooms look similar, they could be different properties with similar design

Respond in JSON format:
{
  "match": true/false,
  "confidence": 0.0-1.0,
  "reason": "Brief explanation of your decision (2-3 sentences)",
  "distinctive_features": ["list of specific matching features if match=true, or key differences if match=false"]
}

Be critical and rigorous. Only mark as match=true if you are confident these are the SAME property.`;

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
      error: false
    };

  } catch (error) {
    console.error(`Error comparing mosaics for ${vivaCode} vs ${coelhoCode}:`, error.message);
    return {
      match: false,
      confidence: 0,
      reason: `API error: ${error.message}`,
      error: true
    };
  }
}

/**
 * Main validation function
 */
async function validateMatches() {
  console.log('============================================================');
  console.log('🔍 VALIDATING SPEC-BASED MATCHES WITH MOSAIC COMPARISON');
  console.log('============================================================\n');

  const matches = loadMatches();
  console.log(`📊 Total matches to validate: ${matches.length}\n`);

  const results = [];
  let confirmedMatches = 0;
  let rejectedMatches = 0;
  let errors = 0;

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const vivaCode = match.viva.code;
    const coelhoCode = match.coelho.code;
    const specConfidence = match.confidence;

    console.log(`[${i + 1}/${matches.length}] Comparing VIVA ${vivaCode} ↔ Coelho ${coelhoCode}`);
    console.log(`   Spec-based confidence: ${(specConfidence * 100).toFixed(0)}%`);

    const comparison = await compareMosaics(vivaCode, coelhoCode);

    if (comparison.error) {
      console.log(`   ❌ ERROR: ${comparison.reason}\n`);
      errors++;
    } else if (comparison.match) {
      console.log(`   ✅ CONFIRMED by mosaic (${(comparison.confidence * 100).toFixed(0)}% confidence)`);
      console.log(`   Reason: ${comparison.reason}\n`);
      confirmedMatches++;
    } else {
      console.log(`   ❌ REJECTED by mosaic (${(comparison.confidence * 100).toFixed(0)}% confidence)`);
      console.log(`   Reason: ${comparison.reason}\n`);
      rejectedMatches++;
    }

    results.push({
      viva: {
        code: vivaCode,
        url: match.viva.url,
        price: match.viva.price,
        specs: match.viva.specs
      },
      coelho: {
        code: coelhoCode,
        url: match.coelho.url,
        price: match.coelho.price,
        features: match.coelho.features
      },
      spec_based: {
        confidence: specConfidence,
        reason: match.reason
      },
      mosaic_verification: comparison
    });

    // Rate limiting: wait 2 seconds between API calls
    if (i < matches.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  console.log('\n============================================================');
  console.log('📊 VALIDATION SUMMARY');
  console.log('============================================================');
  console.log(`Total matches validated: ${matches.length}`);
  console.log(`✅ Confirmed by mosaic: ${confirmedMatches} (${((confirmedMatches / matches.length) * 100).toFixed(1)}%)`);
  console.log(`❌ Rejected by mosaic: ${rejectedMatches} (${((rejectedMatches / matches.length) * 100).toFixed(1)}%)`);
  console.log(`⚠️  Errors: ${errors}`);
  console.log('============================================================\n');

  // Save results
  const outputPath = path.join(process.cwd(), 'data', 'mosaic-validation-results.json');
  const output = {
    generated_at: new Date().toISOString(),
    total_matches: matches.length,
    confirmed_by_mosaic: confirmedMatches,
    rejected_by_mosaic: rejectedMatches,
    errors: errors,
    validation_rate: ((confirmedMatches / (matches.length - errors)) * 100).toFixed(1) + '%',
    results: results
  };

  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`💾 Results saved to: ${outputPath}\n`);

  // Print rejected matches for review
  if (rejectedMatches > 0) {
    console.log('\n🔍 REJECTED MATCHES (requires manual review):');
    console.log('============================================================');
    results.forEach((r, idx) => {
      if (!r.mosaic_verification.error && !r.mosaic_verification.match) {
        console.log(`\n${idx + 1}. VIVA ${r.viva.code} ↔ Coelho ${r.coelho.code}`);
        console.log(`   Spec confidence: ${(r.spec_based.confidence * 100).toFixed(0)}%`);
        console.log(`   Mosaic decision: ${r.mosaic_verification.reason}`);
        console.log(`   VIVA: ${r.viva.url}`);
        console.log(`   Coelho: ${r.coelho.url}`);
      }
    });
  }
}

// Run validation
validateMatches().catch(console.error);

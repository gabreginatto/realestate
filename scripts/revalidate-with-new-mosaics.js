require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

function imageToBase64(imagePath) {
  const imageBuffer = fs.readFileSync(imagePath);
  return imageBuffer.toString('base64');
}

const IMPROVED_PROMPT = `You are a real estate property comparison expert. I am showing you two photo mosaics (3x3 grids of 9 photos each) of two properties listed on different real estate websites.

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

async function compareMosaics(vivaCode, coelhoCode) {
  const vivaMosaicPath = path.join(process.cwd(), 'data', 'mosaics', 'viva', `${vivaCode}.png`);
  const coelhoMosaicPath = path.join(process.cwd(), 'data', 'mosaics', 'coelho', `${coelhoCode}.png`);

  if (!fs.existsSync(vivaMosaicPath) || !fs.existsSync(coelhoMosaicPath)) {
    return { match: false, confidence: 0, reason: 'Mosaic not found', error: true };
  }

  const vivaBase64 = imageToBase64(vivaMosaicPath);
  const coelhoBase64 = imageToBase64(coelhoMosaicPath);
  const prompt = IMPROVED_PROMPT.replace('{vivaCode}', vivaCode).replace('{coelhoCode}', coelhoCode);

  try {
    const result = await model.generateContent([
      prompt,
      { inlineData: { mimeType: 'image/png', data: vivaBase64 } },
      { inlineData: { mimeType: 'image/png', data: coelhoBase64 } }
    ]);

    const responseText = result.response.text();
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);

    if (!jsonMatch) {
      return { match: false, confidence: 0, reason: 'Failed to parse response', error: true };
    }

    const parsed = JSON.parse(jsonMatch[0]);
    return { ...parsed, error: false };
  } catch (error) {
    return { match: false, confidence: 0, reason: `API error: ${error.message}`, error: true };
  }
}

const PAIRS_TO_TEST = [
  { viva: '12252', coelho: '681867', user_feedback: 'User says pool format is the same' },
  { viva: '6930', coelho: '395513', user_feedback: 'User says staircase is the same' }
];

(async () => {
  console.log('============================================================');
  console.log('🔄 TESTING WITH NEW 3×3 MOSAICS');
  console.log('============================================================\n');

  for (const pair of PAIRS_TO_TEST) {
    console.log(`\n📌 VIVA ${pair.viva} ↔ Coelho ${pair.coelho}`);
    console.log(`   User feedback: ${pair.user_feedback}`);

    const result = await compareMosaics(pair.viva, pair.coelho);

    if (result.error) {
      console.log(`   ❌ ERROR: ${result.reason}`);
    } else if (result.match) {
      console.log(`   ✅ NOW CONFIRMED AS MATCH (${(result.confidence * 100).toFixed(0)}%)`);
      console.log(`   Pool: ${result.pool_shape_match}`);
      console.log(`   Features: ${result.key_structural_features?.join(', ')}`);
      console.log(`   Reason: ${result.reason}`);
    } else {
      console.log(`   ❌ STILL REJECTED (${(result.confidence * 100).toFixed(0)}%)`);
      console.log(`   Pool: ${result.pool_shape_match}`);
      console.log(`   Reason: ${result.reason}`);
    }

    await new Promise(resolve => setTimeout(resolve, 3000));
  }

  console.log('\n============================================================\n');
})().catch(console.error);

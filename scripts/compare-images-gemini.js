const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');

// Check for API key
const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
  console.error('\n❌ ERROR: GEMINI_API_KEY environment variable not set');
  console.error('Please set it with: export GEMINI_API_KEY="your-api-key"\n');
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(API_KEY);

// Load datasets
const vivaData = JSON.parse(fs.readFileSync('data/vivaprimeimoveis/listings/all-listings.json', 'utf8'));
const coelhoData = JSON.parse(fs.readFileSync('data/coelhodafonseca/listings/all-listings.json', 'utf8'));

console.log('\n🔍 GEMINI-POWERED IMAGE COMPARISON\n');
console.log(`Vivaprimeimoveis: ${vivaData.total_listings} listings`);
console.log(`Coelho da Fonseca: ${coelhoData.total_listings} listings`);
console.log(`Total comparisons: ${vivaData.total_listings * coelhoData.total_listings}`);
console.log(`Strategy: Compare 1 image per property, verify matches with 2nd image\n`);

// Helper to convert image to base64
function imageToBase64(imagePath) {
  try {
    const imageBuffer = fs.readFileSync(imagePath);
    return imageBuffer.toString('base64');
  } catch (err) {
    console.error(`Error reading image ${imagePath}:`, err.message);
    return null;
  }
}

// Helper to get image mime type
function getMimeType(imagePath) {
  const ext = path.extname(imagePath).toLowerCase();
  const mimeTypes = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp'
  };
  return mimeTypes[ext] || 'image/jpeg';
}

// Compare two images using Gemini
async function compareImages(image1Path, image2Path, model) {
  const image1Base64 = imageToBase64(image1Path);
  const image2Base64 = imageToBase64(image2Path);

  if (!image1Base64 || !image2Base64) {
    return { match: false, confidence: 0, reasoning: 'Image read error' };
  }

  const prompt = `You are a real estate expert analyzing property images. Compare these two property images and determine if they show THE SAME physical property/house.

Consider:
- Architectural design and structure
- Unique features (pools, landscaping, facades)
- Interior finishes and layout (if interior shots)
- Distinctive characteristics

Answer in this EXACT format:
MATCH: [YES or NO]
CONFIDENCE: [0-100]
REASONING: [Brief explanation in one sentence]

Be strict - only say YES if you're highly confident it's the same property.`;

  try {
    const result = await model.generateContent([
      prompt,
      {
        inlineData: {
          data: image1Base64,
          mimeType: getMimeType(image1Path)
        }
      },
      {
        inlineData: {
          data: image2Base64,
          mimeType: getMimeType(image2Path)
        }
      }
    ]);

    const response = await result.response;
    const text = response.text();

    // Parse response
    const matchLine = text.match(/MATCH:\s*(YES|NO)/i);
    const confidenceLine = text.match(/CONFIDENCE:\s*(\d+)/i);
    const reasoningLine = text.match(/REASONING:\s*(.+)/i);

    return {
      match: matchLine ? matchLine[1].toUpperCase() === 'YES' : false,
      confidence: confidenceLine ? parseInt(confidenceLine[1]) : 0,
      reasoning: reasoningLine ? reasoningLine[1].trim() : text.substring(0, 100),
      fullResponse: text
    };
  } catch (err) {
    console.error(`  ⚠️  API Error: ${err.message}`);
    return { match: false, confidence: 0, reasoning: `API Error: ${err.message}` };
  }
}

// Main comparison function
async function runComparison() {
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite' });

  const matches = [];
  let totalComparisons = 0;
  let apiCalls = 0;
  const startTime = Date.now();

  console.log('═══════════════════════════════════════════════════════════════\n');
  console.log('Starting comparison... (this may take a while)\n');

  // Compare each Viva listing against each Coelho listing
  for (let v = 0; v < vivaData.listings.length; v++) {
    const vivaListing = vivaData.listings[v];

    console.log(`\n[${v + 1}/${vivaData.total_listings}] Comparing Viva ${vivaListing.propertyCode}...`);

    // Use only first image for initial comparison
    const vivaImage = vivaListing.detailedData?.image1Path;
    const vivaImage2 = vivaListing.detailedData?.image2Path; // Keep for verification

    if (!vivaImage || !fs.existsSync(vivaImage)) {
      console.log(`  ⚠️  No images found, skipping`);
      continue;
    }

    // Compare against all Coelho listings
    for (let c = 0; c < coelhoData.listings.length; c++) {
      const coelhoListing = coelhoData.listings[c];

      const coelhoImage = coelhoListing.detailedData?.image1Path;
      const coelhoImage2 = coelhoListing.detailedData?.image2Path; // Keep for verification

      if (!coelhoImage || !fs.existsSync(coelhoImage)) continue;

      // Compare only first image from each (optimization)
      process.stdout.write(`  Comparing with Coelho ${coelhoListing.propertyCode}... `);

      const result = await compareImages(vivaImage, coelhoImage, model);
      apiCalls++;
      totalComparisons++;

      if (result.match && result.confidence >= 70) {
        // High confidence match! Compare second images to confirm
        console.log(`\n  🎯 POTENTIAL MATCH! Confidence: ${result.confidence}%`);
        console.log(`     ${result.reasoning}`);

        // Verify with second images if available
        let secondaryConfidence = null;
        let secondaryReasoning = null;
        if (vivaImage2 && coelhoImage2 && fs.existsSync(vivaImage2) && fs.existsSync(coelhoImage2)) {
          console.log(`  Verifying with second image pair...`);
          const result2 = await compareImages(vivaImage2, coelhoImage2, model);
          apiCalls++;
          secondaryConfidence = result2.confidence;
          secondaryReasoning = result2.reasoning;
          console.log(`  Secondary confidence: ${result2.confidence}%`);
          console.log(`  Secondary reasoning: ${result2.reasoning}`);
        }

        matches.push({
          viva: {
            code: vivaListing.propertyCode,
            url: vivaListing.url,
            price: vivaListing.price,
            image1: vivaImage,
            image2: vivaImage2
          },
          coelho: {
            code: coelhoListing.propertyCode,
            url: coelhoListing.url,
            price: coelhoListing.price,
            image1: coelhoImage,
            image2: coelhoImage2
          },
          primaryConfidence: result.confidence,
          secondaryConfidence,
          reasoning: result.reasoning,
          secondaryReasoning,
          fullResponse: result.fullResponse
        });
      } else {
        process.stdout.write(`✗ (${result.confidence}%)\n`);
      }

      // Rate limiting: small delay between API calls
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    // Progress update
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const rate = (apiCalls / (Date.now() - startTime) * 1000).toFixed(2);
    console.log(`  Progress: ${totalComparisons} comparisons, ${apiCalls} API calls, ${elapsed}s elapsed, ${rate} calls/sec`);
  }

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);

  // Display results
  console.log('\n\n═══════════════════════════════════════════════════════════════');
  console.log(`\n🎯 FOUND ${matches.length} POTENTIAL MATCHES\n`);

  if (matches.length === 0) {
    console.log('❌ No matches found between the two datasets.');
    console.log('   This confirms that the properties are genuinely different.\n');
  } else {
    matches.forEach((match, idx) => {
      console.log(`\n╔═══ MATCH #${idx + 1} ═══╗`);
      console.log(`║`);
      console.log(`║ VIVAPRIMEIMOVEIS:`);
      console.log(`║   Code: ${match.viva.code}`);
      console.log(`║   Price: ${match.viva.price}`);
      console.log(`║   URL: ${match.viva.url}`);
      console.log(`║   Images: ${match.viva.images.length}`);
      console.log(`║`);
      console.log(`║ COELHO DA FONSECA:`);
      console.log(`║   Code: ${match.coelho.code}`);
      console.log(`║   Price: ${match.coelho.price}`);
      console.log(`║   URL: ${match.coelho.url}`);
      console.log(`║   Images: ${match.coelho.images.length}`);
      console.log(`║`);
      console.log(`║ CONFIDENCE:`);
      console.log(`║   Primary: ${match.primaryConfidence}%`);
      if (match.secondaryConfidence) {
        console.log(`║   Secondary: ${match.secondaryConfidence}%`);
      }
      console.log(`║`);
      console.log(`║ REASONING:`);
      console.log(`║   ${match.reasoning}`);
      console.log(`╚${'═'.repeat(50)}╝`);
    });
  }

  // Save results
  const outputFile = 'data/image-comparison-results.json';
  fs.writeFileSync(outputFile, JSON.stringify({
    compared_at: new Date().toISOString(),
    total_viva: vivaData.total_listings,
    total_coelho: coelhoData.total_listings,
    total_comparisons: totalComparisons,
    total_api_calls: apiCalls,
    total_time_seconds: parseFloat(totalTime),
    matches_found: matches.length,
    matches
  }, null, 2));

  console.log(`\n\n✅ Comparison complete!`);
  console.log(`📄 Detailed results saved to: ${outputFile}`);
  console.log(`⏱️  Total time: ${totalTime}s`);
  console.log(`📊 API calls made: ${apiCalls}`);
  console.log(`📈 Average rate: ${(apiCalls / totalTime).toFixed(2)} calls/sec\n`);
}

// Run the comparison
runComparison().catch(err => {
  console.error('\n❌ Fatal error:', err);
  process.exit(1);
});

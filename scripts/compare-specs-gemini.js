const { GoogleGenerativeAI } = require("@google/generative-ai");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite" });

// Load data
const vivaData = require('../data/vivaprimeimoveis/listings/all-listings.json');
const coelhoData = require('../data/coelhodafonseca/listings/all-listings.json');

console.log('\n🔍 GEMINI-POWERED SPECS COMPARISON\n');
console.log(`Vivaprimeimoveis: ${vivaData.total_listings} listings`);
console.log(`Coelho da Fonseca: ${coelhoData.total_listings} listings`);
console.log(`\n═══════════════════════════════════════════════════════════════\n`);

(async () => {
  const potentialMatches = [];

  for (let i = 0; i < vivaData.listings.length; i++) {
    const vivaListing = vivaData.listings[i];

    console.log(`\n[${i + 1}/${vivaData.total_listings}] Analyzing Viva ${vivaListing.propertyCode}...`);
    console.log(`  Price: ${vivaListing.price}`);
    console.log(`  Specs: ${vivaListing.detailedData.specs.dormitorios || '?'} dorms / ${vivaListing.detailedData.specs.suites || '?'} suites / ${vivaListing.detailedData.specs.area_construida || '?'} construída`);

    // Create comparison prompt
    const prompt = `You are comparing real estate listings to find the same property listed on two different websites.

VIVA LISTING:
- Price: ${vivaListing.price}
- Bedrooms: ${vivaListing.detailedData.specs.dormitorios || 'unknown'}
- Suites: ${vivaListing.detailedData.specs.suites || 'unknown'}
- Parking: ${vivaListing.detailedData.specs.vagas || 'unknown'}
- Built Area: ${vivaListing.detailedData.specs.area_construida || 'unknown'}
- Total Area: ${vivaListing.detailedData.specs.area_total || 'unknown'}
- Description: ${vivaListing.detailedData.description.substring(0, 300)}

COELHO LISTINGS TO COMPARE:
${coelhoData.listings.slice(0, 81).map((c, idx) =>
  `[${idx}] ${c.propertyCode}: ${c.price} - ${c.features} - ${c.description.substring(0, 150)}`
).join('\n')}

TASK: Find the top 3 most likely matches from COELHO listings. Consider:
1. Similar price (within 20% tolerance)
2. Same number of bedrooms/suites
3. Similar built area (within 20% tolerance)
4. Similar description/features

Return ONLY a JSON array with up to 3 matches, ordered by confidence:
[
  {"coelho_index": 0, "confidence": 0.95, "reason": "Same price, bedrooms, and area"},
  {"coelho_index": 5, "confidence": 0.75, "reason": "Similar specs but different price"}
]

If no good matches (confidence < 0.5), return empty array: []`;

    try {
      const result = await model.generateContent(prompt);
      const responseText = result.response.text();

      // Parse JSON from response
      const jsonMatch = responseText.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const matches = JSON.parse(jsonMatch[0]);

        if (matches.length > 0) {
          console.log(`  ✓ Found ${matches.length} potential matches:`);
          matches.forEach(m => {
            const coelhoListing = coelhoData.listings[m.coelho_index];
            console.log(`    - Coelho ${coelhoListing.propertyCode} (${(m.confidence * 100).toFixed(0)}%): ${m.reason}`);

            potentialMatches.push({
              viva: {
                code: vivaListing.propertyCode,
                url: vivaListing.url,
                price: vivaListing.price,
                specs: vivaListing.detailedData.specs
              },
              coelho: {
                code: coelhoListing.propertyCode,
                url: coelhoListing.url,
                price: coelhoListing.price,
                features: coelhoListing.features
              },
              confidence: m.confidence,
              reason: m.reason
            });
          });
        } else {
          console.log(`  ✗ No matches found`);
        }
      }
    } catch (e) {
      console.log(`  ❌ Error: ${e.message}`);
    }

    // Rate limiting
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  console.log(`\n\n═══════════════════════════════════════════════════════════════`);
  console.log(`\n📊 SUMMARY: Found ${potentialMatches.length} potential matches\n`);

  // Group by confidence
  const highConfidence = potentialMatches.filter(m => m.confidence >= 0.8);
  const mediumConfidence = potentialMatches.filter(m => m.confidence >= 0.6 && m.confidence < 0.8);
  const lowConfidence = potentialMatches.filter(m => m.confidence < 0.6);

  console.log(`🟢 High confidence (>=80%): ${highConfidence.length} matches`);
  highConfidence.forEach(m => {
    console.log(`   Viva ${m.viva.code} ↔ Coelho ${m.coelho.code} (${(m.confidence * 100).toFixed(0)}%)`);
    console.log(`   ${m.reason}`);
  });

  console.log(`\n🟡 Medium confidence (60-80%): ${mediumConfidence.length} matches`);
  mediumConfidence.forEach(m => {
    console.log(`   Viva ${m.viva.code} ↔ Coelho ${m.coelho.code} (${(m.confidence * 100).toFixed(0)}%)`);
  });

  console.log(`\n🔴 Low confidence (<60%): ${lowConfidence.length} matches`);

  // Save results
  const fs = require('fs');
  const outputFile = 'data/potential-matches.json';
  fs.writeFileSync(outputFile, JSON.stringify({
    generated_at: new Date().toISOString(),
    total_matches: potentialMatches.length,
    high_confidence: highConfidence.length,
    medium_confidence: mediumConfidence.length,
    low_confidence: lowConfidence.length,
    matches: potentialMatches
  }, null, 2));

  console.log(`\n💾 Saved to: ${outputFile}\n`);
})();

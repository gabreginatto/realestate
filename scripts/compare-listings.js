const fs = require('fs');
const path = require('path');

// Load both datasets
const vivaData = JSON.parse(fs.readFileSync('data/vivaprimeimoveis/listings/all-listings.json', 'utf8'));
const coelhoData = JSON.parse(fs.readFileSync('data/coelhodafonseca/listings/all-listings.json', 'utf8'));

console.log('\n🔍 COMPARING REAL ESTATE LISTINGS\n');
console.log(`Vivaprimeimoveis: ${vivaData.total_listings} listings`);
console.log(`Coelho da Fonseca: ${coelhoData.total_listings} listings\n`);

// Helper function to extract specs from Coelho's features string
function parseCoelhoFeatures(featuresString) {
  const specs = {
    dorms: null,
    suites: null,
    vagas: null,
    areaConst: null,
    areaTerreno: null
  };

  if (!featuresString) return specs;

  // "5 dorms / 5 suítes / 8 vagas / 950 m² construída / 1145 m² do terreno"
  const dormsMatch = featuresString.match(/(\d+)\s*dorms?/i);
  const suitesMatch = featuresString.match(/(\d+)\s*suítes?/i);
  const vagasMatch = featuresString.match(/(\d+)\s*vagas?/i);
  const areaConstMatch = featuresString.match(/(\d+)\s*m²\s*construída/i);
  const areaTerrenoMatch = featuresString.match(/(\d+)\s*m²\s*do\s*terreno/i);

  if (dormsMatch) specs.dorms = parseInt(dormsMatch[1]);
  if (suitesMatch) specs.suites = parseInt(suitesMatch[1]);
  if (vagasMatch) specs.vagas = parseInt(vagasMatch[1]);
  if (areaConstMatch) specs.areaConst = parseInt(areaConstMatch[1]);
  if (areaTerrenoMatch) specs.areaTerreno = parseInt(areaTerrenoMatch[1]);

  return specs;
}

// Helper function to parse Coelho price
function parseCoelhoPrice(priceString) {
  if (!priceString) return null;
  // "R$32.000.000" -> 32000000
  const cleanPrice = priceString.replace(/[R$\.\s]/g, '').replace(',', '.');
  return parseFloat(cleanPrice);
}

// Helper function to parse Vivaprime price range
function parseVivaPriceRange(priceString) {
  if (!priceString) return null;
  // "R$ 1.000.000,00 a 2.000.000,00" -> {min: 1000000, max: 2000000}
  const matches = priceString.match(/R\$\s*([\d.,]+)\s*a\s*([\d.,]+)/);
  if (!matches) {
    // Try single price "R$ 1.000.000,00"
    const singleMatch = priceString.match(/R\$\s*([\d.,]+)/);
    if (singleMatch) {
      const price = parseFloat(singleMatch[1].replace(/\./g, '').replace(',', '.'));
      return { min: price, max: price };
    }
    return null;
  }

  const min = parseFloat(matches[1].replace(/\./g, '').replace(',', '.'));
  const max = parseFloat(matches[2].replace(/\./g, '').replace(',', '.'));
  return { min, max };
}

// Helper function to check if price matches
function priceMatches(coelhoPrice, vivaPriceRange) {
  if (!coelhoPrice || !vivaPriceRange) return false;
  return coelhoPrice >= vivaPriceRange.min && coelhoPrice <= vivaPriceRange.max;
}

// Helper function to extract amenities from Coelho
function getCoelhoAmenities(amenitiesArray) {
  if (!amenitiesArray) return [];
  const amenities = new Set();

  amenitiesArray.forEach(item => {
    // Extract individual amenities
    if (item.includes('Piscina')) amenities.add('Piscina');
    if (item.includes('Sauna')) amenities.add('Sauna');
    if (item.includes('Churrasqueira')) amenities.add('Churrasqueira');
    if (item.includes('Elevador')) amenities.add('Elevador');
    if (item.includes('Dep. De Empregados') || item.includes('WC Empregada')) amenities.add('Dependência de Empregados');
    if (item.includes('Espaço Gourmet') || item.includes('Gourmet')) amenities.add('Espaço Gourmet');
    if (item.includes('Lavabo')) amenities.add('Lavabo');
    if (item.includes('Lareira')) amenities.add('Lareira');
  });

  return Array.from(amenities);
}

// Helper function to get Viva amenities
function getVivaAmenities(featuresArray) {
  if (!featuresArray) return [];
  const relevant = ['Piscina', 'Sauna', 'Churrasqueira', 'Elevador', 'WC Empregada',
                   'Espaço Gourmet', 'Lavabo', 'Lareira', 'Área Serviço', 'Despensa'];
  return featuresArray.filter(f => relevant.includes(f));
}

// Calculate amenity similarity
function calculateAmenitySimilarity(amenities1, amenities2) {
  const set1 = new Set(amenities1.map(a => a.toLowerCase()));
  const set2 = new Set(amenities2.map(a => a.toLowerCase()));

  const intersection = new Set([...set1].filter(x => set2.has(x)));
  const union = new Set([...set1, ...set2]);

  if (union.size === 0) return 0;
  return intersection.size / union.size;
}

// Compare specs
function compareSpecs(coelhoSpecs, vivaListing) {
  let matchScore = 0;
  let totalChecks = 0;

  // For now, we'll focus on Coelho data since Viva has empty spec fields
  // We'll need to search in Viva's descriptions for specs

  return { matchScore, totalChecks };
}

// Main comparison logic
console.log('═══════════════════════════════════════════════════════════════\n');

const matches = [];

coelhoData.listings.forEach((coelhoListing, idx) => {
  const coelhoSpecs = parseCoelhoFeatures(coelhoListing.features);
  const coelhoPrice = parseCoelhoPrice(coelhoListing.price);
  const coelhoAmenities = getCoelhoAmenities(coelhoListing.detailedData?.amenities || []);

  vivaData.listings.forEach((vivaListing) => {
    const vivaPriceRange = parseVivaPriceRange(vivaListing.price);
    const vivaAmenities = getVivaAmenities(vivaListing.detailedData?.features || []);

    // Check price match
    const isPriceMatch = priceMatches(coelhoPrice, vivaPriceRange);

    // Calculate amenity similarity
    const amenitySimilarity = calculateAmenitySimilarity(coelhoAmenities, vivaAmenities);

    // Calculate overall match confidence
    let confidence = 0;
    const reasons = [];

    if (isPriceMatch) {
      confidence += 40;
      reasons.push(`Price match: ${coelhoListing.price} within ${vivaListing.price}`);
    }

    if (amenitySimilarity > 0.3) {
      const amenityScore = amenitySimilarity * 60;
      confidence += amenityScore;
      reasons.push(`Amenity similarity: ${(amenitySimilarity * 100).toFixed(1)}%`);
    }

    // If confidence > 50%, consider it a potential match
    if (confidence >= 50) {
      matches.push({
        confidence: confidence.toFixed(1),
        coelho: {
          code: coelhoListing.propertyCode,
          url: coelhoListing.url,
          price: coelhoListing.price,
          specs: coelhoSpecs,
          amenities: coelhoAmenities,
          description: coelhoListing.description?.substring(0, 100) + '...'
        },
        viva: {
          code: vivaListing.propertyCode,
          url: vivaListing.url,
          price: vivaListing.price,
          amenities: vivaAmenities,
          description: vivaListing.detailedData?.description?.substring(0, 100) || ''
        },
        reasons
      });
    }
  });
});

// Sort by confidence
matches.sort((a, b) => parseFloat(b.confidence) - parseFloat(a.confidence));

// Display results
console.log(`\n🎯 FOUND ${matches.length} POTENTIAL MATCHES\n`);

if (matches.length === 0) {
  console.log('❌ No strong matches found between the two datasets.\n');
  console.log('This could mean:');
  console.log('  1. The properties are genuinely different');
  console.log('  2. The price ranges in Vivaprime are too broad');
  console.log('  3. The Vivaprime data lacks detailed specs for comparison\n');
  console.log('💡 Recommendation: Enhance Vivaprime scraper to extract more specs');
  console.log('   from property descriptions or detail pages.\n');
} else {
  matches.forEach((match, idx) => {
    console.log(`\n╔═══ MATCH #${idx + 1} (${match.confidence}% confidence) ═══╗`);
    console.log(`║`);
    console.log(`║ COELHO DA FONSECA:`);
    console.log(`║   Code: ${match.coelho.code}`);
    console.log(`║   Price: ${match.coelho.price}`);
    console.log(`║   Specs: ${match.coelho.specs.dorms || '?'} dorms, ${match.coelho.specs.suites || '?'} suites, ${match.coelho.specs.vagas || '?'} vagas`);
    console.log(`║   Area: ${match.coelho.specs.areaConst || '?'}m² construída, ${match.coelho.specs.areaTerreno || '?'}m² terreno`);
    console.log(`║   Amenities: ${match.coelho.amenities.join(', ') || 'None'}`);
    console.log(`║   URL: ${match.coelho.url}`);
    console.log(`║`);
    console.log(`║ VIVAPRIMEIMOVEIS:`);
    console.log(`║   Code: ${match.viva.code}`);
    console.log(`║   Price: ${match.viva.price}`);
    console.log(`║   Amenities: ${match.viva.amenities.join(', ') || 'None'}`);
    console.log(`║   URL: ${match.viva.url}`);
    console.log(`║`);
    console.log(`║ REASONS:`);
    match.reasons.forEach(reason => {
      console.log(`║   ✓ ${reason}`);
    });
    console.log(`╚${'═'.repeat(50)}╝`);
  });
}

// Save results to file
const outputFile = 'data/comparison-results.json';
fs.writeFileSync(outputFile, JSON.stringify({
  compared_at: new Date().toISOString(),
  total_coelho: coelhoData.total_listings,
  total_viva: vivaData.total_listings,
  total_matches: matches.length,
  matches
}, null, 2));

console.log(`\n\n✅ Comparison complete!`);
console.log(`📄 Detailed results saved to: ${outputFile}\n`);

// Summary statistics
console.log('═══════════════════════════════════════════════════════════════');
console.log('\n📊 SUMMARY:');
console.log(`   Coelho da Fonseca: ${coelhoData.total_listings} listings`);
console.log(`   Vivaprimeimoveis: ${vivaData.total_listings} listings`);
console.log(`   Potential matches: ${matches.length}`);
console.log(`   Match rate: ${((matches.length / Math.min(coelhoData.total_listings, vivaData.total_listings)) * 100).toFixed(1)}%\n`);

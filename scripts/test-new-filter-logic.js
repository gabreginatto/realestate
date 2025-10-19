// Test the new price-based filtering logic

const testCases = [
  {
    name: "VIVA 4657 vs Coelho 429709 (Same price, 24% built area diff, 0.5% lot diff)",
    viva: {
      code: "4657",
      price: 9500000,
      built: 500,
      lot: 560,
      beds: 4,
      suites: 4,
      park: 4
    },
    coelho: {
      code: "429709",
      price: 9500000,
      built: 380,
      lot: 563,
      beds: 4,
      suites: 4,
      park: 4
    },
    expectedResult: "PASS (special case: price <5%, lot area within 10%)"
  },
  {
    name: "General case: 8% price diff, 12% area diff",
    viva: {
      price: 10000000,
      built: 500,
      lot: 600,
      beds: 4,
      suites: 4,
      park: 4
    },
    coelho: {
      price: 10800000,
      built: 440,
      lot: null,
      beds: 4,
      suites: 4,
      park: 4
    },
    expectedResult: "PASS (general case: price <10%, area <15%)"
  },
  {
    name: "Should reject: 12% price diff",
    viva: {
      price: 10000000,
      built: 500,
      lot: 600,
      beds: 4,
      suites: 4,
      park: 4
    },
    coelho: {
      price: 11200000,
      built: 500,
      lot: 600,
      beds: 4,
      suites: 4,
      park: 4
    },
    expectedResult: "REJECT (price >10%)"
  },
  {
    name: "Special case but NO area matches",
    viva: {
      price: 10000000,
      built: 500,
      lot: 600,
      beds: 4,
      suites: 4,
      park: 4
    },
    coelho: {
      price: 10100000, // 1% diff
      built: 380,      // 24% diff
      lot: 500,        // 16.7% diff
      beds: 4,
      suites: 4,
      park: 4
    },
    expectedResult: "REJECT (special case but neither area within 10%)"
  }
];

function testFilter(v, c) {
  // Calculate price difference
  const priceDiff = (v.price != null && c.price != null)
    ? Math.abs(v.price - c.price) / Math.max(v.price, c.price)
    : null;

  // SPECIAL CASE: If price difference < 5%
  if (priceDiff != null && priceDiff <= 0.05) {
    const builtDiff = (v.built != null && c.built != null)
      ? Math.abs(v.built - c.built) / Math.max(v.built, c.built)
      : null;
    const lotDiff = (v.lot != null && c.lot != null)
      ? Math.abs(v.lot - c.lot) / Math.max(v.lot, c.lot)
      : null;

    const atLeastOneAreaMatches =
      (builtDiff != null && builtDiff <= 0.10) ||
      (lotDiff != null && lotDiff <= 0.10);

    const bedsMatch = v.beds == null || c.beds == null || Math.abs(v.beds - c.beds) <= 1;
    const suitesMatch = v.suites == null || c.suites == null || Math.abs(v.suites - c.suites) <= 1;
    const parkMatch = v.park == null || c.park == null || Math.abs(v.park - c.park) <= 1;

    const result = atLeastOneAreaMatches && bedsMatch && suitesMatch && parkMatch;
    return {
      pass: result,
      reason: result
        ? `Special case: price ${(priceDiff*100).toFixed(1)}%, built ${builtDiff ? (builtDiff*100).toFixed(1)+'%' : 'N/A'}, lot ${lotDiff ? (lotDiff*100).toFixed(1)+'%' : 'N/A'}`
        : `Special case failed: areas ${builtDiff ? (builtDiff*100).toFixed(1)+'%' : 'N/A'}/${lotDiff ? (lotDiff*100).toFixed(1)+'%' : 'N/A'} (need ≤10%)`
    };
  }

  // GENERAL CASE
  const priceOK = priceDiff == null || priceDiff <= 0.10;
  const areaTolerance = 0.15;
  const areaOK = v.built == null || c.built == null ||
    Math.abs(v.built - c.built) / Math.max(v.built, c.built) <= areaTolerance;

  const result = priceOK && areaOK;
  return {
    pass: result,
    reason: result
      ? `General case: price ${priceDiff ? (priceDiff*100).toFixed(1)+'%' : 'N/A'} (≤10%), area ${v.built && c.built ? ((Math.abs(v.built - c.built) / Math.max(v.built, c.built))*100).toFixed(1)+'%' : 'N/A'} (≤15%)`
      : `General case failed: price ${priceDiff ? (priceDiff*100).toFixed(1)+'%' : 'N/A'} or area ${v.built && c.built ? ((Math.abs(v.built - c.built) / Math.max(v.built, c.built))*100).toFixed(1)+'%' : 'N/A'}`
  };
}

console.log('\n🧪 Testing New Filter Logic\n');
console.log('='.repeat(80));

testCases.forEach((test, idx) => {
  console.log(`\n${idx + 1}. ${test.name}`);
  const result = testFilter(test.viva, test.coelho);
  const status = result.pass ? '✅ PASS' : '❌ REJECT';
  console.log(`   Result: ${status}`);
  console.log(`   Reason: ${result.reason}`);
  console.log(`   Expected: ${test.expectedResult}`);

  if (test.coelho.code) {
    console.log(`   VIVA ${test.viva.code} vs Coelho ${test.coelho.code}`);
  }
});

console.log('\n' + '='.repeat(80) + '\n');

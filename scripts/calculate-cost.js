const fs = require('fs');

// Load datasets
const vivaData = JSON.parse(fs.readFileSync('data/vivaprimeimoveis/listings/all-listings.json', 'utf8'));
const coelhoData = JSON.parse(fs.readFileSync('data/coelhodafonseca/listings/all-listings.json', 'utf8'));

console.log('\n💰 GEMINI API COST CALCULATOR\n');
console.log('═══════════════════════════════════════════════════════════════\n');

// Comparison stats
const totalListingsViva = vivaData.total_listings;
const totalListingsCoelho = coelhoData.total_listings;
const totalComparisons = totalListingsViva * totalListingsCoelho;

console.log('📊 COMPARISON SCOPE:');
console.log(`   Vivaprimeimoveis: ${totalListingsViva} listings`);
console.log(`   Coelho da Fonseca: ${totalListingsCoelho} listings`);
console.log(`   Total comparisons: ${totalComparisons.toLocaleString()}\n`);

// Gemini 2.5 Flash Lite pricing (as of January 2025)
// Source: https://ai.google.dev/pricing
const PRICING = {
  // For prompts up to 128k tokens
  inputPer1M: 0.00,    // FREE tier
  outputPer1M: 0.00,   // FREE tier

  // Beyond free tier (if applicable)
  paidInputPer1M: 0.10,    // $0.10 per 1M input tokens
  paidOutputPer1M: 0.40,   // $0.40 per 1M output tokens

  // Free tier limits
  freeRequestsPerDay: 1500,
  freeRequestsPerMinute: 15
};

// Token estimates
const TOKENS_PER_IMAGE = 258;  // Average for standard images
const PROMPT_TOKENS = 100;     // Our comparison prompt
const OUTPUT_TOKENS = 50;      // Response (MATCH: YES/NO + confidence + reasoning)

const tokensPerComparison = (TOKENS_PER_IMAGE * 2) + PROMPT_TOKENS + OUTPUT_TOKENS;
const totalInputTokens = totalComparisons * ((TOKENS_PER_IMAGE * 2) + PROMPT_TOKENS);
const totalOutputTokens = totalComparisons * OUTPUT_TOKENS;

console.log('🔢 TOKEN ESTIMATES:');
console.log(`   Tokens per image: ${TOKENS_PER_IMAGE}`);
console.log(`   Tokens per comparison: ${tokensPerComparison}`);
console.log(`     - 2 images: ${TOKENS_PER_IMAGE * 2}`);
console.log(`     - Prompt: ${PROMPT_TOKENS}`);
console.log(`     - Output: ${OUTPUT_TOKENS}`);
console.log(`   Total input tokens: ${totalInputTokens.toLocaleString()} (~${(totalInputTokens / 1_000_000).toFixed(2)}M)`);
console.log(`   Total output tokens: ${totalOutputTokens.toLocaleString()} (~${(totalOutputTokens / 1_000_000).toFixed(2)}M)\n`);

// Time estimates
const estimatedSeconds = totalComparisons * 0.5; // ~0.5 seconds per comparison (including API latency)
const estimatedMinutes = estimatedSeconds / 60;
const estimatedHours = estimatedMinutes / 60;

console.log('⏱️  TIME ESTIMATES:');
console.log(`   Per comparison: ~0.5 seconds`);
console.log(`   Total time: ${estimatedMinutes.toFixed(0)} minutes (~${estimatedHours.toFixed(1)} hours)\n`);

// Cost calculation - FREE TIER
console.log('💵 COST ANALYSIS:\n');

console.log('   OPTION 1: Using Free Tier (1,500 requests/day)');
const daysNeeded = Math.ceil(totalComparisons / PRICING.freeRequestsPerDay);
console.log(`   ├─ Days needed: ${daysNeeded} days`);
console.log(`   ├─ Cost: $0.00 (100% FREE)`);
console.log(`   └─ Strategy: Run 1,500 comparisons per day\n`);

// Cost calculation - PAID (if running all at once)
console.log('   OPTION 2: All at Once (beyond free tier)');
const freeComparisons = PRICING.freeRequestsPerDay;
const paidComparisons = Math.max(0, totalComparisons - freeComparisons);

const freeInputTokens = freeComparisons * ((TOKENS_PER_IMAGE * 2) + PROMPT_TOKENS);
const freeOutputTokens = freeComparisons * OUTPUT_TOKENS;

const paidInputTokens = paidComparisons * ((TOKENS_PER_IMAGE * 2) + PROMPT_TOKENS);
const paidOutputTokens = paidComparisons * OUTPUT_TOKENS;

const inputCost = (paidInputTokens / 1_000_000) * PRICING.paidInputPer1M;
const outputCost = (paidOutputTokens / 1_000_000) * PRICING.paidOutputPer1M;
const totalCost = inputCost + outputCost;

console.log(`   ├─ Free comparisons: ${freeComparisons.toLocaleString()}`);
console.log(`   ├─ Paid comparisons: ${paidComparisons.toLocaleString()}`);
console.log(`   ├─ Input cost: $${inputCost.toFixed(2)}`);
console.log(`   ├─ Output cost: $${outputCost.toFixed(2)}`);
console.log(`   └─ Total cost: $${totalCost.toFixed(2)}\n`);

// Verification cost (for matches)
const estimatedMatches = 5; // Assume 5 potential matches (conservative)
const verificationCost = (estimatedMatches * tokensPerComparison / 1_000_000) * (PRICING.paidInputPer1M + PRICING.paidOutputPer1M);

console.log('   VERIFICATION (if matches found):');
console.log(`   ├─ Estimated matches: ~${estimatedMatches}`);
console.log(`   ├─ Additional comparisons: ${estimatedMatches}`);
console.log(`   └─ Additional cost: $${verificationCost.toFixed(4)} (~$0.00)\n`);

// RECOMMENDATIONS
console.log('═══════════════════════════════════════════════════════════════\n');
console.log('💡 RECOMMENDATIONS:\n');

console.log('   🌟 BEST OPTION: Use Free Tier (Option 1)');
console.log(`   ├─ Run ${PRICING.freeRequestsPerDay} comparisons per day for ${daysNeeded} days`);
console.log('   ├─ 100% FREE');
console.log('   └─ Total time: ~1.5 hours per day\n');

console.log('   ⚡ FASTEST OPTION: All at Once (Option 2)');
console.log(`   ├─ Run all ${totalComparisons.toLocaleString()} comparisons immediately`);
console.log(`   ├─ Cost: $${totalCost.toFixed(2)}`);
console.log(`   └─ Total time: ~${estimatedHours.toFixed(1)} hours\n`);

// Rate limiting info
console.log('📋 RATE LIMITS:');
console.log(`   Free tier: ${PRICING.freeRequestsPerMinute} requests/minute, ${PRICING.freeRequestsPerDay} requests/day`);
console.log(`   Our script: 100ms delay = 10 requests/sec = 600 requests/min`);
console.log(`   Status: NEED TO SLOW DOWN to stay within free tier!\n`);

console.log('═══════════════════════════════════════════════════════════════\n');

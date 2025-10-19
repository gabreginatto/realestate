# Gemini Image Comparison Guide

## Overview

This script uses Google's Gemini 2.5 Flash AI model to visually compare property images between two datasets to find matching properties.

## Setup

### 1. Get a Gemini API Key

1. Go to [Google AI Studio](https://aistudio.google.com/app/apikey)
2. Sign in with your Google account
3. Click "Create API Key"
4. Copy your API key

### 2. Set the API Key

```bash
export GEMINI_API_KEY="your-api-key-here"
```

To make it permanent, add it to your `~/.zshrc` or `~/.bashrc`:
```bash
echo 'export GEMINI_API_KEY="your-api-key-here"' >> ~/.zshrc
source ~/.zshrc
```

### 3. Test the API Connection

```bash
node scripts/test-gemini-api.js
```

You should see:
```
✅ API Response:
   Hello from Gemini!

🎉 Gemini API is working correctly!
```

## Running the Comparison

```bash
node scripts/compare-images-gemini.js
```

### What It Does

1. Loads both datasets (60 Vivaprime + 81 Coelho = 141 properties)
2. Compares images between all property pairs
3. Uses Gemini AI to determine if images show the same property
4. For potential matches (>70% confidence), verifies with additional images
5. Outputs detailed match report

### Optimization

The script is optimized to minimize API calls:
- Compares only the first image pair initially
- Only if match is found (>70% confidence), compares additional images
- Small delays between calls to respect rate limits

### Expected Performance

- **Total properties**: 60 × 81 = 4,860 potential pairs
- **API calls**: ~4,860 initial + additional for matches
- **Time**: ~15-30 minutes (depending on rate limits)
- **Cost**: Gemini Flash is very affordable (~$0.001 per call)

## Output

### Console Output
```
[1/60] Comparing Viva 17232...
  Comparing with Coelho 663777... ✗ (15%)
  Comparing with Coelho 652122... ✗ (8%)
  ...

🎯 FOUND 2 POTENTIAL MATCHES

╔═══ MATCH #1 ═══╗
║ VIVAPRIMEIMOVEIS:
║   Code: 17232
║   Price: R$ 1.000.000,00 a 2.000.000,00
║ COELHO DA FONSECA:
║   Code: 663777
║   Price: R$32.000.000
║ CONFIDENCE:
║   Primary: 87%
║   Secondary: 92%
╚══════════════════════════════════════════════════════════╝
```

### JSON Output

Results saved to `data/image-comparison-results.json`:
```json
{
  "compared_at": "2025-10-15T17:30:00.000Z",
  "total_comparisons": 4860,
  "total_api_calls": 4862,
  "matches_found": 2,
  "matches": [
    {
      "viva": { "code": "17232", "url": "...", "price": "..." },
      "coelho": { "code": "663777", "url": "...", "price": "..." },
      "primaryConfidence": 87,
      "secondaryConfidence": 92,
      "reasoning": "Same pool design and architectural features"
    }
  ]
}
```

## Troubleshooting

### API Key Not Set
```
❌ ERROR: GEMINI_API_KEY environment variable not set
```
**Solution**: Run `export GEMINI_API_KEY="your-key"`

### Invalid API Key
```
❌ API Test Failed: API_KEY_INVALID
```
**Solution**: Get a new key from https://aistudio.google.com/app/apikey

### Rate Limit Exceeded
```
⚠️  API Error: quota exceeded
```
**Solution**: Wait a few minutes or upgrade your API quota

### Image Read Errors
```
⚠️  No images found, skipping
```
**Solution**: Ensure images were downloaded during scraping

## Cost Estimate

**Gemini 2.0 Flash Pricing** (as of Jan 2025):
- Input: $0.00001875 per 1K tokens (~0.02 per image)
- Output: $0.000075 per 1K tokens

**For 4,860 comparisons**:
- Estimated cost: ~$0.50 - $2.00
- Free tier: 1,500 requests per day (plenty for this job)

## Notes

- The script uses `gemini-2.0-flash-exp` (experimental fast model)
- Confidence threshold is set to 70% for initial matches
- False positives are minimized by verifying with second image pair
- The vast price difference (R$1-2M vs R$4.9-44M) suggests few/no matches expected

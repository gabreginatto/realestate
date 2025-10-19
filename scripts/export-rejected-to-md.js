const fs = require('fs');
const path = require('path');

// Load the smart-matches data
const matchesData = require('../data/smart-matches.json');

// Generate markdown content
let markdown = `# Visual Verification - Rejected Candidates (106 pairs)

This document shows all 106 candidate pairs that were rejected by visual AI verification.

**Generated**: ${matchesData.generated_at}
**Approach**: ${matchesData.approach}

---

`;

// Group rejected pairs by VIVA listing
const groupedByViva = {};
matchesData.rejected_pairs.forEach(pair => {
  const vivaCode = pair.viva.code;
  if (!groupedByViva[vivaCode]) {
    groupedByViva[vivaCode] = {
      viva: pair.viva,
      candidates: []
    };
  }
  groupedByViva[vivaCode].candidates.push({
    coelho: pair.coelho,
    deterministic_score: pair.deterministic_score,
    visual_confidence: pair.visual_confidence,
    visual_reason: pair.visual_reason
  });
});

// Sort VIVA listings by code
const sortedVivaListings = Object.entries(groupedByViva).sort((a, b) => {
  const aCode = parseInt(a[0]);
  const bCode = parseInt(b[0]);
  return aCode - bCode;
});

let pairCounter = 1;

// Generate markdown for each VIVA listing
sortedVivaListings.forEach(([vivaCode, data]) => {
  const viva = data.viva;

  markdown += `## ${pairCounter}. VIVA Listing: ${vivaCode}\n\n`;

  markdown += `### VIVA Property Details\n\n`;
  markdown += `- **Code**: ${viva.code}\n`;
  markdown += `- **Price**: ${viva.price}\n`;
  markdown += `- **URL**: ${viva.url}\n`;

  if (viva.specs) {
    markdown += `- **Specs**:\n`;
    Object.entries(viva.specs).forEach(([key, value]) => {
      if (value) {
        markdown += `  - ${key}: ${value}\n`;
      }
    });
  }

  markdown += `\n### Rejected Coelho Candidates (${data.candidates.length})\n\n`;

  // Sort candidates by deterministic score (highest first)
  const sortedCandidates = data.candidates.sort((a, b) => b.deterministic_score - a.deterministic_score);

  sortedCandidates.forEach((candidate, idx) => {
    const coelho = candidate.coelho;

    markdown += `#### Candidate ${idx + 1}: Coelho ${coelho.code}\n\n`;
    markdown += `- **Code**: ${coelho.code}\n`;
    markdown += `- **Price**: ${coelho.price}\n`;
    markdown += `- **URL**: ${coelho.url}\n`;
    markdown += `- **Features**: ${coelho.features || 'N/A'}\n`;
    markdown += `- **Deterministic Score**: ${candidate.deterministic_score.toFixed(3)}\n`;
    markdown += `- **Visual Confidence**: ${(candidate.visual_confidence * 100).toFixed(0)}%\n`;
    markdown += `- **Visual Rejection Reason**: ${candidate.visual_reason}\n`;

    markdown += `\n**Mosaic Comparison**:\n`;
    markdown += `- VIVA mosaic: \`data/mosaics/viva/${viva.code}.png\`\n`;
    markdown += `- Coelho mosaic: \`data/mosaics/coelho/${coelho.code}.png\`\n\n`;

    markdown += `---\n\n`;
  });

  pairCounter++;
});

// Add summary at the end
markdown += `\n## Summary\n\n`;
markdown += `- **Total VIVA listings with rejected candidates**: ${sortedVivaListings.length}\n`;
markdown += `- **Total rejected pairs**: ${matchesData.rejected_pairs.length}\n`;
markdown += `- **Matches found**: ${matchesData.matches_found}\n`;
markdown += `- **Total pairs tested**: ${matchesData.total_visual_api_calls}\n`;

// Write to file
const outputPath = path.join(__dirname, '..', 'REJECTED-CANDIDATES.md');
fs.writeFileSync(outputPath, markdown);

console.log(`✅ Markdown file created: ${outputPath}`);
console.log(`📊 Stats:`);
console.log(`   - VIVA listings with rejections: ${sortedVivaListings.length}`);
console.log(`   - Total rejected pairs: ${matchesData.rejected_pairs.length}`);

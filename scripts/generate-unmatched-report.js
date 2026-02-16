#!/usr/bin/env node
/**
 * Generate Unmatched Properties Report
 *
 * Standalone script that loads matching data from files and generates
 * an HTML report of unmatched Viva properties.
 *
 * Usage:
 *   node scripts/generate-unmatched-report.js
 *   node scripts/generate-unmatched-report.js --email user@example.com
 */
const fs = require('fs');
const path = require('path');

// ============================================================================
// DATA LOADING (same approach as validate-matches.js)
// ============================================================================

const DATA_ROOT = path.join(__dirname, '..', 'data');
const HL_DATA_ROOT = path.join(__dirname, 'human-loop', 'data');

function findDataRoot() {
  if (fs.existsSync(path.join(DATA_ROOT, 'listings'))) return DATA_ROOT;
  if (fs.existsSync(path.join(HL_DATA_ROOT, 'listings'))) return HL_DATA_ROOT;
  console.error('Could not find data directory with listings');
  process.exit(1);
}

const dataRoot = findDataRoot();

function loadListings(site) {
  const listingsFile = path.join(dataRoot, 'listings', `${site}_listings.json`);
  if (!fs.existsSync(listingsFile)) {
    console.error(`Listings file not found: ${listingsFile}`);
    return [];
  }
  try {
    const data = JSON.parse(fs.readFileSync(listingsFile, 'utf-8'));
    return data.listings || [];
  } catch (error) {
    console.error(`Error loading ${listingsFile}: ${error.message}`);
    return [];
  }
}

function loadManualMatches() {
  const matchesFile = path.join(dataRoot, 'manual-matches.json');
  if (!fs.existsSync(matchesFile)) {
    console.warn('No manual-matches.json found - assuming no matches yet');
    return { matches: [], skipped: [], skipped_previous_passes: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(matchesFile, 'utf-8'));
  } catch (error) {
    console.error(`Error loading manual matches: ${error.message}`);
    process.exit(1);
  }
}

function loadDeterministicMatches() {
  const deterministicFile = path.join(dataRoot, 'deterministic-matches.json');
  if (!fs.existsSync(deterministicFile)) {
    console.warn('No deterministic-matches.json found');
    return { candidate_pairs: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(deterministicFile, 'utf-8'));
  } catch (error) {
    console.error(`Error loading deterministic matches: ${error.message}`);
    return { candidate_pairs: [] };
  }
}

// ============================================================================
// COMPUTE UNMATCHED
// ============================================================================

const vivaListings = loadListings('vivaprimeimoveis');
const matchState = loadManualMatches();
const deterministicData = loadDeterministicMatches();

console.log(`Data root: ${dataRoot}`);
console.log(`Loaded ${vivaListings.length} Viva listings`);
console.log(`Loaded ${matchState.matches?.length || 0} matches`);
console.log(`Loaded ${deterministicData.candidate_pairs?.length || 0} deterministic candidate pairs`);
console.log('');

// Collect all Viva codes that were in the candidate pool
const allVivaCodes = new Set();

for (const pair of deterministicData.candidate_pairs || []) {
  const vivaCode = pair.viva?.code || pair.viva?.propertyCode;
  if (vivaCode) allVivaCodes.add(vivaCode);
}

// Include codes from skipped_previous_passes
if (matchState.skipped_previous_passes) {
  for (const passData of matchState.skipped_previous_passes) {
    for (const skip of passData.skipped || []) {
      allVivaCodes.add(skip.viva_code);
    }
  }
}
for (const skip of matchState.skipped || []) {
  allVivaCodes.add(skip.viva_code);
}

// Get matched viva codes
const matchedVivaCodes = new Set((matchState.matches || []).map(m => m.viva_code));

// Find unmatched
const unmatchedCodes = [...allVivaCodes].filter(code => !matchedVivaCodes.has(code));

// Build lookup map
const vivaMap = new Map();
for (const l of vivaListings) {
  vivaMap.set(l.code || l.propertyCode, l);
}

const unmatchedListings = unmatchedCodes.map(code => {
  const listing = vivaMap.get(code);
  if (!listing) {
    return { code, error: 'listing data not found' };
  }
  return {
    code,
    price: listing.price,
    address: listing.address,
    url: listing.url,
    beds: listing.beds,
    suites: listing.suites,
    built: listing.built,
    park: listing.park,
    neighbourhood: listing.neighbourhood || listing.bairro
  };
});

// ============================================================================
// PRINT SUMMARY
// ============================================================================

console.log('========================================');
console.log(' Unmatched Properties Report');
console.log('========================================');
console.log(`Total Viva in pool: ${allVivaCodes.size}`);
console.log(`Matched:            ${matchedVivaCodes.size}`);
console.log(`Unmatched:          ${unmatchedListings.length}`);
console.log('');

if (unmatchedListings.length > 0) {
  console.log('UNMATCHED LISTINGS:');
  for (const listing of unmatchedListings) {
    const price = listing.price || '-';
    const address = listing.address || '-';
    const beds = listing.beds || '-';
    const built = listing.built ? `${listing.built}m\u00b2` : '-';
    console.log(`  ${listing.code} | ${address} | ${price} | ${beds} beds | ${built}`);
  }
  console.log('');
}

// ============================================================================
// GENERATE HTML REPORT
// ============================================================================

function generateReportHTML(unmatchedListings, matchedCount) {
  const rows = unmatchedListings.map(listing => {
    const price = listing.price || '-';
    const address = listing.address || '-';
    const beds = listing.beds || '-';
    const built = listing.built ? `${listing.built}m\u00b2` : '-';
    const url = listing.url || '#';

    return `
      <tr style="border-bottom: 1px solid #e2e8f0;">
        <td style="padding: 12px 8px; font-size: 13px;">${listing.code}</td>
        <td style="padding: 12px 8px; font-size: 13px;">${address}</td>
        <td style="padding: 12px 8px; font-size: 13px;">${price}</td>
        <td style="padding: 12px 8px; font-size: 13px; text-align: center;">${beds}</td>
        <td style="padding: 12px 8px; font-size: 13px; text-align: center;">${built}</td>
        <td style="padding: 12px 8px; font-size: 13px;">
          <a href="${url}" style="color: #3b82f6; text-decoration: none;">View \u2192</a>
        </td>
      </tr>
    `;
  }).join('');

  return `
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"><title>Unmatched Properties Report</title></head>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; background: #f8fafc;">
      <div style="background: white; border-radius: 12px; padding: 32px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
        <h1 style="font-size: 24px; margin: 0 0 8px; color: #0f172a;">Property Matching Report</h1>
        <p style="color: #64748b; margin: 0 0 24px;">Generated on ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</p>

        <div style="display: flex; gap: 16px; margin-bottom: 24px;">
          <div style="flex: 1; background: #ecfdf5; padding: 16px; border-radius: 8px; text-align: center;">
            <div style="font-size: 28px; font-weight: 800; color: #059669;">${matchedCount}</div>
            <div style="font-size: 12px; color: #6b7280; text-transform: uppercase;">Matched</div>
          </div>
          <div style="flex: 1; background: #fef3c7; padding: 16px; border-radius: 8px; text-align: center;">
            <div style="font-size: 28px; font-weight: 800; color: #d97706;">${unmatchedListings.length}</div>
            <div style="font-size: 12px; color: #6b7280; text-transform: uppercase;">Unmatched</div>
          </div>
        </div>

        <h2 style="font-size: 18px; margin: 0 0 16px; color: #0f172a;">Unmatched Properties</h2>
        <table style="width: 100%; border-collapse: collapse;">
          <thead>
            <tr style="background: #f1f5f9;">
              <th style="padding: 10px 8px; text-align: left; font-size: 12px; color: #64748b; text-transform: uppercase;">Code</th>
              <th style="padding: 10px 8px; text-align: left; font-size: 12px; color: #64748b; text-transform: uppercase;">Address</th>
              <th style="padding: 10px 8px; text-align: left; font-size: 12px; color: #64748b; text-transform: uppercase;">Price</th>
              <th style="padding: 10px 8px; text-align: center; font-size: 12px; color: #64748b; text-transform: uppercase;">Beds</th>
              <th style="padding: 10px 8px; text-align: center; font-size: 12px; color: #64748b; text-transform: uppercase;">Area</th>
              <th style="padding: 10px 8px; text-align: left; font-size: 12px; color: #64748b; text-transform: uppercase;">Link</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>

        <p style="margin-top: 24px; font-size: 12px; color: #94a3b8; text-align: center;">
          Generated by Property Matcher
        </p>
      </div>
    </body>
    </html>
  `;
}

const htmlContent = generateReportHTML(unmatchedListings, matchedVivaCodes.size);
const reportFile = path.join(dataRoot, 'unmatched-report.html');
fs.writeFileSync(reportFile, htmlContent);
console.log(`HTML report written to: ${reportFile}`);

// ============================================================================
// OPTIONAL: SEND EMAIL
// ============================================================================

const emailArg = process.argv.find(a => a.startsWith('--email'));
const emailAddress = emailArg
  ? (emailArg.includes('=') ? emailArg.split('=')[1] : process.argv[process.argv.indexOf('--email') + 1])
  : null;

if (emailAddress) {
  (async () => {
    try {
      const nodemailer = require('nodemailer');

      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtp.gmail.com',
        port: parseInt(process.env.SMTP_PORT || '587'),
        secure: process.env.SMTP_SECURE === 'true',
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS,
        },
      });

      await transporter.sendMail({
        from: process.env.REPORT_FROM_EMAIL || process.env.SMTP_USER,
        to: emailAddress,
        subject: `Property Matching Report - ${matchedVivaCodes.size} matched, ${unmatchedListings.length} unmatched`,
        html: htmlContent,
      });

      console.log(`\nReport emailed to: ${emailAddress}`);
    } catch (error) {
      if (error.code === 'MODULE_NOT_FOUND') {
        console.error('\nnodemailer is not installed. Run: npm install nodemailer');
      } else {
        console.error(`\nFailed to send email: ${error.message}`);
      }
      process.exit(1);
    }
  })();
} else {
  console.log('\nTip: Use --email user@example.com to send the report via email');
}

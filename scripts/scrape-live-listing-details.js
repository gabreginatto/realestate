'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const DATA_ROOT = path.join(REPO_ROOT, 'data');

const SITES = {
  viva: {
    key: 'viva',
    fullSite: 'vivaprimeimoveis',
    host: 'https://www.vivaprimeimoveis.com.br',
  },
  coelho: {
    key: 'coelho',
    fullSite: 'coelhodafonseca',
    host: 'https://www.coelhodafonseca.com.br',
  },
};

function parseArgs(argv) {
  const args = {
    compound: 'all',
    site: 'both',
    limit: 0,
    outputRoot: null,
    delayMs: 150,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--compound') args.compound = argv[++i];
    else if (arg === '--site') args.site = argv[++i];
    else if (arg === '--limit') args.limit = Number(argv[++i]);
    else if (arg === '--output-root') args.outputRoot = path.resolve(argv[++i]);
    else if (arg === '--delay-ms') args.delayMs = Number(argv[++i]);
    else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: node scripts/scrape-live-listing-details.js [options]

Scrape current listing detail pages from data/<compound>/live-listing-inventory/
and write fresh listing JSON to data/<compound>/fresh-listings/.

Options:
  --compound <slug|all>       Compound to scrape (default: all)
  --site <viva|coelho|both>   Site to scrape (default: both)
  --limit <n>                 Scrape only first n listings per site (default: all)
  --output-root <dir>         Output root (default: data/<compound>/fresh-listings)
  --delay-ms <n>              Delay between detail fetches (default: 150)
`);
      process.exit(0);
    }
  }

  if (!Number.isFinite(args.limit) || args.limit < 0) {
    throw new Error('--limit must be zero or a positive number');
  }
  if (!Number.isFinite(args.delayMs) || args.delayMs < 0) {
    throw new Error('--delay-ms must be zero or a positive number');
  }
  return args;
}

function siteKeys(siteArg) {
  if (siteArg === 'both') return ['viva', 'coelho'];
  if (!SITES[siteArg]) throw new Error(`Unknown site: ${siteArg}`);
  return [siteArg];
}

function findCompounds() {
  return fs.readdirSync(DATA_ROOT)
    .filter((name) => !['vivaprimeimoveis', 'coelhodafonseca', 'review-rounds'].includes(name))
    .filter((name) => fs.statSync(path.join(DATA_ROOT, name)).isDirectory())
    .filter((name) => fs.existsSync(path.join(DATA_ROOT, name, 'live-listing-inventory')))
    .sort((a, b) => a.localeCompare(b));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

function inventoryPath(compound, site) {
  return path.join(DATA_ROOT, compound, 'live-listing-inventory', `${site.fullSite}.json`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36',
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.text();
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/\\u002F/g, '/')
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&')
    .replace(/&#x2F;/gi, '/')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function stripTags(value) {
  return decodeHtml(value)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstMatch(html, patterns) {
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return decodeHtml(match[1]).trim();
  }
  return '';
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function absoluteUrl(host, url) {
  const clean = decodeHtml(url).trim();
  if (!clean) return null;
  if (clean.startsWith('http')) return clean;
  if (clean.startsWith('//')) return `https:${clean}`;
  if (clean.startsWith('/')) return `${host}${clean}`;
  return `${host}/${clean}`;
}

function parsePrice(text) {
  const match = text.match(/R\$\s*[\d.]+(?:,\d{2})?/);
  return match ? match[0].replace(/\s+/g, ' ') : '';
}

function parseNumberNear(text, pattern) {
  const match = text.match(pattern);
  return match ? Number(match[1].replace(/[^\d]/g, '')) : null;
}

function parseTitle(html) {
  return stripTags(firstMatch(html, [
    /<title[^>]*>([\s\S]*?)<\/title>/i,
    /<h1[^>]*>([\s\S]*?)<\/h1>/i,
  ]));
}

function parseMetaDescription(html) {
  return stripTags(firstMatch(html, [
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["'][^>]*>/i,
    /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["'][^>]*>/i,
  ]));
}

function sectionSlice(html, startPattern, endPattern) {
  const start = html.search(startPattern);
  if (start < 0) return html;
  const rest = html.slice(start);
  const end = rest.search(endPattern);
  return end > 0 ? rest.slice(0, end) : rest;
}

function vivaCodeFromUrl(url) {
  const match = String(url).match(/(?:^|\/)imovel\/[^?#"']+\/(\d+)(?:[?#"']|$)/);
  return match ? match[1] : null;
}

function parseVivaDetail(inventoryItem, html) {
  const code = String(inventoryItem.code || vivaCodeFromUrl(inventoryItem.url) || '').trim();
  const imagePattern = new RegExp(
    `https?:\\\\?/\\\\?/www\\.vivaprimeimoveis\\.com\\.br\\\\?/vista\\.imobi\\\\?/fotos\\\\?/${code}\\\\?/[^"'<>\\s)]+?\\.(?:jpe?g|png|webp)`,
    'gi'
  );
  const relativePattern = new RegExp(
    `/vista\\.imobi/fotos/${code}/[^"'<>\\s)]+?\\.(?:jpe?g|png|webp)`,
    'gi'
  );
  const images = unique([
    ...[...decodeHtml(html).matchAll(imagePattern)].map((m) => absoluteUrl(SITES.viva.host, m[0])),
    ...[...decodeHtml(html).matchAll(relativePattern)].map((m) => absoluteUrl(SITES.viva.host, m[0])),
  ]);

  const detailsHtml = sectionSlice(html, /<section[^>]+id=["']detalhes["']/i, /<section[^>]+id=["']semelhantes["']/i);
  const body = stripTags(detailsHtml);
  const title = parseTitle(html);
  const description = parseMetaDescription(html);

  return {
    url: inventoryItem.url,
    propertyCode: code,
    page: inventoryItem.page || null,
    price: parsePrice(body),
    images,
    detailedData: {
      title,
      description,
      specs: {
        dormitorios: parseNumberNear(body, /(\d+)\s*dormit/i),
        suites: parseNumberNear(body, /(\d+)\s*su[ií]te/i),
        banheiros: parseNumberNear(body, /(\d+)\s*banheiro/i),
        vagas: parseNumberNear(body, /(\d+)\s*vaga/i),
        area_construida: firstMatch(body, [
          /(\d+(?:[.,]\d+)?\s*m²)\s*Constru[ií]d[ao]/i,
          /(\d+(?:[.,]\d+)?\s*m²)[^.!?]{0,30}(?:constru[ií]da|área constru[ií]da)/i,
        ]),
        area_total: firstMatch(body, [
          /(\d+(?:[.,]\d+)?\s*m²)\s*Total/i,
          /(\d+(?:[.,]\d+)?\s*m²)[^.!?]{0,30}(?:terreno|área total)/i,
        ]),
      },
    },
  };
}

function coelhoCodeFromUrl(url) {
  const cfMatch = String(url).match(/cf(\d+)(?:[?#/]|$)/i);
  if (cfMatch) return cfMatch[1];
  const numericMatch = String(url).match(/\/(\d+)(?:[?#/]|$)/);
  return numericMatch ? numericMatch[1] : null;
}

function coelhoHeroSlice(html) {
  const decoded = decodeHtml(html);
  const marker = decoded.search(/property-hero-swiper|property-hero|swiper-slide/i);
  if (marker < 0) return '';
  const sectionEnd = decoded.indexOf('</section>', marker);
  if (sectionEnd > marker) return decoded.slice(marker, sectionEnd);
  return decoded.slice(marker, marker + 70000);
}

function parseCoelhoDetail(inventoryItem, html) {
  const code = String(inventoryItem.code || coelhoCodeFromUrl(inventoryItem.url) || '').trim();
  const hero = coelhoHeroSlice(html);
  const imageRegex = /https?:\/\/static\.coelhodafonseca\.com\.br\/images\/imoveis\/original\/\d+\.(?:jpe?g|png|webp)/gi;
  let images = unique([...hero.matchAll(imageRegex)].map((m) => m[0]));

  if (images.length === 0) {
    const ogImage = firstMatch(html, [
      /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["'][^>]*>/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["'][^>]*>/i,
    ]);
    images = unique([absoluteUrl(SITES.coelho.host, ogImage)]);
  }

  const body = stripTags(html);
  const title = parseTitle(html);
  const description = parseMetaDescription(html);
  const features = [
    parseNumberNear(body, /(\d+)\s*dorms?/i) ? `${parseNumberNear(body, /(\d+)\s*dorms?/i)} dorms` : '',
    parseNumberNear(body, /(\d+)\s*su[ií]tes?/i) ? `${parseNumberNear(body, /(\d+)\s*su[ií]tes?/i)} suítes` : '',
    parseNumberNear(body, /(\d+)\s*vagas?/i) ? `${parseNumberNear(body, /(\d+)\s*vagas?/i)} vagas` : '',
    firstMatch(body, [/(\d+(?:[.,]\d+)?\s*m²)\s*Área construída/i]) || firstMatch(body, [/(\d+(?:[.,]\d+)?\s*m²)\s*construída/i]),
  ].filter(Boolean).join(' / ');

  return {
    url: inventoryItem.url,
    propertyCode: code,
    price: parsePrice(body),
    location: firstMatch(title, [/^([^-]+)-/]) || '',
    propertyType: title.includes('Casa em Condomínio') ? 'Casa em Condomínio' : '',
    features,
    description,
    page: inventoryItem.page || null,
    images,
    detailedData: {
      title,
      fullDescription: description,
      amenities: [],
    },
  };
}

async function scrapeSite(compound, site, args) {
  const inventoryFile = inventoryPath(compound, site);
  if (!fs.existsSync(inventoryFile)) {
    console.log(`  ${site.fullSite}: inventory missing (${path.relative(REPO_ROOT, inventoryFile)})`);
    return null;
  }

  const inventory = readJson(inventoryFile);
  const inputListings = args.limit > 0
    ? inventory.listings.slice(0, args.limit)
    : inventory.listings;
  const listings = [];
  const errors = [];

  console.log(`  ${site.fullSite}: scraping ${inputListings.length}/${inventory.listings.length} detail page(s)`);
  for (let i = 0; i < inputListings.length; i++) {
    const item = inputListings[i];
    try {
      const html = await fetchText(item.url);
      const listing = site.key === 'viva'
        ? parseVivaDetail(item, html)
        : parseCoelhoDetail(item, html);
      listings.push(listing);
      console.log(`    [${i + 1}/${inputListings.length}] ${listing.propertyCode}: ${listing.images.length} image(s)`);
    } catch (err) {
      errors.push({ code: item.code, url: item.url, error: err.message });
      console.log(`    [${i + 1}/${inputListings.length}] ${item.code}: ERROR ${err.message}`);
    }
    if (args.delayMs > 0 && i + 1 < inputListings.length) await sleep(args.delayMs);
  }

  const outputRoot = args.outputRoot || path.join(DATA_ROOT, compound, 'fresh-listings');
  const outputFile = path.join(outputRoot, `${site.fullSite}.json`);
  const payload = {
    scraped_at: new Date().toISOString(),
    compound,
    site: site.fullSite,
    source_inventory: path.relative(REPO_ROOT, inventoryFile),
    source_url: inventory.source_url,
    declared_count: inventory.declared_count,
    total_inventory_listings: inventory.total_listings,
    total_listings: listings.length,
    total_pages: Math.max(0, ...inputListings.map((listing) => Number(listing.page) || 0)),
    errors,
    listings,
  };
  writeJson(outputFile, payload);

  return {
    output_file: path.relative(REPO_ROOT, outputFile),
    scraped: listings.length,
    inventory: inventory.total_listings,
    with_images: listings.filter((listing) => listing.images.length > 0).length,
    image_count: listings.reduce((sum, listing) => sum + listing.images.length, 0),
    errors: errors.length,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const compounds = args.compound === 'all' ? findCompounds() : [args.compound];
  const sites = siteKeys(args.site).map((key) => SITES[key]);
  const report = {
    generated_at: new Date().toISOString(),
    compounds: {},
  };

  for (const compound of compounds) {
    console.log(`\n${compound}`);
    report.compounds[compound] = {};
    for (const site of sites) {
      const summary = await scrapeSite(compound, site, args);
      if (summary) {
        report.compounds[compound][site.fullSite] = summary;
        console.log(
          `  ${site.fullSite}: wrote ${summary.output_file}, ` +
          `scraped=${summary.scraped}, with_images=${summary.with_images}, errors=${summary.errors}`
        );
      }
    }
  }

  const reportFile = path.join(DATA_ROOT, 'live-listing-detail-scrape-report.json');
  writeJson(reportFile, report);
  console.log(`\nWrote ${path.relative(REPO_ROOT, reportFile)}`);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});

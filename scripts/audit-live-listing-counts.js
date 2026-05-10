'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const DATA_ROOT = path.join(REPO_ROOT, 'data');
const SITE_CONFIGS = {
  viva: {
    key: 'viva',
    fullSite: 'vivaprimeimoveis',
    listingFile: 'vivaprimeimoveis_listings.json',
    host: 'https://www.vivaprimeimoveis.com.br',
  },
  coelho: {
    key: 'coelho',
    fullSite: 'coelhodafonseca',
    listingFile: 'coelhodafonseca_listings.json',
    host: 'https://www.coelhodafonseca.com.br',
  },
};

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36',
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return response.text();
}

function parseArgs(argv) {
  const args = {
    compound: 'all',
    site: 'both',
    output: path.join(DATA_ROOT, 'live-listing-count-audit.json'),
    maxPages: 20,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--compound') args.compound = argv[++i];
    else if (arg === '--site') args.site = argv[++i];
    else if (arg === '--output') args.output = path.resolve(argv[++i]);
    else if (arg === '--max-pages') args.maxPages = Number(argv[++i]);
    else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: node scripts/audit-live-listing-counts.js [options]

Read-only live listing inventory audit. It collects current listing codes from
site search pages and compares them with local listing JSON files.

Options:
  --compound <slug|all>  Compound to audit (default: all)
  --site <viva|coelho|both>  Site to audit (default: both)
  --output <file>       Report path (default: data/live-listing-count-audit.json)
  --max-pages <n>       Safety cap for pagination (default: 20)
`);
      process.exit(0);
    }
  }

  if (!Number.isFinite(args.maxPages) || args.maxPages < 1) {
    throw new Error('--max-pages must be a positive number');
  }
  return args;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readListingEnvelope(file) {
  if (!fs.existsSync(file)) return null;
  const data = readJson(file);
  const listings = Array.isArray(data) ? data : (data.listings || []);
  return { file, data, listings };
}

function listingFilesFor(compound, site) {
  const compoundDir = path.join(DATA_ROOT, compound);
  return [
    path.join(compoundDir, 'listings', site.listingFile),
    path.join(compoundDir, site.fullSite, 'listings', 'all-listings.json'),
  ];
}

function primaryListingEnvelope(compound, site) {
  for (const file of listingFilesFor(compound, site)) {
    const envelope = readListingEnvelope(file);
    if (envelope && envelope.listings.length > 0) return envelope;
  }
  return null;
}

function listingCode(listing) {
  return String(listing.propertyCode || listing.code || listing.id || '').trim();
}

function findCompounds() {
  return fs.readdirSync(DATA_ROOT)
    .filter((name) => !['vivaprimeimoveis', 'coelhodafonseca', 'review-rounds'].includes(name))
    .filter((name) => fs.statSync(path.join(DATA_ROOT, name)).isDirectory())
    .filter((name) => {
      const compoundDir = path.join(DATA_ROOT, name);
      return fs.existsSync(path.join(compoundDir, 'listings'))
        || fs.existsSync(path.join(compoundDir, 'pipeline-state.json'));
    })
    .sort((a, b) => a.localeCompare(b));
}

function siteKeys(siteArg) {
  if (siteArg === 'both') return ['viva', 'coelho'];
  if (!SITE_CONFIGS[siteArg]) throw new Error(`Unknown site: ${siteArg}`);
  return [siteArg];
}

function buildCoelhoUrl(criteria) {
  if (!criteria || typeof criteria !== 'object') return null;
  const enterprise = String(criteria.enterprises || '').trim();
  const propertyType = String(criteria.kind_of || 'Casa em Condomínio').trim();
  if (!enterprise) return null;

  const params = new URLSearchParams();
  params.set('category', 'Alphaville');
  params.set('transaction', 'Comprar');
  params.set('purpose', 'Residencial');
  params.append('location', `enterprise_name:${enterprise}`);
  if (propertyType) {
    params.append('propertyType', propertyType);
  }
  return `https://www.coelhodafonseca.com.br/search?${params.toString()}`;
}

function searchUrlFor(envelope, site) {
  if (site.key === 'viva') return envelope.data.search_url || null;
  if (site.key === 'coelho') return buildCoelhoUrl(envelope.data.search_criteria) || envelope.data.search_url || null;
  return null;
}

function absoluteUrl(host, href) {
  if (!href) return null;
  if (href.startsWith('http')) return href;
  if (href.startsWith('/')) return `${host}${href}`;
  return `${host}/${href}`;
}

function vivaCodeFromUrl(url) {
  const match = String(url).match(/(?:^|\/)imovel\/[^?#"']+\/(\d+)(?:[?#"']|$)/);
  return match ? match[1] : null;
}

function coelhoCodeFromHref(href) {
  const clean = String(href || '').split('?')[0].replace(/^\/+|\/+$/g, '');
  const cfMatch = clean.match(/cf(\d+)$/i);
  if (cfMatch) return cfMatch[1];
  const numericMatch = clean.match(/^(\d+)$/);
  return numericMatch ? numericMatch[1] : null;
}

async function collectViva(searchUrl, maxPages) {
  const seenCodes = new Map();
  const pageSummaries = [];

  let declaredCount = null;
  let maxObservedPage = 1;
  for (let currentPage = 1; currentPage <= Math.min(maxPages, maxObservedPage); currentPage++) {
    const url = currentPage === 1
      ? searchUrl
      : `${searchUrl}${searchUrl.includes('?') ? '&' : '?'}pg=${currentPage}`;
    const html = await fetchText(url);

    const declaredMatch = html.match(/Casas\s+à\s+Venda\s+\((\d+)\)/i);
    if (declaredMatch) declaredCount = Number(declaredMatch[1]);

    for (const pageMatch of html.matchAll(/imoveis\?pg=(\d+)[^"']*/g)) {
      maxObservedPage = Math.max(maxObservedPage, Number(pageMatch[1]));
    }

    const links = [...html.matchAll(/href=["']([^"']*imovel\/[^"']+\/\d+[^"']*)["']/g)]
      .map((match) => match[1]);

    let added = 0;
    for (const href of links) {
      const url = absoluteUrl('https://www.vivaprimeimoveis.com.br', href);
      const code = vivaCodeFromUrl(url);
      if (!code || seenCodes.has(code)) continue;
      seenCodes.set(code, { code, url, page: currentPage });
      added++;
    }
    pageSummaries.push({ page: currentPage, links: links.length, new_codes: added });
  }

  return { listings: [...seenCodes.values()], pages: pageSummaries, declared_count: declaredCount };
}

function parseSearchResultCount(html) {
  const patterns = [
    /Resultados da busca<!-- -->\s*<span[^>]*>(\d+)\s+imóveis encontrados/i,
    /Resultados da busca[\s\S]{0,120}?(\d+)\s+imóveis encontrados/i,
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return Number(match[1]);
  }
  return null;
}

async function collectCoelho(searchUrl, maxPages) {
  const seenCodes = new Map();
  const pageSummaries = [];
  let declaredCount = null;
  let maxObservedPage = 1;

  for (let currentPage = 1; currentPage <= Math.min(maxPages, maxObservedPage); currentPage++) {
    const url = currentPage === 1
      ? searchUrl
      : `${searchUrl}${searchUrl.includes('?') ? '&' : '?'}page=${currentPage}`;
    const html = await fetchText(url);

    const pageCount = parseSearchResultCount(html);
    if (pageCount !== null) declaredCount = pageCount;

    for (const pageMatch of html.matchAll(/page=(\d+)/g)) {
      maxObservedPage = Math.max(maxObservedPage, Number(pageMatch[1]));
    }

    const hrefs = [...html.matchAll(/href=["']([^"']*cf\d{5,9}[^"']*)["']/g)]
      .map((match) => match[1]);

    let added = 0;
    for (const href of hrefs) {
      const code = coelhoCodeFromHref(href);
      if (!code || seenCodes.has(code)) continue;
      seenCodes.set(code, {
        code,
        url: absoluteUrl('https://www.coelhodafonseca.com.br', href),
        page: currentPage,
      });
      added++;
    }
    pageSummaries.push({ page: currentPage, links: hrefs.length, new_codes: added });
  }

  return { listings: [...seenCodes.values()], pages: pageSummaries, declared_count: declaredCount };
}

function diffCodes(existingCodes, freshCodes) {
  return {
    missing_from_live: [...existingCodes].filter((code) => !freshCodes.has(code)).sort(),
    new_on_live: [...freshCodes].filter((code) => !existingCodes.has(code)).sort(),
  };
}

function writeInventory(compound, site, summary) {
  if (summary.error) return null;
  const inventoryDir = path.join(DATA_ROOT, compound, 'live-listing-inventory');
  fs.mkdirSync(inventoryDir, { recursive: true });
  const outputFile = path.join(inventoryDir, `${site.fullSite}.json`);
  const payload = {
    scraped_at: new Date().toISOString(),
    compound,
    site: site.fullSite,
    source_url: summary.search_url,
    declared_count: summary.live_declared_count,
    total_listings: summary.live_count,
    total_unique_codes: summary.live_unique_codes,
    listings: summary.live_listings,
  };
  fs.writeFileSync(outputFile, JSON.stringify(payload, null, 2) + '\n');
  return outputFile;
}

async function auditSite(compound, site, maxPages) {
  const envelope = primaryListingEnvelope(compound, site);
  if (!envelope) {
    return { error: 'No local listing file found' };
  }

  const searchUrl = searchUrlFor(envelope, site);
  if (!searchUrl) {
    return {
      listing_file: path.relative(REPO_ROOT, envelope.file),
      local_count: envelope.listings.length,
      error: 'No search URL or criteria available',
    };
  }

  try {
    const localCodes = new Set(envelope.listings.map(listingCode).filter(Boolean));
    const fresh = site.key === 'viva'
      ? await collectViva(searchUrl, maxPages)
      : await collectCoelho(searchUrl, maxPages);
    const freshCodes = new Set(fresh.listings.map((listing) => listing.code));
    const diff = diffCodes(localCodes, freshCodes);
    return {
      listing_file: path.relative(REPO_ROOT, envelope.file),
      search_url: searchUrl,
      local_count: envelope.listings.length,
      local_unique_codes: localCodes.size,
      live_declared_count: fresh.declared_count,
      live_count: fresh.listings.length,
      live_unique_codes: freshCodes.size,
      delta_live_vs_local: freshCodes.size - localCodes.size,
      missing_from_live_count: diff.missing_from_live.length,
      new_on_live_count: diff.new_on_live.length,
      missing_from_live: diff.missing_from_live,
      new_on_live: diff.new_on_live,
      pages: fresh.pages,
      live_listings: fresh.listings,
    };
  } catch (err) {
    return {
      listing_file: path.relative(REPO_ROOT, envelope.file),
      search_url: searchUrl,
      local_count: envelope.listings.length,
      error: err.message,
    };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const compounds = args.compound === 'all' ? findCompounds() : [args.compound];
  const sites = siteKeys(args.site).map((key) => SITE_CONFIGS[key]);

  const report = {
    generated_at: new Date().toISOString(),
    compounds: {},
  };

  for (const compound of compounds) {
    report.compounds[compound] = {};
    console.log(`\n${compound}`);
    for (const site of sites) {
      process.stdout.write(`  ${site.fullSite}: `);
      const summary = await auditSite(compound, site, args.maxPages);
      report.compounds[compound][site.fullSite] = summary;
      if (summary.error) {
        console.log(`ERROR ${summary.error}`);
      } else {
        const inventoryFile = writeInventory(compound, site, summary);
        console.log(
          `local=${summary.local_unique_codes}, live=${summary.live_unique_codes}, ` +
          `declared=${summary.live_declared_count ?? 'n/a'}, ` +
          `delta=${summary.delta_live_vs_local}, new=${summary.new_on_live_count}, ` +
          `missing=${summary.missing_from_live_count}, ` +
          `inventory=${path.relative(REPO_ROOT, inventoryFile)}`
        );
      }
    }
  }

  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  fs.writeFileSync(args.output, JSON.stringify(report, null, 2) + '\n');
  console.log(`\nWrote ${path.relative(REPO_ROOT, args.output)}`);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});

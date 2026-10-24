'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

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
    codes: null,
    outputRoot: null,
    delayMs: 1500,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--compound') args.compound = argv[++i];
    else if (arg === '--site') args.site = argv[++i];
    else if (arg === '--limit') args.limit = Number(argv[++i]);
    else if (arg === '--codes') args.codes = new Set(argv[++i].split(',').map((c) => c.trim()));
    else if (arg === '--output-root') args.outputRoot = path.resolve(argv[++i]);
    else if (arg === '--delay-ms') args.delayMs = Number(argv[++i]);
    else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: node scripts/scrape-live-listing-details.js [options]

Scrape current listing detail pages from data/<compound>/live-listing-inventory/
and write fresh listing JSON to data/<compound>/fresh-listings/.

Options:
  --compound <slug|all>       Compound to scrape (default: all)
  --site <viva|coelho|both>   Site to scrape (default: both)
  --codes <a,b,c>             Scrape only these listing codes (sampling)
  --limit <n>                 Scrape only first n listings per site (default: all)
  --output-root <dir>         Output root (default: data/<compound>/fresh-listings)
  --delay-ms <n>              Delay between detail fetches (default: 1500, be polite)
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

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36';

// vivaprimeimoveis.com.br serves an incomplete certificate chain: Node's fetch rejects it
// while curl (which follows the AIA issuer) accepts it, so fall back to curl on TLS errors.
function curlText(url) {
  return new Promise((resolve, reject) => {
    execFile('curl', ['-sL', '--max-time', '60', '-A', USER_AGENT, '-w', '\n%{http_code}', url],
      { maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
        if (err) return reject(err);
        const cut = stdout.lastIndexOf('\n');
        const status = Number(stdout.slice(cut + 1));
        if (status !== 200) return reject(new Error(`HTTP ${status} for ${url}`));
        return resolve(stdout.slice(0, cut));
      });
  });
}

async function fetchText(url) {
  let response;
  try {
    response = await fetch(url, {
      headers: {
        'user-agent': USER_AGENT,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
  } catch (err) {
    return curlText(url);
  }
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
  const match = String(text || '').match(/R\$\s*[\d.]+(?:,\d{2})?/);
  return match ? match[0].replace(/\s+/g, ' ') : null;
}

function toNumber(text) {
  // '1.183 m²' / '457m²' / '1.128' -> 1183 / 457 / 1128 (Brazilian thousands dots)
  const match = String(text || '').match(/\d[\d.,]*/);
  if (!match) return null;
  let value = match[0].replace(/[.,]+$/, '');
  if (value.includes(',')) value = value.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(value)) value = value.replace(/\./g, '');
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseTitle(html) {
  return stripTags(firstMatch(html, [
    /<title[^>]*>([\s\S]*?)<\/title>/i,
    /<h1[^>]*>([\s\S]*?)<\/h1>/i,
  ]));
}

// Strict: returns null when the section is missing. Never falls back to the whole page,
// because the search-filter widget outside the details section also contains "R$" and counters.
function sectionSlice(html, startPattern, endPattern) {
  const start = html.search(startPattern);
  if (start < 0) return null;
  const rest = html.slice(start);
  const end = rest.search(endPattern);
  return end > 0 ? rest.slice(0, end) : rest;
}

function emptyDetail(inventoryItem, code, warnings) {
  return {
    url: inventoryItem.url,
    propertyCode: code,
    page: inventoryItem.page || null,
    price: null,
    transaction: null,
    condo: null,
    description: null,
    area_terreno: null,
    images: [],
    warnings,
    detailedData: {
      title: null,
      description: null,
      specs: {
        dormitorios: null, suites: null, banheiros: null, vagas: null, area_construida: null, area_total: null,
      },
    },
  };
}

function vivaCodeFromUrl(url) {
  const match = String(url).match(/(?:^|\/)imovel\/[^?#"']+\/(\d+)(?:[?#"']|$)/);
  return match ? match[1] : null;
}

function parseVivaDetail(inventoryItem, html) {
  const code = String(inventoryItem.code || vivaCodeFromUrl(inventoryItem.url) || '').trim();
  const detailsHtml = sectionSlice(html, /<section[^>]+id=["']detalhes["']/i, /<section[^>]+id=["']semelhantes["']/i);
  if (!detailsHtml) {
    const reason = /Fatal error|mysqli_sql_exception/i.test(html)
      ? 'server error page (listing probably removed)'
      : 'details section (#detalhes) not found';
    return emptyDetail(inventoryItem, code, [reason]);
  }

  const warnings = [];
  const specs = {
    dormitorios: null, suites: null, banheiros: null, vagas: null, area_construida: null, area_total: null,
  };
  // Spec tiles: <div class="item ..."><div class="num">4</div><div class="label">Dormitórios</div></div>
  const tileRegex = /<div class="num">([\s\S]*?)<\/div>\s*<div class="label">([\s\S]*?)<\/div>/gi;
  for (const m of detailsHtml.matchAll(tileRegex)) {
    const label = stripTags(m[2]).toLowerCase();
    const num = stripTags(m[1]);
    if (/hidden/i.test(num)) continue;
    if (label.includes('dormit')) specs.dormitorios = toNumber(num);
    else if (label.includes('suíte') || label.includes('suite')) specs.suites = toNumber(num);
    else if (label.includes('banheiro')) specs.banheiros = toNumber(num);
    else if (label.includes('vaga')) specs.vagas = toNumber(num);
    else if (label.includes('construído') || label.includes('construido')) specs.area_construida = num;
    else if (label === 'total') specs.area_total = num;
  }
  if (specs.dormitorios === null) warnings.push('spec tiles not found');

  // Sale price: the "Venda" block (Condomínio / IPTU use the same .preco class).
  const priceMatch = detailsHtml.match(/<span>\s*(Venda|Loca[çc][ãa]o)\s*<\/span>\s*<div class="preco[^"]*">([\s\S]*?)<\/div>/i);
  const price = priceMatch ? parsePrice(stripTags(priceMatch[2])) : null;
  const transaction = priceMatch ? (/^venda$/i.test(priceMatch[1]) ? 'venda' : 'locacao') : null;
  if (!price) warnings.push('price not found');

  const descMatch = detailsHtml.match(/<div class="descricao[^"]*">\s*<div>([\s\S]*?)<\/div>/i);
  const description = descMatch
    ? decodeHtml(descMatch[1]).replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim()
    : null;

  // Gallery: every <a class="foto" href=...> inside the details section (the swiper repeats slides).
  const images = unique([...detailsHtml.matchAll(/<a[^>]+href=["']([^"']*\/vista\.imobi\/fotos\/[^"']+\.(?:jpe?g|png|webp))["'][^>]*class=["']foto["']|<a[^>]+class=["']foto["'][^>]+href=["']([^"']*\/vista\.imobi\/fotos\/[^"']+\.(?:jpe?g|png|webp))["']/gi)]
    .map((m) => absoluteUrl(SITES.viva.host, m[1] || m[2])));
  if (images.length === 0) warnings.push('no gallery images found');

  const slug = String(inventoryItem.url).match(/\/imovel\/([^/]+)\//);
  const condo = slug && /alphaville-01/.test(slug[1]) ? 'Alphaville 1' : null;

  return {
    url: inventoryItem.url,
    propertyCode: code,
    page: inventoryItem.page || null,
    price,
    transaction,
    condo,
    description,
    area_terreno: specs.area_total,
    images,
    warnings,
    detailedData: {
      title: parseTitle(html),
      description,
      specs,
    },
  };
}

function coelhoCodeFromUrl(url) {
  const cfMatch = String(url).match(/cf(\d+)(?:[?#/]|$)/i);
  if (cfMatch) return cfMatch[1];
  const numericMatch = String(url).match(/\/(\d+)(?:[?#/]|$)/);
  return numericMatch ? numericMatch[1] : null;
}

function parseCoelhoDetail(inventoryItem, html) {
  const code = String(inventoryItem.code || coelhoCodeFromUrl(inventoryItem.url) || '').trim();
  // Everything before the "similar listings" carousel belongs to this property.
  const similarAt = html.search(/Quem viu este im[óo]vel/i);
  const mainHtml = similarAt > 0 ? html.slice(0, similarAt) : html;
  const text = stripTags(mainHtml.replace(/<!--[\s\S]*?-->/g, '').replace(/<svg[\s\S]*?<\/svg>/gi, ' '));
  const codeAt = text.indexOf(`Cód: ${code}`);
  if (codeAt < 0) return emptyDetail(inventoryItem, code, [`property header "Cód: ${code}" not found`]);

  const warnings = [];
  // Header text, e.g. "Cód: 652122 Venda R$ 27.000.000 1.183 Área construída 1.128 Área do terreno 4 Dorms 4 Suítes 4 Vagas ..."
  const aboutAt = text.indexOf('Sobre o imóvel', codeAt);
  const header = text.slice(codeAt, aboutAt > 0 ? aboutAt : codeAt + 600);
  const num = '(\\d[\\d.,]*)';
  const pick = (re) => { const m = header.match(re); return m ? toNumber(m[1]) : null; };
  const built = pick(new RegExp(`${num}\\s*(?:m²)?\\s*Área construída`, 'i'));
  const lot = pick(new RegExp(`${num}\\s*(?:m²)?\\s*Área do terreno`, 'i'));
  const dorms = pick(new RegExp(`${num}\\s*Dorm`, 'i'));
  const suites = pick(new RegExp(`${num}\\s*Su[ií]tes?`, 'i'));
  const vagas = pick(new RegExp(`${num}\\s*Vagas?`, 'i'));
  const txMatch = header.match(/Cód:\s*\d+\s*(Venda|Loca[çc][ãa]o)/i);
  const transaction = txMatch ? (/^venda$/i.test(txMatch[1]) ? 'venda' : 'locacao') : null;
  const price = parsePrice(header.slice(0, 200));
  if (!price) warnings.push('price not found');
  if (lot === null) warnings.push('lot area not found');
  if (dorms === null) warnings.push('dorms not found');

  const locMatch = text.slice(Math.max(0, codeAt - 80), codeAt).match(/Casa em Condom[ií]nio\s+(.+?)\s*$/i);
  const condo = locMatch ? locMatch[1].trim() : null;

  let description = null;
  const infoAt = text.indexOf('Informações do corretor associado', aboutAt);
  if (aboutAt > 0 && infoAt > 0) {
    const rest = text.slice(infoAt + 'Informações do corretor associado'.length);
    const end = rest.search(/Estas informações refletem|Pedro|Corretor\(a\) associado/);
    description = (end > 0 ? rest.slice(0, end) : rest).trim() || null;
  }

  const imageRegex = /https?:\/\/static\.coelhodafonseca\.com\.br\/images\/imoveis\/original\/\d+\.(?:jpe?g|png|webp)/gi;
  // The <head> preloads images of other listings, so only read the hero carousel in <body>,
  // which ends at the "Ver fotos (N)" button (N = declared photo count).
  const bodyAt = Math.max(0, mainHtml.search(/<body/i));
  const markerAt = mainHtml.search(/Ver (?:fotos|galeria) \((?:<!-- -->)?\d+/);
  const galleryHtml = markerAt > bodyAt ? mainHtml.slice(bodyAt, markerAt) : mainHtml.slice(bodyAt);
  if (markerAt <= bodyAt) warnings.push('"Ver fotos/galeria (N)" marker not found; gallery may include extras');
  const images = unique([...galleryHtml.matchAll(imageRegex)].map((m) => m[0]));
  const expected = text.match(/Ver (?:fotos|galeria) \((\d+)\)/);
  if (images.length === 0) warnings.push('no gallery images found');
  else if (expected && Number(expected[1]) !== images.length) {
    warnings.push(`gallery count ${images.length} != declared ${expected[1]}`);
  }

  const features = [
    dorms !== null ? `${dorms} dorms` : '',
    suites !== null ? `${suites} suítes` : '',
    vagas !== null ? `${vagas} vagas` : '',
    built !== null ? `${built} m² construída` : '',
    lot !== null ? `${lot} m² do terreno` : '',
  ].filter(Boolean).join(' / ');

  return {
    url: inventoryItem.url,
    propertyCode: code,
    price,
    transaction,
    location: condo || '',
    condo,
    propertyType: /Casa em Condom[ií]nio/i.test(text.slice(Math.max(0, codeAt - 80), codeAt)) ? 'Casa em Condomínio' : '',
    features,
    description,
    area_terreno: lot,
    page: inventoryItem.page || null,
    images,
    warnings,
    detailedData: {
      title: parseTitle(html),
      fullDescription: description,
      specs: {
        dormitorios: dorms, suites, banheiros: null, vagas, area_construida: built, area_total: lot,
      },
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
  const filtered = args.codes
    ? inventory.listings.filter((l) => args.codes.has(String(l.code)))
    : inventory.listings;
  const inputListings = args.limit > 0 ? filtered.slice(0, args.limit) : filtered;
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
      const warn = listing.warnings.length ? ` WARN ${listing.warnings.join('; ')}` : '';
      console.log(`    [${i + 1}/${inputListings.length}] ${listing.propertyCode}: ${listing.images.length} image(s)${warn}`);
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

  if (args.outputRoot) return; // sample/validation runs must not overwrite the production report
  const reportFile = path.join(DATA_ROOT, 'live-listing-detail-scrape-report.json');
  writeJson(reportFile, report);
  console.log(`\nWrote ${path.relative(REPO_ROOT, reportFile)}`);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});

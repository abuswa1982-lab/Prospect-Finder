// Modonix Customer Toolkit — self-contained Worker.
// The page is embedded below (PAGE_B64) and served directly by this Worker,
// so there is no separate static-assets layer that can intercept /api routes.
//
// v4.2 adds a D1 database (binding name: DB) used for two things:
//   1. customers table  — every domain the Classifier has researched, so
//      re-uploading the same list later doesn't re-pay Anthropic, and so
//      Prospect Finder can flag "you already have this one."
//   2. prospect_cache table — every Google Places search result, keyed by
//      category + rounded coordinates + radius, so re-running the same
//      search doesn't re-bill Google within the cache window.
//
// Run schema.sql once against your D1 database before this will work.

const CUSTOMER_CACHE_DAYS = 90;   // how long a classified domain is trusted before re-researching
const PROSPECT_CACHE_DAYS = 30;   // how long a places search result is trusted before re-searching
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_ENRICH_PER_SEARCH = 20; // cap on domains classified/scraped in one places search, to stay under Worker subrequest limits

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/geocode'      && request.method === 'POST') return handleGeocode(request, env);
    if (url.pathname === '/api/places'       && request.method === 'POST') return handlePlaces(request, env);
    if (url.pathname === '/api/seed'         && request.method === 'POST') return handleSeed(request, env);
    if (url.pathname === '/api/classify'     && request.method === 'POST') return handleClassify(request, env);
    if (url.pathname === '/api/categories'   && request.method === 'GET')  return handleCategories(request, env);
    if (url.pathname === '/api/customers'    && request.method === 'GET')  return handleCustomerList(request, env);
    if (url.pathname === '/api/approve-customers' && request.method === 'POST') return handleApproveCustomers(request, env);
    if (url.pathname === '/api/categories-tree' && request.method === 'GET')  return handleCategoriesTree(request, env);
    if (url.pathname === '/api/categories/bulk' && request.method === 'POST') return handleCategoriesBulkAdd(request, env);
    if (url.pathname === '/api/check-search-log' && request.method === 'POST') return handleCheckSearchLog(request, env);
    if (url.pathname === '/api/log-search'     && request.method === 'POST') return handleLogSearch(request, env);
    if (url.pathname === '/api/search-report'  && request.method === 'GET')  return handleSearchReport(request, env);
    // Everything else: serve the app page.
    return new Response(decodePage(), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }
};

function decodePage() {
  const bin = atob(PAGE_B64);
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}

function extractDomain(websiteUrl) {
  if (!websiteUrl) return '';
  try {
    const u = new URL(websiteUrl);
    return u.hostname.replace(/^www\./, '').toLowerCase();
  } catch (e) {
    return '';
  }
}

async function handleGeocode(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }
  const address = body && body.address;
  if (!address || typeof address !== 'string') {
    return jsonResponse({ error: 'Missing "address" in request body' }, 400);
  }
  const key = env.GOOGLE_MAPS_API_KEY;
  if (!key) {
    return jsonResponse({ error: 'Server is missing GOOGLE_MAPS_API_KEY' }, 500);
  }
  try {
    const url = 'https://maps.googleapis.com/maps/api/geocode/json?address='
      + encodeURIComponent(address) + '&key=' + key;
    const r = await fetch(url);
    const data = await r.json();
    if (data.status !== 'OK' || !data.results || !data.results.length) {
      return jsonResponse({ error: 'Could not geocode "' + address + '"', status: data.status }, 404);
    }
    const result = data.results[0];
    return jsonResponse({
      lat: result.geometry.location.lat,
      lng: result.geometry.location.lng,
      formattedAddress: result.formatted_address
    }, 200);
  } catch (e) {
    return jsonResponse({ error: 'Geocoding request failed: ' + e.message }, 500);
  }
}

// --- Prospect search, with D1 caching and existing-customer tagging ---
async function handlePlaces(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }
  const { category, lat, lng, radiusMeters, includeDetails } = body || {};
  if (!category || typeof lat !== 'number' || typeof lng !== 'number') {
    return jsonResponse({ error: 'Missing category, lat, or lng in request body' }, 400);
  }
  const key = env.GOOGLE_MAPS_API_KEY;
  if (!key) {
    return jsonResponse({ error: 'Server is missing GOOGLE_MAPS_API_KEY' }, 500);
  }

  const cacheKey = buildPlacesCacheKey(category, lat, lng, radiusMeters, includeDetails);
  const db = env.DB;

  // 1. Check the cache first. Cached entries already have industry/email
  // baked in from the first time they were enriched, so a cache hit is free
  // and instant — no re-classifying, no re-scraping.
  if (db) {
    try {
      const cached = await db.prepare(
        'SELECT results_json, searched_at FROM prospect_cache WHERE cache_key = ?'
      ).bind(cacheKey).first();
      if (cached && (Date.now() - cached.searched_at) < PROSPECT_CACHE_DAYS * DAY_MS) {
        const places = JSON.parse(cached.results_json);
        return jsonResponse({ places: places.map(p => ({ ...p, cached: true })) }, 200);
      }
    } catch (e) {
      console.error('Prospect cache read failed, continuing without cache', e);
    }
  }

  // 2. No fresh cache hit — call Google Places live.
  const fieldMask = includeDetails
    ? 'places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.websiteUri'
    : 'places.id,places.displayName,places.formattedAddress';
  try {
    const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': fieldMask
      },
      body: JSON.stringify({
        textQuery: category,
        locationBias: {
          circle: {
            center: { latitude: lat, longitude: lng },
            radius: radiusMeters || 32000
          }
        },
        maxResultCount: 20,
        languageCode: 'en',
        regionCode: 'us'
      })
    });
    if (!r.ok) {
      const errText = await r.text();
      return jsonResponse({ error: 'Places API error: ' + errText.slice(0, 300) }, r.status);
    }
    const data = await r.json();
    let places = (data.places || []).map(p => ({
      id: p.id,
      name: (p.displayName && p.displayName.text) || '',
      address: p.formattedAddress || '',
      phone: p.nationalPhoneNumber || '',
      website: p.websiteUri || ''
    }));

    // 3. Enrich: tag existing customers, classify industry/sub-industry
    // (reusing the same cached-by-domain classifier as the Customer
    // Classifier tab), and best-effort scrape an email from each website.
    places = await enrichPlaces(places, db, env);

    // 4. Save the fully enriched list to cache for next time (best-effort).
    if (db) {
      try {
        await db.prepare(
          'INSERT INTO prospect_cache (cache_key, category, results_json, searched_at) VALUES (?, ?, ?, ?) ' +
          'ON CONFLICT(cache_key) DO UPDATE SET results_json = excluded.results_json, searched_at = excluded.searched_at'
        ).bind(cacheKey, category, JSON.stringify(places), Date.now()).run();
      } catch (e) {
        console.error('Prospect cache write failed', e);
      }
    }

    return jsonResponse({ places }, 200);
  } catch (e) {
    return jsonResponse({ error: 'Places search failed: ' + e.message }, 500);
  }
}

// Enrich a batch of raw Places results with:
//   - existingCustomer: does this website's domain match a saved customer?
//   - industry / subIndustry: pulled from the customer cache, or freshly
//     researched with the same Claude+web-search classifier used in the
//     Customer Classifier tab (and saved there for next time).
//   - email: best-effort scrape of the business's own website.
// Capped at MAX_ENRICH_PER_SEARCH domains per search to stay well under
// Cloudflare Workers' subrequest limit for a single request.
async function enrichPlaces(places, db, env) {
  const existingDomains = db ? await getExistingCustomerDomains(places, db) : new Set();

  const seenDomains = new Set();
  let enrichedCount = 0;

  const results = [];
  for (const p of places) {
    const domain = extractDomain(p.website);
    const out = { ...p, existingCustomer: domain ? existingDomains.has(domain) : false };

    if (domain && !seenDomains.has(domain) && enrichedCount < MAX_ENRICH_PER_SEARCH) {
      seenDomains.add(domain);
      enrichedCount++;

      if (db) {
        try {
          const cls = await researchDomain(domain, p.name, env, db);
          out.industry = cls.industry;
          out.subIndustry = cls.subIndustry;
        } catch (e) {
          console.error('Enrichment classify failed for ' + domain, e);
        }
      }

      try {
        out.email = await scrapeEmailFromWebsite(p.website);
      } catch (e) {
        out.email = '';
      }
    } else if (domain && seenDomains.has(domain)) {
      // Duplicate domain within the same result set — reuse what we already found.
      const already = results.find(r => extractDomain(r.website) === domain);
      if (already) {
        out.industry = already.industry;
        out.subIndustry = already.subIndustry;
        out.email = already.email;
      }
    }

    results.push(out);
  }
  return results;
}

async function getExistingCustomerDomains(places, db) {
  const domains = [...new Set(places.map(p => extractDomain(p.website)).filter(Boolean))];
  if (!domains.length) return new Set();
  try {
    const placeholders = domains.map(() => '?').join(',');
    const rows = await db.prepare(
      'SELECT domain FROM customers WHERE domain IN (' + placeholders + ')'
    ).bind(...domains).all();
    return new Set((rows.results || []).map(r => r.domain));
  } catch (e) {
    console.error('Existing-customer lookup failed', e);
    return new Set();
  }
}

// Best-effort: fetch a business's own homepage and look for a plausible
// public email address in the raw HTML. No guarantee of a hit — many sites
// hide contact info behind a form. Returns '' if nothing is found or the
// fetch fails for any reason (never throws).
async function scrapeEmailFromWebsite(websiteUrl) {
  if (!websiteUrl) return '';
  try {
    const r = await fetch(websiteUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ModonixBot/1.0)' },
      cf: { cacheTtl: 3600, cacheEverything: true }
    });
    if (!r.ok) return '';
    const html = await r.text();
    const matches = html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
    const IGNORE_EXT = /\.(png|jpg|jpeg|gif|svg|webp|css|js)$/i;
    const IGNORE_PREFIX = /^(example|test|your-?email|name|user|admin@localhost)/i;
    const good = matches.find(m => !IGNORE_EXT.test(m) && !IGNORE_PREFIX.test(m));
    return good || '';
  } catch (e) {
    return '';
  }
}

function buildPlacesCacheKey(category, lat, lng, radiusMeters, includeDetails) {
  const catKey = String(category).trim().toLowerCase();
  const latKey = Number(lat).toFixed(3);
  const lngKey = Number(lng).toFixed(3);
  return catKey + '|' + latKey + '|' + lngKey + '|' + (radiusMeters || 32000) + '|' + (includeDetails ? 1 : 0);
}

async function handleSeed(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }
  const { seedName, seedLocation, seedWebsite } = body || {};
  if (!seedName || typeof seedName !== 'string') {
    return jsonResponse({ error: 'Missing "seedName" in request body' }, 400);
  }
  const key = env.GOOGLE_MAPS_API_KEY;
  if (!key) {
    return jsonResponse({ error: 'Server is missing GOOGLE_MAPS_API_KEY' }, 500);
  }

  let textQuery = seedName.trim();
  if (seedLocation && typeof seedLocation === 'string' && seedLocation.trim()) {
    textQuery += ' ' + seedLocation.trim();
  }

  const fieldMask = [
    'places.id',
    'places.displayName',
    'places.formattedAddress',
    'places.websiteUri',
    'places.primaryType',
    'places.primaryTypeDisplayName',
    'places.types'
  ].join(',');

  try {
    const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': fieldMask
      },
      body: JSON.stringify({
        textQuery: textQuery,
        maxResultCount: 1,
        languageCode: 'en',
        regionCode: 'us'
      })
    });
    if (!r.ok) {
      const errText = await r.text();
      return jsonResponse({ error: 'Seed lookup error: ' + errText.slice(0, 300) }, r.status);
    }
    const data = await r.json();
    const p = data.places && data.places[0];
    if (!p) {
      return jsonResponse({ error: 'Could not find a business matching "' + textQuery + '"' }, 404);
    }

    let suggestedCategory = '';
    if (p.primaryTypeDisplayName && p.primaryTypeDisplayName.text) {
      suggestedCategory = p.primaryTypeDisplayName.text;
    } else if (p.primaryType) {
      suggestedCategory = p.primaryType.replace(/_/g, ' ').trim();
    }

    return jsonResponse({
      suggestedCategory: suggestedCategory,
      match: {
        id: p.id,
        name: (p.displayName && p.displayName.text) || '',
        address: p.formattedAddress || '',
        website: p.websiteUri || (seedWebsite || ''),
        primaryType: p.primaryType || '',
        types: p.types || []
      }
    }, 200);
  } catch (e) {
    return jsonResponse({ error: 'Seed lookup failed: ' + e.message }, 500);
  }
}

// Research a domain's industry/sub-industry/city using Claude with web
// search — checked against a general-purpose research cache first, shared
// by BOTH the Classifier tab and Prospect Finder result enrichment, so a
// domain is only ever paid for once no matter which tool sees it first.
// IMPORTANT: this does NOT write to the customers table. Researching a
// domain (classifying it, or finding it as a prospect) never makes it a
// customer on its own — only an explicit save via /api/approve-customers
// does that. This keeps the customer list to only what was deliberately
// approved, instead of filling up with every business ever looked at.
async function researchDomain(domain, sampleName, env, db) {
  if (db) {
    try {
      const existing = await db.prepare(
        'SELECT industry, sub_industry, city, website, researched_at FROM domain_research WHERE domain = ?'
      ).bind(domain).first();
      if (existing && (Date.now() - existing.researched_at) < CUSTOMER_CACHE_DAYS * DAY_MS) {
        return {
          industry: existing.industry,
          subIndustry: existing.sub_industry,
          city: existing.city || '',
          website: existing.website || ('https://' + domain),
          cached: true
        };
      }
    } catch (e) {
      console.error('Research cache read failed, continuing without cache', e);
    }
  }

  const key = env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error('Server is missing ANTHROPIC_API_KEY. Add it as a Worker secret to enable classification.');
  }

  const prompt = 'A B2B distributor needs to know what industry a customer operates in, at two levels of detail, plus its city.\n\n' +
    'Domain: ' + domain + (sampleName ? '\nCompany name on file: ' + sampleName : '') + '\n\n' +
    'Search the web for information about this company or domain. Then respond with exactly three lines, nothing else:\n' +
    'INDUSTRY: <broad category, 1 to 3 words, like "Manufacturing" or "Contractor" or "Distribution">\n' +
    'SUB-INDUSTRY: <specific flavor within that category, 2 to 5 words, like "precision manufacturing" or "commercial contractor" or "industrial safety distribution">\n' +
    'LOCATION: <city, state if you can determine it, otherwise "Unknown">\n\n' +
    'No NAICS codes, no explanation, no extra lines. If you cannot find enough information to determine industry with reasonable confidence, respond with exactly:\n' +
    'INDUSTRY: Unknown\n' +
    'SUB-INDUSTRY: Unknown\n' +
    'LOCATION: Unknown';

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
      tools: [{ type: 'web_search_20250305', name: 'web_search' }]
    })
  });
  if (!r.ok) {
    const errText = await r.text();
    throw new Error('Anthropic API error: ' + errText.slice(0, 300));
  }
  const data = await r.json();
  const text = (data.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('')
    .trim();

  const industryMatch = text.match(/INDUSTRY:\s*(.+)/i);
  const subMatch = text.match(/SUB-INDUSTRY:\s*(.+)/i);
  const locationMatch = text.match(/LOCATION:\s*(.+)/i);
  const industry = industryMatch ? industryMatch[1].trim() : 'Unknown';
  const subIndustry = subMatch ? subMatch[1].trim() : 'Unknown';
  const city = locationMatch ? locationMatch[1].trim() : 'Unknown';
  const website = 'https://' + domain;

  if (db) {
    try {
      await db.prepare(
        'INSERT INTO domain_research (domain, sample_name, industry, sub_industry, city, website, researched_at) VALUES (?, ?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT(domain) DO UPDATE SET sample_name = excluded.sample_name, industry = excluded.industry, ' +
        'sub_industry = excluded.sub_industry, city = excluded.city, website = excluded.website, researched_at = excluded.researched_at'
      ).bind(domain, sampleName || '', industry, subIndustry, city, website, Date.now()).run();
    } catch (e) {
      console.error('Research cache write failed', e);
    }
  }

  return { industry, subIndustry, city, website, cached: false };
}

async function handleClassify(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }
  const { domain, sampleName } = body || {};
  if (!domain || typeof domain !== 'string') {
    return jsonResponse({ error: 'Missing "domain" in request body' }, 400);
  }
  try {
    const result = await researchDomain(domain, sampleName, env, env.DB);
    return jsonResponse(result, 200);
  } catch (e) {
    return jsonResponse({ error: 'Classification failed: ' + e.message }, 500);
  }
}

// Add a Category/Sub-Category pair to the taxonomy if it doesn't already
// exist. Called both automatically (customer approval) and manually
// (Categories tab). Never errors the caller — taxonomy bookkeeping should
// never block a customer save or a bulk upload.
async function addCategoryPair(db, category, subCategory) {
  if (!db || !category) return;
  const cat = String(category).trim();
  const sub = String(subCategory || '').trim();
  if (!cat) return;
  try {
    await db.prepare(
      'INSERT INTO categories (category, sub_category, created_at) VALUES (?, ?, ?) ON CONFLICT(category, sub_category) DO NOTHING'
    ).bind(cat, sub, Date.now()).run();
  } catch (e) {
    console.error('addCategoryPair failed for ' + cat + '/' + sub, e);
  }
}

// Explicit, deliberate save — this is the ONLY way a domain enters the
// customers table. Called from the "Review & Save" tab after the person
// has checked exactly which rows they want kept.
async function handleApproveCustomers(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }
  const list = (body && body.customers) || [];
  if (!Array.isArray(list) || !list.length) {
    return jsonResponse({ error: 'No customers provided to save' }, 400);
  }
  const db = env.DB;
  if (!db) {
    return jsonResponse({ error: 'Server has no database connected' }, 500);
  }
  let saved = 0;
  for (const c of list) {
    if (!c.domain) continue;
    try {
      await db.prepare(
        'INSERT INTO customers (domain, sample_name, industry, sub_industry, city, website, classified_at) VALUES (?, ?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT(domain) DO UPDATE SET sample_name = excluded.sample_name, industry = excluded.industry, ' +
        'sub_industry = excluded.sub_industry, city = excluded.city, website = excluded.website, classified_at = excluded.classified_at'
      ).bind(
        c.domain, c.name || '', c.industry || 'Unknown', c.subIndustry || 'Unknown',
        c.city || '', c.website || ('https://' + c.domain), Date.now()
      ).run();
      saved++;
      if (c.industry && !/^unknown/i.test(c.industry) && !/^skipped/i.test(c.industry)) {
        await addCategoryPair(db, c.industry, c.subIndustry);
      }
    } catch (e) {
      console.error('Approve-save failed for ' + c.domain, e);
    }
  }
  return jsonResponse({ saved }, 200);
}

// Category dropdown data: { "Contractor": ["General", "Plumbing", ...], ... }
async function handleCategoriesTree(request, env) {
  const db = env.DB;
  if (!db) return jsonResponse({ tree: {} }, 200);
  try {
    const rows = await db.prepare(
      'SELECT category, sub_category FROM categories ORDER BY category COLLATE NOCASE, sub_category COLLATE NOCASE'
    ).all();
    const tree = {};
    for (const r of (rows.results || [])) {
      if (!tree[r.category]) tree[r.category] = [];
      if (r.sub_category) tree[r.category].push(r.sub_category);
    }
    return jsonResponse({ tree }, 200);
  } catch (e) {
    console.error('Categories tree failed', e);
    return jsonResponse({ tree: {} }, 200);
  }
}

// Bulk-add Category/Sub-Category pairs — used by both the manual "Add"
// form and the template upload on the Categories tab.
async function handleCategoriesBulkAdd(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }
  const pairs = (body && body.pairs) || [];
  if (!Array.isArray(pairs) || !pairs.length) {
    return jsonResponse({ error: 'No category pairs provided' }, 400);
  }
  const db = env.DB;
  if (!db) return jsonResponse({ error: 'Server has no database connected' }, 500);
  let added = 0;
  for (const p of pairs) {
    if (!p.category) continue;
    await addCategoryPair(db, p.category, p.subCategory);
    added++;
  }
  return jsonResponse({ added }, 200);
}

// Before running a search: has this exact Category (+ Sub-Category) +
// location combo been searched before? Returns a flag, not a block — the
// person decides whether to proceed.
async function handleCheckSearchLog(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }
  const { category, subCategory, location } = body || {};
  const db = env.DB;
  if (!db || !category || !location) {
    return jsonResponse({ found: false, timesSearched: 0 }, 200);
  }
  try {
    const rows = await db.prepare(
      'SELECT COUNT(*) as cnt, MAX(searched_at) as last_at FROM search_log ' +
      'WHERE category = ? AND sub_category = ? AND LOWER(location) = LOWER(?)'
    ).bind(category, subCategory || '', location).first();
    const timesSearched = (rows && rows.cnt) || 0;
    return jsonResponse({
      found: timesSearched > 0,
      timesSearched,
      lastSearchedAt: (rows && rows.last_at) || null
    }, 200);
  } catch (e) {
    console.error('Search log check failed', e);
    return jsonResponse({ found: false, timesSearched: 0 }, 200);
  }
}

// Record a search after it runs, for the duplicate-flagging check above
// and for the Reports tab.
async function handleLogSearch(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }
  const { category, subCategory, location, resultCount } = body || {};
  const db = env.DB;
  if (!db || !category || !location) {
    return jsonResponse({ ok: false }, 200);
  }
  try {
    await db.prepare(
      'INSERT INTO search_log (category, sub_category, location, result_count, searched_at, app_user) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(category, subCategory || '', location, resultCount || 0, Date.now(), '').run();
    return jsonResponse({ ok: true }, 200);
  } catch (e) {
    console.error('Search log write failed', e);
    return jsonResponse({ ok: false }, 200);
  }
}

// Simple report: every distinct Category/Sub-Category/Location combo ever
// searched, how many times, and when it was last run — sorted so repeats
// (the ones worth noticing) float to the top.
async function handleSearchReport(request, env) {
  const db = env.DB;
  if (!db) return jsonResponse({ rows: [] }, 200);
  try {
    const rows = await db.prepare(
      'SELECT category, sub_category, location, COUNT(*) as times_searched, ' +
      'MAX(searched_at) as last_searched_at, SUM(result_count) as total_results ' +
      'FROM search_log GROUP BY category, sub_category, location ' +
      'ORDER BY times_searched DESC, last_searched_at DESC'
    ).all();
    return jsonResponse({ rows: rows.results || [] }, 200);
  } catch (e) {
    console.error('Search report failed', e);
    return jsonResponse({ rows: [] }, 200);
  }
}

// Distinct list of real industries already found among classified customers,
// used to populate the Customer Category autocomplete on the front end.
async function handleCategories(request, env) {
  const db = env.DB;
  if (!db) {
    return jsonResponse({ categories: [] }, 200);
  }
  try {
    const rows = await db.prepare(
      "SELECT DISTINCT industry FROM customers " +
      "WHERE industry IS NOT NULL AND industry != '' " +
      "AND industry NOT LIKE 'Unknown%' AND industry NOT LIKE 'Skipped%' " +
      "ORDER BY industry COLLATE NOCASE"
    ).all();
    const categories = (rows.results || []).map(r => r.industry);
    return jsonResponse({ categories }, 200);
  } catch (e) {
    console.error('Category list failed', e);
    return jsonResponse({ categories: [] }, 200);
  }
}

// List of saved customers (name, domain, city, website) for the Find
// Similar tab's seed picker — pick a customer instead of typing one from
// memory, and its city/website auto-fill.
async function handleCustomerList(request, env) {
  const db = env.DB;
  if (!db) {
    return jsonResponse({ customers: [] }, 200);
  }
  try {
    const rows = await db.prepare(
      "SELECT domain, sample_name, city, website FROM customers " +
      "WHERE sample_name IS NOT NULL AND sample_name != '' " +
      "ORDER BY sample_name COLLATE NOCASE"
    ).all();
    const customers = (rows.results || []).map(r => ({
      name: r.sample_name,
      domain: r.domain,
      city: r.city || '',
      website: r.website || ''
    }));
    return jsonResponse({ customers }, 200);
  } catch (e) {
    console.error('Customer list failed', e);
    return jsonResponse({ customers: [] }, 200);
  }
}

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

const PAGE_B64 = "PCFET0NUWVBFIGh0bWw+CjxodG1sIGxhbmc9ImVuIj4KPGhlYWQ+CjxtZXRhIGNoYXJzZXQ9IlVURi04Ij4KPG1ldGEgbmFtZT0idmlld3BvcnQiIGNvbnRlbnQ9IndpZHRoPWRldmljZS13aWR0aCwgaW5pdGlhbC1zY2FsZT0xLjAiPgo8dGl0bGU+TW9kb25peCBDdXN0b21lciBUb29sa2l0PC90aXRsZT4KPGxpbmsgcmVsPSJwcmVjb25uZWN0IiBocmVmPSJodHRwczovL2ZvbnRzLmdvb2dsZWFwaXMuY29tIj4KPGxpbmsgaHJlZj0iaHR0cHM6Ly9mb250cy5nb29nbGVhcGlzLmNvbS9jc3MyP2ZhbWlseT1BcmNoaXZvOndkdGgsd2dodEA3NS4uMTI1LDQwMC4uODAwJmZhbWlseT1JQk0rUGxleCtNb25vOndnaHRANDAwOzUwMDs2MDAmZGlzcGxheT1zd2FwIiByZWw9InN0eWxlc2hlZXQiPgo8c2NyaXB0IHNyYz0iaHR0cHM6Ly9jZG5qcy5jbG91ZGZsYXJlLmNvbS9hamF4L2xpYnMveGxzeC8wLjE4LjUveGxzeC5mdWxsLm1pbi5qcyI+PC9zY3JpcHQ+CjxzdHlsZT4KICA6cm9vdHsKICAgIC0tcGFwZXI6I0Y0RjVGMjstLWluazojMUEyMTI5Oy0tc3RlZWw6IzhBOTU5RTstLWxpbmU6I0Q4RENEOTsKICAgIC0tc2VhbTojRDk1ODFFOy0tc2VhbS1zb2Z0OiNGQkVBRTA7LS1vazojMkU3RDRGOy0tZXJyOiNCMzM0MUU7LS1jYXJkOiNGRkZGRkY7CiAgfQogICp7Ym94LXNpemluZzpib3JkZXItYm94O21hcmdpbjowO3BhZGRpbmc6MH0KICBodG1se3Njcm9sbC1iZWhhdmlvcjpzbW9vdGh9CiAgQG1lZGlhIChwcmVmZXJzLXJlZHVjZWQtbW90aW9uOiByZWR1Y2Upe2h0bWx7c2Nyb2xsLWJlaGF2aW9yOmF1dG99ICp7YW5pbWF0aW9uOm5vbmUhaW1wb3J0YW50O3RyYW5zaXRpb246bm9uZSFpbXBvcnRhbnR9fQogIGJvZHl7YmFja2dyb3VuZDp2YXIoLS1wYXBlcik7Y29sb3I6dmFyKC0taW5rKTtmb250LWZhbWlseTonQXJjaGl2bycsc3lzdGVtLXVpLHNhbnMtc2VyaWY7Zm9udC12YXJpYXRpb24tc2V0dGluZ3M6J3dkdGgnIDEwMDtsaW5lLWhlaWdodDoxLjU7bWluLWhlaWdodDoxMDB2aDtwYWRkaW5nOjAgMjBweCA4MHB4fQogIC53cmFwe21heC13aWR0aDo5NjBweDttYXJnaW46MCBhdXRvfQogIGhlYWRlcntwYWRkaW5nOjQ0cHggMCAyNHB4O2JvcmRlci1ib3R0b206M3B4IHNvbGlkIHZhcigtLWluayl9CiAgLmJyYW5ke2ZvbnQtc2l6ZToxMnB4O2ZvbnQtd2VpZ2h0OjYwMDtsZXR0ZXItc3BhY2luZzouMjJlbTt0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7Y29sb3I6dmFyKC0tc3RlZWwpfQogIGgxe2ZvbnQtd2VpZ2h0OjgwMDtmb250LXZhcmlhdGlvbi1zZXR0aW5nczond2R0aCcgMTE4O2ZvbnQtc2l6ZTpjbGFtcCgzMHB4LDUuNHZ3LDQ2cHgpO2xldHRlci1zcGFjaW5nOi0uMDFlbTtsaW5lLWhlaWdodDoxLjA1O21hcmdpbi10b3A6OHB4fQogIGgxIC5zZWFtd29yZHtjb2xvcjp2YXIoLS1zZWFtKX0KICAudGFnbGluZXttYXJnaW4tdG9wOjEwcHg7Zm9udC1zaXplOjE1cHg7Y29sb3I6dmFyKC0tc3RlZWwpO21heC13aWR0aDo2NGNofQoKICAvKiBUYWJzICovCiAgLnRhYnN7ZGlzcGxheTpmbGV4O2dhcDowO21hcmdpbi10b3A6MDtib3JkZXItYm90dG9tOm5vbmV9CiAgLnRhYntmb250LWZhbWlseTonQXJjaGl2bycsc2Fucy1zZXJpZjtmb250LXdlaWdodDo3MDA7Zm9udC1zaXplOjEzcHg7bGV0dGVyLXNwYWNpbmc6LjA4ZW07dGV4dC10cmFuc2Zvcm06dXBwZXJjYXNlOwogICAgcGFkZGluZzoxNXB4IDIycHg7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItYm90dG9tOm5vbmU7YmFja2dyb3VuZDp2YXIoLS1wYXBlcik7Y29sb3I6dmFyKC0tc3RlZWwpO2N1cnNvcjpwb2ludGVyfQogIC50YWIgKyAudGFie2JvcmRlci1sZWZ0Om5vbmV9CiAgLnRhYjpob3Zlcntjb2xvcjp2YXIoLS1pbmspfQogIC50YWIuYWN0aXZle2JhY2tncm91bmQ6dmFyKC0tY2FyZCk7Y29sb3I6dmFyKC0taW5rKTtib3JkZXItdG9wOjNweCBzb2xpZCB2YXIoLS1zZWFtKTtwYWRkaW5nLXRvcDoxM3B4fQogIC50YWJwYW5lbHtkaXNwbGF5Om5vbmV9CiAgLnRhYnBhbmVsLmFjdGl2ZXtkaXNwbGF5OmJsb2NrfQoKICAucGFuZWx7YmFja2dyb3VuZDp2YXIoLS1jYXJkKTtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2JvcmRlci10b3A6bm9uZTtwYWRkaW5nOjI4cHg7bWFyZ2luLXRvcDowfQogIC5maWVsZHttYXJnaW4tYm90dG9tOjIwcHh9CiAgbGFiZWx7ZGlzcGxheTpibG9jaztmb250LXNpemU6MTFweDtmb250LXdlaWdodDo3MDA7bGV0dGVyLXNwYWNpbmc6LjE2ZW07dGV4dC10cmFuc2Zvcm06dXBwZXJjYXNlO21hcmdpbi1ib3R0b206OHB4fQogIGxhYmVsIC5vcHR7Y29sb3I6dmFyKC0tc3RlZWwpO2ZvbnQtd2VpZ2h0OjUwMDtsZXR0ZXItc3BhY2luZzouMWVtO3RleHQtdHJhbnNmb3JtOm5vbmV9CiAgaW5wdXRbdHlwZT0idGV4dCJdLCBpbnB1dFt0eXBlPSJwYXNzd29yZCJdLCBpbnB1dFt0eXBlPSJmaWxlIl0sIHRleHRhcmVhewogICAgd2lkdGg6MTAwJTtwYWRkaW5nOjEzcHggMTRweDtmb250LXNpemU6MTZweDtmb250LWZhbWlseTonQXJjaGl2bycsc2Fucy1zZXJpZjsKICAgIGJvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7Ym9yZGVyLXJhZGl1czowO2JhY2tncm91bmQ6dmFyKC0tcGFwZXIpO2NvbG9yOnZhcigtLWluayk7CiAgfQogIHRleHRhcmVhe3Jlc2l6ZTp2ZXJ0aWNhbDtmb250LWZhbWlseTonSUJNIFBsZXggTW9ubycsbW9ub3NwYWNlO2ZvbnQtc2l6ZToxNHB4fQogIGlucHV0OmZvY3VzLCB0ZXh0YXJlYTpmb2N1c3tvdXRsaW5lOjJweCBzb2xpZCB2YXIoLS1zZWFtKTtvdXRsaW5lLW9mZnNldDoxcHg7YmFja2dyb3VuZDojZmZmfQogIC5oaW50e2ZvbnQtc2l6ZToxM3B4O2NvbG9yOnZhcigtLXN0ZWVsKTttYXJnaW4tdG9wOjZweH0KCiAgLnJvd3tkaXNwbGF5OmZsZXg7Z2FwOjE0cHg7YWxpZ24taXRlbXM6Y2VudGVyO2ZsZXgtd3JhcDp3cmFwfQogIGJ1dHRvbntmb250LWZhbWlseTonQXJjaGl2bycsc2Fucy1zZXJpZjtmb250LXdlaWdodDo3MDA7Zm9udC1zaXplOjE0cHg7bGV0dGVyLXNwYWNpbmc6LjA2ZW07dGV4dC10cmFuc2Zvcm06dXBwZXJjYXNlO3BhZGRpbmc6MTRweCAyNnB4O2JvcmRlcjpub25lO2N1cnNvcjpwb2ludGVyO2JvcmRlci1yYWRpdXM6MH0KICBidXR0b246Zm9jdXMtdmlzaWJsZXtvdXRsaW5lOjJweCBzb2xpZCB2YXIoLS1pbmspO291dGxpbmUtb2Zmc2V0OjJweH0KICAuYnRuLW1pbmV7YmFja2dyb3VuZDp2YXIoLS1pbmspO2NvbG9yOiNmZmZ9CiAgLmJ0bi1taW5lOmhvdmVye2JhY2tncm91bmQ6dmFyKC0tc2VhbSl9CiAgLmJ0bi1taW5lOmRpc2FibGVke2JhY2tncm91bmQ6dmFyKC0tc3RlZWwpO2N1cnNvcjpub3QtYWxsb3dlZH0KICAuYnRuLXNlY29uZGFyeXtiYWNrZ3JvdW5kOnZhcigtLXBhcGVyKTtjb2xvcjp2YXIoLS1pbmspO2JvcmRlcjoxcHggc29saWQgdmFyKC0taW5rKX0KICAuYnRuLXNlY29uZGFyeTpob3ZlcntiYWNrZ3JvdW5kOnZhcigtLWluayk7Y29sb3I6I2ZmZn0KICAuY291bnQtc2VsZWN0e2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjhweDtmb250LXNpemU6MTNweDtjb2xvcjp2YXIoLS1zdGVlbCl9CiAgc2VsZWN0e2ZvbnQtZmFtaWx5OidJQk0gUGxleCBNb25vJyxtb25vc3BhY2U7Zm9udC1zaXplOjE0cHg7cGFkZGluZzoxMHB4IDhweDtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2JhY2tncm91bmQ6dmFyKC0tcGFwZXIpO2NvbG9yOnZhcigtLWluayk7Ym9yZGVyLXJhZGl1czowfQogIGlucHV0W3R5cGU9Im51bWJlciJde3BhZGRpbmc6OXB4IDhweDtmb250LWZhbWlseTonSUJNIFBsZXggTW9ubycsbW9ub3NwYWNlO2ZvbnQtc2l6ZToxNHB4O2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7YmFja2dyb3VuZDp2YXIoLS1wYXBlcik7Y29sb3I6dmFyKC0taW5rKTt3aWR0aDo3MHB4fQoKICAuc3RhdHVze21hcmdpbi10b3A6MjJweDtwYWRkaW5nOjE0cHggMTZweDtmb250LWZhbWlseTonSUJNIFBsZXggTW9ubycsbW9ub3NwYWNlO2ZvbnQtc2l6ZToxM3B4O2JvcmRlci1sZWZ0OjRweCBzb2xpZCB2YXIoLS1zdGVlbCk7YmFja2dyb3VuZDp2YXIoLS1jYXJkKTtkaXNwbGF5Om5vbmV9CiAgLnN0YXR1cy5vbntkaXNwbGF5OmJsb2NrfQogIC5zdGF0dXMud29ya2luZ3tib3JkZXItbGVmdC1jb2xvcjp2YXIoLS1zZWFtKX0KICAuc3RhdHVzLmVycm9ye2JvcmRlci1sZWZ0LWNvbG9yOnZhcigtLWVycik7Y29sb3I6dmFyKC0tZXJyKX0KICAuc3RhdHVzLmRvbmV7Ym9yZGVyLWxlZnQtY29sb3I6dmFyKC0tb2spO2NvbG9yOnZhcigtLW9rKX0KICAucHVsc2V7ZGlzcGxheTppbmxpbmUtYmxvY2s7d2lkdGg6OXB4O2hlaWdodDo5cHg7YmFja2dyb3VuZDp2YXIoLS1zZWFtKTttYXJnaW4tcmlnaHQ6OXB4O2FuaW1hdGlvbjpwbCAxLjFzIGluZmluaXRlfQogIEBrZXlmcmFtZXMgcGx7MCUsMTAwJXtvcGFjaXR5OjF9NTAle29wYWNpdHk6LjJ9fQoKICAucHJvZ3Jlc3MtYmFye21hcmdpbi10b3A6MTRweDtoZWlnaHQ6NnB4O2JhY2tncm91bmQ6dmFyKC0tbGluZSk7cG9zaXRpb246cmVsYXRpdmU7b3ZlcmZsb3c6aGlkZGVuO2Rpc3BsYXk6bm9uZX0KICAucHJvZ3Jlc3MtYmFyLm9ue2Rpc3BsYXk6YmxvY2t9CiAgLnByb2dyZXNzLWZpbGx7aGVpZ2h0OjEwMCU7YmFja2dyb3VuZDp2YXIoLS1zZWFtKTt3aWR0aDowJTt0cmFuc2l0aW9uOndpZHRoIC4zcyBlYXNlfQoKICAuY29zdC1ub3Rle21hcmdpbi10b3A6MTRweDtwYWRkaW5nOjEycHggMTRweDtmb250LXNpemU6MTIuNXB4O2NvbG9yOnZhcigtLWluayk7YmFja2dyb3VuZDp2YXIoLS1zZWFtLXNvZnQpO2JvcmRlci1sZWZ0OjNweCBzb2xpZCB2YXIoLS1zZWFtKX0KCiAgLnNlZWQtYm94e3BhZGRpbmc6MTZweDtiYWNrZ3JvdW5kOnZhcigtLXBhcGVyKTtib3JkZXI6MXB4IGRhc2hlZCB2YXIoLS1saW5lKTttYXJnaW4tYm90dG9tOjIwcHh9CiAgLnNlZWQtaW5mb3ttYXJnaW4tdG9wOjEycHg7cGFkZGluZzoxMnB4IDE0cHg7Zm9udC1mYW1pbHk6J0lCTSBQbGV4IE1vbm8nLG1vbm9zcGFjZTtmb250LXNpemU6MTIuNXB4O2JhY2tncm91bmQ6dmFyKC0tY2FyZCk7Ym9yZGVyLWxlZnQ6M3B4IHNvbGlkIHZhcigtLW9rKTtkaXNwbGF5Om5vbmV9CiAgLnNlZWQtaW5mby5vbntkaXNwbGF5OmJsb2NrfQoKICBkZXRhaWxzLmhlbHB7bWFyZ2luLXRvcDowO2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7Ym9yZGVyLXRvcDpub25lO2JhY2tncm91bmQ6dmFyKC0tY2FyZCl9CiAgZGV0YWlscy5oZWxwIHN1bW1hcnl7Y3Vyc29yOnBvaW50ZXI7cGFkZGluZzoxNnB4IDI4cHg7Zm9udC1zaXplOjEycHg7Zm9udC13ZWlnaHQ6NzAwO2xldHRlci1zcGFjaW5nOi4xNGVtO3RleHQtdHJhbnNmb3JtOnVwcGVyY2FzZTtjb2xvcjp2YXIoLS1pbmspO2xpc3Qtc3R5bGU6bm9uZX0KICBkZXRhaWxzLmhlbHAgc3VtbWFyeTo6LXdlYmtpdC1kZXRhaWxzLW1hcmtlcntkaXNwbGF5Om5vbmV9CiAgZGV0YWlscy5oZWxwIHN1bW1hcnk6YmVmb3Jle2NvbnRlbnQ6IisgIjtjb2xvcjp2YXIoLS1zZWFtKX0KICBkZXRhaWxzLmhlbHBbb3Blbl0gc3VtbWFyeTpiZWZvcmV7Y29udGVudDoiXDIyMTIgIn0KICBkZXRhaWxzLmhlbHAgLmhlbHAtYm9keXtwYWRkaW5nOjAgMjhweCAyNHB4O2ZvbnQtc2l6ZToxNHB4O2NvbG9yOnZhcigtLWluayl9CiAgZGV0YWlscy5oZWxwIC5oZWxwLWJvZHkgb2x7bWFyZ2luLWxlZnQ6MjBweDttYXJnaW4tdG9wOjhweH0KICBkZXRhaWxzLmhlbHAgLmhlbHAtYm9keSBsaXttYXJnaW4tYm90dG9tOjhweH0KCiAgLnNhdmVkLXBhbmVse21hcmdpbi10b3A6MjBweDtib3JkZXItdG9wOjJweCBzb2xpZCB2YXIoLS1saW5lKTtwYWRkaW5nLXRvcDoxOHB4fQogIC5zYXZlZC1pdGVte2Rpc3BsYXk6ZmxleDtqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2VlbjthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjEwcHg7cGFkZGluZzoxMHB4IDA7Ym9yZGVyLWJvdHRvbToxcHggZGFzaGVkIHZhcigtLWxpbmUpO2ZvbnQtc2l6ZToxMy41cHh9CiAgLnNhdmVkLWl0ZW06bGFzdC1jaGlsZHtib3JkZXItYm90dG9tOm5vbmV9CiAgLnNhdmVkLWl0ZW0gLm1ldGF7Y29sb3I6dmFyKC0tc3RlZWwpO2ZvbnQtc2l6ZToxMnB4O2ZvbnQtZmFtaWx5OidJQk0gUGxleCBNb25vJyxtb25vc3BhY2V9CiAgLnNhdmVkLWFjdGlvbnMgYnV0dG9ue3BhZGRpbmc6N3B4IDEycHg7Zm9udC1zaXplOjExcHh9CiAgLmVtcHR5LW5vdGV7Y29sb3I6dmFyKC0tc3RlZWwpO2ZvbnQtc2l6ZToxM3B4O2ZvbnQtc3R5bGU6aXRhbGljfQoKICAucmVzdWx0c3ttYXJnaW4tdG9wOjM2cHg7ZGlzcGxheTpub25lfQogIC5yZXN1bHRzLm9ue2Rpc3BsYXk6YmxvY2t9CiAgLnJlcy1oZWFke2Rpc3BsYXk6ZmxleDtqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2VlbjthbGlnbi1pdGVtczpiYXNlbGluZTtmbGV4LXdyYXA6d3JhcDtnYXA6MTBweDtib3JkZXItYm90dG9tOjNweCBzb2xpZCB2YXIoLS1pbmspO3BhZGRpbmctYm90dG9tOjEwcHg7bWFyZ2luLWJvdHRvbTowfQogIC5yZXMtaGVhZCBoMntmb250LXdlaWdodDo4MDA7Zm9udC12YXJpYXRpb24tc2V0dGluZ3M6J3dkdGgnIDExNTtmb250LXNpemU6MjJweDtsZXR0ZXItc3BhY2luZzotLjAxZW19CiAgLnJlcy1oZWFkIC5tZXRhe2ZvbnQtZmFtaWx5OidJQk0gUGxleCBNb25vJyxtb25vc3BhY2U7Zm9udC1zaXplOjEycHg7Y29sb3I6dmFyKC0tc3RlZWwpfQoKICAuYmxvY2t7YmFja2dyb3VuZDp2YXIoLS1jYXJkKTtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2JvcmRlci10b3A6bm9uZTtwYWRkaW5nOjI0cHggMjZweH0KICAuYmxvY2stdGl0bGV7ZGlzcGxheTpmbGV4O2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuO2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6MTJweDttYXJnaW4tYm90dG9tOjE2cHg7ZmxleC13cmFwOndyYXB9CiAgLmJsb2NrLXRpdGxlIGgze2ZvbnQtc2l6ZToxMnB4O2ZvbnQtd2VpZ2h0OjcwMDtsZXR0ZXItc3BhY2luZzouMmVtO3RleHQtdHJhbnNmb3JtOnVwcGVyY2FzZX0KICAuYmxvY2stdGl0bGUgaDMgc3Bhbntjb2xvcjp2YXIoLS1zZWFtKX0KICAuYnRuLWNvcHl7YmFja2dyb3VuZDp2YXIoLS1wYXBlcik7Y29sb3I6dmFyKC0taW5rKTtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWluayk7Zm9udC1zaXplOjExcHg7cGFkZGluZzo5cHggMTZweH0KICAuYnRuLWNvcHk6aG92ZXJ7YmFja2dyb3VuZDp2YXIoLS1pbmspO2NvbG9yOiNmZmZ9CiAgLmJ0bi1jb3B5LmNvcGllZHtiYWNrZ3JvdW5kOnZhcigtLW9rKTtib3JkZXItY29sb3I6dmFyKC0tb2spO2NvbG9yOiNmZmZ9CiAgLmJ0bi1ncm91cHtkaXNwbGF5OmZsZXg7Z2FwOjhweDtmbGV4LXdyYXA6d3JhcH0KCiAgLnNjb3JpbmctYm94e2Rpc3BsYXk6ZmxleDtnYXA6MThweDtmbGV4LXdyYXA6d3JhcDthbGlnbi1pdGVtczpmbGV4LWVuZDttYXJnaW4tYm90dG9tOjIwcHg7cGFkZGluZzoxNnB4O2JhY2tncm91bmQ6dmFyKC0tcGFwZXIpO2JvcmRlcjoxcHggZGFzaGVkIHZhcigtLWxpbmUpfQogIC5zY29yaW5nLWJveCAuZmllbGR7bWFyZ2luLWJvdHRvbTowfQogIC5zY29yaW5nLWJveCBsYWJlbHttYXJnaW4tYm90dG9tOjZweH0KCiAgdGFibGV7d2lkdGg6MTAwJTtib3JkZXItY29sbGFwc2U6Y29sbGFwc2U7Zm9udC1zaXplOjEzLjVweH0KICB0aHt0ZXh0LWFsaWduOmxlZnQ7Zm9udC1mYW1pbHk6J0lCTSBQbGV4IE1vbm8nLG1vbm9zcGFjZTtmb250LXNpemU6MTFweDtsZXR0ZXItc3BhY2luZzouMDhlbTt0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7Y29sb3I6dmFyKC0tc3RlZWwpO3BhZGRpbmc6OHB4IDEwcHg7Ym9yZGVyLWJvdHRvbToycHggc29saWQgdmFyKC0taW5rKTtjdXJzb3I6cG9pbnRlcjt1c2VyLXNlbGVjdDpub25lfQogIHRoOmhvdmVye2NvbG9yOnZhcigtLWluayl9CiAgdGR7cGFkZGluZzoxMHB4O2JvcmRlci1ib3R0b206MXB4IGRhc2hlZCB2YXIoLS1saW5lKTt2ZXJ0aWNhbC1hbGlnbjp0b3B9CiAgdHI6bGFzdC1jaGlsZCB0ZHtib3JkZXItYm90dG9tOm5vbmV9CiAgdGQgYXtjb2xvcjp2YXIoLS1zZWFtKTt0ZXh0LWRlY29yYXRpb246bm9uZTt3b3JkLWJyZWFrOmJyZWFrLXdvcmR9CiAgdGQgYTpob3Zlcnt0ZXh0LWRlY29yYXRpb246dW5kZXJsaW5lfQogIC5jYXQtdGFne2Rpc3BsYXk6aW5saW5lLWJsb2NrO2ZvbnQtZmFtaWx5OidJQk0gUGxleCBNb25vJyxtb25vc3BhY2U7Zm9udC1zaXplOjExcHg7YmFja2dyb3VuZDp2YXIoLS1zZWFtLXNvZnQpO2JvcmRlci1sZWZ0OjJweCBzb2xpZCB2YXIoLS1zZWFtKTtwYWRkaW5nOjJweCA2cHg7Y29sb3I6dmFyKC0taW5rKX0KICAuY2F0LXRhZy51bmtub3due2JhY2tncm91bmQ6dmFyKC0tcGFwZXIpO2JvcmRlci1sZWZ0LWNvbG9yOnZhcigtLXN0ZWVsKTtjb2xvcjp2YXIoLS1zdGVlbCl9CiAgLnNjb3JlLXRhZ3tkaXNwbGF5OmlubGluZS1ibG9jaztmb250LWZhbWlseTonSUJNIFBsZXggTW9ubycsbW9ub3NwYWNlO2ZvbnQtc2l6ZToxMnB4O2ZvbnQtd2VpZ2h0OjYwMDtwYWRkaW5nOjJweCA4cHg7YmFja2dyb3VuZDp2YXIoLS1pbmspO2NvbG9yOiNmZmZ9CiAgLmV4aXN0aW5nLXRhZ3tkaXNwbGF5OmlubGluZS1ibG9jaztmb250LWZhbWlseTonSUJNIFBsZXggTW9ubycsbW9ub3NwYWNlO2ZvbnQtc2l6ZToxMXB4O2JhY2tncm91bmQ6I0VBRjNFQztib3JkZXItbGVmdDoycHggc29saWQgdmFyKC0tb2spO3BhZGRpbmc6MnB4IDZweDtjb2xvcjp2YXIoLS1vayk7Zm9udC13ZWlnaHQ6NjAwfQogIC5jYWNoZWQtdGFne2Rpc3BsYXk6aW5saW5lLWJsb2NrO2ZvbnQtZmFtaWx5OidJQk0gUGxleCBNb25vJyxtb25vc3BhY2U7Zm9udC1zaXplOjEwcHg7Y29sb3I6dmFyKC0tc3RlZWwpO21hcmdpbi1sZWZ0OjZweH0KICAudGFibGUtd3JhcHtvdmVyZmxvdy14OmF1dG99CiAgLnRhYmxlLXdyYXAuc2Nyb2xse21heC1oZWlnaHQ6NTIwcHg7b3ZlcmZsb3cteTphdXRvfQoKICBmb290ZXJ7bWFyZ2luLXRvcDo1NnB4O2ZvbnQtc2l6ZToxMnB4O2NvbG9yOnZhcigtLXN0ZWVsKTtmb250LWZhbWlseTonSUJNIFBsZXggTW9ubycsbW9ub3NwYWNlfQogIEBtZWRpYShtYXgtd2lkdGg6NTYwcHgpey5wYW5lbHtwYWRkaW5nOjIwcHggMTZweH0uYmxvY2t7cGFkZGluZzoxOHB4IDE0cHh9LnRhYntwYWRkaW5nOjEycHggMTJweDtmb250LXNpemU6MTFweH19Cjwvc3R5bGU+CjwvaGVhZD4KPGJvZHk+CjxkaXYgY2xhc3M9IndyYXAiPgoKICA8aGVhZGVyPgogICAgPGRpdiBjbGFzcz0iYnJhbmQiPk1vZG9uaXggJm1pZGRvdDsgQ3VzdG9tZXIgVG9vbGtpdDwvZGl2PgogICAgPGgxPkN1c3RvbWVyIDxzcGFuIGNsYXNzPSJzZWFtd29yZCI+VG9vbGtpdDwvc3Bhbj48L2gxPgogICAgPHAgY2xhc3M9InRhZ2xpbmUiPlRocmVlIHRvb2xzLCBvbmUgcm9vZi4gQ2xhc3NpZnkgd2hvIHlvdXIgY3VzdG9tZXJzIGFscmVhZHkgYXJlLCBmaW5kIG5ldyBwcm9zcGVjdHMgYnkgY2F0ZWdvcnksIG9yIGZpbmQgbG9va2FsaWtlcyBvZiBhIGN1c3RvbWVyIHlvdSBhbHJlYWR5IGxpa2UuIEtleXMgc3RheSBvbiB0aGUgc2VydmVyICZtZGFzaDsgbm90aGluZyBzZW5zaXRpdmUgdG91Y2hlcyB0aGlzIHBhZ2UuPC9wPgogIDwvaGVhZGVyPgoKICA8ZGl2IGNsYXNzPSJ0YWJzIiByb2xlPSJ0YWJsaXN0Ij4KICAgIDxidXR0b24gY2xhc3M9InRhYiBhY3RpdmUiIGlkPSJ0YWItZmluZGVyIiBvbmNsaWNrPSJzaG93VGFiKCdmaW5kZXInKSI+UHJvc3BlY3QgRmluZGVyPC9idXR0b24+CiAgICA8YnV0dG9uIGNsYXNzPSJ0YWIiIGlkPSJ0YWItc2ltaWxhciIgb25jbGljaz0ic2hvd1RhYignc2ltaWxhcicpIj5GaW5kIFNpbWlsYXI8L2J1dHRvbj4KICAgIDxidXR0b24gY2xhc3M9InRhYiIgaWQ9InRhYi1jbGFzc2lmeSIgb25jbGljaz0ic2hvd1RhYignY2xhc3NpZnknKSI+Q3VzdG9tZXIgQ2xhc3NpZmllcjwvYnV0dG9uPgogICAgPGJ1dHRvbiBjbGFzcz0idGFiIiBpZD0idGFiLWNhdGVnb3JpZXMiIG9uY2xpY2s9InNob3dUYWIoJ2NhdGVnb3JpZXMnKSI+Q2F0ZWdvcmllczwvYnV0dG9uPgogICAgPGJ1dHRvbiBjbGFzcz0idGFiIiBpZD0idGFiLXJldmlldyIgb25jbGljaz0ic2hvd1RhYigncmV2aWV3JykiPlJldmlldyAmYW1wOyBTYXZlPC9idXR0b24+CiAgICA8YnV0dG9uIGNsYXNzPSJ0YWIiIGlkPSJ0YWItcmVwb3J0cyIgb25jbGljaz0ic2hvd1RhYigncmVwb3J0cycpIj5SZXBvcnRzPC9idXR0b24+CiAgPC9kaXY+CgogIDwhLS0gPT09PT09PT09PT09PT09PT09PT0gVEFCIDE6IFBST1NQRUNUIEZJTkRFUiA9PT09PT09PT09PT09PT09PT09PSAtLT4KICA8ZGl2IGNsYXNzPSJ0YWJwYW5lbCBhY3RpdmUiIGlkPSJwYW5lbC1maW5kZXIiPgogICAgPGRpdiBjbGFzcz0icGFuZWwiPgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+CiAgICAgICAgPGxhYmVsIGZvcj0iY2F0ZWdvcnkiPkNhdGVnb3J5IDxzcGFuIGNsYXNzPSJvcHQiPihvbmx5IGNhdGVnb3JpZXMgYWRkZWQgb24gdGhlIENhdGVnb3JpZXMgdGFiIGNhbiBiZSBzZWFyY2hlZCk8L3NwYW4+PC9sYWJlbD4KICAgICAgICA8c2VsZWN0IGlkPSJjYXRlZ29yeSIgb25jaGFuZ2U9Im9uQ2F0ZWdvcnlDaGFuZ2UoJycsICdzdWJDYXRlZ29yeScpIj4KICAgICAgICAgIDxvcHRpb24gdmFsdWU9IiI+LS0gQ2hvb3NlIGEgY2F0ZWdvcnkgLS08L29wdGlvbj4KICAgICAgICA8L3NlbGVjdD4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj4KICAgICAgICA8bGFiZWwgZm9yPSJzdWJDYXRlZ29yeSI+U3ViLUNhdGVnb3J5IDxzcGFuIGNsYXNzPSJvcHQiPihvcHRpb25hbCDigJQgbGVhdmUgYmxhbmsgZm9yIGEgYnJvYWQgc2VhcmNoKTwvc3Bhbj48L2xhYmVsPgogICAgICAgIDxzZWxlY3QgaWQ9InN1YkNhdGVnb3J5Ij4KICAgICAgICAgIDxvcHRpb24gdmFsdWU9IiI+LS0gQW55IC8gYnJvYWQgLS08L29wdGlvbj4KICAgICAgICA8L3NlbGVjdD4KICAgICAgPC9kaXY+CgogICAgICA8ZGl2IGNsYXNzPSJyb3ciIHN0eWxlPSJtYXJnaW4tYm90dG9tOjIwcHg7YWxpZ24taXRlbXM6ZmxleC1lbmQiPgogICAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIiBzdHlsZT0ibWFyZ2luLWJvdHRvbTowIj4KICAgICAgICAgIDxsYWJlbCBmb3I9ImxvY1R5cGUiIHN0eWxlPSJtYXJnaW4tYm90dG9tOjZweCI+U2VhcmNoIGJ5PC9sYWJlbD4KICAgICAgICAgIDxzZWxlY3QgaWQ9ImxvY1R5cGUiPgogICAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJ6aXAiPlpJUCBjb2RlPC9vcHRpb24+CiAgICAgICAgICAgIDxvcHRpb24gdmFsdWU9ImNpdHkiPkNpdHk8L29wdGlvbj4KICAgICAgICAgIDwvc2VsZWN0PgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImNvdW50LXNlbGVjdCI+CiAgICAgICAgICA8bGFiZWwgZm9yPSJyYWRpdXMiIHN0eWxlPSJtYXJnaW46MDtmb250LXNpemU6MTFweCI+UmFkaXVzPC9sYWJlbD4KICAgICAgICAgIDxzZWxlY3QgaWQ9InJhZGl1cyI+CiAgICAgICAgICAgIDxvcHRpb24gdmFsdWU9IjE2MDAwIj4xMCBtaTwvb3B0aW9uPgogICAgICAgICAgICA8b3B0aW9uIHZhbHVlPSIzMjAwMCIgc2VsZWN0ZWQ+MjAgbWk8L29wdGlvbj4KICAgICAgICAgICAgPG9wdGlvbiB2YWx1ZT0iNDgwMDAiPjMwIG1pIChwcmFjdGljYWwgbWF4KTwvb3B0aW9uPgogICAgICAgICAgPC9zZWxlY3Q+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iY291bnQtc2VsZWN0Ij4KICAgICAgICAgIDxsYWJlbCBmb3I9ImRldGFpbHMiIHN0eWxlPSJtYXJnaW46MDtmb250LXNpemU6MTFweCI+UGhvbmUgJmFtcDsgd2Vic2l0ZTwvbGFiZWw+CiAgICAgICAgICA8c2VsZWN0IGlkPSJkZXRhaWxzIj4KICAgICAgICAgICAgPG9wdGlvbiB2YWx1ZT0ieWVzIiBzZWxlY3RlZD5JbmNsdWRlPC9vcHRpb24+CiAgICAgICAgICAgIDxvcHRpb24gdmFsdWU9Im5vIj5Ta2lwIChjaGVhcGVzdCk8L29wdGlvbj4KICAgICAgICAgIDwvc2VsZWN0PgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImNvdW50LXNlbGVjdCI+CiAgICAgICAgICA8bGFiZWwgZm9yPSJtYXhTZWFyY2hlcyIgc3R5bGU9Im1hcmdpbjowO2ZvbnQtc2l6ZToxMXB4Ij5TZXNzaW9uIGNhcDwvbGFiZWw+CiAgICAgICAgICA8aW5wdXQgdHlwZT0ibnVtYmVyIiBpZD0ibWF4U2VhcmNoZXMiIHZhbHVlPSIyNSIgbWluPSIxIiBtYXg9IjUwMCI+CiAgICAgICAgPC9kaXY+CiAgICAgIDwvZGl2PgoKICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPgogICAgICAgIDxsYWJlbCBmb3I9ImxvY1ZhbHVlIj5Mb2NhdGlvbihzKSA8c3BhbiBjbGFzcz0ib3B0IiBpZD0ibG9jSGludCI+KG9uZSBaSVAgcGVyIGxpbmUg4oCUIGFkZCBtb3JlIGxpbmVzIHRvIHNlYXJjaCBtdWx0aXBsZSBhcmVhcyBpbiBvbmUgcnVuKTwvc3Bhbj48L2xhYmVsPgogICAgICAgIDx0ZXh0YXJlYSBpZD0ibG9jVmFsdWUiIHJvd3M9IjMiIHBsYWNlaG9sZGVyPSIzMjkzNyYjMTA7MzI5MDEmIzEwOzMyOTM1Ij48L3RleHRhcmVhPgogICAgICA8L2Rpdj4KCiAgICAgIDxkaXYgY2xhc3M9InNjb3JpbmctYm94Ij4KICAgICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+CiAgICAgICAgICA8bGFiZWwgZm9yPSJzY29yZVdlYnNpdGUiPkhhcyB3ZWJzaXRlPC9sYWJlbD4KICAgICAgICAgIDxpbnB1dCB0eXBlPSJudW1iZXIiIGlkPSJzY29yZVdlYnNpdGUiIHZhbHVlPSIyIiBtaW49IjAiIG1heD0iMjAiPgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj4KICAgICAgICAgIDxsYWJlbCBmb3I9InNjb3JlUGhvbmUiPkhhcyBwaG9uZTwvbGFiZWw+CiAgICAgICAgICA8aW5wdXQgdHlwZT0ibnVtYmVyIiBpZD0ic2NvcmVQaG9uZSIgdmFsdWU9IjEiIG1pbj0iMCIgbWF4PSIyMCI+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZmllbGQiIHN0eWxlPSJmbGV4OjE7bWluLXdpZHRoOjIyMHB4Ij4KICAgICAgICAgIDxsYWJlbCBmb3I9InNjb3JlS2V5d29yZHMiPkJvbnVzIGtleXdvcmRzIGluIG5hbWUgPHNwYW4gY2xhc3M9Im9wdCI+KGNvbW1hIHNlcGFyYXRlZCwgb3B0aW9uYWwpPC9zcGFuPjwvbGFiZWw+CiAgICAgICAgICA8aW5wdXQgdHlwZT0idGV4dCIgaWQ9InNjb3JlS2V5d29yZHMiIHBsYWNlaG9sZGVyPSJlLmcuIGluZHVzdHJpYWwsIGNvbW1lcmNpYWwsIHdob2xlc2FsZSI+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPgogICAgICAgICAgPGxhYmVsIGZvcj0ic2NvcmVLZXl3b3JkUHRzIj5Qb2ludHMgcGVyIGtleXdvcmQ8L2xhYmVsPgogICAgICAgICAgPGlucHV0IHR5cGU9Im51bWJlciIgaWQ9InNjb3JlS2V5d29yZFB0cyIgdmFsdWU9IjEiIG1pbj0iMCIgbWF4PSIyMCI+CiAgICAgICAgPC9kaXY+CiAgICAgIDwvZGl2PgoKICAgICAgPGRpdiBjbGFzcz0icm93Ij4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4tbWluZSIgaWQ9ImZpbmRCdG4iIG9uY2xpY2s9InJ1blNlYXJjaCgpIj5GaW5kIFByb3NwZWN0czwvYnV0dG9uPgogICAgICAgIDxidXR0b24gY2xhc3M9ImJ0bi1zZWNvbmRhcnkiIG9uY2xpY2s9InNhdmVDdXJyZW50U2VhcmNoKCkiPlNhdmUgVGhpcyBTZWFyY2ggU2V0dXA8L2J1dHRvbj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InN0YXR1cyIgaWQ9InN0YXR1cyI+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImNvc3Qtbm90ZSI+CiAgICAgICAgRWFjaCBsb2NhdGlvbiBzZWFyY2hlZCBpcyBvbmUgYmlsbGVkIHJlcXVlc3QgYmVoaW5kIHRoZSBzY2VuZXMsIHdoZXRoZXIgaXQgZmluZHMgMiBidXNpbmVzc2VzIG9yIDIwIOKAlCB1bmxlc3MgdGhhdCBleGFjdCBjYXRlZ29yeSBhbmQgYXJlYSB3YXMgYWxyZWFkeSBzZWFyY2hlZCByZWNlbnRseSwgaW4gd2hpY2ggY2FzZSB0aGUgc2F2ZWQgcmVzdWx0IGlzIHJldXNlZCBhdCBubyBjb3N0LiBFYWNoIHVuaXF1ZSBidXNpbmVzcyBmb3VuZCBpcyBhbHNvIGNsYXNzaWZpZWQgKEluZHVzdHJ5L1N1Yi1JbmR1c3RyeSwgc2FtZSBlbmdpbmUgYXMgdGhlIEN1c3RvbWVyIENsYXNzaWZpZXIgdGFiKSBhbmQgY2hlY2tlZCBmb3IgYSBwdWJsaWMgZW1haWwgb24gaXRzIHdlYnNpdGUg4oCUIGNsYXNzaWZpY2F0aW9uIGNvc3RzIGFib3V0IGEgcGVubnkgcGVyIG5ldyBidXNpbmVzcywgcmV1c2VkIGZyb20gdGhlIHNhdmVkIGxpc3QgaWYgYWxyZWFkeSBrbm93bi4gUmVzdWx0cyBhcmUgZGVkdXBsaWNhdGVkIGFjcm9zcyBldmVyeSBsb2NhdGlvbiBpbiB0aGlzIHJ1bi4gVGhlIHNlc3Npb24gY2FwIGlzIGEgc2FtZS10YWIgY29udmVuaWVuY2UgbGltaXQsIHJlYWwgdXNhZ2UgY29udHJvbCBsaXZlcyBpbiB5b3VyIEdvb2dsZSBDbG91ZCBidWRnZXQvcXVvdGEgc2V0dGluZ3Mgb24gdGhlIHNlcnZlciBzaWRlLgogICAgICA8L2Rpdj4KCiAgICAgIDxkaXYgY2xhc3M9InNhdmVkLXBhbmVsIj4KICAgICAgICA8bGFiZWwgc3R5bGU9Im1hcmdpbi1ib3R0b206MTBweCI+U2F2ZWQgU2VhcmNoIFNldHVwcyA8c3BhbiBjbGFzcz0ib3B0Ij4oc3RvcmVkIGluIHRoaXMgYnJvd3NlciBvbmx5KTwvc3Bhbj48L2xhYmVsPgogICAgICAgIDxkaXYgaWQ9InNhdmVkTGlzdCI+PC9kaXY+CiAgICAgIDwvZGl2PgogICAgPC9kaXY+CgogICAgPGRldGFpbHMgY2xhc3M9ImhlbHAiPgogICAgICA8c3VtbWFyeT5Ib3cgdG8gdXNlIHRoZSBQcm9zcGVjdCBGaW5kZXI8L3N1bW1hcnk+CiAgICAgIDxkaXYgY2xhc3M9ImhlbHAtYm9keSI+CiAgICAgICAgPG9sPgogICAgICAgICAgPGxpPjxzdHJvbmc+Q3VzdG9tZXIgQ2F0ZWdvcnk8L3N0cm9uZz4gaXMgd2hhdCBraW5kIG9mIGJ1c2luZXNzIHlvdSdyZSBsb29raW5nIGZvciwgd3JpdHRlbiBsaWtlIHlvdSdkIHNlYXJjaCBHb29nbGUsIGUuZy4gImNvbW1lcmNpYWwgcGx1bWJpbmcgY29udHJhY3RvciIgb3IgImluZHVzdHJpYWwgc2FmZXR5IGVxdWlwbWVudCBkaXN0cmlidXRvci4iIFN0YXJ0IHR5cGluZyB0byBzZWUgY2F0ZWdvcmllcyBhbHJlYWR5IGZvdW5kIGFtb25nIHlvdXIgY2xhc3NpZmllZCBjdXN0b21lcnMuPC9saT4KICAgICAgICAgIDxsaT48c3Ryb25nPkxvY2F0aW9uKHMpPC9zdHJvbmc+IHRha2VzIG9uZSBaSVAgY29kZSBvciBjaXR5IHBlciBsaW5lLiBBZGQgc2V2ZXJhbCBsaW5lcyB0byBjb3ZlciBtdWx0aXBsZSBhcmVhcyBpbiBhIHNpbmdsZSBydW4sIHJlc3VsdHMgYWNyb3NzIGFsbCBvZiB0aGVtIGdldCBjb21iaW5lZCBhbmQgZGVkdXBsaWNhdGVkIGF1dG9tYXRpY2FsbHkuPC9saT4KICAgICAgICAgIDxsaT48c3Ryb25nPlJhZGl1czwvc3Ryb25nPiBjb250cm9scyBob3cgZmFyIG91dCBmcm9tIGVhY2ggbG9jYXRpb24gdG8gc2VhcmNoLiBHb29nbGUncyBwcmFjdGljYWwgbGltaXQgaXMgYXJvdW5kIDMwIG1pbGVzIHBlciBwb2ludCwgZW50ZXJpbmcgYSBiaWdnZXIgYXJlYSBqdXN0IG1lYW5zIGFkZGluZyBtb3JlIGxvY2F0aW9uIGxpbmVzIGluc3RlYWQuPC9saT4KICAgICAgICAgIDxsaT48c3Ryb25nPkxlYWQgc2NvcmluZzwvc3Ryb25nPiBnaXZlcyBldmVyeSByZXN1bHQgYSBwb2ludCB0b3RhbCBiYXNlZCBvbiB0aGUgcnVsZXMgeW91IHNldCAoaGF2aW5nIGEgd2Vic2l0ZSwgaGF2aW5nIGEgcGhvbmUgbnVtYmVyLCBtYXRjaGluZyBib251cyBrZXl3b3JkcyBpbiB0aGUgYnVzaW5lc3MgbmFtZSkuIEhpZ2hlci1zY29yaW5nLCBtb3JlIGNvbXBsZXRlIGxlYWRzIHNvcnQgdG8gdGhlIHRvcC48L2xpPgogICAgICAgICAgPGxpPjxzdHJvbmc+RXhpc3RpbmcgQ3VzdG9tZXI8L3N0cm9uZz4gdGFncyBzaG93IHVwIGF1dG9tYXRpY2FsbHkgaWYgYSByZXN1bHQncyB3ZWJzaXRlIGRvbWFpbiBtYXRjaGVzIG9uZSBvZiB5b3VyIGFscmVhZHktY2xhc3NpZmllZCBjdXN0b21lcnMsIHNvIHlvdSBkb24ndCB3YXN0ZSB0aW1lIG9uIHNvbWVvbmUgeW91IGFscmVhZHkgd29yayB3aXRoLjwvbGk+CiAgICAgICAgICA8bGk+PHN0cm9uZz5TYXZlIFRoaXMgU2VhcmNoIFNldHVwPC9zdHJvbmc+IHJlbWVtYmVycyB5b3VyIGNhdGVnb3J5LCBsb2NhdGlvbnMsIGFuZCBzZXR0aW5ncyBmb3IgbmV4dCB0aW1lLCBpdCBkb2VzIG5vdCBzYXZlIHRoZSByZXN1bHRzIHRoZW1zZWx2ZXMsIGp1c3QgdGhlIHNldHVwIHNvIHlvdSBjYW4gcmVydW4gaXQgZnJlc2guPC9saT4KICAgICAgICAgIDxsaT5XaGVuIHJlc3VsdHMgY29tZSBpbiwgdXNlIDxzdHJvbmc+RG93bmxvYWQgRXhjZWw8L3N0cm9uZz4gZm9yIGEgc3ByZWFkc2hlZXQgZmlsZSwgb3IgPHN0cm9uZz5Db3B5IGZvciBTaGVldHM8L3N0cm9uZz4gdG8gcGFzdGUgZGlyZWN0bHkgaW50byBhbiBvcGVuIEdvb2dsZSBTaGVldC48L2xpPgogICAgICAgIDwvb2w+CiAgICAgIDwvZGl2PgogICAgPC9kZXRhaWxzPgogIDwvZGl2PgoKICA8IS0tID09PT09PT09PT09PT09PT09PT09IFRBQiAyOiBGSU5EIFNJTUlMQVIgPT09PT09PT09PT09PT09PT09PT0gLS0+CiAgPGRpdiBjbGFzcz0idGFicGFuZWwiIGlkPSJwYW5lbC1zaW1pbGFyIj4KICAgIDxkaXYgY2xhc3M9InBhbmVsIj4KICAgICAgPGRpdiBjbGFzcz0ic2VlZC1ib3giPgogICAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj4KICAgICAgICAgIDxsYWJlbCBmb3I9ImZzX3NlZWROYW1lIj5TZWVkIGN1c3RvbWVyIDxzcGFuIGNsYXNzPSJvcHQiPihwaWNrIG9uZSB5b3UndmUgYWxyZWFkeSBjbGFzc2lmaWVkLCBvciB0eXBlIGFueSBuYW1lKTwvc3Bhbj48L2xhYmVsPgogICAgICAgICAgPGlucHV0IHR5cGU9InRleHQiIGlkPSJmc19zZWVkTmFtZSIgbGlzdD0ic2F2ZWRDdXN0b21lck9wdGlvbnMiIHBsYWNlaG9sZGVyPSJlLmcuIEJyYWNlIE1hbnVmYWN0dXJpbmciIG9uY2hhbmdlPSJmaWxsU2VlZEZyb21TYXZlZEN1c3RvbWVyKCkiPgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9InJvdyIgc3R5bGU9ImFsaWduLWl0ZW1zOmZsZXgtZW5kIj4KICAgICAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIiBzdHlsZT0iZmxleDoxO21pbi13aWR0aDoyMDBweDttYXJnaW4tYm90dG9tOjAiPgogICAgICAgICAgICA8bGFiZWwgZm9yPSJmc19zZWVkTG9jYXRpb24iPkl0cyBjaXR5IC8gc3RhdGUgb3IgWklQIDxzcGFuIGNsYXNzPSJvcHQiPihoZWxwcyBmaW5kIHRoZSBleGFjdCBvbmUpPC9zcGFuPjwvbGFiZWw+CiAgICAgICAgICAgIDxpbnB1dCB0eXBlPSJ0ZXh0IiBpZD0iZnNfc2VlZExvY2F0aW9uIiBwbGFjZWhvbGRlcj0iZS5nLiBHYXJsYW5kLCBUWCI+CiAgICAgICAgICA8L2Rpdj4KICAgICAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIiBzdHlsZT0iZmxleDoxO21pbi13aWR0aDoyMDBweDttYXJnaW4tYm90dG9tOjAiPgogICAgICAgICAgICA8bGFiZWwgZm9yPSJmc19zZWVkV2Vic2l0ZSI+V2Vic2l0ZSA8c3BhbiBjbGFzcz0ib3B0Ij4ob3B0aW9uYWwpPC9zcGFuPjwvbGFiZWw+CiAgICAgICAgICAgIDxpbnB1dCB0eXBlPSJ0ZXh0IiBpZD0iZnNfc2VlZFdlYnNpdGUiIHBsYWNlaG9sZGVyPSJlLmcuIGJyYWNlbWFudWZhY3R1cmluZy5jb20iPgogICAgICAgICAgPC9kaXY+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0icm93IiBzdHlsZT0ibWFyZ2luLXRvcDoxNnB4Ij4KICAgICAgICAgIDxidXR0b24gY2xhc3M9ImJ0bi1zZWNvbmRhcnkiIGlkPSJmc19hbmFseXplQnRuIiBvbmNsaWNrPSJhbmFseXplU2VlZCgpIj5BbmFseXplIFNlZWQgJnJhcnI7IFN1Z2dlc3QgQ2F0ZWdvcnk8L2J1dHRvbj4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJzZWVkLWluZm8iIGlkPSJmc19zZWVkSW5mbyI+PC9kaXY+CiAgICAgIDwvZGl2PgoKICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPgogICAgICAgIDxsYWJlbCBmb3I9ImZzX2NhdGVnb3J5Ij5DYXRlZ29yeSA8c3BhbiBjbGFzcz0ib3B0Ij4oYXV0by1maWxsZWQgZnJvbSB0aGUgc2VlZCBpZiBpdCBtYXRjaGVzIG9uZSB5b3UgaGF2ZSDigJQgb3RoZXJ3aXNlIHBpY2sgb3IgYWRkIG9uZSk8L3NwYW4+PC9sYWJlbD4KICAgICAgICA8c2VsZWN0IGlkPSJmc19jYXRlZ29yeSIgb25jaGFuZ2U9Im9uQ2F0ZWdvcnlDaGFuZ2UoJ2ZzXycsICdmc19zdWJDYXRlZ29yeScpIj4KICAgICAgICAgIDxvcHRpb24gdmFsdWU9IiI+LS0gQ2hvb3NlIGEgY2F0ZWdvcnkgLS08L29wdGlvbj4KICAgICAgICA8L3NlbGVjdD4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj4KICAgICAgICA8bGFiZWwgZm9yPSJmc19zdWJDYXRlZ29yeSI+U3ViLUNhdGVnb3J5IDxzcGFuIGNsYXNzPSJvcHQiPihvcHRpb25hbCDigJQgbGVhdmUgYmxhbmsgZm9yIGEgYnJvYWQgc2VhcmNoKTwvc3Bhbj48L2xhYmVsPgogICAgICAgIDxzZWxlY3QgaWQ9ImZzX3N1YkNhdGVnb3J5Ij4KICAgICAgICAgIDxvcHRpb24gdmFsdWU9IiI+LS0gQW55IC8gYnJvYWQgLS08L29wdGlvbj4KICAgICAgICA8L3NlbGVjdD4KICAgICAgPC9kaXY+CgogICAgICA8ZGl2IGNsYXNzPSJyb3ciIHN0eWxlPSJtYXJnaW4tYm90dG9tOjIwcHg7YWxpZ24taXRlbXM6ZmxleC1lbmQiPgogICAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIiBzdHlsZT0ibWFyZ2luLWJvdHRvbTowIj4KICAgICAgICAgIDxsYWJlbCBmb3I9ImZzX2xvY1R5cGUiIHN0eWxlPSJtYXJnaW4tYm90dG9tOjZweCI+U2VhcmNoIGJ5PC9sYWJlbD4KICAgICAgICAgIDxzZWxlY3QgaWQ9ImZzX2xvY1R5cGUiPgogICAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJ6aXAiPlpJUCBjb2RlPC9vcHRpb24+CiAgICAgICAgICAgIDxvcHRpb24gdmFsdWU9ImNpdHkiPkNpdHk8L29wdGlvbj4KICAgICAgICAgIDwvc2VsZWN0PgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImNvdW50LXNlbGVjdCI+CiAgICAgICAgICA8bGFiZWwgZm9yPSJmc19yYWRpdXMiIHN0eWxlPSJtYXJnaW46MDtmb250LXNpemU6MTFweCI+UmFkaXVzPC9sYWJlbD4KICAgICAgICAgIDxzZWxlY3QgaWQ9ImZzX3JhZGl1cyI+CiAgICAgICAgICAgIDxvcHRpb24gdmFsdWU9IjE2MDAwIj4xMCBtaTwvb3B0aW9uPgogICAgICAgICAgICA8b3B0aW9uIHZhbHVlPSIzMjAwMCIgc2VsZWN0ZWQ+MjAgbWk8L29wdGlvbj4KICAgICAgICAgICAgPG9wdGlvbiB2YWx1ZT0iNDgwMDAiPjMwIG1pIChwcmFjdGljYWwgbWF4KTwvb3B0aW9uPgogICAgICAgICAgPC9zZWxlY3Q+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iY291bnQtc2VsZWN0Ij4KICAgICAgICAgIDxsYWJlbCBmb3I9ImZzX2RldGFpbHMiIHN0eWxlPSJtYXJnaW46MDtmb250LXNpemU6MTFweCI+UGhvbmUgJmFtcDsgd2Vic2l0ZTwvbGFiZWw+CiAgICAgICAgICA8c2VsZWN0IGlkPSJmc19kZXRhaWxzIj4KICAgICAgICAgICAgPG9wdGlvbiB2YWx1ZT0ieWVzIiBzZWxlY3RlZD5JbmNsdWRlPC9vcHRpb24+CiAgICAgICAgICAgIDxvcHRpb24gdmFsdWU9Im5vIj5Ta2lwIChjaGVhcGVzdCk8L29wdGlvbj4KICAgICAgICAgIDwvc2VsZWN0PgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImNvdW50LXNlbGVjdCI+CiAgICAgICAgICA8bGFiZWwgZm9yPSJmc19tYXhTZWFyY2hlcyIgc3R5bGU9Im1hcmdpbjowO2ZvbnQtc2l6ZToxMXB4Ij5TZXNzaW9uIGNhcDwvbGFiZWw+CiAgICAgICAgICA8aW5wdXQgdHlwZT0ibnVtYmVyIiBpZD0iZnNfbWF4U2VhcmNoZXMiIHZhbHVlPSIyNSIgbWluPSIxIiBtYXg9IjUwMCI+CiAgICAgICAgPC9kaXY+CiAgICAgIDwvZGl2PgoKICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPgogICAgICAgIDxsYWJlbCBmb3I9ImZzX2xvY1ZhbHVlIj5Mb2NhdGlvbihzKSA8c3BhbiBjbGFzcz0ib3B0IiBpZD0iZnNfbG9jSGludCI+KG9uZSBaSVAgcGVyIGxpbmUg4oCUIEZsb3JpZGEtd2lkZSBtZWFucyBhZGRpbmcgdGhlIFpJUHMvY2l0aWVzIHlvdSB3YW50IHRvIGNvdmVyKTwvc3Bhbj48L2xhYmVsPgogICAgICAgIDx0ZXh0YXJlYSBpZD0iZnNfbG9jVmFsdWUiIHJvd3M9IjMiIHBsYWNlaG9sZGVyPSIzMzgxMSYjMTA7MzM4MTMmIzEwOzMzODMwIj48L3RleHRhcmVhPgogICAgICA8L2Rpdj4KCiAgICAgIDxkaXYgY2xhc3M9InNjb3JpbmctYm94Ij4KICAgICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+CiAgICAgICAgICA8bGFiZWwgZm9yPSJmc19zY29yZVdlYnNpdGUiPkhhcyB3ZWJzaXRlPC9sYWJlbD4KICAgICAgICAgIDxpbnB1dCB0eXBlPSJudW1iZXIiIGlkPSJmc19zY29yZVdlYnNpdGUiIHZhbHVlPSIyIiBtaW49IjAiIG1heD0iMjAiPgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj4KICAgICAgICAgIDxsYWJlbCBmb3I9ImZzX3Njb3JlUGhvbmUiPkhhcyBwaG9uZTwvbGFiZWw+CiAgICAgICAgICA8aW5wdXQgdHlwZT0ibnVtYmVyIiBpZD0iZnNfc2NvcmVQaG9uZSIgdmFsdWU9IjEiIG1pbj0iMCIgbWF4PSIyMCI+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZmllbGQiIHN0eWxlPSJmbGV4OjE7bWluLXdpZHRoOjIyMHB4Ij4KICAgICAgICAgIDxsYWJlbCBmb3I9ImZzX3Njb3JlS2V5d29yZHMiPkJvbnVzIGtleXdvcmRzIGluIG5hbWUgPHNwYW4gY2xhc3M9Im9wdCI+KGNvbW1hIHNlcGFyYXRlZCwgb3B0aW9uYWwpPC9zcGFuPjwvbGFiZWw+CiAgICAgICAgICA8aW5wdXQgdHlwZT0idGV4dCIgaWQ9ImZzX3Njb3JlS2V5d29yZHMiIHBsYWNlaG9sZGVyPSJlLmcuIG1hbnVmYWN0dXJpbmcsIGZhYnJpY2F0aW9uLCBtYWNoaW5lIj4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+CiAgICAgICAgICA8bGFiZWwgZm9yPSJmc19zY29yZUtleXdvcmRQdHMiPlBvaW50cyBwZXIga2V5d29yZDwvbGFiZWw+CiAgICAgICAgICA8aW5wdXQgdHlwZT0ibnVtYmVyIiBpZD0iZnNfc2NvcmVLZXl3b3JkUHRzIiB2YWx1ZT0iMSIgbWluPSIwIiBtYXg9IjIwIj4KICAgICAgICA8L2Rpdj4KICAgICAgPC9kaXY+CgogICAgICA8ZGl2IGNsYXNzPSJyb3ciPgogICAgICAgIDxidXR0b24gY2xhc3M9ImJ0bi1taW5lIiBpZD0iZnNfZmluZEJ0biIgb25jbGljaz0icnVuU2ltaWxhclNlYXJjaCgpIj5GaW5kIFNpbWlsYXIgUHJvc3BlY3RzPC9idXR0b24+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJzdGF0dXMiIGlkPSJmc19zdGF0dXMiPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJjb3N0LW5vdGUiPgogICAgICAgICJBbmFseXplIFNlZWQiIGlzIG9uZSBsb29rdXAuIFRoZW4gZWFjaCBsb2NhdGlvbiBsaW5lIGlzIG9uZSBiaWxsZWQgcmVxdWVzdCwgc2FtZSBhcyB0aGUgUHJvc3BlY3QgRmluZGVyLCB1bmxlc3MgdGhhdCBleGFjdCBzZWFyY2ggd2FzIGFscmVhZHkgcnVuIHJlY2VudGx5LiBUaGUgc2VlZCBidXNpbmVzcyBpdHNlbGYgaXMgZHJvcHBlZCBmcm9tIHRoZSByZXN1bHRzIGF1dG9tYXRpY2FsbHkuIFNhbWUgZ2VvZ3JhcGh5IHJ1bGVzIGFwcGx5OiBHb29nbGUgY2FwcyBlYWNoIHBvaW50IG5lYXIgMzAgbWlsZXMsIHNvIGEgd2hvbGUgc3RhdGUgbWVhbnMgYWRkaW5nIG1vcmUgWklQL2NpdHkgbGluZXMgcmF0aGVyIHRoYW4gb25lIGdpYW50IHJhZGl1cy4KICAgICAgPC9kaXY+CiAgICA8L2Rpdj4KCiAgICA8ZGV0YWlscyBjbGFzcz0iaGVscCI+CiAgICAgIDxzdW1tYXJ5PkhvdyB0byB1c2UgRmluZCBTaW1pbGFyPC9zdW1tYXJ5PgogICAgICA8ZGl2IGNsYXNzPSJoZWxwLWJvZHkiPgogICAgICAgIDxvbD4KICAgICAgICAgIDxsaT48c3Ryb25nPlNlZWQgY3VzdG9tZXI8L3N0cm9uZz4gaXMgb25lIGNvbXBhbnkgeW91IGFscmVhZHkgbGlrZS4gQWRkIGl0cyBjaXR5L3N0YXRlIG9yIFpJUCBzbyBHb29nbGUgZmluZHMgdGhlIGV4YWN0IG9uZSwgYW5kIHRoZSB3ZWJzaXRlIGlmIHlvdSBoYXZlIGl0LjwvbGk+CiAgICAgICAgICA8bGk+PHN0cm9uZz5BbmFseXplIFNlZWQ8L3N0cm9uZz4gbG9va3MgdGhhdCBidXNpbmVzcyB1cCBhbmQgcHJvcG9zZXMgYSBDdXN0b21lciBDYXRlZ29yeS4gUmV2aWV3IGl0IGFuZCB0d2VhayBpdCBiZWZvcmUgc2VhcmNoaW5nIOKAlCB5b3Ugc3RheSBpbiBjb250cm9sIG9mIHRoZSB3b3JkaW5nLjwvbGk+CiAgICAgICAgICA8bGk+PHN0cm9uZz5Mb2NhdGlvbihzKTwvc3Ryb25nPiB3b3JrcyBleGFjdGx5IGxpa2UgdGhlIFByb3NwZWN0IEZpbmRlcjogb25lIFpJUCBvciBjaXR5IHBlciBsaW5lLCB0aWxlZCB0byBjb3ZlciBhcyBtdWNoIGFyZWEgYXMgeW91IHdhbnQuIE5vdCB0aGUgd2hvbGUgY291bnRyeSBpbiBvbmUgc2hvdC48L2xpPgogICAgICAgICAgPGxpPlJ1biBpdCBhbmQgdGhlIHJlc3VsdHMgZHJvcCBpbnRvIHRoZSBzYW1lIHRhYmxlLCB3aXRoIHRoZSBzZWVkIGNvbXBhbnkgaXRzZWxmIGxlZnQgb3V0LiBEb3dubG9hZCBFeGNlbCBvciBDb3B5IGZvciBTaGVldHMgbGlrZSB1c3VhbC48L2xpPgogICAgICAgIDwvb2w+CiAgICAgIDwvZGl2PgogICAgPC9kZXRhaWxzPgogIDwvZGl2PgoKICA8IS0tID09PT09PT09PT09PT09PT09PT09IFNIQVJFRCBGSU5ERVIgUkVTVUxUUyA9PT09PT09PT09PT09PT09PT09PSAtLT4KICA8ZGl2IGNsYXNzPSJyZXN1bHRzIiBpZD0icmVzdWx0cyI+CiAgICA8ZGl2IGNsYXNzPSJyZXMtaGVhZCI+CiAgICAgIDxoMj5Qcm9zcGVjdCBSZXBvcnQ8L2gyPgogICAgICA8ZGl2IGNsYXNzPSJtZXRhIiBpZD0icmVzTWV0YSI+PC9kaXY+CiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImJsb2NrIj4KICAgICAgPGRpdiBjbGFzcz0iYmxvY2stdGl0bGUiPgogICAgICAgIDxoMz48c3Bhbj4mIzk2NDY7PC9zcGFuPiBNYXRjaGVkIEJ1c2luZXNzZXM8L2gzPgogICAgICAgIDxkaXYgY2xhc3M9ImJ0bi1ncm91cCI+CiAgICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4tY29weSIgb25jbGljaz0iZG93bmxvYWRGaW5kZXJYbHN4KCkiPkRvd25sb2FkIEV4Y2VsPC9idXR0b24+CiAgICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4tY29weSIgaWQ9ImNvcHlTaGVldHNCdG4iIG9uY2xpY2s9ImNvcHlGaW5kZXJGb3JTaGVldHModGhpcykiPkNvcHkgZm9yIFNoZWV0czwvYnV0dG9uPgogICAgICAgIDwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0idGFibGUtd3JhcCI+CiAgICAgICAgPHRhYmxlIGlkPSJyZXN1bHRzVGFibGUiPgogICAgICAgICAgPHRoZWFkPgogICAgICAgICAgICA8dHI+CiAgICAgICAgICAgICAgPHRoIG9uY2xpY2s9InNvcnRCeSgnc2NvcmUnKSI+U2NvcmU8L3RoPgogICAgICAgICAgICAgIDx0aCBvbmNsaWNrPSJzb3J0QnkoJ25hbWUnKSI+QnVzaW5lc3M8L3RoPgogICAgICAgICAgICAgIDx0aCBvbmNsaWNrPSJzb3J0QnkoJ2FkZHJlc3MnKSI+QWRkcmVzczwvdGg+CiAgICAgICAgICAgICAgPHRoIG9uY2xpY2s9InNvcnRCeSgncGhvbmUnKSI+UGhvbmU8L3RoPgogICAgICAgICAgICAgIDx0aCBvbmNsaWNrPSJzb3J0QnkoJ3dlYnNpdGUnKSI+V2Vic2l0ZTwvdGg+CiAgICAgICAgICAgICAgPHRoIG9uY2xpY2s9InNvcnRCeSgnaW5kdXN0cnknKSI+SW5kdXN0cnk8L3RoPgogICAgICAgICAgICAgIDx0aCBvbmNsaWNrPSJzb3J0QnkoJ2VtYWlsJykiPkVtYWlsPC90aD4KICAgICAgICAgICAgICA8dGggb25jbGljaz0ic29ydEJ5KCdhcmVhJykiPk1hdGNoZWQgQXJlYTwvdGg+CiAgICAgICAgICAgICAgPHRoPkV4aXN0aW5nPzwvdGg+CiAgICAgICAgICAgIDwvdHI+CiAgICAgICAgICA8L3RoZWFkPgogICAgICAgICAgPHRib2R5IGlkPSJyZXN1bHRzQm9keSI+PC90Ym9keT4KICAgICAgICA8L3RhYmxlPgogICAgICA8L2Rpdj4KICAgIDwvZGl2PgogIDwvZGl2PgoKICA8IS0tID09PT09PT09PT09PT09PT09PT09IFRBQiAzOiBDVVNUT01FUiBDTEFTU0lGSUVSID09PT09PT09PT09PT09PT09PT09IC0tPgogIDxkaXYgY2xhc3M9InRhYnBhbmVsIiBpZD0icGFuZWwtY2xhc3NpZnkiPgogICAgPGRpdiBjbGFzcz0icGFuZWwiPgogICAgICA8cCBjbGFzcz0idGFnbGluZSIgc3R5bGU9Im1hcmdpbi10b3A6MDttYXJnaW4tYm90dG9tOjIycHgiPlVwbG9hZCBhIGN1c3RvbWVyIGV4cG9ydCB3aXRoIG5hbWVzIGFuZCBlbWFpbHMuIEl0IHB1bGxzIHRoZSBkb21haW4gb3V0IG9mIGVhY2ggZW1haWwsIHJlc2VhcmNoZXMgaXQsIGFuZCBmaWxscyBpbiBhbiBJbmR1c3RyeSBhbmQgYSBtb3JlIHNwZWNpZmljIFN1Yi1JbmR1c3RyeSBmb3IgZXZlcnkgcm93ICZtZGFzaDsgbm8gbWFudWFsIGxvb2t1cC4gVGhpcyB0YWIgb25seSBjbGFzc2lmaWVzIGFuZCBsZXRzIHlvdSBleHBvcnQgJm1kYXNoOyBub3RoaW5nIGlzIHNhdmVkIHRvIHlvdXIgY3VzdG9tZXIgZGF0YWJhc2UgYXV0b21hdGljYWxseS4gV2hlbiB5b3UncmUgcmVhZHksIHVzZSA8c3Ryb25nPlJldmlldyAmYW1wOyBTYXZlPC9zdHJvbmc+IHRvIHBpY2sgZXhhY3RseSB3aGljaCBvbmVzIHRvIGtlZXAuPC9wPgoKICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPgogICAgICAgIDxsYWJlbCBmb3I9ImZpbGVJbnB1dCI+Q3VzdG9tZXIgU2hlZXQgPHNwYW4gY2xhc3M9Im9wdCI+KC54bHN4IG9yIC5jc3Yg4oCUIG5lZWRzIGEgV2Vic2l0ZSBjb2x1bW4sIGV2ZXJ5dGhpbmcgZWxzZSBvcHRpb25hbCk8L3NwYW4+PC9sYWJlbD4KICAgICAgICA8ZGl2IGNsYXNzPSJyb3ciIHN0eWxlPSJtYXJnaW4tYm90dG9tOjEwcHgiPgogICAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuLXNlY29uZGFyeSIgb25jbGljaz0iZG93bmxvYWRDdXN0b21lclRlbXBsYXRlKCkiPkRvd25sb2FkIEJsYW5rIFRlbXBsYXRlPC9idXR0b24+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGlucHV0IHR5cGU9ImZpbGUiIGlkPSJmaWxlSW5wdXQiIGFjY2VwdD0iLnhsc3gsLnhscywuY3N2Ij4KICAgICAgICA8cCBjbGFzcz0iaGludCI+TG9va3MgZm9yIGEgY29sdW1uIGhlYWRlciBjb250YWluaW5nICJ3ZWJzaXRlIiAocmVxdWlyZWQpLCBhbmQgImVtYWlsIiwgImZpcnN0IiwgImxhc3QiLCAiY29tcGFueSIsICJjYXRlZ29yeSIsICJzdWIiIGlmIHByZXNlbnQuIElmIENhdGVnb3J5L1N1Yi1DYXRlZ29yeSBhcmUgYWxyZWFkeSBmaWxsZWQgaW4gb24gYSByb3csIHRoYXQgcm93IGlzIHVzZWQgYXMtaXMgYW5kIHNraXBwZWQgZnJvbSByZXNlYXJjaC48L3A+CiAgICAgIDwvZGl2PgoKICAgICAgPGRpdiBjbGFzcz0icm93Ij4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4tbWluZSIgaWQ9ImNsc1J1bkJ0biIgb25jbGljaz0icnVuQ2xhc3NpZnkoKSI+Q2xhc3NpZnkgQ3VzdG9tZXJzPC9idXR0b24+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJzdGF0dXMiIGlkPSJjbHNfc3RhdHVzIj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0icHJvZ3Jlc3MtYmFyIiBpZD0iY2xzUHJvZ3Jlc3NCYXIiPjxkaXYgY2xhc3M9InByb2dyZXNzLWZpbGwiIGlkPSJjbHNQcm9ncmVzc0ZpbGwiPjwvZGl2PjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJjb3N0LW5vdGUiPgogICAgICAgIFJvd3Mgc2hhcmluZyB0aGUgc2FtZSBlbWFpbCBkb21haW4gYXJlIG9ubHkgcmVzZWFyY2hlZCBvbmNlIGFuZCB0aGUgbGFiZWwgaXMgcmV1c2VkLCBzbyBhIGJhdGNoIG9mIDEwMCBjdXN0b21lcnMgZnJvbSAzMCBjb21wYW5pZXMgaXMgMzAgbG9va3Vwcywgbm90IDEwMC4gRG9tYWlucyBhbHJlYWR5IHJlc2VhcmNoZWQgaW4gYSBwcmV2aW91cyBydW4gKGZyb20gZWl0aGVyIHRoaXMgdGFiIG9yIGEgUHJvc3BlY3QgRmluZGVyIHNlYXJjaCkgYXJlIHB1bGxlZCBmcm9tIHlvdXIgc2F2ZWQgcmVzZWFyY2ggY2FjaGUgaW5zdGVhZCBvZiBiZWluZyByZXNlYXJjaGVkIGFnYWluLiBSb3dzIHdpdGggbm8gZW1haWwsIG9yIHdpdGggYSBwZXJzb25hbCBlbWFpbCBkb21haW4gKGdtYWlsLmNvbSwgeWFob28uY29tLCBldGMuKSwgYXJlIHNraXBwZWQgYW5kIG1hcmtlZCByYXRoZXIgdGhhbiBndWVzc2VkIGF0LgogICAgICAgIDxicj48YnI+CiAgICAgICAgPHN0cm9uZz5SZW1pbmRlciBvbiBjb3N0Ojwvc3Ryb25nPiBlYWNoIG5ld2x5IHJlc2VhcmNoZWQgY29tcGFueSBydW5zIGFib3V0IDEgY2VudCAodGhlIHdlYiBzZWFyY2gpIHBsdXMgYSBmcmFjdGlvbiBvZiBhIGNlbnQgZm9yIENsYXVkZSByZWFkaW5nIGFuZCB3cml0aW5nIHRoZSBsYWJlbC4gVGhlIEFudGhyb3BpYyBrZXkgaXMgaGVsZCBhcyBhIHNlcnZlciBzZWNyZXQsIHNvIHRoZSBjb3N0IGxhbmRzIG9uIHlvdXIgQW50aHJvcGljIGFjY291bnQsIG5vdCB0aGlzIHBhZ2UuIENoZWNrIEFudGhyb3BpYyBDb25zb2xlICZyYXJyOyBVc2FnZSBmb3IgdGhlIHJ1bm5pbmcgdG90YWwuCiAgICAgICAgPGJyPjxicj4KICAgICAgICA8c3Ryb25nPk5vdGhpbmcgaGVyZSBpcyBzYXZlZCB0byB5b3VyIGN1c3RvbWVyIGRhdGFiYXNlIGF1dG9tYXRpY2FsbHkuPC9zdHJvbmc+IE9uY2UgeW91J3JlIGhhcHB5IHdpdGggdGhlIHJlc3VsdHMgYmVsb3csIGNsaWNrIDxzdHJvbmc+UmV2aWV3ICZhbXA7IFNhdmU8L3N0cm9uZz4gdG8gY2hvb3NlIGV4YWN0bHkgd2hpY2ggcm93cyB0byBrZWVwLgogICAgICA8L2Rpdj4KICAgIDwvZGl2PgoKICAgIDxkaXYgY2xhc3M9InJlc3VsdHMiIGlkPSJjbHNfcmVzdWx0cyI+CiAgICAgIDxkaXYgY2xhc3M9InJlcy1oZWFkIj4KICAgICAgICA8aDI+Q2xhc3NpZmljYXRpb24gUmVwb3J0PC9oMj4KICAgICAgICA8ZGl2IGNsYXNzPSJtZXRhIiBpZD0iY2xzX3Jlc01ldGEiPjwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iYmxvY2siPgogICAgICAgIDxkaXYgY2xhc3M9ImJsb2NrLXRpdGxlIj4KICAgICAgICAgIDxoMz48c3Bhbj4mIzk2NDY7PC9zcGFuPiBDdXN0b21lcnMgd2l0aCBJbmR1c3RyeTwvaDM+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJidG4tZ3JvdXAiPgogICAgICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4tY29weSIgaWQ9ImNsc0Rvd25sb2FkWGxzeCIgb25jbGljaz0iZG93bmxvYWRDbGFzc2lmaWVyWGxzeCgpIj5Eb3dubG9hZCBFeGNlbDwvYnV0dG9uPgogICAgICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4tbWluZSIgc3R5bGU9InBhZGRpbmc6OXB4IDE2cHg7Zm9udC1zaXplOjExcHgiIG9uY2xpY2s9InNlbmRUb1JldmlldygpIj5SZXZpZXcgJmFtcDsgU2F2ZSBUaGVzZSAmcmFycjs8L2J1dHRvbj4KICAgICAgICAgIDwvZGl2PgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9InRhYmxlLXdyYXAgc2Nyb2xsIj4KICAgICAgICAgIDx0YWJsZSBpZD0iY2xzUmVzdWx0c1RhYmxlIj4KICAgICAgICAgICAgPHRoZWFkPjx0cj48dGg+TmFtZTwvdGg+PHRoPldlYnNpdGU8L3RoPjx0aD5FbWFpbDwvdGg+PHRoPkRvbWFpbjwvdGg+PHRoPkluZHVzdHJ5PC90aD48dGg+U3ViLUluZHVzdHJ5PC90aD48L3RyPjwvdGhlYWQ+CiAgICAgICAgICAgIDx0Ym9keSBpZD0iY2xzUmVzdWx0c0JvZHkiPjwvdGJvZHk+CiAgICAgICAgICA8L3RhYmxlPgogICAgICAgIDwvZGl2PgogICAgICA8L2Rpdj4KICAgIDwvZGl2PgogIDwvZGl2PgoKICA8IS0tID09PT09PT09PT09PT09PT09PT09IFRBQiA1OiBSRVZJRVcgJiBTQVZFID09PT09PT09PT09PT09PT09PT09IC0tPgogIDxkaXYgY2xhc3M9InRhYnBhbmVsIiBpZD0icGFuZWwtcmV2aWV3Ij4KICAgIDxkaXYgY2xhc3M9InBhbmVsIj4KICAgICAgPHAgY2xhc3M9InRhZ2xpbmUiIHN0eWxlPSJtYXJnaW4tdG9wOjA7bWFyZ2luLWJvdHRvbToyMnB4Ij5QaWNrIGV4YWN0bHkgd2hpY2ggY2xhc3NpZmllZCBjb21wYW5pZXMgYWN0dWFsbHkgZW50ZXIgeW91ciBzYXZlZCBjdXN0b21lciBkYXRhYmFzZS4gT25seSBjaGVja2VkIHJvd3MgZ2V0IHNhdmVkIOKAlCB0aGUgcmVzdCBzdGF5IG91dC4gQW55dGhpbmcgbWFya2VkICJBbHJlYWR5IHNhdmVkIiBpcyBhbHJlYWR5IGluIHlvdXIgZGF0YWJhc2UgYW5kIGRvZXNuJ3QgbmVlZCB0byBiZSBhZGRlZCBhZ2Fpbi4gQ2F0ZWdvcnkgYW5kIFN1Yi1DYXRlZ29yeSBhcmUgZWRpdGFibGUgYmVmb3JlIHNhdmluZywgaW4gY2FzZSB5b3Ugd2FudCB0byBjbGVhbiB1cCB0aGUgd29yZGluZy48L3A+CiAgICAgIDxkaXYgaWQ9InJldmlld0VtcHR5Tm90ZSIgY2xhc3M9ImVtcHR5LW5vdGUiPk5vdGhpbmcgdG8gcmV2aWV3IHlldC4gUnVuIGEgY2xhc3NpZmljYXRpb24gb24gdGhlIEN1c3RvbWVyIENsYXNzaWZpZXIgdGFiLCB0aGVuIGNsaWNrICJSZXZpZXcgJmFtcDsgU2F2ZSBUaGVzZS4iPC9kaXY+CiAgICAgIDxkaXYgaWQ9InJldmlld1RhYmxlV3JhcCIgc3R5bGU9ImRpc3BsYXk6bm9uZSI+CiAgICAgICAgPGRpdiBjbGFzcz0idGFibGUtd3JhcCI+CiAgICAgICAgICA8dGFibGUgaWQ9InJldmlld1RhYmxlIj4KICAgICAgICAgICAgPHRoZWFkPgogICAgICAgICAgICAgIDx0cj4KICAgICAgICAgICAgICAgIDx0aCBzdHlsZT0iY3Vyc29yOmRlZmF1bHQiPlNhdmU/PC90aD4KICAgICAgICAgICAgICAgIDx0aCBzdHlsZT0iY3Vyc29yOmRlZmF1bHQiPk5hbWU8L3RoPgogICAgICAgICAgICAgICAgPHRoIHN0eWxlPSJjdXJzb3I6ZGVmYXVsdCI+RG9tYWluPC90aD4KICAgICAgICAgICAgICAgIDx0aCBzdHlsZT0iY3Vyc29yOmRlZmF1bHQiPkNhdGVnb3J5PC90aD4KICAgICAgICAgICAgICAgIDx0aCBzdHlsZT0iY3Vyc29yOmRlZmF1bHQiPlN1Yi1DYXRlZ29yeTwvdGg+CiAgICAgICAgICAgICAgICA8dGggc3R5bGU9ImN1cnNvcjpkZWZhdWx0Ij5TdGF0dXM8L3RoPgogICAgICAgICAgICAgIDwvdHI+CiAgICAgICAgICAgIDwvdGhlYWQ+CiAgICAgICAgICAgIDx0Ym9keSBpZD0icmV2aWV3Qm9keSI+PC90Ym9keT4KICAgICAgICAgIDwvdGFibGU+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0icm93IiBzdHlsZT0ibWFyZ2luLXRvcDoyMHB4Ij4KICAgICAgICAgIDxidXR0b24gY2xhc3M9ImJ0bi1taW5lIiBpZD0icmV2aWV3U2F2ZUJ0biIgb25jbGljaz0ic2F2ZVJldmlld2VkQ3VzdG9tZXJzKCkiPlNhdmUgU2VsZWN0ZWQgdG8gRGF0YWJhc2U8L2J1dHRvbj4KICAgICAgICAgIDxidXR0b24gY2xhc3M9ImJ0bi1zZWNvbmRhcnkiIG9uY2xpY2s9InRvZ2dsZUFsbFJldmlldyh0cnVlKSI+Q2hlY2sgQWxsIE5ldzwvYnV0dG9uPgogICAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuLXNlY29uZGFyeSIgb25jbGljaz0idG9nZ2xlQWxsUmV2aWV3KGZhbHNlKSI+VW5jaGVjayBBbGw8L2J1dHRvbj4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJzdGF0dXMiIGlkPSJyZXZpZXdfc3RhdHVzIj48L2Rpdj4KICAgICAgPC9kaXY+CiAgICA8L2Rpdj4KICA8L2Rpdj4KCiAgPCEtLSA9PT09PT09PT09PT09PT09PT09PSBUQUI6IENBVEVHT1JJRVMgPT09PT09PT09PT09PT09PT09PT0gLS0+CiAgPGRpdiBjbGFzcz0idGFicGFuZWwiIGlkPSJwYW5lbC1jYXRlZ29yaWVzIj4KICAgIDxkaXYgY2xhc3M9InBhbmVsIj4KICAgICAgPHAgY2xhc3M9InRhZ2xpbmUiIHN0eWxlPSJtYXJnaW4tdG9wOjA7bWFyZ2luLWJvdHRvbToyMnB4Ij5UaGlzIGlzIHRoZSBtYXN0ZXIgbGlzdCBQcm9zcGVjdCBGaW5kZXIgYW5kIEZpbmQgU2ltaWxhciBwaWNrIGZyb20uIEEgc2VhcmNoIGNhbiBvbmx5IHVzZSBhIENhdGVnb3J5L1N1Yi1DYXRlZ29yeSB0aGF0IGV4aXN0cyBoZXJlIOKAlCBhZGQgb25lIGJlbG93LCBvciB1cGxvYWQgYSB0ZW1wbGF0ZSwgYmVmb3JlIGl0J3Mgc2VhcmNoYWJsZS48L3A+CgogICAgICA8ZGl2IGNsYXNzPSJyb3ciIHN0eWxlPSJhbGlnbi1pdGVtczpmbGV4LWVuZDttYXJnaW4tYm90dG9tOjI0cHgiPgogICAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIiBzdHlsZT0ibWFyZ2luLWJvdHRvbTowO2ZsZXg6MTttaW4td2lkdGg6MTgwcHgiPgogICAgICAgICAgPGxhYmVsIGZvcj0iY2F0X25ld0NhdGVnb3J5Ij5DYXRlZ29yeTwvbGFiZWw+CiAgICAgICAgICA8aW5wdXQgdHlwZT0idGV4dCIgaWQ9ImNhdF9uZXdDYXRlZ29yeSIgcGxhY2Vob2xkZXI9ImUuZy4gQ29udHJhY3RvciI+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZmllbGQiIHN0eWxlPSJtYXJnaW4tYm90dG9tOjA7ZmxleDoxO21pbi13aWR0aDoxODBweCI+CiAgICAgICAgICA8bGFiZWwgZm9yPSJjYXRfbmV3U3ViQ2F0ZWdvcnkiPlN1Yi1DYXRlZ29yeSA8c3BhbiBjbGFzcz0ib3B0Ij4ob3B0aW9uYWwpPC9zcGFuPjwvbGFiZWw+CiAgICAgICAgICA8aW5wdXQgdHlwZT0idGV4dCIgaWQ9ImNhdF9uZXdTdWJDYXRlZ29yeSIgcGxhY2Vob2xkZXI9ImUuZy4gUGx1bWJpbmciPgogICAgICAgIDwvZGl2PgogICAgICAgIDxidXR0b24gY2xhc3M9ImJ0bi1taW5lIiBvbmNsaWNrPSJhZGRTaW5nbGVDYXRlZ29yeSgpIj5BZGQ8L2J1dHRvbj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InN0YXR1cyIgaWQ9ImNhdF9zdGF0dXMiPjwvZGl2PgoKICAgICAgPGRpdiBjbGFzcz0ic2VlZC1ib3giIHN0eWxlPSJtYXJnaW4tdG9wOjI0cHgiPgogICAgICAgIDxsYWJlbCBzdHlsZT0ibWFyZ2luLWJvdHRvbToxMHB4Ij5CdWxrIFVwbG9hZCA8c3BhbiBjbGFzcz0ib3B0Ij4oc2FtZSBwYXR0ZXJuIGFzIHRoZSBDdXN0b21lciBDbGFzc2lmaWVyKTwvc3Bhbj48L2xhYmVsPgogICAgICAgIDxkaXYgY2xhc3M9InJvdyIgc3R5bGU9Im1hcmdpbi1ib3R0b206MTRweCI+CiAgICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4tc2Vjb25kYXJ5IiBvbmNsaWNrPSJkb3dubG9hZENhdGVnb3J5VGVtcGxhdGUoKSI+RG93bmxvYWQgQmxhbmsgVGVtcGxhdGU8L2J1dHRvbj4KICAgICAgICA8L2Rpdj4KICAgICAgICA8aW5wdXQgdHlwZT0iZmlsZSIgaWQ9ImNhdGVnb3J5RmlsZUlucHV0IiBhY2NlcHQ9Ii54bHN4LC54bHMsLmNzdiI+CiAgICAgICAgPGRpdiBjbGFzcz0icm93IiBzdHlsZT0ibWFyZ2luLXRvcDoxNHB4Ij4KICAgICAgICAgIDxidXR0b24gY2xhc3M9ImJ0bi1taW5lIiBvbmNsaWNrPSJ1cGxvYWRDYXRlZ29yeVRlbXBsYXRlKCkiPlVwbG9hZCAmYW1wOyBBZGQ8L2J1dHRvbj4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJzdGF0dXMiIGlkPSJjYXRfdXBsb2FkX3N0YXR1cyI+PC9kaXY+CiAgICAgIDwvZGl2PgoKICAgICAgPGRpdiBjbGFzcz0ic2F2ZWQtcGFuZWwiPgogICAgICAgIDxsYWJlbCBzdHlsZT0ibWFyZ2luLWJvdHRvbToxMHB4Ij5DdXJyZW50IENhdGVnb3JpZXM8L2xhYmVsPgogICAgICAgIDxkaXYgaWQ9ImNhdGVnb3J5TGlzdERpc3BsYXkiPjwvZGl2PgogICAgICA8L2Rpdj4KICAgIDwvZGl2PgogIDwvZGl2PgoKICA8IS0tID09PT09PT09PT09PT09PT09PT09IFRBQjogUkVQT1JUUyA9PT09PT09PT09PT09PT09PT09PSAtLT4KICA8ZGl2IGNsYXNzPSJ0YWJwYW5lbCIgaWQ9InBhbmVsLXJlcG9ydHMiPgogICAgPGRpdiBjbGFzcz0icGFuZWwiPgogICAgICA8cCBjbGFzcz0idGFnbGluZSIgc3R5bGU9Im1hcmdpbi10b3A6MDttYXJnaW4tYm90dG9tOjIycHgiPkV2ZXJ5IENhdGVnb3J5IC8gU3ViLUNhdGVnb3J5IC8gTG9jYXRpb24gY29tYmluYXRpb24gdGhhdCdzIGJlZW4gc2VhcmNoZWQsIGFuZCBob3cgbWFueSB0aW1lcy4gUmVwZWF0cyBhcmUgc29ydGVkIHRvIHRoZSB0b3Ag4oCUIHdvcnRoIGEgbG9vayBiZWZvcmUgcnVubmluZyB0aGUgc2FtZSBzZWFyY2ggYWdhaW4uPC9wPgogICAgICA8ZGl2IGNsYXNzPSJ0YWJsZS13cmFwIj4KICAgICAgICA8dGFibGUgaWQ9InJlcG9ydFRhYmxlIj4KICAgICAgICAgIDx0aGVhZD4KICAgICAgICAgICAgPHRyPgogICAgICAgICAgICAgIDx0aCBzdHlsZT0iY3Vyc29yOmRlZmF1bHQiPkNhdGVnb3J5PC90aD4KICAgICAgICAgICAgICA8dGggc3R5bGU9ImN1cnNvcjpkZWZhdWx0Ij5TdWItQ2F0ZWdvcnk8L3RoPgogICAgICAgICAgICAgIDx0aCBzdHlsZT0iY3Vyc29yOmRlZmF1bHQiPkxvY2F0aW9uPC90aD4KICAgICAgICAgICAgICA8dGggc3R5bGU9ImN1cnNvcjpkZWZhdWx0Ij5UaW1lcyBTZWFyY2hlZDwvdGg+CiAgICAgICAgICAgICAgPHRoIHN0eWxlPSJjdXJzb3I6ZGVmYXVsdCI+VG90YWwgUmVzdWx0cyBGb3VuZDwvdGg+CiAgICAgICAgICAgICAgPHRoIHN0eWxlPSJjdXJzb3I6ZGVmYXVsdCI+TGFzdCBTZWFyY2hlZDwvdGg+CiAgICAgICAgICAgIDwvdHI+CiAgICAgICAgICA8L3RoZWFkPgogICAgICAgICAgPHRib2R5IGlkPSJyZXBvcnRCb2R5Ij48L3Rib2R5PgogICAgICAgIDwvdGFibGU+CiAgICAgIDwvZGl2PgogICAgPC9kaXY+CiAgPC9kaXY+CgogIDxkYXRhbGlzdCBpZD0ic2F2ZWRDdXN0b21lck9wdGlvbnMiPjwvZGF0YWxpc3Q+CgogIDxmb290ZXI+TW9kb25peCBDdXN0b21lciBUb29sa2l0IHY1LjAgJm1pZGRvdDsgcnVucyB0aHJvdWdoIGEgc2VjdXJlIGJhY2tlbmQsIG5vIEFQSSBrZXkgZXZlciB0b3VjaGVzIHRoaXMgcGFnZSAmbWlkZG90OyBzYXZlZCBzZWFyY2hlcyBsaXZlIGluIHRoaXMgYnJvd3NlciBvbmx5ICZtaWRkb3Q7IHZlcmlmeSByZXN1bHRzIGJlZm9yZSBvdXRyZWFjaDwvZm9vdGVyPgo8L2Rpdj4KCjxzY3JpcHQ+Ci8qID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PQogICBUQUJTCiAgID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PSAqLwpmdW5jdGlvbiBzaG93VGFiKG5hbWUpewogIFsnZmluZGVyJywnc2ltaWxhcicsJ2NsYXNzaWZ5JywnY2F0ZWdvcmllcycsJ3JldmlldycsJ3JlcG9ydHMnXS5mb3JFYWNoKHQgPT4gewogICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3RhYi0nICsgdCkuY2xhc3NMaXN0LnRvZ2dsZSgnYWN0aXZlJywgdCA9PT0gbmFtZSk7CiAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgncGFuZWwtJyArIHQpLmNsYXNzTGlzdC50b2dnbGUoJ2FjdGl2ZScsIHQgPT09IG5hbWUpOwogIH0pOwogIGNvbnN0IGZpbmRlclJlc0VsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3Jlc3VsdHMnKTsKICBpZihuYW1lID09PSAnY2xhc3NpZnknIHx8IG5hbWUgPT09ICdyZXZpZXcnIHx8IG5hbWUgPT09ICdjYXRlZ29yaWVzJyB8fCBuYW1lID09PSAncmVwb3J0cycpeyBmaW5kZXJSZXNFbC5zdHlsZS5kaXNwbGF5ID0gJ25vbmUnOyB9CiAgZWxzZSB7IGZpbmRlclJlc0VsLnN0eWxlLmRpc3BsYXkgPSAnJzsgfQogIGlmKG5hbWUgPT09ICdyZXBvcnRzJyl7IGxvYWRTZWFyY2hSZXBvcnQoKTsgfQp9CgpmdW5jdGlvbiBlc2Mocyl7CiAgcmV0dXJuIFN0cmluZyhzID09IG51bGwgPyAnJyA6IHMpLnJlcGxhY2UoLyYvZywnJmFtcDsnKS5yZXBsYWNlKC88L2csJyZsdDsnKS5yZXBsYWNlKC8+L2csJyZndDsnKS5yZXBsYWNlKC8iL2csJyZxdW90OycpOwp9CgovKiA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0KICAgUkVWSUVXICYgU0FWRSAoZGVsaWJlcmF0ZSwgY2hlY2tlZC1ieS1oYW5kIHNhdmUgaW50byB0aGUKICAgY3VzdG9tZXIgZGF0YWJhc2Ug4oCUIG5vdGhpbmcgZ2V0cyBpbiB3aXRob3V0IHRoaXMgc3RlcCkKICAgPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09ICovCmxldCByZXZpZXdSb3dzID0gW107CgpmdW5jdGlvbiBzZW5kVG9SZXZpZXcoKXsKICBpZighY2xhc3NpZmllZFJvd3MubGVuZ3RoKXsgcmV0dXJuOyB9CiAgLy8gT25lIHJvdyBwZXIgdW5pcXVlIGRvbWFpbiAoc2tpcCB1bmtub3ducy9wZXJzb25hbCDigJQgbm90aGluZyB1c2VmdWwgdG8gc2F2ZSkuCiAgY29uc3QgYnlEb21haW4gPSBuZXcgTWFwKCk7CiAgZm9yKGNvbnN0IHIgb2YgY2xhc3NpZmllZFJvd3MpewogICAgaWYoIXIuZG9tYWluKSBjb250aW51ZTsKICAgIGlmKHIuaW5kdXN0cnkudG9Mb3dlckNhc2UoKS5zdGFydHNXaXRoKCd1bmtub3duJykgfHwgci5pbmR1c3RyeS50b0xvd2VyQ2FzZSgpLnN0YXJ0c1dpdGgoJ3NraXBwZWQnKSkgY29udGludWU7CiAgICBpZighYnlEb21haW4uaGFzKHIuZG9tYWluKSl7CiAgICAgIGJ5RG9tYWluLnNldChyLmRvbWFpbiwgeyBuYW1lOiByLm5hbWUsIGRvbWFpbjogci5kb21haW4sIGluZHVzdHJ5OiByLmluZHVzdHJ5LCBzdWJJbmR1c3RyeTogci5zdWJJbmR1c3RyeSB9KTsKICAgIH0KICB9CiAgcmV2aWV3Um93cyA9IEFycmF5LmZyb20oYnlEb21haW4udmFsdWVzKCkpOwogIHNob3dUYWIoJ3JldmlldycpOwogIHJlbmRlclJldmlld1RhYmxlKCk7Cn0KCmFzeW5jIGZ1bmN0aW9uIHJlbmRlclJldmlld1RhYmxlKCl7CiAgY29uc3Qgd3JhcCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdyZXZpZXdUYWJsZVdyYXAnKTsKICBjb25zdCBlbXB0eSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdyZXZpZXdFbXB0eU5vdGUnKTsKICBpZighcmV2aWV3Um93cy5sZW5ndGgpewogICAgd3JhcC5zdHlsZS5kaXNwbGF5ID0gJ25vbmUnOwogICAgZW1wdHkuc3R5bGUuZGlzcGxheSA9ICdibG9jayc7CiAgICByZXR1cm47CiAgfQogIGVtcHR5LnN0eWxlLmRpc3BsYXkgPSAnbm9uZSc7CiAgd3JhcC5zdHlsZS5kaXNwbGF5ID0gJ2Jsb2NrJzsKCiAgLy8gQ2hlY2sgd2hpY2ggb2YgdGhlc2UgZG9tYWlucyBhcmUgYWxyZWFkeSBzYXZlZCwgc28gd2UgZG9uJ3QgcHVzaCB5b3UKICAvLyB0byByZS1hZGQgc29tZXRoaW5nIHRoYXQncyBhbHJlYWR5IGluIHlvdXIgZGF0YWJhc2UuCiAgbGV0IGV4aXN0aW5nRG9tYWlucyA9IG5ldyBTZXQoKTsKICB0cnl7CiAgICBjb25zdCByZXNwID0gYXdhaXQgZmV0Y2goJy9hcGkvY3VzdG9tZXJzJyk7CiAgICBpZihyZXNwLm9rKXsKICAgICAgY29uc3QgZGF0YSA9IGF3YWl0IHJlc3AuanNvbigpOwogICAgICBleGlzdGluZ0RvbWFpbnMgPSBuZXcgU2V0KChkYXRhLmN1c3RvbWVycyB8fCBbXSkubWFwKGMgPT4gYy5kb21haW4pKTsKICAgIH0KICB9Y2F0Y2goZSl7IGNvbnNvbGUuZXJyb3IoJ0NvdWxkIG5vdCBjaGVjayBleGlzdGluZyBjdXN0b21lcnMnLCBlKTsgfQoKICBjb25zdCBib2R5ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3Jldmlld0JvZHknKTsKICBib2R5LmlubmVySFRNTCA9IHJldmlld1Jvd3MubWFwKChyLCBpKSA9PiB7CiAgICBjb25zdCBhbHJlYWR5ID0gZXhpc3RpbmdEb21haW5zLmhhcyhyLmRvbWFpbik7CiAgICByZXR1cm4gJzx0ciBkYXRhLWlkeD0iJyArIGkgKyAnIj4nICsKICAgICAgJzx0ZD48aW5wdXQgdHlwZT0iY2hlY2tib3giIGNsYXNzPSJyZXZpZXctY2hlY2siICcgKyAoYWxyZWFkeSA/ICcnIDogJ2NoZWNrZWQnKSArICc+PC90ZD4nICsKICAgICAgJzx0ZD4nICsgZXNjKHIubmFtZSkgKyAnPC90ZD4nICsKICAgICAgJzx0ZD4nICsgZXNjKHIuZG9tYWluKSArICc8L3RkPicgKwogICAgICAnPHRkPjxpbnB1dCB0eXBlPSJ0ZXh0IiBjbGFzcz0icmV2aWV3LWluZHVzdHJ5IiB2YWx1ZT0iJyArIGVzYyhyLmluZHVzdHJ5KSArICciIHN0eWxlPSJ3aWR0aDoxMDAlO3BhZGRpbmc6NnB4IDhweDtmb250LXNpemU6MTNweCI+PC90ZD4nICsKICAgICAgJzx0ZD48aW5wdXQgdHlwZT0idGV4dCIgY2xhc3M9InJldmlldy1zdWJpbmR1c3RyeSIgdmFsdWU9IicgKyBlc2Moci5zdWJJbmR1c3RyeSkgKyAnIiBzdHlsZT0id2lkdGg6MTAwJTtwYWRkaW5nOjZweCA4cHg7Zm9udC1zaXplOjEzcHgiPjwvdGQ+JyArCiAgICAgICc8dGQ+JyArIChhbHJlYWR5ID8gJzxzcGFuIGNsYXNzPSJleGlzdGluZy10YWciPkFscmVhZHkgc2F2ZWQ8L3NwYW4+JyA6ICc8c3BhbiBjbGFzcz0iY2F0LXRhZyI+TmV3PC9zcGFuPicpICsgJzwvdGQ+JyArCiAgICAnPC90cj4nOwogIH0pLmpvaW4oJycpOwp9CgpmdW5jdGlvbiB0b2dnbGVBbGxSZXZpZXcob25seU5ldyl7CiAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnI3Jldmlld0JvZHkgdHInKS5mb3JFYWNoKHRyID0+IHsKICAgIGNvbnN0IGNoZWNrYm94ID0gdHIucXVlcnlTZWxlY3RvcignLnJldmlldy1jaGVjaycpOwogICAgY29uc3QgaXNBbHJlYWR5ID0gdHIucXVlcnlTZWxlY3RvcignLmV4aXN0aW5nLXRhZycpICE9PSBudWxsOwogICAgaWYob25seU5ldyl7IGNoZWNrYm94LmNoZWNrZWQgPSAhaXNBbHJlYWR5OyB9CiAgICBlbHNlIHsgY2hlY2tib3guY2hlY2tlZCA9IGZhbHNlOyB9CiAgfSk7Cn0KCmFzeW5jIGZ1bmN0aW9uIHNhdmVSZXZpZXdlZEN1c3RvbWVycygpewogIGNvbnN0IHJvd3MgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcjcmV2aWV3Qm9keSB0cicpOwogIGNvbnN0IHRvU2F2ZSA9IFtdOwogIHJvd3MuZm9yRWFjaCh0ciA9PiB7CiAgICBjb25zdCBjaGVja2JveCA9IHRyLnF1ZXJ5U2VsZWN0b3IoJy5yZXZpZXctY2hlY2snKTsKICAgIGlmKCFjaGVja2JveC5jaGVja2VkKSByZXR1cm47CiAgICBjb25zdCBpZHggPSBwYXJzZUludCh0ci5nZXRBdHRyaWJ1dGUoJ2RhdGEtaWR4JyksIDEwKTsKICAgIGNvbnN0IGJhc2UgPSByZXZpZXdSb3dzW2lkeF07CiAgICB0b1NhdmUucHVzaCh7CiAgICAgIGRvbWFpbjogYmFzZS5kb21haW4sCiAgICAgIG5hbWU6IGJhc2UubmFtZSwKICAgICAgaW5kdXN0cnk6IHRyLnF1ZXJ5U2VsZWN0b3IoJy5yZXZpZXctaW5kdXN0cnknKS52YWx1ZS50cmltKCksCiAgICAgIHN1YkluZHVzdHJ5OiB0ci5xdWVyeVNlbGVjdG9yKCcucmV2aWV3LXN1YmluZHVzdHJ5JykudmFsdWUudHJpbSgpCiAgICB9KTsKICB9KTsKCiAgaWYoIXRvU2F2ZS5sZW5ndGgpeyBzZXRTdGF0dXMoJ3Jldmlld19zdGF0dXMnLCdlcnJvcicsJ05vdGhpbmcgY2hlY2tlZCDigJQgY2hlY2sgYXQgbGVhc3Qgb25lIHJvdyBmaXJzdC4nKTsgcmV0dXJuOyB9CgogIGNvbnN0IGJ0biA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdyZXZpZXdTYXZlQnRuJyk7CiAgYnRuLmRpc2FibGVkID0gdHJ1ZTsKICBzZXRTdGF0dXMoJ3Jldmlld19zdGF0dXMnLCd3b3JraW5nJywnU2F2aW5nICcgKyB0b1NhdmUubGVuZ3RoICsgJyBjdXN0b21lcihzKS4nKTsKICB0cnl7CiAgICBjb25zdCByZXNwID0gYXdhaXQgZmV0Y2goJy9hcGkvYXBwcm92ZS1jdXN0b21lcnMnLCB7CiAgICAgIG1ldGhvZDogJ1BPU1QnLAogICAgICBoZWFkZXJzOiB7ICdDb250ZW50LVR5cGUnOiAnYXBwbGljYXRpb24vanNvbicgfSwKICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBjdXN0b21lcnM6IHRvU2F2ZSB9KQogICAgfSk7CiAgICBjb25zdCBkYXRhID0gYXdhaXQgcmVzcC5qc29uKCk7CiAgICBpZighcmVzcC5vaykgdGhyb3cgbmV3IEVycm9yKGRhdGEuZXJyb3IgfHwgJ1NhdmUgZmFpbGVkJyk7CiAgICBzZXRTdGF0dXMoJ3Jldmlld19zdGF0dXMnLCdkb25lJywgZGF0YS5zYXZlZCArICcgY3VzdG9tZXIocykgc2F2ZWQgdG8geW91ciBkYXRhYmFzZS4nKTsKICAgIGxvYWRDYXRlZ29yeU9wdGlvbnMoKTsKICAgIGxvYWRTYXZlZEN1c3RvbWVycygpOwogICAgcmVuZGVyUmV2aWV3VGFibGUoKTsKICB9Y2F0Y2goZSl7CiAgICBjb25zb2xlLmVycm9yKGUpOwogICAgc2V0U3RhdHVzKCdyZXZpZXdfc3RhdHVzJywnZXJyb3InLCdTYXZlIGZhaWxlZDogJyArIGUubWVzc2FnZSk7CiAgfWZpbmFsbHl7CiAgICBidG4uZGlzYWJsZWQgPSBmYWxzZTsKICB9Cn0KCi8qID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PQogICBDQVRFR09SWSBUQVhPTk9NWSAoQ2F0ZWdvcnkgLT4gW1N1Yi1DYXRlZ29yaWVzXSkg4oCUIHRoZSBtYXN0ZXIKICAgbGlzdCBldmVyeXRoaW5nIGVsc2UgcmVhZHMgZnJvbS4gTm90aGluZyBnZXRzIHNlYXJjaGVkIHRoYXQKICAgaXNuJ3QgaW4gdGhpcyBsaXN0LgogICA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0gKi8KbGV0IGNhdGVnb3JpZXNUcmVlID0ge307Cgphc3luYyBmdW5jdGlvbiBsb2FkQ2F0ZWdvcnlPcHRpb25zKCl7CiAgdHJ5ewogICAgY29uc3QgcmVzcCA9IGF3YWl0IGZldGNoKCcvYXBpL2NhdGVnb3JpZXMtdHJlZScpOwogICAgaWYoIXJlc3Aub2spIHJldHVybjsKICAgIGNvbnN0IGRhdGEgPSBhd2FpdCByZXNwLmpzb24oKTsKICAgIGNhdGVnb3JpZXNUcmVlID0gZGF0YS50cmVlIHx8IHt9OwogICAgcG9wdWxhdGVDYXRlZ29yeVNlbGVjdCgnJywgJ3N1YkNhdGVnb3J5Jyk7CiAgICBwb3B1bGF0ZUNhdGVnb3J5U2VsZWN0KCdmc18nLCAnZnNfc3ViQ2F0ZWdvcnknKTsKICAgIHJlbmRlckNhdGVnb3J5TGlzdERpc3BsYXkoKTsKICB9Y2F0Y2goZSl7CiAgICBjb25zb2xlLmVycm9yKCdDb3VsZCBub3QgbG9hZCBjYXRlZ29yeSBsaXN0JywgZSk7CiAgfQp9CgpmdW5jdGlvbiBwb3B1bGF0ZUNhdGVnb3J5U2VsZWN0KHByZWZpeCwgc3ViU2VsZWN0SWQpewogIGNvbnN0IGVsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQocHJlZml4ICsgJ2NhdGVnb3J5Jyk7CiAgaWYoIWVsKSByZXR1cm47CiAgY29uc3QgY3VycmVudCA9IGVsLnZhbHVlOwogIGNvbnN0IGNhdHMgPSBPYmplY3Qua2V5cyhjYXRlZ29yaWVzVHJlZSkuc29ydCgoYSxiKSA9PiBhLmxvY2FsZUNvbXBhcmUoYikpOwogIGVsLmlubmVySFRNTCA9ICc8b3B0aW9uIHZhbHVlPSIiPi0tIENob29zZSBhIGNhdGVnb3J5IC0tPC9vcHRpb24+JyArCiAgICBjYXRzLm1hcChjID0+ICc8b3B0aW9uIHZhbHVlPSInICsgZXNjKGMpICsgJyInICsgKGMgPT09IGN1cnJlbnQgPyAnIHNlbGVjdGVkJyA6ICcnKSArICc+JyArIGVzYyhjKSArICc8L29wdGlvbj4nKS5qb2luKCcnKTsKICBvbkNhdGVnb3J5Q2hhbmdlKHByZWZpeCwgc3ViU2VsZWN0SWQsIHRydWUpOwp9CgpmdW5jdGlvbiBvbkNhdGVnb3J5Q2hhbmdlKHByZWZpeCwgc3ViU2VsZWN0SWQsIGtlZXBDdXJyZW50KXsKICBjb25zdCBjYXRFbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKHByZWZpeCArICdjYXRlZ29yeScpOwogIGNvbnN0IHN1YkVsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoc3ViU2VsZWN0SWQpOwogIGlmKCFjYXRFbCB8fCAhc3ViRWwpIHJldHVybjsKICBjb25zdCBjaG9zZW4gPSBjYXRFbC52YWx1ZTsKICBjb25zdCBjdXJyZW50ID0ga2VlcEN1cnJlbnQgPyBzdWJFbC52YWx1ZSA6ICcnOwogIGNvbnN0IHN1YnMgPSBjYXRlZ29yaWVzVHJlZVtjaG9zZW5dIHx8IFtdOwogIHN1YkVsLmlubmVySFRNTCA9ICc8b3B0aW9uIHZhbHVlPSIiPi0tIEFueSAvIGJyb2FkIC0tPC9vcHRpb24+JyArCiAgICBzdWJzLm1hcChzID0+ICc8b3B0aW9uIHZhbHVlPSInICsgZXNjKHMpICsgJyInICsgKHMgPT09IGN1cnJlbnQgPyAnIHNlbGVjdGVkJyA6ICcnKSArICc+JyArIGVzYyhzKSArICc8L29wdGlvbj4nKS5qb2luKCcnKTsKfQoKZnVuY3Rpb24gcmVuZGVyQ2F0ZWdvcnlMaXN0RGlzcGxheSgpewogIGNvbnN0IGVsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2NhdGVnb3J5TGlzdERpc3BsYXknKTsKICBpZighZWwpIHJldHVybjsKICBjb25zdCBjYXRzID0gT2JqZWN0LmtleXMoY2F0ZWdvcmllc1RyZWUpLnNvcnQoKGEsYikgPT4gYS5sb2NhbGVDb21wYXJlKGIpKTsKICBpZighY2F0cy5sZW5ndGgpewogICAgZWwuaW5uZXJIVE1MID0gJzxwIGNsYXNzPSJlbXB0eS1ub3RlIj5ObyBjYXRlZ29yaWVzIHlldC4gQWRkIG9uZSBhYm92ZSwgb3IgY2xhc3NpZnkgYW5kIGFwcHJvdmUgc29tZSBjdXN0b21lcnMgZmlyc3QuPC9wPic7CiAgICByZXR1cm47CiAgfQogIGVsLmlubmVySFRNTCA9IGNhdHMubWFwKGMgPT4gewogICAgY29uc3Qgc3VicyA9IGNhdGVnb3JpZXNUcmVlW2NdOwogICAgcmV0dXJuICc8ZGl2IGNsYXNzPSJzYXZlZC1pdGVtIj48ZGl2PjxzdHJvbmc+JyArIGVzYyhjKSArICc8L3N0cm9uZz4nICsKICAgICAgKHN1YnMubGVuZ3RoID8gJyA8c3BhbiBjbGFzcz0ibWV0YSI+JyArIGVzYyhzdWJzLmpvaW4oJywgJykpICsgJzwvc3Bhbj4nIDogJyA8c3BhbiBjbGFzcz0ibWV0YSI+KG5vIHN1Yi1jYXRlZ29yaWVzIHlldCk8L3NwYW4+JykgKwogICAgICAnPC9kaXY+PC9kaXY+JzsKICB9KS5qb2luKCcnKTsKfQoKYXN5bmMgZnVuY3Rpb24gYWRkU2luZ2xlQ2F0ZWdvcnkoKXsKICBjb25zdCBjYXRlZ29yeSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjYXRfbmV3Q2F0ZWdvcnknKS52YWx1ZS50cmltKCk7CiAgY29uc3Qgc3ViQ2F0ZWdvcnkgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnY2F0X25ld1N1YkNhdGVnb3J5JykudmFsdWUudHJpbSgpOwogIGlmKCFjYXRlZ29yeSl7IHNldFN0YXR1cygnY2F0X3N0YXR1cycsJ2Vycm9yJywnRW50ZXIgYSBjYXRlZ29yeSBuYW1lIGZpcnN0LicpOyByZXR1cm47IH0KICB0cnl7CiAgICBjb25zdCByZXNwID0gYXdhaXQgZmV0Y2goJy9hcGkvY2F0ZWdvcmllcy9idWxrJywgewogICAgICBtZXRob2Q6ICdQT1NUJywKICAgICAgaGVhZGVyczogeyAnQ29udGVudC1UeXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nIH0sCiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgcGFpcnM6IFt7IGNhdGVnb3J5LCBzdWJDYXRlZ29yeSB9XSB9KQogICAgfSk7CiAgICBjb25zdCBkYXRhID0gYXdhaXQgcmVzcC5qc29uKCk7CiAgICBpZighcmVzcC5vaykgdGhyb3cgbmV3IEVycm9yKGRhdGEuZXJyb3IgfHwgJ0FkZCBmYWlsZWQnKTsKICAgIHNldFN0YXR1cygnY2F0X3N0YXR1cycsJ2RvbmUnLCdBZGRlZDogJyArIGNhdGVnb3J5ICsgKHN1YkNhdGVnb3J5ID8gJyAvICcgKyBzdWJDYXRlZ29yeSA6ICcnKSk7CiAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnY2F0X25ld0NhdGVnb3J5JykudmFsdWUgPSAnJzsKICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjYXRfbmV3U3ViQ2F0ZWdvcnknKS52YWx1ZSA9ICcnOwogICAgbG9hZENhdGVnb3J5T3B0aW9ucygpOwogIH1jYXRjaChlKXsKICAgIHNldFN0YXR1cygnY2F0X3N0YXR1cycsJ2Vycm9yJywnQ291bGQgbm90IGFkZDogJyArIGUubWVzc2FnZSk7CiAgfQp9CgpmdW5jdGlvbiBkb3dubG9hZENhdGVnb3J5VGVtcGxhdGUoKXsKICBjb25zdCByb3dzID0gW3sgJ0NhdGVnb3J5JzogJycsICdTdWItQ2F0ZWdvcnknOiAnJyB9XTsKICBjb25zdCB3cyA9IFhMU1gudXRpbHMuanNvbl90b19zaGVldChyb3dzKTsKICB3c1snIWNvbHMnXSA9IFt7d2NoOjI0fSx7d2NoOjI0fV07CiAgY29uc3Qgd2IgPSBYTFNYLnV0aWxzLmJvb2tfbmV3KCk7CiAgWExTWC51dGlscy5ib29rX2FwcGVuZF9zaGVldCh3Yiwgd3MsICdDYXRlZ29yaWVzJyk7CiAgWExTWC53cml0ZUZpbGUod2IsICdtb2Rvbml4X2NhdGVnb3J5X3RlbXBsYXRlLnhsc3gnKTsKfQoKYXN5bmMgZnVuY3Rpb24gdXBsb2FkQ2F0ZWdvcnlUZW1wbGF0ZSgpewogIGNvbnN0IGZpbGVJbnB1dCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjYXRlZ29yeUZpbGVJbnB1dCcpOwogIGlmKCFmaWxlSW5wdXQuZmlsZXMgfHwgIWZpbGVJbnB1dC5maWxlc1swXSl7CiAgICBzZXRTdGF0dXMoJ2NhdF91cGxvYWRfc3RhdHVzJywnZXJyb3InLCdDaG9vc2UgYSBjYXRlZ29yeSBzaGVldCBmaXJzdC4nKTsKICAgIHJldHVybjsKICB9CiAgdHJ5ewogICAgc2V0U3RhdHVzKCdjYXRfdXBsb2FkX3N0YXR1cycsJ3dvcmtpbmcnLCdSZWFkaW5nIHRoZSBzaGVldC4nKTsKICAgIGNvbnN0IGZpbGUgPSBmaWxlSW5wdXQuZmlsZXNbMF07CiAgICBjb25zdCBkYXRhID0gYXdhaXQgbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4gewogICAgICBjb25zdCByZWFkZXIgPSBuZXcgRmlsZVJlYWRlcigpOwogICAgICByZWFkZXIub25sb2FkID0gZSA9PiByZXNvbHZlKG5ldyBVaW50OEFycmF5KGUudGFyZ2V0LnJlc3VsdCkpOwogICAgICByZWFkZXIub25lcnJvciA9ICgpID0+IHJlamVjdChuZXcgRXJyb3IoJ0NvdWxkIG5vdCByZWFkIHRoZSBmaWxlLicpKTsKICAgICAgcmVhZGVyLnJlYWRBc0FycmF5QnVmZmVyKGZpbGUpOwogICAgfSk7CiAgICBjb25zdCB3YiA9IFhMU1gucmVhZChkYXRhLCB7IHR5cGU6ICdhcnJheScgfSk7CiAgICBjb25zdCB3cyA9IHdiLlNoZWV0c1t3Yi5TaGVldE5hbWVzWzBdXTsKICAgIGNvbnN0IHJvd3MgPSBYTFNYLnV0aWxzLnNoZWV0X3RvX2pzb24od3MsIHsgaGVhZGVyOiAxLCBkZWZ2YWw6ICcnIH0pOwogICAgaWYoIXJvd3MubGVuZ3RoKSB0aHJvdyBuZXcgRXJyb3IoJ1NoZWV0IGFwcGVhcnMgZW1wdHkuJyk7CiAgICBjb25zdCBoZWFkZXJzID0gcm93c1swXTsKICAgIGNvbnN0IGNhdElkeCA9IGZpbmRDb2x1bW4oaGVhZGVycywgWydjYXRlZ29yeSddKTsKICAgIGNvbnN0IHN1YklkeCA9IGZpbmRDb2x1bW4oaGVhZGVycywgWydzdWInXSk7CiAgICBpZihjYXRJZHggPT09IC0xKSB0aHJvdyBuZXcgRXJyb3IoJ0NvdWxkIG5vdCBmaW5kIGEgQ2F0ZWdvcnkgY29sdW1uLicpOwoKICAgIGNvbnN0IHBhaXJzID0gW107CiAgICBmb3IobGV0IGkgPSAxOyBpIDwgcm93cy5sZW5ndGg7IGkrKyl7CiAgICAgIGNvbnN0IGNhdGVnb3J5ID0gU3RyaW5nKHJvd3NbaV1bY2F0SWR4XSB8fCAnJykudHJpbSgpOwogICAgICBpZighY2F0ZWdvcnkpIGNvbnRpbnVlOwogICAgICBjb25zdCBzdWJDYXRlZ29yeSA9IHN1YklkeCAhPT0gLTEgPyBTdHJpbmcocm93c1tpXVtzdWJJZHhdIHx8ICcnKS50cmltKCkgOiAnJzsKICAgICAgcGFpcnMucHVzaCh7IGNhdGVnb3J5LCBzdWJDYXRlZ29yeSB9KTsKICAgIH0KICAgIGlmKCFwYWlycy5sZW5ndGgpIHRocm93IG5ldyBFcnJvcignTm8gY2F0ZWdvcnkgcm93cyBmb3VuZC4nKTsKCiAgICBjb25zdCByZXNwID0gYXdhaXQgZmV0Y2goJy9hcGkvY2F0ZWdvcmllcy9idWxrJywgewogICAgICBtZXRob2Q6ICdQT1NUJywKICAgICAgaGVhZGVyczogeyAnQ29udGVudC1UeXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nIH0sCiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgcGFpcnMgfSkKICAgIH0pOwogICAgY29uc3QgcmVzcERhdGEgPSBhd2FpdCByZXNwLmpzb24oKTsKICAgIGlmKCFyZXNwLm9rKSB0aHJvdyBuZXcgRXJyb3IocmVzcERhdGEuZXJyb3IgfHwgJ1VwbG9hZCBmYWlsZWQnKTsKICAgIHNldFN0YXR1cygnY2F0X3VwbG9hZF9zdGF0dXMnLCdkb25lJywgcmVzcERhdGEuYWRkZWQgKyAnIGNhdGVnb3J5IHJvdyhzKSBwcm9jZXNzZWQuJyk7CiAgICBsb2FkQ2F0ZWdvcnlPcHRpb25zKCk7CiAgfWNhdGNoKGUpewogICAgc2V0U3RhdHVzKCdjYXRfdXBsb2FkX3N0YXR1cycsJ2Vycm9yJywnVXBsb2FkIGZhaWxlZDogJyArIGUubWVzc2FnZSk7CiAgfQp9CgovKiA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0KICAgU0VBUkNIIExPRyDigJQgZmxhZyByZXBlYXRzIGJlZm9yZSBydW5uaW5nLCBsb2cgYWZ0ZXIKICAgPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09ICovCmFzeW5jIGZ1bmN0aW9uIGNoZWNrU2VhcmNoTG9nQmVmb3JlUnVuKGNhdGVnb3J5LCBzdWJDYXRlZ29yeSwgbG9jYXRpb24pewogIHRyeXsKICAgIGNvbnN0IHJlc3AgPSBhd2FpdCBmZXRjaCgnL2FwaS9jaGVjay1zZWFyY2gtbG9nJywgewogICAgICBtZXRob2Q6ICdQT1NUJywKICAgICAgaGVhZGVyczogeyAnQ29udGVudC1UeXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nIH0sCiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgY2F0ZWdvcnksIHN1YkNhdGVnb3J5LCBsb2NhdGlvbiB9KQogICAgfSk7CiAgICBpZighcmVzcC5vaykgcmV0dXJuIHRydWU7IC8vIGZhaWwgb3BlbiDigJQgZG9uJ3QgYmxvY2sgYSBzZWFyY2ggb3ZlciBhIGxvZy1jaGVjayBoaWNjdXAKICAgIGNvbnN0IGRhdGEgPSBhd2FpdCByZXNwLmpzb24oKTsKICAgIGlmKGRhdGEuZm91bmQpewogICAgICBjb25zdCB3aGVuID0gZGF0YS5sYXN0U2VhcmNoZWRBdCA/IG5ldyBEYXRlKGRhdGEubGFzdFNlYXJjaGVkQXQpLnRvTG9jYWxlU3RyaW5nKCkgOiAncHJldmlvdXNseSc7CiAgICAgIHJldHVybiBjb25maXJtKAogICAgICAgICciJyArIGNhdGVnb3J5ICsgKHN1YkNhdGVnb3J5ID8gJyAvICcgKyBzdWJDYXRlZ29yeSA6ICcnKSArICciIGluICInICsgbG9jYXRpb24gKyAnIiAnICsKICAgICAgICAnaGFzIGFscmVhZHkgYmVlbiBzZWFyY2hlZCAnICsgZGF0YS50aW1lc1NlYXJjaGVkICsgJyB0aW1lKHMpLCBsYXN0IG9uICcgKyB3aGVuICsgJy5cblxuJyArCiAgICAgICAgJ1J1biBpdCBhZ2FpbiBhbnl3YXk/JwogICAgICApOwogICAgfQogICAgcmV0dXJuIHRydWU7CiAgfWNhdGNoKGUpewogICAgY29uc29sZS5lcnJvcignU2VhcmNoIGxvZyBjaGVjayBmYWlsZWQnLCBlKTsKICAgIHJldHVybiB0cnVlOwogIH0KfQoKYXN5bmMgZnVuY3Rpb24gbG9nU2VhcmNoQWZ0ZXJSdW4oY2F0ZWdvcnksIHN1YkNhdGVnb3J5LCBsb2NhdGlvbiwgcmVzdWx0Q291bnQpewogIHRyeXsKICAgIGF3YWl0IGZldGNoKCcvYXBpL2xvZy1zZWFyY2gnLCB7CiAgICAgIG1ldGhvZDogJ1BPU1QnLAogICAgICBoZWFkZXJzOiB7ICdDb250ZW50LVR5cGUnOiAnYXBwbGljYXRpb24vanNvbicgfSwKICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBjYXRlZ29yeSwgc3ViQ2F0ZWdvcnksIGxvY2F0aW9uLCByZXN1bHRDb3VudCB9KQogICAgfSk7CiAgfWNhdGNoKGUpewogICAgY29uc29sZS5lcnJvcignU2VhcmNoIGxvZyB3cml0ZSBmYWlsZWQnLCBlKTsKICB9Cn0KCmFzeW5jIGZ1bmN0aW9uIGxvYWRTZWFyY2hSZXBvcnQoKXsKICBjb25zdCBib2R5ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3JlcG9ydEJvZHknKTsKICBib2R5LmlubmVySFRNTCA9ICc8dHI+PHRkIGNvbHNwYW49IjYiPkxvYWRpbmfigKY8L3RkPjwvdHI+JzsKICB0cnl7CiAgICBjb25zdCByZXNwID0gYXdhaXQgZmV0Y2goJy9hcGkvc2VhcmNoLXJlcG9ydCcpOwogICAgY29uc3QgZGF0YSA9IGF3YWl0IHJlc3AuanNvbigpOwogICAgY29uc3Qgcm93cyA9IGRhdGEucm93cyB8fCBbXTsKICAgIGlmKCFyb3dzLmxlbmd0aCl7CiAgICAgIGJvZHkuaW5uZXJIVE1MID0gJzx0cj48dGQgY29sc3Bhbj0iNiI+Tm8gc2VhcmNoZXMgbG9nZ2VkIHlldC48L3RkPjwvdHI+JzsKICAgICAgcmV0dXJuOwogICAgfQogICAgYm9keS5pbm5lckhUTUwgPSByb3dzLm1hcChyID0+CiAgICAgICc8dHI+JyArCiAgICAgICAgJzx0ZD4nICsgZXNjKHIuY2F0ZWdvcnkpICsgJzwvdGQ+JyArCiAgICAgICAgJzx0ZD4nICsgZXNjKHIuc3ViX2NhdGVnb3J5IHx8ICcnKSArICc8L3RkPicgKwogICAgICAgICc8dGQ+JyArIGVzYyhyLmxvY2F0aW9uKSArICc8L3RkPicgKwogICAgICAgICc8dGQ+JyArIChyLnRpbWVzX3NlYXJjaGVkID4gMSA/ICc8c3BhbiBjbGFzcz0ic2NvcmUtdGFnIj4nICsgci50aW1lc19zZWFyY2hlZCArICc8L3NwYW4+JyA6IHIudGltZXNfc2VhcmNoZWQpICsgJzwvdGQ+JyArCiAgICAgICAgJzx0ZD4nICsgKHIudG90YWxfcmVzdWx0cyB8fCAwKSArICc8L3RkPicgKwogICAgICAgICc8dGQ+JyArIGVzYyhuZXcgRGF0ZShyLmxhc3Rfc2VhcmNoZWRfYXQpLnRvTG9jYWxlU3RyaW5nKCkpICsgJzwvdGQ+JyArCiAgICAgICc8L3RyPicKICAgICkuam9pbignJyk7CiAgfWNhdGNoKGUpewogICAgYm9keS5pbm5lckhUTUwgPSAnPHRyPjx0ZCBjb2xzcGFuPSI2Ij5Db3VsZCBub3QgbG9hZCByZXBvcnQuPC90ZD48L3RyPic7CiAgfQp9CgovKiA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0KICAgU0FWRUQgQ1VTVE9NRVIgUElDS0VSIChGaW5kIFNpbWlsYXIgdGFiIOKAlCBwaWNrIGEgc2VlZCBpbnN0ZWFkCiAgIG9mIHR5cGluZyBvbmUgZnJvbSBtZW1vcnk7IGNpdHkvd2Vic2l0ZSBhdXRvLWZpbGwpCiAgID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PSAqLwpsZXQgc2F2ZWRDdXN0b21lcnMgPSBbXTsKCmFzeW5jIGZ1bmN0aW9uIGxvYWRTYXZlZEN1c3RvbWVycygpewogIHRyeXsKICAgIGNvbnN0IHJlc3AgPSBhd2FpdCBmZXRjaCgnL2FwaS9jdXN0b21lcnMnKTsKICAgIGlmKCFyZXNwLm9rKSByZXR1cm47CiAgICBjb25zdCBkYXRhID0gYXdhaXQgcmVzcC5qc29uKCk7CiAgICBzYXZlZEN1c3RvbWVycyA9IGRhdGEuY3VzdG9tZXJzIHx8IFtdOwogICAgY29uc3QgZGwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc2F2ZWRDdXN0b21lck9wdGlvbnMnKTsKICAgIGRsLmlubmVySFRNTCA9IHNhdmVkQ3VzdG9tZXJzLm1hcChjID0+ICc8b3B0aW9uIHZhbHVlPSInICsgZXNjKGMubmFtZSkgKyAnIj4nKS5qb2luKCcnKTsKICB9Y2F0Y2goZSl7CiAgICBjb25zb2xlLmVycm9yKCdDb3VsZCBub3QgbG9hZCBzYXZlZCBjdXN0b21lciBsaXN0JywgZSk7CiAgfQp9CgpmdW5jdGlvbiBmaWxsU2VlZEZyb21TYXZlZEN1c3RvbWVyKCl7CiAgY29uc3QgdHlwZWQgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZnNfc2VlZE5hbWUnKS52YWx1ZS50cmltKCkudG9Mb3dlckNhc2UoKTsKICBjb25zdCBtYXRjaCA9IHNhdmVkQ3VzdG9tZXJzLmZpbmQoYyA9PiBjLm5hbWUudG9Mb3dlckNhc2UoKSA9PT0gdHlwZWQpOwogIGlmKG1hdGNoKXsKICAgIGlmKG1hdGNoLmNpdHkpIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdmc19zZWVkTG9jYXRpb24nKS52YWx1ZSA9IG1hdGNoLmNpdHk7CiAgICBpZihtYXRjaC53ZWJzaXRlKSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZnNfc2VlZFdlYnNpdGUnKS52YWx1ZSA9IG1hdGNoLndlYnNpdGU7CiAgfQp9CgovKiA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0KICAgU0hBUkVEIEZJTkRFUiBFTkdJTkUgKFByb3NwZWN0IEZpbmRlciArIEZpbmQgU2ltaWxhcikKICAgPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09ICovCmxldCBmaW5kZXJSZXN1bHRzID0gW107CmxldCBzZXNzaW9uU2VhcmNoQ291bnQgPSAwOwpsZXQgc29ydFN0YXRlID0geyBmaWVsZDogJ3Njb3JlJywgZGlyOiAnZGVzYycgfTsKCmZ1bmN0aW9uIHNldFN0YXR1cyhlbElkLCBraW5kLCBtc2cpewogIGNvbnN0IHMgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChlbElkKTsKICBzLmNsYXNzTmFtZSA9ICdzdGF0dXMgb24gJyArIGtpbmQ7CiAgcy5pbm5lckhUTUwgPSAoa2luZCA9PT0gJ3dvcmtpbmcnID8gJzxzcGFuIGNsYXNzPSJwdWxzZSI+PC9zcGFuPicgOiAnJykgKyBtc2c7Cn0KCmFzeW5jIGZ1bmN0aW9uIGdlb2NvZGVPbmUobG9jVmFsdWUpewogIGNvbnN0IHJlc3AgPSBhd2FpdCBmZXRjaCgnL2FwaS9nZW9jb2RlJywgewogICAgbWV0aG9kOiAnUE9TVCcsCiAgICBoZWFkZXJzOiB7ICdDb250ZW50LVR5cGUnOiAnYXBwbGljYXRpb24vanNvbicgfSwKICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgYWRkcmVzczogbG9jVmFsdWUgKyAnLCBVU0EnIH0pCiAgfSk7CiAgY29uc3QgZGF0YSA9IGF3YWl0IHJlc3AuanNvbigpOwogIGlmKCFyZXNwLm9rKSB0aHJvdyBuZXcgRXJyb3IoZGF0YS5lcnJvciB8fCAnR2VvY29kaW5nIGZhaWxlZCBmb3IgIicgKyBsb2NWYWx1ZSArICciJyk7CiAgcmV0dXJuIGRhdGE7Cn0KCmFzeW5jIGZ1bmN0aW9uIHNlYXJjaE9uZShjYXRlZ29yeSwgbGF0LCBsbmcsIHJhZGl1cywgaW5jbHVkZURldGFpbHMpewogIGNvbnN0IHJlc3AgPSBhd2FpdCBmZXRjaCgnL2FwaS9wbGFjZXMnLCB7CiAgICBtZXRob2Q6ICdQT1NUJywKICAgIGhlYWRlcnM6IHsgJ0NvbnRlbnQtVHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uJyB9LAogICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBjYXRlZ29yeSwgbGF0LCBsbmcsIHJhZGl1c01ldGVyczogcmFkaXVzLCBpbmNsdWRlRGV0YWlscyB9KQogIH0pOwogIGNvbnN0IGRhdGEgPSBhd2FpdCByZXNwLmpzb24oKTsKICBpZighcmVzcC5vaykgdGhyb3cgbmV3IEVycm9yKGRhdGEuZXJyb3IgfHwgJ1NlYXJjaCBmYWlsZWQnKTsKICByZXR1cm4gZGF0YS5wbGFjZXMgfHwgW107Cn0KCmZ1bmN0aW9uIGNvbXB1dGVTY29yZVdpdGgocGxhY2UsIHNjb3JlKXsKICBsZXQgdG90YWwgPSAwOwogIGlmKHBsYWNlLndlYnNpdGUpIHRvdGFsICs9IHNjb3JlLndlYnNpdGU7CiAgaWYocGxhY2UucGhvbmUpIHRvdGFsICs9IHNjb3JlLnBob25lOwogIGlmKHNjb3JlLmtleXdvcmRzLmxlbmd0aCl7CiAgICBjb25zdCBuYW1lTG93ZXIgPSAocGxhY2UubmFtZSB8fCAnJykudG9Mb3dlckNhc2UoKTsKICAgIGZvcihjb25zdCBrdyBvZiBzY29yZS5rZXl3b3Jkcyl7CiAgICAgIGlmKGt3ICYmIG5hbWVMb3dlci5pbmNsdWRlcyhrdykpIHRvdGFsICs9IHNjb3JlLmt3UHRzOwogICAgfQogIH0KICByZXR1cm4gdG90YWw7Cn0KCmFzeW5jIGZ1bmN0aW9uIGV4ZWN1dGVGaW5kZXJTZWFyY2goY2ZnKXsKICBjb25zdCBidG4gPSBjZmcuYnRuOwogIGJ0bi5kaXNhYmxlZCA9IHRydWU7CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3Jlc3VsdHMnKS5jbGFzc0xpc3QucmVtb3ZlKCdvbicpOwogIGZpbmRlclJlc3VsdHMgPSBbXTsKICBjb25zdCBzZWVuID0gbmV3IFNldCgpOwogIGlmKGNmZy5leGNsdWRlSWQpIHNlZW4uYWRkKGNmZy5leGNsdWRlSWQpOwogIGNvbnN0IHNlYXJjaFRleHQgPSBjZmcuY2F0ZWdvcnkgKyAoY2ZnLnN1YkNhdGVnb3J5ID8gJyAnICsgY2ZnLnN1YkNhdGVnb3J5IDogJycpOwoKICB0cnl7CiAgICBmb3IobGV0IGkgPSAwOyBpIDwgY2ZnLmxvY2F0aW9ucy5sZW5ndGg7IGkrKyl7CiAgICAgIGNvbnN0IGxvY1ZhbHVlID0gY2ZnLmxvY2F0aW9uc1tpXTsKCiAgICAgIGlmKHNlc3Npb25TZWFyY2hDb3VudCA+PSBjZmcubWF4U2VhcmNoZXMpewogICAgICAgIHNldFN0YXR1cyhjZmcuc3RhdHVzSWQsICdlcnJvcicsICdTZXNzaW9uIGxpbWl0IHJlYWNoZWQgKCcgKyBzZXNzaW9uU2VhcmNoQ291bnQgKyAnIG9mICcgKyBjZmcubWF4U2VhcmNoZXMgKyAnKSBwYXJ0d2F5IHRocm91Z2guIFJlc3VsdHMgc28gZmFyIGFyZSBrZXB0IGJlbG93LiBSYWlzZSB0aGUgbGltaXQgb3IgcmVsb2FkIHRvIHJlc2V0LCB0aGVuIGNvbnRpbnVlLicpOwogICAgICAgIGJyZWFrOwogICAgICB9CgogICAgICBjb25zdCBva1RvUHJvY2VlZCA9IGF3YWl0IGNoZWNrU2VhcmNoTG9nQmVmb3JlUnVuKGNmZy5jYXRlZ29yeSwgY2ZnLnN1YkNhdGVnb3J5LCBsb2NWYWx1ZSk7CiAgICAgIGlmKCFva1RvUHJvY2VlZCl7CiAgICAgICAgc2V0U3RhdHVzKGNmZy5zdGF0dXNJZCwgJ3dvcmtpbmcnLCAnU2tpcHBlZCAnICsgbG9jVmFsdWUgKyAnIChhbHJlYWR5IHNlYXJjaGVkKS4nKTsKICAgICAgICBjb250aW51ZTsKICAgICAgfQoKICAgICAgc2V0U3RhdHVzKGNmZy5zdGF0dXNJZCwgJ3dvcmtpbmcnLCAnTG9jYXRpbmcgJyArIGxvY1ZhbHVlICsgJyAoJyArIChpKzEpICsgJyBvZiAnICsgY2ZnLmxvY2F0aW9ucy5sZW5ndGggKyAnKS4nKTsKICAgICAgY29uc3QgZ2VvID0gYXdhaXQgZ2VvY29kZU9uZShsb2NWYWx1ZSk7CgogICAgICBzZXNzaW9uU2VhcmNoQ291bnQrKzsKICAgICAgc2V0U3RhdHVzKGNmZy5zdGF0dXNJZCwgJ3dvcmtpbmcnLCAnU2VhcmNoaW5nICcgKyBsb2NWYWx1ZSArICcgKHNlYXJjaCAnICsgc2Vzc2lvblNlYXJjaENvdW50ICsgJyBvZiAnICsgY2ZnLm1heFNlYXJjaGVzICsgJyBhbGxvd2VkIHRoaXMgc2Vzc2lvbikuJyk7CgogICAgICBjb25zdCBwbGFjZXMgPSBhd2FpdCBzZWFyY2hPbmUoc2VhcmNoVGV4dCwgZ2VvLmxhdCwgZ2VvLmxuZywgY2ZnLnJhZGl1cywgY2ZnLmluY2x1ZGVEZXRhaWxzKTsKICAgICAgZm9yKGNvbnN0IHAgb2YgcGxhY2VzKXsKICAgICAgICBpZighcC5pZCB8fCBzZWVuLmhhcyhwLmlkKSkgY29udGludWU7CiAgICAgICAgc2Vlbi5hZGQocC5pZCk7CiAgICAgICAgZmluZGVyUmVzdWx0cy5wdXNoKHsgLi4ucCwgYXJlYTogbG9jVmFsdWUsIHNjb3JlOiAwIH0pOwogICAgICB9CiAgICAgIGxvZ1NlYXJjaEFmdGVyUnVuKGNmZy5jYXRlZ29yeSwgY2ZnLnN1YkNhdGVnb3J5LCBsb2NWYWx1ZSwgcGxhY2VzLmxlbmd0aCk7CiAgICB9CgogICAgZm9yKGNvbnN0IHIgb2YgZmluZGVyUmVzdWx0cyl7IHIuc2NvcmUgPSBjb21wdXRlU2NvcmVXaXRoKHIsIGNmZy5zY29yZSk7IH0KCiAgICByZW5kZXJGaW5kZXJSZXN1bHRzKCk7CiAgICBzZXRTdGF0dXMoY2ZnLnN0YXR1c0lkLCAnZG9uZScsIGZpbmRlclJlc3VsdHMubGVuZ3RoICsgJyB1bmlxdWUgYnVzaW5lc3NlcyBmb3VuZCBhY3Jvc3MgJyArIGNmZy5sb2NhdGlvbnMubGVuZ3RoICsgJyBsb2NhdGlvbihzKS4gU2Vzc2lvbiBzZWFyY2hlcyB1c2VkOiAnICsgc2Vzc2lvblNlYXJjaENvdW50ICsgJyBvZiAnICsgY2ZnLm1heFNlYXJjaGVzICsgJy4nKTsKICB9Y2F0Y2goZSl7CiAgICBjb25zb2xlLmVycm9yKGUpOwogICAgc2V0U3RhdHVzKGNmZy5zdGF0dXNJZCwgJ2Vycm9yJywgJ1NlYXJjaCBmYWlsZWQ6ICcgKyBlLm1lc3NhZ2UpOwogIH1maW5hbGx5ewogICAgYnRuLmRpc2FibGVkID0gZmFsc2U7CiAgfQp9CgpmdW5jdGlvbiByZWFkU2NvcmUocHJlZml4KXsKICByZXR1cm4gewogICAgd2Vic2l0ZTogcGFyc2VJbnQoZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQocHJlZml4ICsgJ3Njb3JlV2Vic2l0ZScpLnZhbHVlLCAxMCkgfHwgMCwKICAgIHBob25lOiBwYXJzZUludChkb2N1bWVudC5nZXRFbGVtZW50QnlJZChwcmVmaXggKyAnc2NvcmVQaG9uZScpLnZhbHVlLCAxMCkgfHwgMCwKICAgIGt3UHRzOiBwYXJzZUludChkb2N1bWVudC5nZXRFbGVtZW50QnlJZChwcmVmaXggKyAnc2NvcmVLZXl3b3JkUHRzJykudmFsdWUsIDEwKSB8fCAwLAogICAga2V5d29yZHM6IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKHByZWZpeCArICdzY29yZUtleXdvcmRzJykudmFsdWUKICAgICAgLnNwbGl0KCcsJykubWFwKGsgPT4gay50cmltKCkudG9Mb3dlckNhc2UoKSkuZmlsdGVyKEJvb2xlYW4pCiAgfTsKfQoKZnVuY3Rpb24gcmVhZExvY2F0aW9ucyhpZCl7CiAgcmV0dXJuIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKGlkKS52YWx1ZS5zcGxpdCgnXG4nKS5tYXAocyA9PiBzLnRyaW0oKSkuZmlsdGVyKEJvb2xlYW4pOwp9CgpmdW5jdGlvbiBydW5TZWFyY2goKXsKICBjb25zdCBjYXRlZ29yeSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjYXRlZ29yeScpLnZhbHVlLnRyaW0oKTsKICBjb25zdCBzdWJDYXRlZ29yeSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzdWJDYXRlZ29yeScpLnZhbHVlLnRyaW0oKTsKICBjb25zdCBsb2NhdGlvbnMgPSByZWFkTG9jYXRpb25zKCdsb2NWYWx1ZScpOwogIGlmKCFjYXRlZ29yeSl7IHNldFN0YXR1cygnc3RhdHVzJywnZXJyb3InLCdDaG9vc2UgYSBjYXRlZ29yeSBmaXJzdC4nKTsgcmV0dXJuOyB9CiAgaWYoIWxvY2F0aW9ucy5sZW5ndGgpeyBzZXRTdGF0dXMoJ3N0YXR1cycsJ2Vycm9yJywnRW50ZXIgYXQgbGVhc3Qgb25lIGxvY2F0aW9uIGZpcnN0LicpOyByZXR1cm47IH0KICBleGVjdXRlRmluZGVyU2VhcmNoKHsKICAgIGNhdGVnb3J5LAogICAgc3ViQ2F0ZWdvcnksCiAgICBsb2NhdGlvbnMsCiAgICByYWRpdXM6IHBhcnNlSW50KGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdyYWRpdXMnKS52YWx1ZSwgMTApLAogICAgaW5jbHVkZURldGFpbHM6IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdkZXRhaWxzJykudmFsdWUgPT09ICd5ZXMnLAogICAgbWF4U2VhcmNoZXM6IHBhcnNlSW50KGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdtYXhTZWFyY2hlcycpLnZhbHVlLCAxMCkgfHwgMjUsCiAgICBzY29yZTogcmVhZFNjb3JlKCcnKSwKICAgIGV4Y2x1ZGVJZDogbnVsbCwKICAgIHN0YXR1c0lkOiAnc3RhdHVzJywKICAgIGJ0bjogZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2ZpbmRCdG4nKQogIH0pOwp9CgpsZXQgZnNTZWVkSWQgPSBudWxsOwoKYXN5bmMgZnVuY3Rpb24gYW5hbHl6ZVNlZWQoKXsKICBjb25zdCBzZWVkTmFtZSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdmc19zZWVkTmFtZScpLnZhbHVlLnRyaW0oKTsKICBjb25zdCBzZWVkTG9jYXRpb24gPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZnNfc2VlZExvY2F0aW9uJykudmFsdWUudHJpbSgpOwogIGNvbnN0IHNlZWRXZWJzaXRlID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2ZzX3NlZWRXZWJzaXRlJykudmFsdWUudHJpbSgpOwogIGlmKCFzZWVkTmFtZSl7IHNldFN0YXR1cygnZnNfc3RhdHVzJywnZXJyb3InLCdFbnRlciBhIHNlZWQgY3VzdG9tZXIgbmFtZSBmaXJzdC4nKTsgcmV0dXJuOyB9CgogIGNvbnN0IGJ0biA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdmc19hbmFseXplQnRuJyk7CiAgYnRuLmRpc2FibGVkID0gdHJ1ZTsKICBzZXRTdGF0dXMoJ2ZzX3N0YXR1cycsJ3dvcmtpbmcnLCdMb29raW5nIHVwICInICsgc2VlZE5hbWUgKyAnIi4nKTsKICB0cnl7CiAgICBjb25zdCByZXNwID0gYXdhaXQgZmV0Y2goJy9hcGkvc2VlZCcsIHsKICAgICAgbWV0aG9kOiAnUE9TVCcsCiAgICAgIGhlYWRlcnM6IHsgJ0NvbnRlbnQtVHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uJyB9LAogICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IHNlZWROYW1lLCBzZWVkTG9jYXRpb24sIHNlZWRXZWJzaXRlIH0pCiAgICB9KTsKICAgIGNvbnN0IGRhdGEgPSBhd2FpdCByZXNwLmpzb24oKTsKICAgIGlmKCFyZXNwLm9rKSB0aHJvdyBuZXcgRXJyb3IoZGF0YS5lcnJvciB8fCAnU2VlZCBsb29rdXAgZmFpbGVkJyk7CgogICAgZnNTZWVkSWQgPSAoZGF0YS5tYXRjaCAmJiBkYXRhLm1hdGNoLmlkKSB8fCBudWxsOwogICAgbGV0IGNhdGVnb3J5Tm90ZSA9ICcnOwogICAgaWYoZGF0YS5zdWdnZXN0ZWRDYXRlZ29yeSl7CiAgICAgIGNvbnN0IG1hdGNoZWRDYXQgPSBPYmplY3Qua2V5cyhjYXRlZ29yaWVzVHJlZSkuZmluZChjID0+IGMudG9Mb3dlckNhc2UoKSA9PT0gZGF0YS5zdWdnZXN0ZWRDYXRlZ29yeS50b0xvd2VyQ2FzZSgpKTsKICAgICAgaWYobWF0Y2hlZENhdCl7CiAgICAgICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2ZzX2NhdGVnb3J5JykudmFsdWUgPSBtYXRjaGVkQ2F0OwogICAgICAgIG9uQ2F0ZWdvcnlDaGFuZ2UoJ2ZzXycsICdmc19zdWJDYXRlZ29yeScpOwogICAgICAgIGNhdGVnb3J5Tm90ZSA9ICdNYXRjaGVkIHRvIHlvdXIgZXhpc3RpbmcgY2F0ZWdvcnkgIicgKyBtYXRjaGVkQ2F0ICsgJyIuJzsKICAgICAgfSBlbHNlIHsKICAgICAgICBjYXRlZ29yeU5vdGUgPSAnR29vZ2xlIHN1Z2dlc3RzICInICsgZXNjKGRhdGEuc3VnZ2VzdGVkQ2F0ZWdvcnkpICsgJyIg4oCUIHRoYXRcJ3Mgbm90IGluIHlvdXIgQ2F0ZWdvcmllcyBsaXN0IHlldCwgc28gcGljayB0aGUgY2xvc2VzdCBtYXRjaCBiZWxvdywgb3IgYWRkIGl0IG9uIHRoZSBDYXRlZ29yaWVzIHRhYiBmaXJzdC4nOwogICAgICB9CiAgICB9CgogICAgY29uc3QgbSA9IGRhdGEubWF0Y2ggfHwge307CiAgICBjb25zdCBpbmZvID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2ZzX3NlZWRJbmZvJyk7CiAgICBpbmZvLmlubmVySFRNTCA9CiAgICAgICdNYXRjaGVkOiA8c3Ryb25nPicgKyBlc2MobS5uYW1lIHx8IHNlZWROYW1lKSArICc8L3N0cm9uZz48YnI+JyArCiAgICAgIChtLmFkZHJlc3MgPyBlc2MobS5hZGRyZXNzKSArICc8YnI+JyA6ICcnKSArCiAgICAgIChtLndlYnNpdGUgPyBlc2MobS53ZWJzaXRlKSArICc8YnI+JyA6ICcnKSArCiAgICAgICdHb29nbGUgY2F0ZWdvcnk6ICcgKyBlc2MoZGF0YS5zdWdnZXN0ZWRDYXRlZ29yeSB8fCBtLnByaW1hcnlUeXBlIHx8ICduL2EnKSArCiAgICAgICc8YnI+PGJyPicgKyBjYXRlZ29yeU5vdGU7CiAgICBpbmZvLmNsYXNzTGlzdC5hZGQoJ29uJyk7CiAgICBzZXRTdGF0dXMoJ2ZzX3N0YXR1cycsJ2RvbmUnLCdTZWVkIGFuYWx5emVkLiBDb25maXJtIHRoZSBjYXRlZ29yeSBiZWxvdywgYWRkIHlvdXIgWklQL2NpdHkgbGluZXMsIHRoZW4gRmluZCBTaW1pbGFyLicpOwogIH1jYXRjaChlKXsKICAgIGNvbnNvbGUuZXJyb3IoZSk7CiAgICBzZXRTdGF0dXMoJ2ZzX3N0YXR1cycsJ2Vycm9yJywnQ291bGQgbm90IGFuYWx5emUgc2VlZDogJyArIGUubWVzc2FnZSk7CiAgfWZpbmFsbHl7CiAgICBidG4uZGlzYWJsZWQgPSBmYWxzZTsKICB9Cn0KCmZ1bmN0aW9uIHJ1blNpbWlsYXJTZWFyY2goKXsKICBjb25zdCBjYXRlZ29yeSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdmc19jYXRlZ29yeScpLnZhbHVlLnRyaW0oKTsKICBjb25zdCBzdWJDYXRlZ29yeSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdmc19zdWJDYXRlZ29yeScpLnZhbHVlLnRyaW0oKTsKICBjb25zdCBsb2NhdGlvbnMgPSByZWFkTG9jYXRpb25zKCdmc19sb2NWYWx1ZScpOwogIGlmKCFjYXRlZ29yeSl7IHNldFN0YXR1cygnZnNfc3RhdHVzJywnZXJyb3InLCdDaG9vc2UgYSBjYXRlZ29yeSBmaXJzdC4nKTsgcmV0dXJuOyB9CiAgaWYoIWxvY2F0aW9ucy5sZW5ndGgpeyBzZXRTdGF0dXMoJ2ZzX3N0YXR1cycsJ2Vycm9yJywnRW50ZXIgYXQgbGVhc3Qgb25lIGxvY2F0aW9uIGZpcnN0LicpOyByZXR1cm47IH0KICBleGVjdXRlRmluZGVyU2VhcmNoKHsKICAgIGNhdGVnb3J5LAogICAgc3ViQ2F0ZWdvcnksCiAgICBsb2NhdGlvbnMsCiAgICByYWRpdXM6IHBhcnNlSW50KGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdmc19yYWRpdXMnKS52YWx1ZSwgMTApLAogICAgaW5jbHVkZURldGFpbHM6IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdmc19kZXRhaWxzJykudmFsdWUgPT09ICd5ZXMnLAogICAgbWF4U2VhcmNoZXM6IHBhcnNlSW50KGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdmc19tYXhTZWFyY2hlcycpLnZhbHVlLCAxMCkgfHwgMjUsCiAgICBzY29yZTogcmVhZFNjb3JlKCdmc18nKSwKICAgIGV4Y2x1ZGVJZDogZnNTZWVkSWQsCiAgICBzdGF0dXNJZDogJ2ZzX3N0YXR1cycsCiAgICBidG46IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdmc19maW5kQnRuJykKICB9KTsKfQpmdW5jdGlvbiBzb3J0QnkoZmllbGQpewogIGlmKHNvcnRTdGF0ZS5maWVsZCA9PT0gZmllbGQpewogICAgc29ydFN0YXRlLmRpciA9IHNvcnRTdGF0ZS5kaXIgPT09ICdhc2MnID8gJ2Rlc2MnIDogJ2FzYyc7CiAgfSBlbHNlIHsKICAgIHNvcnRTdGF0ZS5maWVsZCA9IGZpZWxkOwogICAgc29ydFN0YXRlLmRpciA9IGZpZWxkID09PSAnc2NvcmUnID8gJ2Rlc2MnIDogJ2FzYyc7CiAgfQogIHJlbmRlckZpbmRlclJlc3VsdHMoKTsKfQoKZnVuY3Rpb24gcmVuZGVyRmluZGVyUmVzdWx0cygpewogIGNvbnN0IGJvZHkgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgncmVzdWx0c0JvZHknKTsKICBjb25zdCBzb3J0ZWQgPSBbLi4uZmluZGVyUmVzdWx0c10uc29ydCgoYSwgYikgPT4gewogICAgY29uc3QgZiA9IHNvcnRTdGF0ZS5maWVsZDsKICAgIGxldCBhdiA9IGFbZl0sIGJ2ID0gYltmXTsKICAgIGlmKGYgPT09ICdzY29yZScpeyBhdiA9IGF2IHx8IDA7IGJ2ID0gYnYgfHwgMDsgfQogICAgZWxzZSB7IGF2ID0gKGF2IHx8ICcnKS50b1N0cmluZygpLnRvTG93ZXJDYXNlKCk7IGJ2ID0gKGJ2IHx8ICcnKS50b1N0cmluZygpLnRvTG93ZXJDYXNlKCk7IH0KICAgIGlmKGF2IDwgYnYpIHJldHVybiBzb3J0U3RhdGUuZGlyID09PSAnYXNjJyA/IC0xIDogMTsKICAgIGlmKGF2ID4gYnYpIHJldHVybiBzb3J0U3RhdGUuZGlyID09PSAnYXNjJyA/IDEgOiAtMTsKICAgIHJldHVybiAwOwogIH0pOwoKICBpZihzb3J0ZWQubGVuZ3RoID09PSAwKXsKICAgIGJvZHkuaW5uZXJIVE1MID0gJzx0cj48dGQgY29sc3Bhbj0iOSI+Tm8gbWF0Y2hlcyBmb3VuZC4gVHJ5IGEgYnJvYWRlciBjYXRlZ29yeSwgYSBsYXJnZXIgcmFkaXVzLCBvciBkaWZmZXJlbnQgbG9jYXRpb25zLjwvdGQ+PC90cj4nOwogIH0gZWxzZSB7CiAgICBib2R5LmlubmVySFRNTCA9IHNvcnRlZC5tYXAociA9PgogICAgICAnPHRyPicgKwogICAgICAgICc8dGQ+PHNwYW4gY2xhc3M9InNjb3JlLXRhZyI+JyArIGVzYyhyLnNjb3JlKSArICc8L3NwYW4+PC90ZD4nICsKICAgICAgICAnPHRkPicgKyBlc2Moci5uYW1lKSArICc8L3RkPicgKwogICAgICAgICc8dGQ+JyArIGVzYyhyLmFkZHJlc3MpICsgJzwvdGQ+JyArCiAgICAgICAgJzx0ZD4nICsgZXNjKHIucGhvbmUpICsgJzwvdGQ+JyArCiAgICAgICAgJzx0ZD4nICsgKHIud2Vic2l0ZSA/ICc8YSBocmVmPSInK2VzYyhyLndlYnNpdGUpKyciIHRhcmdldD0iX2JsYW5rIiByZWw9Im5vb3BlbmVyIj4nK2VzYyhyLndlYnNpdGUpKyc8L2E+JyA6ICcnKSArICc8L3RkPicgKwogICAgICAgICc8dGQ+JyArIChyLmluZHVzdHJ5ID8gJzxzcGFuIGNsYXNzPSJjYXQtdGFnIj4nICsgZXNjKHIuaW5kdXN0cnkpICsgKHIuc3ViSW5kdXN0cnkgPyAnIOKAlCAnICsgZXNjKHIuc3ViSW5kdXN0cnkpIDogJycpICsgJzwvc3Bhbj4nIDogJycpICsgJzwvdGQ+JyArCiAgICAgICAgJzx0ZD4nICsgZXNjKHIuZW1haWwgfHwgJycpICsgJzwvdGQ+JyArCiAgICAgICAgJzx0ZD48c3BhbiBjbGFzcz0iY2F0LXRhZyI+JyArIGVzYyhyLmFyZWEpICsgJzwvc3Bhbj4nICsgKHIuY2FjaGVkID8gJzxzcGFuIGNsYXNzPSJjYWNoZWQtdGFnIj4oY2FjaGVkKTwvc3Bhbj4nIDogJycpICsgJzwvdGQ+JyArCiAgICAgICAgJzx0ZD4nICsgKHIuZXhpc3RpbmdDdXN0b21lciA/ICc8c3BhbiBjbGFzcz0iZXhpc3RpbmctdGFnIj5FeGlzdGluZzwvc3Bhbj4nIDogJycpICsgJzwvdGQ+JyArCiAgICAgICc8L3RyPicKICAgICkuam9pbignJyk7CiAgfQogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdyZXNNZXRhJykudGV4dENvbnRlbnQgPSBmaW5kZXJSZXN1bHRzLmxlbmd0aCArICcgYnVzaW5lc3Nlcyc7CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3Jlc3VsdHMnKS5jbGFzc0xpc3QuYWRkKCdvbicpOwogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdyZXN1bHRzJykuc2Nyb2xsSW50b1ZpZXcoeyBiZWhhdmlvcjonc21vb3RoJywgYmxvY2s6J3N0YXJ0JyB9KTsKfQoKZnVuY3Rpb24gZG93bmxvYWRGaW5kZXJYbHN4KCl7CiAgaWYoIWZpbmRlclJlc3VsdHMubGVuZ3RoKXsgc2V0U3RhdHVzKCdzdGF0dXMnLCdlcnJvcicsJ05vdGhpbmcgdG8gZG93bmxvYWQgeWV0LCBydW4gYSBzZWFyY2ggZmlyc3QuJyk7IHJldHVybjsgfQogIGNvbnN0IHJvd3MgPSBmaW5kZXJSZXN1bHRzLm1hcChyID0+ICh7CiAgICAnU2NvcmUnOiByLnNjb3JlLCAnQnVzaW5lc3MnOiByLm5hbWUsICdBZGRyZXNzJzogci5hZGRyZXNzLCAnUGhvbmUnOiByLnBob25lLCAnV2Vic2l0ZSc6IHIud2Vic2l0ZSwKICAgICdJbmR1c3RyeSc6IHIuaW5kdXN0cnkgfHwgJycsICdTdWItSW5kdXN0cnknOiByLnN1YkluZHVzdHJ5IHx8ICcnLCAnRW1haWwnOiByLmVtYWlsIHx8ICcnLAogICAgJ01hdGNoZWQgQXJlYSc6IHIuYXJlYSwgJ0V4aXN0aW5nIEN1c3RvbWVyJzogci5leGlzdGluZ0N1c3RvbWVyID8gJ1llcycgOiAnJwogIH0pKTsKICBjb25zdCB3cyA9IFhMU1gudXRpbHMuanNvbl90b19zaGVldChyb3dzKTsKICB3c1snIWNvbHMnXSA9IFt7d2NoOjh9LHt3Y2g6MzJ9LHt3Y2g6NDJ9LHt3Y2g6MTZ9LHt3Y2g6MzJ9LHt3Y2g6MTh9LHt3Y2g6MjR9LHt3Y2g6MjZ9LHt3Y2g6MTh9LHt3Y2g6MTZ9XTsKICBjb25zdCB3YiA9IFhMU1gudXRpbHMuYm9va19uZXcoKTsKICBYTFNYLnV0aWxzLmJvb2tfYXBwZW5kX3NoZWV0KHdiLCB3cywgJ1Byb3NwZWN0cycpOwogIFhMU1gud3JpdGVGaWxlKHdiLCAnbW9kb25peF9wcm9zcGVjdHMueGxzeCcpOwp9Cgphc3luYyBmdW5jdGlvbiBjb3B5RmluZGVyRm9yU2hlZXRzKGJ0bil7CiAgaWYoIWZpbmRlclJlc3VsdHMubGVuZ3RoKXsgc2V0U3RhdHVzKCdzdGF0dXMnLCdlcnJvcicsJ05vdGhpbmcgdG8gY29weSB5ZXQsIHJ1biBhIHNlYXJjaCBmaXJzdC4nKTsgcmV0dXJuOyB9CiAgY29uc3QgaGVhZGVyID0gWydTY29yZScsJ0J1c2luZXNzJywnQWRkcmVzcycsJ1Bob25lJywnV2Vic2l0ZScsJ0luZHVzdHJ5JywnU3ViLUluZHVzdHJ5JywnRW1haWwnLCdNYXRjaGVkIEFyZWEnLCdFeGlzdGluZyBDdXN0b21lciddOwogIGNvbnN0IHJvd3MgPSBmaW5kZXJSZXN1bHRzLm1hcChyID0+IFtyLnNjb3JlLCByLm5hbWUsIHIuYWRkcmVzcywgci5waG9uZSwgci53ZWJzaXRlLCByLmluZHVzdHJ5IHx8ICcnLCByLnN1YkluZHVzdHJ5IHx8ICcnLCByLmVtYWlsIHx8ICcnLCByLmFyZWEsIHIuZXhpc3RpbmdDdXN0b21lciA/ICdZZXMnIDogJyddKTsKICBjb25zdCB0c3YgPSBbaGVhZGVyLCAuLi5yb3dzXS5tYXAocm93ID0+IHJvdy5qb2luKCdcdCcpKS5qb2luKCdcbicpOwogIHRyeXsKICAgIGF3YWl0IG5hdmlnYXRvci5jbGlwYm9hcmQud3JpdGVUZXh0KHRzdik7CiAgICBjb25zdCBvcmlnID0gYnRuLnRleHRDb250ZW50OwogICAgYnRuLnRleHRDb250ZW50ID0gJ0NvcGllZCc7CiAgICBidG4uY2xhc3NMaXN0LmFkZCgnY29waWVkJyk7CiAgICBzZXRUaW1lb3V0KCgpID0+IHsgYnRuLnRleHRDb250ZW50ID0gb3JpZzsgYnRuLmNsYXNzTGlzdC5yZW1vdmUoJ2NvcGllZCcpOyB9LCAxNjAwKTsKICB9Y2F0Y2goZSl7CiAgICBzZXRTdGF0dXMoJ3N0YXR1cycsJ2Vycm9yJywnQ29weSBmYWlsZWQsIHNlbGVjdCBhbmQgY29weSBtYW51YWxseS4nKTsKICB9Cn0KCmRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdsb2NUeXBlJykuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgKCkgPT4gewogIGNvbnN0IHR5cGUgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbG9jVHlwZScpLnZhbHVlOwogIGNvbnN0IHRhID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2xvY1ZhbHVlJyk7CiAgY29uc3QgaGludCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdsb2NIaW50Jyk7CiAgaWYodHlwZSA9PT0gJ3ppcCcpeyB0YS5wbGFjZWhvbGRlciA9ICczMjkzN1xuMzI5MDFcbjMyOTM1JzsgaGludC50ZXh0Q29udGVudCA9ICcob25lIFpJUCBwZXIgbGluZSDigJQgYWRkIG1vcmUgbGluZXMgdG8gc2VhcmNoIG11bHRpcGxlIGFyZWFzIGluIG9uZSBydW4pJzsgfQogIGVsc2UgeyB0YS5wbGFjZWhvbGRlciA9ICdPcmxhbmRvLCBGTFxuVGFtcGEsIEZMJzsgaGludC50ZXh0Q29udGVudCA9ICcob25lIGNpdHkgcGVyIGxpbmUg4oCUIGFkZCBtb3JlIGxpbmVzIHRvIHNlYXJjaCBtdWx0aXBsZSBhcmVhcyBpbiBvbmUgcnVuKSc7IH0KfSk7CmRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdmc19sb2NUeXBlJykuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgKCkgPT4gewogIGNvbnN0IHR5cGUgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZnNfbG9jVHlwZScpLnZhbHVlOwogIGNvbnN0IHRhID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2ZzX2xvY1ZhbHVlJyk7CiAgY29uc3QgaGludCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdmc19sb2NIaW50Jyk7CiAgaWYodHlwZSA9PT0gJ3ppcCcpeyB0YS5wbGFjZWhvbGRlciA9ICczMzgxMVxuMzM4MTNcbjMzODMwJzsgaGludC50ZXh0Q29udGVudCA9ICcob25lIFpJUCBwZXIgbGluZSDigJQgYWRkIHRoZSBaSVBzIHlvdSB3YW50IHRvIGNvdmVyKSc7IH0KICBlbHNlIHsgdGEucGxhY2Vob2xkZXIgPSAnTGFrZWxhbmQsIEZMXG5UYW1wYSwgRkwnOyBoaW50LnRleHRDb250ZW50ID0gJyhvbmUgY2l0eSBwZXIgbGluZSDigJQgYWRkIHRoZSBjaXRpZXMgeW91IHdhbnQgdG8gY292ZXIpJzsgfQp9KTsKCmNvbnN0IFNBVkVEX0tFWSA9ICdtb2Rvbml4X3Byb3NwZWN0X3NhdmVkX3NlYXJjaGVzJzsKCmZ1bmN0aW9uIGdldFNhdmVkU2VhcmNoZXMoKXsKICB0cnl7IHJldHVybiBKU09OLnBhcnNlKGxvY2FsU3RvcmFnZS5nZXRJdGVtKFNBVkVEX0tFWSkgfHwgJ1tdJyk7IH1jYXRjaChlKXsgcmV0dXJuIFtdOyB9Cn0KZnVuY3Rpb24gc2V0U2F2ZWRTZWFyY2hlcyhsaXN0KXsgbG9jYWxTdG9yYWdlLnNldEl0ZW0oU0FWRURfS0VZLCBKU09OLnN0cmluZ2lmeShsaXN0KSk7IH0KCmZ1bmN0aW9uIHNhdmVDdXJyZW50U2VhcmNoKCl7CiAgY29uc3QgY2F0ZWdvcnkgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnY2F0ZWdvcnknKS52YWx1ZS50cmltKCk7CiAgY29uc3Qgc3ViQ2F0ZWdvcnkgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc3ViQ2F0ZWdvcnknKS52YWx1ZS50cmltKCk7CiAgY29uc3QgbG9jYXRpb25zID0gcmVhZExvY2F0aW9ucygnbG9jVmFsdWUnKTsKICBpZighY2F0ZWdvcnkgfHwgIWxvY2F0aW9ucy5sZW5ndGgpewogICAgc2V0U3RhdHVzKCdzdGF0dXMnLCdlcnJvcicsJ0Nob29zZSBhIGNhdGVnb3J5IGFuZCBlbnRlciBhdCBsZWFzdCBvbmUgbG9jYXRpb24gYmVmb3JlIHNhdmluZy4nKTsKICAgIHJldHVybjsKICB9CiAgY29uc3QgZW50cnkgPSB7CiAgICBpZDogRGF0ZS5ub3coKS50b1N0cmluZygzNiksCiAgICBjYXRlZ29yeSwKICAgIHN1YkNhdGVnb3J5LAogICAgbG9jVHlwZTogZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2xvY1R5cGUnKS52YWx1ZSwKICAgIGxvY2F0aW9ucywKICAgIHJhZGl1czogZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3JhZGl1cycpLnZhbHVlLAogICAgZGV0YWlsczogZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2RldGFpbHMnKS52YWx1ZSwKICAgIHNjb3JlV2Vic2l0ZTogZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3Njb3JlV2Vic2l0ZScpLnZhbHVlLAogICAgc2NvcmVQaG9uZTogZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3Njb3JlUGhvbmUnKS52YWx1ZSwKICAgIHNjb3JlS2V5d29yZHM6IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzY29yZUtleXdvcmRzJykudmFsdWUsCiAgICBzY29yZUtleXdvcmRQdHM6IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzY29yZUtleXdvcmRQdHMnKS52YWx1ZSwKICAgIHNhdmVkQXQ6IG5ldyBEYXRlKCkudG9Mb2NhbGVTdHJpbmcoKQogIH07CiAgY29uc3QgbGlzdCA9IGdldFNhdmVkU2VhcmNoZXMoKTsKICBsaXN0LnVuc2hpZnQoZW50cnkpOwogIHNldFNhdmVkU2VhcmNoZXMobGlzdC5zbGljZSgwLCAzMCkpOwogIHJlbmRlclNhdmVkU2VhcmNoZXMoKTsKICBzZXRTdGF0dXMoJ3N0YXR1cycsJ2RvbmUnLCdTZWFyY2ggc2V0dXAgc2F2ZWQuJyk7Cn0KCmZ1bmN0aW9uIGxvYWRTYXZlZFNlYXJjaChpZCl7CiAgY29uc3QgZW50cnkgPSBnZXRTYXZlZFNlYXJjaGVzKCkuZmluZChlID0+IGUuaWQgPT09IGlkKTsKICBpZighZW50cnkpIHJldHVybjsKICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnY2F0ZWdvcnknKS52YWx1ZSA9IGVudHJ5LmNhdGVnb3J5OwogIG9uQ2F0ZWdvcnlDaGFuZ2UoJycsICdzdWJDYXRlZ29yeScpOwogIGlmKGVudHJ5LnN1YkNhdGVnb3J5KSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc3ViQ2F0ZWdvcnknKS52YWx1ZSA9IGVudHJ5LnN1YkNhdGVnb3J5OwogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdsb2NUeXBlJykudmFsdWUgPSBlbnRyeS5sb2NUeXBlOwogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdsb2NUeXBlJykuZGlzcGF0Y2hFdmVudChuZXcgRXZlbnQoJ2NoYW5nZScpKTsKICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbG9jVmFsdWUnKS52YWx1ZSA9IGVudHJ5LmxvY2F0aW9ucy5qb2luKCdcbicpOwogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdyYWRpdXMnKS52YWx1ZSA9IGVudHJ5LnJhZGl1czsKICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZGV0YWlscycpLnZhbHVlID0gZW50cnkuZGV0YWlsczsKICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc2NvcmVXZWJzaXRlJykudmFsdWUgPSBlbnRyeS5zY29yZVdlYnNpdGU7CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3Njb3JlUGhvbmUnKS52YWx1ZSA9IGVudHJ5LnNjb3JlUGhvbmU7CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3Njb3JlS2V5d29yZHMnKS52YWx1ZSA9IGVudHJ5LnNjb3JlS2V5d29yZHM7CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3Njb3JlS2V5d29yZFB0cycpLnZhbHVlID0gZW50cnkuc2NvcmVLZXl3b3JkUHRzOwogIHNldFN0YXR1cygnc3RhdHVzJywnZG9uZScsJ0xvYWRlZCBzYXZlZCBzZWFyY2g6ICcgKyBlbnRyeS5jYXRlZ29yeSk7Cn0KCmZ1bmN0aW9uIGRlbGV0ZVNhdmVkU2VhcmNoKGlkKXsKICBzZXRTYXZlZFNlYXJjaGVzKGdldFNhdmVkU2VhcmNoZXMoKS5maWx0ZXIoZSA9PiBlLmlkICE9PSBpZCkpOwogIHJlbmRlclNhdmVkU2VhcmNoZXMoKTsKfQoKZnVuY3Rpb24gcmVuZGVyU2F2ZWRTZWFyY2hlcygpewogIGNvbnN0IGNvbnRhaW5lciA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzYXZlZExpc3QnKTsKICBjb25zdCBsaXN0ID0gZ2V0U2F2ZWRTZWFyY2hlcygpOwogIGlmKCFsaXN0Lmxlbmd0aCl7CiAgICBjb250YWluZXIuaW5uZXJIVE1MID0gJzxwIGNsYXNzPSJlbXB0eS1ub3RlIj5ObyBzYXZlZCBzZWFyY2hlcyB5ZXQuIFNldCB1cCBhIHNlYXJjaCBhYm92ZSBhbmQgY2xpY2sgIlNhdmUgVGhpcyBTZWFyY2ggU2V0dXAuIjwvcD4nOwogICAgcmV0dXJuOwogIH0KICBjb250YWluZXIuaW5uZXJIVE1MID0gbGlzdC5tYXAoZSA9PgogICAgJzxkaXYgY2xhc3M9InNhdmVkLWl0ZW0iPicgKwogICAgICAnPGRpdj48c3Ryb25nPicgKyBlc2MoZS5jYXRlZ29yeSkgKyAnPC9zdHJvbmc+IDxzcGFuIGNsYXNzPSJtZXRhIj4nICsgZXNjKGUubG9jYXRpb25zLmpvaW4oJywgJykpICsgJyAmbWlkZG90OyBzYXZlZCAnICsgZXNjKGUuc2F2ZWRBdCkgKyAnPC9zcGFuPjwvZGl2PicgKwogICAgICAnPGRpdiBjbGFzcz0ic2F2ZWQtYWN0aW9ucyBidG4tZ3JvdXAiPicgKwogICAgICAgICc8YnV0dG9uIGNsYXNzPSJidG4tY29weSIgb25jbGljaz0ibG9hZFNhdmVkU2VhcmNoKFwnJyArIGUuaWQgKyAnXCcpIj5Mb2FkPC9idXR0b24+JyArCiAgICAgICAgJzxidXR0b24gY2xhc3M9ImJ0bi1jb3B5IiBvbmNsaWNrPSJkZWxldGVTYXZlZFNlYXJjaChcJycgKyBlLmlkICsgJ1wnKSI+RGVsZXRlPC9idXR0b24+JyArCiAgICAgICc8L2Rpdj4nICsKICAgICc8L2Rpdj4nCiAgKS5qb2luKCcnKTsKfQoKLyogPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09CiAgIENVU1RPTUVSIENMQVNTSUZJRVIgKGNhbGxzIC9hcGkvY2xhc3NpZnkg4oCUIGtleSBzZXJ2ZXItc2lkZSkKICAgPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09ICovCmNvbnN0IFBFUlNPTkFMX0RPTUFJTlMgPSBuZXcgU2V0KFsKICAnZ21haWwuY29tJywneWFob28uY29tJywnaG90bWFpbC5jb20nLCdvdXRsb29rLmNvbScsJ2FvbC5jb20nLCdpY2xvdWQuY29tJywKICAnbGl2ZS5jb20nLCdtc24uY29tJywnY29tY2FzdC5uZXQnLCdhdHQubmV0JywndmVyaXpvbi5uZXQnLCdtZS5jb20nLCdwcm90b25tYWlsLmNvbScKXSk7CgpsZXQgcGFyc2VkUm93cyA9IFtdOwpsZXQgY2xhc3NpZmllZFJvd3MgPSBbXTsKCmZ1bmN0aW9uIHNldENsc1Byb2dyZXNzKHBjdCl7CiAgY29uc3QgYmFyID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2Nsc1Byb2dyZXNzQmFyJyk7CiAgY29uc3QgZmlsbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjbHNQcm9ncmVzc0ZpbGwnKTsKICBpZihwY3QgPT09IG51bGwpeyBiYXIuY2xhc3NMaXN0LnJlbW92ZSgnb24nKTsgcmV0dXJuOyB9CiAgYmFyLmNsYXNzTGlzdC5hZGQoJ29uJyk7CiAgZmlsbC5zdHlsZS53aWR0aCA9IHBjdCArICclJzsKfQoKZnVuY3Rpb24gZmluZENvbHVtbihoZWFkZXJzLCBrZXl3b3Jkcyl7CiAgY29uc3QgbG93ZXIgPSBoZWFkZXJzLm1hcChoID0+IFN0cmluZyhoIHx8ICcnKS50b0xvd2VyQ2FzZSgpKTsKICBmb3IoY29uc3Qga3cgb2Yga2V5d29yZHMpewogICAgY29uc3QgaWR4ID0gbG93ZXIuZmluZEluZGV4KGggPT4gaC5pbmNsdWRlcyhrdykpOwogICAgaWYoaWR4ICE9PSAtMSkgcmV0dXJuIGlkeDsKICB9CiAgcmV0dXJuIC0xOwp9CgpmdW5jdGlvbiBleHRyYWN0RG9tYWluQ2xpZW50KHdlYnNpdGVVcmwpewogIGlmKCF3ZWJzaXRlVXJsKSByZXR1cm4gJyc7CiAgbGV0IHUgPSBTdHJpbmcod2Vic2l0ZVVybCkudHJpbSgpOwogIGlmKCF1KSByZXR1cm4gJyc7CiAgaWYoIS9eaHR0cHM/OlwvXC8vaS50ZXN0KHUpKSB1ID0gJ2h0dHBzOi8vJyArIHU7CiAgdHJ5ewogICAgY29uc3QgcGFyc2VkID0gbmV3IFVSTCh1KTsKICAgIHJldHVybiBwYXJzZWQuaG9zdG5hbWUucmVwbGFjZSgvXnd3d1wuL2ksICcnKS50b0xvd2VyQ2FzZSgpOwogIH1jYXRjaChlKXsgcmV0dXJuICcnOyB9Cn0KCmZ1bmN0aW9uIGRvd25sb2FkQ3VzdG9tZXJUZW1wbGF0ZSgpewogIGNvbnN0IHJvd3MgPSBbewogICAgJ0ZpcnN0IE5hbWUnOiAnJywgJ0xhc3QgTmFtZSc6ICcnLCAnV2Vic2l0ZSc6ICcnLCAnRW1haWwnOiAnJywgJ0NvbXBhbnkgTmFtZSc6ICcnLCAnQ2F0ZWdvcnknOiAnJywgJ1N1Yi1DYXRlZ29yeSc6ICcnCiAgfV07CiAgY29uc3Qgd3MgPSBYTFNYLnV0aWxzLmpzb25fdG9fc2hlZXQocm93cyk7CiAgd3NbJyFjb2xzJ10gPSBbe3djaDoxNn0se3djaDoxNn0se3djaDoyOH0se3djaDoyOH0se3djaDoyNn0se3djaDoyMH0se3djaDoyNH1dOwogIGNvbnN0IHdiID0gWExTWC51dGlscy5ib29rX25ldygpOwogIFhMU1gudXRpbHMuYm9va19hcHBlbmRfc2hlZXQod2IsIHdzLCAnQ3VzdG9tZXJzJyk7CiAgWExTWC53cml0ZUZpbGUod2IsICdtb2Rvbml4X2N1c3RvbWVyX3RlbXBsYXRlLnhsc3gnKTsKfQoKZnVuY3Rpb24gcGFyc2VGaWxlKGZpbGUpewogIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7CiAgICBjb25zdCByZWFkZXIgPSBuZXcgRmlsZVJlYWRlcigpOwogICAgcmVhZGVyLm9ubG9hZCA9IChlKSA9PiB7CiAgICAgIHRyeXsKICAgICAgICBjb25zdCBkYXRhID0gbmV3IFVpbnQ4QXJyYXkoZS50YXJnZXQucmVzdWx0KTsKICAgICAgICBjb25zdCB3YiA9IFhMU1gucmVhZChkYXRhLCB7IHR5cGU6ICdhcnJheScgfSk7CiAgICAgICAgY29uc3Qgd3MgPSB3Yi5TaGVldHNbd2IuU2hlZXROYW1lc1swXV07CiAgICAgICAgY29uc3Qgcm93cyA9IFhMU1gudXRpbHMuc2hlZXRfdG9fanNvbih3cywgeyBoZWFkZXI6IDEsIGRlZnZhbDogJycgfSk7CiAgICAgICAgaWYoIXJvd3MubGVuZ3RoKSB0aHJvdyBuZXcgRXJyb3IoJ1NoZWV0IGFwcGVhcnMgZW1wdHkuJyk7CgogICAgICAgIGNvbnN0IGhlYWRlcnMgPSByb3dzWzBdOwogICAgICAgIGNvbnN0IHdlYnNpdGVJZHggPSBmaW5kQ29sdW1uKGhlYWRlcnMsIFsnd2Vic2l0ZSddKTsKICAgICAgICBjb25zdCBlbWFpbElkeCA9IGZpbmRDb2x1bW4oaGVhZGVycywgWydlbWFpbCddKTsKICAgICAgICBjb25zdCBmaXJzdElkeCA9IGZpbmRDb2x1bW4oaGVhZGVycywgWydmaXJzdCddKTsKICAgICAgICBjb25zdCBsYXN0SWR4ID0gZmluZENvbHVtbihoZWFkZXJzLCBbJ2xhc3QnXSk7CiAgICAgICAgY29uc3QgY29tcGFueUlkeCA9IGZpbmRDb2x1bW4oaGVhZGVycywgWydjb21wYW55J10pOwogICAgICAgIGNvbnN0IGNhdGVnb3J5SWR4ID0gZmluZENvbHVtbihoZWFkZXJzLCBbJ2NhdGVnb3J5J10pOwogICAgICAgIGNvbnN0IHN1YkNhdGVnb3J5SWR4ID0gZmluZENvbHVtbihoZWFkZXJzLCBbJ3N1YiddKTsKICAgICAgICBpZih3ZWJzaXRlSWR4ID09PSAtMSkgdGhyb3cgbmV3IEVycm9yKCdDb3VsZCBub3QgZmluZCBhIFdlYnNpdGUgY29sdW1uLiBDaGVjayB0aGUgc2hlZXQgaGFzIGEgaGVhZGVyIGNvbnRhaW5pbmcgIndlYnNpdGUiLicpOwoKICAgICAgICBjb25zdCBvdXQgPSBbXTsKICAgICAgICBmb3IobGV0IGkgPSAxOyBpIDwgcm93cy5sZW5ndGg7IGkrKyl7CiAgICAgICAgICBjb25zdCByb3cgPSByb3dzW2ldOwogICAgICAgICAgY29uc3Qgd2Vic2l0ZSA9IFN0cmluZyhyb3dbd2Vic2l0ZUlkeF0gfHwgJycpLnRyaW0oKTsKICAgICAgICAgIGlmKCF3ZWJzaXRlKSBjb250aW51ZTsKICAgICAgICAgIGNvbnN0IGRvbWFpbiA9IGV4dHJhY3REb21haW5DbGllbnQod2Vic2l0ZSk7CiAgICAgICAgICBjb25zdCBlbWFpbCA9IGVtYWlsSWR4ICE9PSAtMSA/IFN0cmluZyhyb3dbZW1haWxJZHhdIHx8ICcnKS50cmltKCkgOiAnJzsKICAgICAgICAgIGNvbnN0IGZpcnN0ID0gZmlyc3RJZHggIT09IC0xID8gU3RyaW5nKHJvd1tmaXJzdElkeF0gfHwgJycpLnRyaW0oKSA6ICcnOwogICAgICAgICAgY29uc3QgbGFzdCA9IGxhc3RJZHggIT09IC0xID8gU3RyaW5nKHJvd1tsYXN0SWR4XSB8fCAnJykudHJpbSgpIDogJyc7CiAgICAgICAgICBjb25zdCBjb21wYW55ID0gY29tcGFueUlkeCAhPT0gLTEgPyBTdHJpbmcocm93W2NvbXBhbnlJZHhdIHx8ICcnKS50cmltKCkgOiAnJzsKICAgICAgICAgIGNvbnN0IG5hbWUgPSBjb21wYW55IHx8IFtmaXJzdCwgbGFzdF0uZmlsdGVyKEJvb2xlYW4pLmpvaW4oJyAnKTsKICAgICAgICAgIGNvbnN0IHByZXNldENhdGVnb3J5ID0gY2F0ZWdvcnlJZHggIT09IC0xID8gU3RyaW5nKHJvd1tjYXRlZ29yeUlkeF0gfHwgJycpLnRyaW0oKSA6ICcnOwogICAgICAgICAgY29uc3QgcHJlc2V0U3ViQ2F0ZWdvcnkgPSBzdWJDYXRlZ29yeUlkeCAhPT0gLTEgPyBTdHJpbmcocm93W3N1YkNhdGVnb3J5SWR4XSB8fCAnJykudHJpbSgpIDogJyc7CiAgICAgICAgICBvdXQucHVzaCh7IG5hbWUsIGVtYWlsLCB3ZWJzaXRlLCBkb21haW4sIHByZXNldENhdGVnb3J5LCBwcmVzZXRTdWJDYXRlZ29yeSB9KTsKICAgICAgICB9CiAgICAgICAgcmVzb2x2ZShvdXQpOwogICAgICB9Y2F0Y2goZXJyKXsgcmVqZWN0KGVycik7IH0KICAgIH07CiAgICByZWFkZXIub25lcnJvciA9ICgpID0+IHJlamVjdChuZXcgRXJyb3IoJ0NvdWxkIG5vdCByZWFkIHRoZSBmaWxlLicpKTsKICAgIHJlYWRlci5yZWFkQXNBcnJheUJ1ZmZlcihmaWxlKTsKICB9KTsKfQoKYXN5bmMgZnVuY3Rpb24gY2xhc3NpZnlEb21haW4oZG9tYWluLCBzYW1wbGVOYW1lKXsKICB0cnl7CiAgICBjb25zdCByZXNwID0gYXdhaXQgZmV0Y2goJy9hcGkvY2xhc3NpZnknLCB7CiAgICAgIG1ldGhvZDogJ1BPU1QnLAogICAgICBoZWFkZXJzOiB7ICdDb250ZW50LVR5cGUnOiAnYXBwbGljYXRpb24vanNvbicgfSwKICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBkb21haW4sIHNhbXBsZU5hbWUgfSkKICAgIH0pOwogICAgY29uc3QgZGF0YSA9IGF3YWl0IHJlc3AuanNvbigpOwogICAgaWYoIXJlc3Aub2spIHRocm93IG5ldyBFcnJvcihkYXRhLmVycm9yIHx8ICdDbGFzc2lmaWNhdGlvbiBmYWlsZWQnKTsKICAgIHJldHVybiB7IGluZHVzdHJ5OiBkYXRhLmluZHVzdHJ5IHx8ICdVbmtub3duJywgc3ViSW5kdXN0cnk6IGRhdGEuc3ViSW5kdXN0cnkgfHwgJ1Vua25vd24nLCBjYWNoZWQ6ICEhZGF0YS5jYWNoZWQgfTsKICB9Y2F0Y2goZSl7CiAgICBjb25zb2xlLmVycm9yKCdDbGFzc2lmaWNhdGlvbiBmYWlsZWQgZm9yICcgKyBkb21haW4sIGUpOwogICAgcmV0dXJuIHsgaW5kdXN0cnk6ICdVbmtub3duIChsb29rdXAgZmFpbGVkKScsIHN1YkluZHVzdHJ5OiAnVW5rbm93biAobG9va3VwIGZhaWxlZCknLCBjYWNoZWQ6IGZhbHNlIH07CiAgfQp9Cgphc3luYyBmdW5jdGlvbiBydW5DbGFzc2lmeSgpewogIGNvbnN0IGZpbGVJbnB1dCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdmaWxlSW5wdXQnKTsKICBpZighZmlsZUlucHV0LmZpbGVzIHx8ICFmaWxlSW5wdXQuZmlsZXNbMF0pewogICAgc2V0U3RhdHVzKCdjbHNfc3RhdHVzJywnZXJyb3InLCdDaG9vc2UgYSBjdXN0b21lciBzaGVldCBmaXJzdC4nKTsKICAgIHJldHVybjsKICB9CgogIGNvbnN0IGJ0biA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjbHNSdW5CdG4nKTsKICBidG4uZGlzYWJsZWQgPSB0cnVlOwogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjbHNfcmVzdWx0cycpLmNsYXNzTGlzdC5yZW1vdmUoJ29uJyk7CiAgY2xhc3NpZmllZFJvd3MgPSBbXTsKCiAgdHJ5ewogICAgc2V0U3RhdHVzKCdjbHNfc3RhdHVzJywnd29ya2luZycsJ1JlYWRpbmcgdGhlIHNoZWV0LicpOwogICAgcGFyc2VkUm93cyA9IGF3YWl0IHBhcnNlRmlsZShmaWxlSW5wdXQuZmlsZXNbMF0pOwogICAgaWYoIXBhcnNlZFJvd3MubGVuZ3RoKSB0aHJvdyBuZXcgRXJyb3IoJ05vIHJvd3Mgd2l0aCBhIHdlYnNpdGUgd2VyZSBmb3VuZC4nKTsKCiAgICBjb25zdCBkb21haW5NYXAgPSBuZXcgTWFwKCk7CiAgICBmb3IoY29uc3QgciBvZiBwYXJzZWRSb3dzKXsKICAgICAgaWYoIXIuZG9tYWluKSBjb250aW51ZTsKICAgICAgaWYoIWRvbWFpbk1hcC5oYXMoci5kb21haW4pKXsKICAgICAgICBkb21haW5NYXAuc2V0KHIuZG9tYWluLCB7CiAgICAgICAgICBpbmR1c3RyeTogci5wcmVzZXRDYXRlZ29yeSB8fCBudWxsLAogICAgICAgICAgc3ViSW5kdXN0cnk6IHIucHJlc2V0U3ViQ2F0ZWdvcnkgfHwgbnVsbCwKICAgICAgICAgIHNhbXBsZU5hbWU6IHIubmFtZSwKICAgICAgICAgIHByZXNldDogISFyLnByZXNldENhdGVnb3J5CiAgICAgICAgfSk7CiAgICAgIH0KICAgIH0KCiAgICBjb25zdCBkb21haW5zID0gQXJyYXkuZnJvbShkb21haW5NYXAua2V5cygpKTsKICAgIGxldCBkb25lID0gMDsKICAgIGxldCBuZXdMb29rdXBzID0gMDsKICAgIGZvcihjb25zdCBkb21haW4gb2YgZG9tYWlucyl7CiAgICAgIGRvbmUrKzsKICAgICAgY29uc3QgZW50cnkgPSBkb21haW5NYXAuZ2V0KGRvbWFpbik7CiAgICAgIHNldENsc1Byb2dyZXNzKE1hdGgucm91bmQoKGRvbmUgLyBkb21haW5zLmxlbmd0aCkgKiAxMDApKTsKICAgICAgaWYoZW50cnkucHJlc2V0KXsKICAgICAgICBzZXRTdGF0dXMoJ2Nsc19zdGF0dXMnLCd3b3JraW5nJywgJ1VzaW5nIGdpdmVuIGNhdGVnb3J5ICcgKyBkb25lICsgJyBvZiAnICsgZG9tYWlucy5sZW5ndGggKyAnOiAnICsgZG9tYWluKTsKICAgICAgICBjb250aW51ZTsgLy8gYWxyZWFkeSBoYXMgaW5kdXN0cnkvc3ViSW5kdXN0cnkgZnJvbSB0aGUgc2hlZXQg4oCUIG5vIEFQSSBjYWxsIG5lZWRlZAogICAgICB9CiAgICAgIHNldFN0YXR1cygnY2xzX3N0YXR1cycsJ3dvcmtpbmcnLCAnUmVzZWFyY2hpbmcgZG9tYWluICcgKyBkb25lICsgJyBvZiAnICsgZG9tYWlucy5sZW5ndGggKyAnOiAnICsgZG9tYWluKTsKICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgY2xhc3NpZnlEb21haW4oZG9tYWluLCBlbnRyeS5zYW1wbGVOYW1lKTsKICAgICAgaWYoIXJlc3VsdC5jYWNoZWQpIG5ld0xvb2t1cHMrKzsKICAgICAgZW50cnkuaW5kdXN0cnkgPSByZXN1bHQuaW5kdXN0cnk7CiAgICAgIGVudHJ5LnN1YkluZHVzdHJ5ID0gcmVzdWx0LnN1YkluZHVzdHJ5OwogICAgfQoKICAgIGNsYXNzaWZpZWRSb3dzID0gcGFyc2VkUm93cy5tYXAociA9PiB7CiAgICAgIGxldCBpbmR1c3RyeSwgc3ViSW5kdXN0cnk7CiAgICAgIGlmKCFyLmRvbWFpbil7IGluZHVzdHJ5ID0gJ1Vua25vd24gKG5vIHdlYnNpdGUpJzsgc3ViSW5kdXN0cnkgPSAnVW5rbm93biAobm8gd2Vic2l0ZSknOyB9CiAgICAgIGVsc2UgewogICAgICAgIGNvbnN0IGQgPSBkb21haW5NYXAuZ2V0KHIuZG9tYWluKTsKICAgICAgICBpbmR1c3RyeSA9IChkICYmIGQuaW5kdXN0cnkpIHx8ICdVbmtub3duJzsKICAgICAgICBzdWJJbmR1c3RyeSA9IChkICYmIGQuc3ViSW5kdXN0cnkpIHx8ICdVbmtub3duJzsKICAgICAgfQogICAgICByZXR1cm4geyBuYW1lOiByLm5hbWUsIGVtYWlsOiByLmVtYWlsLCB3ZWJzaXRlOiByLndlYnNpdGUsIGRvbWFpbjogci5kb21haW4sIGluZHVzdHJ5LCBzdWJJbmR1c3RyeSB9OwogICAgfSk7CgogICAgcmVuZGVyQ2xhc3NpZmllclJlc3VsdHMoKTsKICAgIHNldENsc1Byb2dyZXNzKG51bGwpOwogICAgc2V0U3RhdHVzKCdjbHNfc3RhdHVzJywnZG9uZScsIGNsYXNzaWZpZWRSb3dzLmxlbmd0aCArICcgY3VzdG9tZXJzIHByb2Nlc3NlZCBhY3Jvc3MgJyArIGRvbWFpbnMubGVuZ3RoICsgJyB1bmlxdWUgYnVzaW5lc3MgZG9tYWlucyAoJyArIG5ld0xvb2t1cHMgKyAnIG5ld2x5IHJlc2VhcmNoZWQsICcgKyAoZG9tYWlucy5sZW5ndGggLSBuZXdMb29rdXBzKSArICcgcHVsbGVkIGZyb20gY2FjaGUgb3IgZ2l2ZW4gZGlyZWN0bHkpLicpOwogICAgbG9hZENhdGVnb3J5T3B0aW9ucygpOwogIH1jYXRjaChlKXsKICAgIGNvbnNvbGUuZXJyb3IoZSk7CiAgICBzZXRDbHNQcm9ncmVzcyhudWxsKTsKICAgIHNldFN0YXR1cygnY2xzX3N0YXR1cycsJ2Vycm9yJywnQ2xhc3NpZmljYXRpb24gZmFpbGVkOiAnICsgZS5tZXNzYWdlKTsKICB9ZmluYWxseXsKICAgIGJ0bi5kaXNhYmxlZCA9IGZhbHNlOwogIH0KfQoKZnVuY3Rpb24gcmVuZGVyQ2xhc3NpZmllclJlc3VsdHMoKXsKICBjb25zdCBib2R5ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2Nsc1Jlc3VsdHNCb2R5Jyk7CiAgYm9keS5pbm5lckhUTUwgPSBjbGFzc2lmaWVkUm93cy5tYXAociA9PiB7CiAgICBjb25zdCBpc1Vua25vd24gPSByLmluZHVzdHJ5LnRvTG93ZXJDYXNlKCkuc3RhcnRzV2l0aCgndW5rbm93bicpIHx8IHIuaW5kdXN0cnkudG9Mb3dlckNhc2UoKS5zdGFydHNXaXRoKCdza2lwcGVkJyk7CiAgICByZXR1cm4gJzx0cj4nICsKICAgICAgJzx0ZD4nICsgZXNjKHIubmFtZSkgKyAnPC90ZD4nICsKICAgICAgJzx0ZD4nICsgZXNjKHIud2Vic2l0ZSkgKyAnPC90ZD4nICsKICAgICAgJzx0ZD4nICsgZXNjKHIuZW1haWwpICsgJzwvdGQ+JyArCiAgICAgICc8dGQ+JyArIGVzYyhyLmRvbWFpbikgKyAnPC90ZD4nICsKICAgICAgJzx0ZD48c3BhbiBjbGFzcz0iY2F0LXRhZycgKyAoaXNVbmtub3duID8gJyB1bmtub3duJyA6ICcnKSArICciPicgKyBlc2Moci5pbmR1c3RyeSkgKyAnPC9zcGFuPjwvdGQ+JyArCiAgICAgICc8dGQ+PHNwYW4gY2xhc3M9ImNhdC10YWcnICsgKGlzVW5rbm93biA/ICcgdW5rbm93bicgOiAnJykgKyAnIj4nICsgZXNjKHIuc3ViSW5kdXN0cnkpICsgJzwvc3Bhbj48L3RkPicgKwogICAgJzwvdHI+JzsKICB9KS5qb2luKCcnKTsKICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnY2xzX3Jlc01ldGEnKS50ZXh0Q29udGVudCA9IGNsYXNzaWZpZWRSb3dzLmxlbmd0aCArICcgY3VzdG9tZXJzJzsKICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnY2xzX3Jlc3VsdHMnKS5jbGFzc0xpc3QuYWRkKCdvbicpOwogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjbHNfcmVzdWx0cycpLnNjcm9sbEludG9WaWV3KHsgYmVoYXZpb3I6J3Ntb290aCcsIGJsb2NrOidzdGFydCcgfSk7Cn0KCmZ1bmN0aW9uIGRvd25sb2FkQ2xhc3NpZmllclhsc3goKXsKICBpZighY2xhc3NpZmllZFJvd3MubGVuZ3RoKXsgc2V0U3RhdHVzKCdjbHNfc3RhdHVzJywnZXJyb3InLCdOb3RoaW5nIHRvIGRvd25sb2FkIHlldCwgcnVuIGEgY2xhc3NpZmljYXRpb24gZmlyc3QuJyk7IHJldHVybjsgfQogIGNvbnN0IHJvd3MgPSBjbGFzc2lmaWVkUm93cy5tYXAociA9PiAoewogICAgJ05hbWUnOiByLm5hbWUsICdXZWJzaXRlJzogci53ZWJzaXRlLCAnRW1haWwnOiByLmVtYWlsLCAnRG9tYWluJzogci5kb21haW4sICdJbmR1c3RyeSc6IHIuaW5kdXN0cnksICdTdWItSW5kdXN0cnknOiByLnN1YkluZHVzdHJ5CiAgfSkpOwogIGNvbnN0IHdzID0gWExTWC51dGlscy5qc29uX3RvX3NoZWV0KHJvd3MpOwogIHdzWychY29scyddID0gW3t3Y2g6Mjh9LHt3Y2g6Mjh9LHt3Y2g6MzJ9LHt3Y2g6MjR9LHt3Y2g6MjJ9LHt3Y2g6MzR9XTsKICBjb25zdCB3YiA9IFhMU1gudXRpbHMuYm9va19uZXcoKTsKICBYTFNYLnV0aWxzLmJvb2tfYXBwZW5kX3NoZWV0KHdiLCB3cywgJ0NsYXNzaWZpZWQnKTsKICBYTFNYLndyaXRlRmlsZSh3YiwgJ21vZG9uaXhfY2xhc3NpZmllZF9jdXN0b21lcnMueGxzeCcpOwp9CgovKiBpbml0ICovCnJlbmRlclNhdmVkU2VhcmNoZXMoKTsKbG9hZENhdGVnb3J5T3B0aW9ucygpOwpsb2FkU2F2ZWRDdXN0b21lcnMoKTsKPC9zY3JpcHQ+CjwvYm9keT4KPC9odG1sPgo=";

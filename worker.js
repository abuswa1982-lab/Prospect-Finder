export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/geocode' && request.method === 'POST') {
      return handleGeocode(request, env);
    }
    if (url.pathname === '/api/places' && request.method === 'POST') {
      return handlePlaces(request, env);
    }
    // NEW: look up a seed customer and read its Google category (Find Similar tab)
    if (url.pathname === '/api/seed' && request.method === 'POST') {
      return handleSeed(request, env);
    }
    // NEW: classify a company domain into Industry / Sub-Industry (Classifier tab)
    if (url.pathname === '/api/classify' && request.method === 'POST') {
      return handleClassify(request, env);
    }
    // Anything else falls through to the static files in /public
    return env.ASSETS.fetch(request);
  }
};

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
    const places = (data.places || []).map(p => ({
      id: p.id,
      name: (p.displayName && p.displayName.text) || '',
      address: p.formattedAddress || '',
      phone: p.nationalPhoneNumber || '',
      website: p.websiteUri || ''
    }));
    return jsonResponse({ places }, 200);
  } catch (e) {
    return jsonResponse({ error: 'Places search failed: ' + e.message }, 500);
  }
}

// Given a seed customer (name, optional location, optional website), find that
// business on Google and return its category so the Find Similar tab can
// pre-fill the Customer Category box.
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

// Classify a single company domain into Industry / Sub-Industry using Claude
// with web search. Key lives server-side as ANTHROPIC_API_KEY (Cloudflare
// secret), so nothing is pasted into the page.
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
  const key = env.ANTHROPIC_API_KEY;
  if (!key) {
    return jsonResponse({ error: 'Server is missing ANTHROPIC_API_KEY. Add it as a Worker secret to enable the Classifier tab.' }, 500);
  }

  const prompt = 'A B2B distributor needs to know what industry a customer operates in, at two levels of detail.\n\n' +
    'Domain: ' + domain + (sampleName ? '\nCompany name on file: ' + sampleName : '') + '\n\n' +
    'Search the web for information about this company or domain. Then respond with exactly two lines, nothing else:\n' +
    'INDUSTRY: <broad category, 1 to 3 words, like "Manufacturing" or "Contractor" or "Distribution">\n' +
    'SUB-INDUSTRY: <specific flavor within that category, 2 to 5 words, like "precision manufacturing" or "commercial contractor" or "industrial safety distribution">\n\n' +
    'No NAICS codes, no explanation, no extra lines. If you cannot find enough information to determine this with reasonable confidence, respond with exactly:\n' +
    'INDUSTRY: Unknown\n' +
    'SUB-INDUSTRY: Unknown';

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }],
        tools: [{ type: 'web_search_20250305', name: 'web_search' }]
      })
    });
    if (!r.ok) {
      const errText = await r.text();
      return jsonResponse({ error: 'Anthropic API error: ' + errText.slice(0, 300) }, r.status);
    }
    const data = await r.json();
    const text = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('')
      .trim();

    const industryMatch = text.match(/INDUSTRY:\s*(.+)/i);
    const subMatch = text.match(/SUB-INDUSTRY:\s*(.+)/i);

    return jsonResponse({
      industry: industryMatch ? industryMatch[1].trim() : 'Unknown',
      subIndustry: subMatch ? subMatch[1].trim() : 'Unknown'
    }, 200);
  } catch (e) {
    return jsonResponse({ error: 'Classification failed: ' + e.message }, 500);
  }
}

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

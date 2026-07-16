// Cloudflare Pages Function — server-side proxy for Places API (New) Text Search.
// Lives at /api/places automatically because of this file's path.
// Runs server-to-server, so the browser CORS restriction that blocks this API
// from client-side code never applies here, and the key never reaches the browser.
export async function onRequestPost(context) {
  const { request, env } = context;

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

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

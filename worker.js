export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/geocode' && request.method === 'POST') {
      return handleGeocode(request, env);
    }
    if (url.pathname === '/api/places' && request.method === 'POST') {
      return handlePlaces(request, env);
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

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

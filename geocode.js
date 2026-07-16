// Cloudflare Pages Function — server-side proxy for Google Geocoding.
// Lives at /api/geocode automatically because of this file's path.
// The API key never reaches the browser.
export async function onRequestPost(context) {
  const { request, env } = context;

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

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

# Modonix Prospect Finder (flat structure, Cloudflare Workers)

Everything sits at the repo root, no folders at all — this avoids GitHub's
"choose your files" upload losing folder structure.

## Files
- `index.html` — the app itself (multi-location search, lead scoring, saved searches, Excel/Sheets export, how-to-use panel)
- `worker.js` — serves index.html AND handles the two secure API calls (`/api/geocode`, `/api/places`)
- `wrangler.jsonc` — tells Cloudflare how to run this
- `.assetsignore` — tells Cloudflare not to serve worker.js/wrangler.jsonc/README.md as if they were website files, only index.html

## Clean-up step first (only needed once)
Your repo currently has leftover `geocode.js` and `places.js` files from an
earlier attempt. They're no longer used — `worker.js` replaces both. Delete
them: open each file on GitHub, click the trash-can icon, commit the deletion.

## Deploy steps

1. Upload these 4 files (`index.html`, `worker.js`, `wrangler.jsonc`,
   `.assetsignore`) to the repo root, overwriting anything with the same name.
2. Go to the Cloudflare "Create application" screen, connected to this repo,
   Path still `/`, Build command still empty. Click Deploy.
3. First deploy will likely fail — expected, no Google key yet.
4. Worker → Settings → Variables and Secrets → add `GOOGLE_MAPS_API_KEY`
   (your Google Maps API key) as a **Secret**.
5. Redeploy (push any small change, or use "Retry deployment") so the new
   variable actually takes effect.

## Google Cloud key settings
- Remove the HTTP referrer restriction (doesn't apply to server-to-server calls anymore)
- Keep only Places API (New) + Geocoding API enabled on this key
- Set a budget alert and daily quota cap — that's the real usage control now

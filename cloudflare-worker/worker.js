/*
 * Worker di Cloudflare "ponte" verso Backblaze B2.
 *
 * Il sito chiede alla funzione B2 di Supabase un link firmato (temporaneo) e lo apre passando
 * da qui invece che direttamente da Backblaze: i dati che escono da Backblaze verso Cloudflare
 * non contano nel limite giornaliero di download (accordo Bandwidth Alliance).
 *
 * Non contiene chiavi: inoltra solo link già firmati dalla funzione B2, e solo verso il nostro
 * archivio. Un link scaduto o modificato viene rifiutato da Backblaze come prima.
 *
 * Da incollare in Cloudflare → Workers & Pages → (il Worker) → Edit code → Deploy.
 */
const B2_HOST = 's3.eu-central-003.backblazeb2.com';
const BUCKET = 'appunti-stc-bicocca-2026';
const SITE = 'https://appunti-stc.github.io';

const PASS_REQUEST = ['range', 'if-range', 'if-none-match', 'if-modified-since'];
const PASS_RESPONSE = ['content-type', 'content-length', 'content-range', 'content-disposition', 'accept-ranges', 'etag', 'last-modified'];

function cors(headers) {
  headers.set('Access-Control-Allow-Origin', SITE);
  headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Range');
  headers.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Content-Disposition, ETag');
  headers.set('Vary', 'Origin');
  return headers;
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(new Headers()) });
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Metodo non ammesso', { status: 405 });
    if (url.pathname === '/' || url.pathname === '/ping') return new Response('ok', { headers: cors(new Headers()) });
    // solo link firmati verso il nostro archivio
    if (!url.pathname.startsWith('/' + BUCKET + '/') || !url.searchParams.has('X-Amz-Signature')) {
      return new Response('Link non valido', { status: 403 });
    }
    const headers = new Headers();
    for (const h of PASS_REQUEST) { const v = request.headers.get(h); if (v) headers.set(h, v); }
    const upstream = await fetch('https://' + B2_HOST + url.pathname + url.search, { method: request.method, headers });
    const out = new Headers();
    for (const h of PASS_RESPONSE) { const v = upstream.headers.get(h); if (v) out.set(h, v); }
    // il browser tiene il file in memoria finché il link è valido: riaprirlo non lo riscarica
    if (upstream.ok) out.set('Cache-Control', 'private, max-age=3000');
    return new Response(upstream.body, { status: upstream.status, headers: cors(out) });
  },
};

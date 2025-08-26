// server.js — TODOBIWENGER Backend (Node/Express)
// -------------------------------------------------
// Endpoints:
//   GET /health
//   GET /api/laliga-transfers?comp=ea-sports|hypermotion
//
// Requisitos: Node 18+
// (La instalación de paquetes la haremos en el PASO 3)
//
// -------------------------------------------------

const express = require('express');
const cors = require('cors');
const { chromium } = require('playwright');

const PORT = process.env.PORT || 3001;
const HEADLESS = process.env.HEADLESS !== 'false';
const USER_AGENT =
  process.env.USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36';

// URLs oficiales de LaLiga (fichajes)
const LALIGA_URL = {
  'ea-sports': 'https://www.laliga.com/fichajes/laliga-easports',
  'hypermotion': 'https://www.laliga.com/fichajes/laliga-hypermotion',
};

// Caché sencilla en memoria (TTL)
const cache = new Map(); // key -> { ts, ttl, data }
const putCache = (key, data, ttlMs = 10 * 60 * 1000) =>
  cache.set(key, { ts: Date.now(), ttl: ttlMs, data });
const getCache = (key) => {
  const v = cache.get(key);
  if (!v) return null;
  if (Date.now() - v.ts > v.ttl) {
    cache.delete(key);
    return null;
  }
  return v.data;
};

const app = express();
app.use(cors());

app.get('/health', (req, res) => res.json({ ok: true }));

// Normaliza un registro scrapeado a nuestro formato
function normalizeItem(x = {}) {
  return {
    player: x.player || x.name || '',
    from: x.from || x.origin || '',
    to: x.to || x.destination || '',
    date: x.date || x.ts || '',
    status: x.status || x.type || '',
    position: x.position || '',
    fee: x.fee || '',
    contract: x.contract || '',
    url: x.url || '',
    source: 'LaLiga.com',
  };
}

// Scraper con varias estrategias de extracción
async function scrapeTransfers(comp = 'ea-sports') {
  const url = LALIGA_URL[comp];
  if (!url) throw new Error('Parámetro comp inválido');

  // cache
  const cacheKey = `laliga:${comp}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  const browser = await chromium.launch({
    headless: HEADLESS,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage({ userAgent: USER_AGENT });

  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 });
    // Dar tiempo a que cargue el front de LaLiga
    await page.waitForTimeout(2000);

    let items = [];

    // 1) Intento: filas de tabla (si existiera)
    try {
      items = await page.$$eval('table tbody tr', (rows) =>
        rows.map((tr) => {
          const td = Array.from(tr.querySelectorAll('td')).map((x) =>
            x.innerText.trim()
          );
          const [player, to, from, type, date] = td;
          const a = tr.querySelector('a[href^="http"]');
          return { player, to, from, status: type, date, url: a ? a.href : '' };
        })
      );
    } catch {
      items = [];
    }

    // 2) Intento: tarjetas/celdas con texto (fallback genérico)
    if (!items || items.length === 0) {
      try {
        items = await page.$$eval('section,div', (nodes) => {
          const out = [];
          nodes.forEach((n) => {
            const hasLabels = /Jugador|Destino|Procedencia|Tipo/i.test(
              n.innerText
            );
            if (!hasLabels) return;
            const rows = Array.from(n.querySelectorAll('div,li,article')).filter(
              (el) => /→|Destino|Procedencia|Jugador/i.test(el.innerText)
            );
            rows.forEach((r) => {
              const txt = r.innerText.trim().replace(/\s+/g, ' ');
              const m = txt.match(
                /^(.*?)(?:\s)(?:Destino|→)\s+(.*?)(?:\s)(?:Procedencia|desde)\s+(.*?)(?:\s)(?:Tipo|Modalidad)\s+(.*)$/i
              );
              if (m) {
                out.push({
                  player: m[1],
                  to: m[2],
                  from: m[3],
                  status: m[4],
                  date: '',
                });
              } else {
                const arrow = txt.indexOf('→');
                if (arrow > 0)
                  out.push({
                    player: txt.slice(0, arrow).trim(),
                    to: txt.slice(arrow + 1).trim(),
                  });
              }
            });
          });
          return out;
        });
      } catch {
        items = [];
      }
    }

    // 3) Intento: JSON embebido (si existiera)
    if (!items || items.length === 0) {
      try {
        const jsonCandidates = await page.$$eval(
          'script[type="application/json"],script[type="application/ld+json"]',
          (ss) => ss.map((s) => s.textContent)
        );
        for (const raw of jsonCandidates) {
          try {
            const obj = JSON.parse(raw);
            const arr = Array.isArray(obj)
              ? obj
              : obj.items || obj.data || obj.results || [];
            if (arr && arr.length) {
              items = arr.map((x) => ({
                player: x.player || x.name || x.title,
                to: x.to || x.destination || (x.club && x.club.name) || '',
                from:
                  x.from || x.origin || (x.previousClub && x.previousClub.name) || '',
                status: x.status || x.type || x.transferType || '',
                date: x.date || x.updatedAt || x.createdAt || '',
                fee: x.fee || x.amount || x.transferFee || '',
                position: x.position || (x.player && x.player.position) || '',
                url: x.url || x.link || '',
              }));
              break;
            }
          } catch {
            // ignorar
          }
        }
      } catch {
        // ignorar
      }
    }

    const cleaned = (items || [])
      .map(normalizeItem)
      .filter((x) => x.player || x.to || x.from);

    const final =
      cleaned.length > 0
        ? cleaned
        : [
            {
              player: '—',
              from: '',
              to: '',
              date: '',
              status: '',
              fee: '',
              contract: '',
              url: '',
              source: 'LaLiga.com',
              __fallback: true,
            },
          ];

    putCache(cacheKey, final, 10 * 60 * 1000); // 10 min
    return final;
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

app.get('/api/laliga-transfers', async (req, res) => {
  try {
    const comp = (req.query.comp || 'ea-sports').toString();
    const data = await scrapeTransfers(comp);
    res.json(data);
  } catch (e) {
    console.error('laliga-transfers error:', e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.listen(PORT, () => {
  console.log(`TODOBIWENGER backend activo en http://localhost:${PORT}`);
});

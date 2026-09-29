import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';

const sql = Bun.sql;

await sql`CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  balance NUMERIC NOT NULL DEFAULT 5000,
  created_at TIMESTAMPTZ DEFAULT now()
)`;

await sql`CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT now()
)`;

await sql`CREATE TABLE IF NOT EXISTS bets (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  desc_text TEXT NOT NULL,
  match_text TEXT NOT NULL,
  stake NUMERIC NOT NULL,
  payout NUMERIC NOT NULL,
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT now()
)`;

await sql`CREATE TABLE IF NOT EXISTS app_state (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL
)`;

const adminTokens = new Set();

async function getUserFromCookie(c) {
  const token = getCookie(c, 'session');
  if (!token) return null;
  const rows = await sql`
    SELECT u.id, u.email, u.balance
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ${token}
  `;
  return rows[0] || null;
}

function isAdminReq(c) {
  const token = getCookie(c, 'admin_session');
  return !!(token && adminTokens.has(token));
}

// index.html and admin.html sit next to this file in the same repo/deploy.
let cachedPageHtml = null;
async function getPageHtml() {
  if (cachedPageHtml) return cachedPageHtml;
  const file = Bun.file(new URL('./index.html', import.meta.url));
  if (await file.exists()) {
    cachedPageHtml = await file.text();
    return cachedPageHtml;
  }
  return null;
}

let cachedAdminHtml = null;
async function getAdminHtml() {
  if (cachedAdminHtml) return cachedAdminHtml;
  const file = Bun.file(new URL('./admin.html', import.meta.url));
  if (await file.exists()) {
    cachedAdminHtml = await file.text();
    return cachedAdminHtml;
  }
  return null;
}

// ---------- Marcador automático de MLB ----------
// Traduce los nombres en español que usa el panel (admin.html) al nombre
// oficial en inglés que devuelve la API de MLB, para poder emparejar los
// partidos guardados con los datos reales.
const MLB_TEAM_ES_TO_EN = {
  'Diamondbacks de Arizona': 'Arizona Diamondbacks',
  'Bravos de Atlanta': 'Atlanta Braves',
  'Orioles de Baltimore': 'Baltimore Orioles',
  'Medias Rojas de Boston': 'Boston Red Sox',
  'Cachorros de Chicago': 'Chicago Cubs',
  'Medias Blancas de Chicago': 'Chicago White Sox',
  'Rojos de Cincinnati': 'Cincinnati Reds',
  'Guardianes de Cleveland': 'Cleveland Guardians',
  'Rocosos de Colorado': 'Colorado Rockies',
  'Tigres de Detroit': 'Detroit Tigers',
  'Astros de Houston': 'Houston Astros',
  'Reales de Kansas City': 'Kansas City Royals',
  'Angelinos de Los Ángeles': 'Los Angeles Angels',
  'Dodgers de Los Ángeles': 'Los Angeles Dodgers',
  'Marlins de Miami': 'Miami Marlins',
  'Cerveceros de Milwaukee': 'Milwaukee Brewers',
  'Mellizos de Minnesota': 'Minnesota Twins',
  'Mets de Nueva York': 'New York Mets',
  'Yanquis de Nueva York': 'New York Yankees',
  'Atléticos de Sacramento': 'Athletics',
  'Filis de Filadelfia': 'Philadelphia Phillies',
  'Piratas de Pittsburgh': 'Pittsburgh Pirates',
  'Padres de San Diego': 'San Diego Padres',
  'Gigantes de San Francisco': 'San Francisco Giants',
  'Marineros de Seattle': 'Seattle Mariners',
  'Cardenales de San Luis': 'St. Louis Cardinals',
  'Rays de Tampa Bay': 'Tampa Bay Rays',
  'Rangers de Texas': 'Texas Rangers',
  'Azulejos de Toronto': 'Toronto Blue Jays',
  'Nacionales de Washington': 'Washington Nationals'
};

function todayISO() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return d.getFullYear() + '-' + mm + '-' + dd;
}

// Consulta la API pública y gratuita de estadísticas de MLB (statsapi.mlb.com)
// y arma una lista de partidos de hoy con su marcador y estado actuales.
async function fetchMlbLiveGames() {
  try {
    const url = 'https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=' + todayISO() + '&hydrate=linescore,team';
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    const games = [];
    for (const date of (data.dates || [])) {
      for (const g of (date.games || [])) {
        games.push({
          home: g.teams && g.teams.home && g.teams.home.team ? g.teams.home.team.name : '',
          away: g.teams && g.teams.away && g.teams.away.team ? g.teams.away.team.name : '',
          abstractState: g.status ? g.status.abstractGameState : '',
          detailedState: g.status ? g.status.detailedState : '',
          homeRuns: g.linescore && g.linescore.teams && g.linescore.teams.home ? g.linescore.teams.home.runs : undefined,
          awayRuns: g.linescore && g.linescore.teams && g.linescore.teams.away ? g.linescore.teams.away.runs : undefined,
          inningState: g.linescore ? g.linescore.inningState : '',
          currentInning: g.linescore ? g.linescore.currentInning : undefined
        });
      }
    }
    return games;
  } catch (e) {
    return [];
  }
}

function periodLabel(g) {
  if (!g.currentInning) return '';
  var state = g.inningState || '';
  var stateEs = state === 'Top' ? 'Alta' : state === 'Bottom' ? 'Baja' : state === 'Middle' ? 'Entre' : state === 'End' ? 'Fin' : state;
  return (stateEs ? stateEs + ' ' : '') + g.currentInning + 'ª entrada';
}

// Revisa los partidos guardados marcados "En vivo" (béisbol/LIDOM) y, si
// encuentra el juego real correspondiente en la API de MLB, actualiza su
// marcador automáticamente. Los partidos de LIDOM u otros deportes, o
// cualquiera que no aparezca en la API de MLB, se dejan intactos para
// que el admin los siga actualizando a mano.
async function updateLiveMlbScores() {
  try {
    const rows = await sql`SELECT value FROM app_state WHERE key = 'matches'`;
    var matches = rows[0] ? rows[0].value : [];
    if (typeof matches === 'string') {
      try { matches = JSON.parse(matches); } catch (e) { matches = []; }
    }
    if (!Array.isArray(matches) || matches.length === 0) return;

    const liveMlb = matches.filter(function (m) { return m.sport === 'beisbol' && m.live; });
    if (liveMlb.length === 0) return;

    const games = await fetchMlbLiveGames();
    if (games.length === 0) return;

    var changed = false;
    matches.forEach(function (m) {
      if (m.sport !== 'beisbol' || !m.live) return;
      var homeEn = MLB_TEAM_ES_TO_EN[m.home];
      var awayEn = MLB_TEAM_ES_TO_EN[m.away];
      if (!homeEn || !awayEn) return;
      var g = games.find(function (x) { return x.home === homeEn && x.away === awayEn; });
      if (!g) return;
      if (g.homeRuns === undefined || g.awayRuns === undefined) return;
      m.score = { home: g.homeRuns, away: g.awayRuns, period: periodLabel(g) };
      // Si el juego real ya terminó, lo bajamos de "en vivo" automáticamente.
      if (g.abstractState === 'Final') m.live = false;
      changed = true;
    });

    if (changed) {
      await sql`
        INSERT INTO app_state (key, value) VALUES ('matches', ${JSON.stringify(matches)}::jsonb)
        ON CONFLICT (key) DO UPDATE SET value = ${JSON.stringify(matches)}::jsonb
      `;
    }
  } catch (e) {
    // No tumbamos el servidor por un fallo de la API externa.
  }
}

// Corre cada 60 segundos mientras el servidor esté vivo.
setInterval(updateLiveMlbScores, 60000);
updateLiveMlbScores();

const app = new Hono();

app.post('/api/register', async (c) => {
  let body;
  try { body = await c.req.json(); } catch (e) { return c.json({ error: 'bad_request' }, 400); }
  const email = (body.email || '').trim().toLowerCase();
  const password = body.password || '';
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 6) {
    return c.json({ error: 'invalid' }, 400);
  }
  const hash = await Bun.password.hash(password);
  let rows;
  try {
    rows = await sql`
      INSERT INTO users (email, password_hash, balance)
      VALUES (${email}, ${hash}, 5000)
      RETURNING id, email, balance
    `;
  } catch (e) {
    return c.json({ error: 'email_taken' }, 400);
  }
  const user = rows[0];
  const token = crypto.randomUUID();
  await sql`INSERT INTO sessions (token, user_id) VALUES (${token}, ${user.id})`;
  setCookie(c, 'session', token, { httpOnly: true, path: '/', maxAge: 60 * 60 * 24 * 30, sameSite: 'Lax' });
  return c.json({ email: user.email, balance: Number(user.balance) });
});

app.post('/api/login', async (c) => {
  let body;
  try { body = await c.req.json(); } catch (e) { return c.json({ error: 'bad_request' }, 400); }
  const email = (body.email || '').trim().toLowerCase();
  const password = body.password || '';
  const rows = await sql`SELECT id, email, password_hash, balance FROM users WHERE email = ${email}`;
  if (rows.length === 0) return c.json({ error: 'invalid' }, 401);
  const user = rows[0];
  const ok = await Bun.password.verify(password, user.password_hash);
  if (!ok) return c.json({ error: 'invalid' }, 401);
  const token = crypto.randomUUID();
  await sql`INSERT INTO sessions (token, user_id) VALUES (${token}, ${user.id})`;
  setCookie(c, 'session', token, { httpOnly: true, path: '/', maxAge: 60 * 60 * 24 * 30, sameSite: 'Lax' });
  return c.json({ email: user.email, balance: Number(user.balance) });
});

app.post('/api/logout', async (c) => {
  const token = getCookie(c, 'session');
  if (token) await sql`DELETE FROM sessions WHERE token = ${token}`;
  deleteCookie(c, 'session', { path: '/' });
  return c.json({ ok: true });
});

app.get('/api/me', async (c) => {
  const user = await getUserFromCookie(c);
  if (!user) return c.json(null);
  return c.json({ email: user.email, balance: Number(user.balance) });
});

app.get('/api/matches', async (c) => {
  const rows = await sql`SELECT value FROM app_state WHERE key = 'matches'`;
  var val = rows[0] ? rows[0].value : [];
  if (typeof val === 'string') {
    try { val = JSON.parse(val); } catch (e) { val = []; }
  }
  return c.json(val);
});

app.post('/api/admin/login', async (c) => {
  let body;
  try { body = await c.req.json(); } catch (e) { return c.json({ error: 'bad_request' }, 400); }
  if (body.password !== Bun.env.ADMIN_PASS) return c.json({ error: 'invalid' }, 401);
  const token = crypto.randomUUID();
  adminTokens.add(token);
  setCookie(c, 'admin_session', token, { httpOnly: true, path: '/', maxAge: 60 * 60 * 8, sameSite: 'Lax' });
  return c.json({ ok: true });
});

app.get('/api/admin/check', async (c) => {
  return c.json({ ok: isAdminReq(c) });
});

app.post('/api/admin/matches', async (c) => {
  if (!isAdminReq(c)) return c.json({ error: 'forbidden' }, 403);
  let matches;
  try { matches = await c.req.json(); } catch (e) { return c.json({ error: 'bad_request' }, 400); }
  if (!Array.isArray(matches)) return c.json({ error: 'bad_request' }, 400);
  await sql`
    INSERT INTO app_state (key, value) VALUES ('matches', ${JSON.stringify(matches)}::jsonb)
    ON CONFLICT (key) DO UPDATE SET value = ${JSON.stringify(matches)}::jsonb
  `;
  return c.json({ ok: true });
});

app.post('/api/bets', async (c) => {
  const user = await getUserFromCookie(c);
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  let body;
  try { body = await c.req.json(); } catch (e) { return c.json({ error: 'bad_request' }, 400); }
  const bets = body.bets;
  if (!Array.isArray(bets) || bets.length === 0) return c.json({ error: 'empty' }, 400);
  let stakeSum = 0;
  for (const b of bets) {
    const st = Number(b.stake);
    if (!st || st <= 0) return c.json({ error: 'bad_request' }, 400);
    stakeSum += st;
  }
  const balRows = await sql`SELECT balance FROM users WHERE id = ${user.id}`;
  const currentBalance = Number(balRows[0].balance);
  if (stakeSum > currentBalance) return c.json({ error: 'insufficient' }, 400);
  const newBalance = currentBalance - stakeSum;
  await sql`UPDATE users SET balance = ${newBalance} WHERE id = ${user.id}`;
  for (const b of bets) {
    await sql`
      INSERT INTO bets (user_id, desc_text, match_text, stake, payout)
      VALUES (${user.id}, ${String(b.desc || '')}, ${String(b.match || '')}, ${Number(b.stake)}, ${Number(b.payout) || 0})
    `;
  }
  return c.json({ balance: newBalance });
});

app.get('/api/bets', async (c) => {
  const user = await getUserFromCookie(c);
  if (!user) return c.json([]);
  const rows = await sql`
    SELECT desc_text, match_text, stake, payout, status, created_at
    FROM bets WHERE user_id = ${user.id}
    ORDER BY created_at DESC LIMIT 20
  `;
  return c.json(rows.map(function (r) {
    return {
      desc: r.desc_text, match: r.match_text,
      stake: Number(r.stake), payout: Number(r.payout),
      status: r.status,
      date: new Date(r.created_at).toLocaleDateString('es-DO')
    };
  }));
});

app.post('/api/deposit', async (c) => {
  const user = await getUserFromCookie(c);
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  const newBalance = Number(user.balance) + 1000;
  await sql`UPDATE users SET balance = ${newBalance} WHERE id = ${user.id}`;
  return c.json({ balance: newBalance });
});

app.post('/api/reset', async (c) => {
  const user = await getUserFromCookie(c);
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  await sql`UPDATE users SET balance = 5000 WHERE id = ${user.id}`;
  await sql`DELETE FROM bets WHERE user_id = ${user.id}`;
  return c.json({ balance: 5000 });
});

app.get('/admin', async (c) => {
  const html = await getAdminHtml();
  if (!html) {
    return c.html(
      '<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px;">' +
      '<h1>Falta admin.html</h1>' +
      '<p>No encontré admin.html junto a server.tsx. Confirma que esté en la raíz del repositorio.</p>' +
      '</body></html>',
      500
    );
  }
  return c.html(html);
});

app.get('/', async (c) => {
  const html = await getPageHtml();
  if (!html) {
    return c.html(
      '<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px;">' +
      '<h1>Falta index.html</h1>' +
      '<p>No encontré index.html junto a server.tsx. Confirma que ambos archivos estén en la raíz del repositorio.</p>' +
      '</body></html>',
      500
    );
  }
  return c.html(html);
});

export default {
  port: Number(Bun.env.PORT) || 3000,
  fetch: app.fetch
};

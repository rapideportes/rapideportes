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

// ---------- Marcador automático (MLB, NBA, NFL, NHL) ----------
// ESPN publica un "scoreboard" público (sin necesidad de clave) para cada
// liga, con el mismo formato para las cuatro. Traducimos los nombres en
// español que usa el panel al nombre en inglés que usa ESPN, para poder
// emparejar los partidos guardados con los datos reales.
const SPORT_ESPN_PATH = {
  beisbol: 'baseball/mlb',
  baloncesto: 'basketball/nba',
  nfl: 'football/nfl',
  nhl: 'hockey/nhl'
};

const TEAM_ES_TO_EN = {
  beisbol: {
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
  },
  baloncesto: {
    'Hawks de Atlanta': 'Atlanta Hawks',
    'Celtics de Boston': 'Boston Celtics',
    'Nets de Brooklyn': 'Brooklyn Nets',
    'Hornets de Charlotte': 'Charlotte Hornets',
    'Bulls de Chicago': 'Chicago Bulls',
    'Cavaliers de Cleveland': 'Cleveland Cavaliers',
    'Mavericks de Dallas': 'Dallas Mavericks',
    'Nuggets de Denver': 'Denver Nuggets',
    'Pistons de Detroit': 'Detroit Pistons',
    'Warriors de Golden State': 'Golden State Warriors',
    'Rockets de Houston': 'Houston Rockets',
    'Pacers de Indiana': 'Indiana Pacers',
    'Clippers de Los Ángeles': 'Clippers',
    'Lakers de Los Ángeles': 'Los Angeles Lakers',
    'Grizzlies de Memphis': 'Memphis Grizzlies',
    'Heat de Miami': 'Miami Heat',
    'Bucks de Milwaukee': 'Milwaukee Bucks',
    'Timberwolves de Minnesota': 'Minnesota Timberwolves',
    'Pelicans de Nueva Orleans': 'New Orleans Pelicans',
    'Knicks de Nueva York': 'New York Knicks',
    'Thunder de Oklahoma City': 'Oklahoma City Thunder',
    'Magic de Orlando': 'Orlando Magic',
    '76ers de Filadelfia': 'Philadelphia 76ers',
    'Suns de Phoenix': 'Phoenix Suns',
    'Trail Blazers de Portland': 'Portland Trail Blazers',
    'Kings de Sacramento': 'Sacramento Kings',
    'Spurs de San Antonio': 'San Antonio Spurs',
    'Raptors de Toronto': 'Toronto Raptors',
    'Jazz de Utah': 'Utah Jazz',
    'Wizards de Washington': 'Washington Wizards'
  },
  nfl: {
    'Cardinals de Arizona': 'Arizona Cardinals',
    'Falcons de Atlanta': 'Atlanta Falcons',
    'Ravens de Baltimore': 'Baltimore Ravens',
    'Bills de Buffalo': 'Buffalo Bills',
    'Panthers de Carolina': 'Carolina Panthers',
    'Bears de Chicago': 'Chicago Bears',
    'Bengals de Cincinnati': 'Cincinnati Bengals',
    'Browns de Cleveland': 'Cleveland Browns',
    'Cowboys de Dallas': 'Dallas Cowboys',
    'Broncos de Denver': 'Denver Broncos',
    'Lions de Detroit': 'Detroit Lions',
    'Packers de Green Bay': 'Green Bay Packers',
    'Texans de Houston': 'Houston Texans',
    'Colts de Indianápolis': 'Indianapolis Colts',
    'Jaguars de Jacksonville': 'Jacksonville Jaguars',
    'Chiefs de Kansas City': 'Kansas City Chiefs',
    'Raiders de Las Vegas': 'Las Vegas Raiders',
    'Chargers de Los Ángeles': 'Chargers',
    'Rams de Los Ángeles': 'Rams',
    'Dolphins de Miami': 'Miami Dolphins',
    'Vikings de Minnesota': 'Minnesota Vikings',
    'Patriots de Nueva Inglaterra': 'New England Patriots',
    'Saints de Nueva Orleans': 'New Orleans Saints',
    'Giants de Nueva York': 'New York Giants',
    'Jets de Nueva York': 'New York Jets',
    'Eagles de Filadelfia': 'Philadelphia Eagles',
    'Steelers de Pittsburgh': 'Pittsburgh Steelers',
    '49ers de San Francisco': 'San Francisco 49ers',
    'Seahawks de Seattle': 'Seattle Seahawks',
    'Buccaneers de Tampa Bay': 'Tampa Bay Buccaneers',
    'Titans de Tennessee': 'Tennessee Titans',
    'Commanders de Washington': 'Washington Commanders'
  },
  nhl: {
    'Ducks de Anaheim': 'Anaheim Ducks',
    'Bruins de Boston': 'Boston Bruins',
    'Sabres de Buffalo': 'Buffalo Sabres',
    'Flames de Calgary': 'Calgary Flames',
    'Hurricanes de Carolina': 'Carolina Hurricanes',
    'Blackhawks de Chicago': 'Chicago Blackhawks',
    'Avalanche de Colorado': 'Colorado Avalanche',
    'Blue Jackets de Columbus': 'Columbus Blue Jackets',
    'Stars de Dallas': 'Dallas Stars',
    'Red Wings de Detroit': 'Detroit Red Wings',
    'Oilers de Edmonton': 'Edmonton Oilers',
    'Panthers de Florida': 'Florida Panthers',
    'Kings de Los Ángeles': 'Kings',
    'Wild de Minnesota': 'Minnesota Wild',
    'Canadiens de Montreal': 'Montreal Canadiens',
    'Predators de Nashville': 'Nashville Predators',
    'Devils de Nueva Jersey': 'New Jersey Devils',
    'Islanders de Nueva York': 'New York Islanders',
    'Rangers de Nueva York': 'New York Rangers',
    'Senators de Ottawa': 'Ottawa Senators',
    'Flyers de Filadelfia': 'Philadelphia Flyers',
    'Penguins de Pittsburgh': 'Pittsburgh Penguins',
    'Sharks de San José': 'San Jose Sharks',
    'Kraken de Seattle': 'Seattle Kraken',
    'Blues de San Luis': 'St. Louis Blues',
    'Lightning de Tampa Bay': 'Tampa Bay Lightning',
    'Maple Leafs de Toronto': 'Toronto Maple Leafs',
    'Mammoth de Utah': 'Utah Mammoth',
    'Canucks de Vancouver': 'Vancouver Canucks',
    'Golden Knights de Vegas': 'Vegas Golden Knights',
    'Capitals de Washington': 'Washington Capitals',
    'Jets de Winnipeg': 'Winnipeg Jets'
  }
};

// Compara nombres de equipo sin importar tildes, puntos, mayúsculas o si
// ESPN usa el nombre completo ("Los Angeles Clippers") o corto ("LA
// Clippers"): basta con que uno contenga al otro una vez normalizados.
function normTeam(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[.]/g, '')
    .trim();
}
function teamNamesMatch(a, b) {
  var na = normTeam(a), nb = normTeam(b);
  if (!na || !nb) return false;
  return na === nb || na.endsWith(nb) || nb.endsWith(na);
}

function todayISO() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return d.getFullYear() + '-' + mm + '-' + dd;
}

// Consulta el "scoreboard" público de ESPN (sin clave) para una liga y arma
// una lista simple de los partidos de hoy con marcador y estado.
async function fetchEspnGames(espnPath) {
  try {
    const url = 'https://site.api.espn.com/apis/site/v2/sports/' + espnPath + '/scoreboard';
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    const games = [];
    for (const ev of (data.events || [])) {
      const comp = ev.competitions && ev.competitions[0];
      if (!comp) continue;
      const competitors = comp.competitors || [];
      const home = competitors.find(function (x) { return x.homeAway === 'home'; });
      const away = competitors.find(function (x) { return x.homeAway === 'away'; });
      if (!home || !away) continue;
      games.push({
        home: home.team ? home.team.displayName : '',
        away: away.team ? away.team.displayName : '',
        homeScore: home.score !== undefined ? Number(home.score) : undefined,
        awayScore: away.score !== undefined ? Number(away.score) : undefined,
        state: comp.status && comp.status.type ? comp.status.type.state : '', // 'pre' | 'in' | 'post'
        period: comp.status ? comp.status.period : undefined,
        clock: comp.status ? comp.status.displayClock : ''
      });
    }
    return games;
  } catch (e) {
    return [];
  }
}

var PERIOD_WORD = {
  beisbol: 'Entrada', baloncesto: 'Cuarto', nfl: 'Cuarto', nhl: 'Período'
};

function periodLabel(sport, g) {
  if (!g.period) return '';
  var word = PERIOD_WORD[sport] || 'Período';
  var label = word + ' ' + g.period;
  if (g.clock) label += ' · ' + g.clock;
  return label;
}

// Revisa TODOS los partidos guardados de MLB/NBA/NFL/NHL (estén o no
// marcados "En vivo" a mano) y los compara contra el estado real en ESPN:
// - Si el juego real ya empezó, lo marca "en vivo" solo y le pone el marcador.
// - Si el juego real ya terminó, lo baja de "en vivo" y deja el marcador final.
// Un partido que no aparezca en ESPN (por ejemplo LIDOM, que ESPN no cubre)
// se deja intacto para que el admin lo actualice a mano.
async function updateLiveScores() {
  try {
    const rows = await sql`SELECT value FROM app_state WHERE key = 'matches'`;
    var matches = rows[0] ? rows[0].value : [];
    if (typeof matches === 'string') {
      try { matches = JSON.parse(matches); } catch (e) { matches = []; }
    }
    if (!Array.isArray(matches) || matches.length === 0) return;

    var sportsInPlay = {};
    matches.forEach(function (m) {
      if (SPORT_ESPN_PATH[m.sport] && TEAM_ES_TO_EN[m.sport] && TEAM_ES_TO_EN[m.sport][m.home] && TEAM_ES_TO_EN[m.sport][m.away]) {
        sportsInPlay[m.sport] = true;
      }
    });
    var sportsList = Object.keys(sportsInPlay);
    if (sportsList.length === 0) return;

    var gamesBySport = {};
    for (var i = 0; i < sportsList.length; i++) {
      var sport = sportsList[i];
      gamesBySport[sport] = await fetchEspnGames(SPORT_ESPN_PATH[sport]);
    }

    var changed = false;
    matches.forEach(function (m) {
      if (!SPORT_ESPN_PATH[m.sport]) return;
      var teamMap = TEAM_ES_TO_EN[m.sport] || {};
      var homeEn = teamMap[m.home];
      var awayEn = teamMap[m.away];
      if (!homeEn || !awayEn) return;
      var games = gamesBySport[m.sport] || [];
      var g = games.find(function (x) { return teamNamesMatch(x.home, homeEn) && teamNamesMatch(x.away, awayEn); });
      if (!g) return;
      // El juego real ya empezó: márcalo "en vivo" aunque el admin nunca haya
      // tocado la casilla, y súbele el marcador.
      if (g.state === 'in') {
        if (g.homeScore === undefined || g.awayScore === undefined || isNaN(g.homeScore) || isNaN(g.awayScore)) return;
        if (!m.live) changed = true;
        m.live = true;
        m.score = { home: g.homeScore, away: g.awayScore, period: periodLabel(m.sport, g) };
        changed = true;
      } else if (g.state === 'post') {
        // El juego real ya terminó: lo bajamos de "en vivo" y dejamos el marcador final.
        if (m.live) changed = true;
        if (g.homeScore !== undefined && g.awayScore !== undefined && !isNaN(g.homeScore) && !isNaN(g.awayScore)) {
          m.score = { home: g.homeScore, away: g.awayScore, period: 'Final' };
        }
        m.live = false;
      }
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
setInterval(updateLiveScores, 60000);
updateLiveScores();

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

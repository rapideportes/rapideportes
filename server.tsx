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
    'Arizona Diamondbacks': 'Arizona Diamondbacks',
    'Atlanta Braves': 'Atlanta Braves',
    'Baltimore Orioles': 'Baltimore Orioles',
    'Boston Red Sox': 'Boston Red Sox',
    'Chicago Cubs': 'Chicago Cubs',
    'Chicago White Sox': 'Chicago White Sox',
    'Cincinnati Reds': 'Cincinnati Reds',
    'Cleveland Guardians': 'Cleveland Guardians',
    'Colorado Rockies': 'Colorado Rockies',
    'Detroit Tigers': 'Detroit Tigers',
    'Houston Astros': 'Houston Astros',
    'Kansas City Royals': 'Kansas City Royals',
    'Los Angeles Angels': 'Los Angeles Angels',
    'Los Angeles Dodgers': 'Los Angeles Dodgers',
    'Miami Marlins': 'Miami Marlins',
    'Milwaukee Brewers': 'Milwaukee Brewers',
    'Minnesota Twins': 'Minnesota Twins',
    'New York Mets': 'New York Mets',
    'New York Yankees': 'New York Yankees',
    'Philadelphia Phillies': 'Philadelphia Phillies',
    'Pittsburgh Pirates': 'Pittsburgh Pirates',
    'San Diego Padres': 'San Diego Padres',
    'San Francisco Giants': 'San Francisco Giants',
    'Seattle Mariners': 'Seattle Mariners',
    'St. Louis Cardinals': 'St. Louis Cardinals',
    'Tampa Bay Rays': 'Tampa Bay Rays',
    'Texas Rangers': 'Texas Rangers',
    'Toronto Blue Jays': 'Toronto Blue Jays',
    'Washington Nationals': 'Washington Nationals',
    'Oakland Athletics': 'Athletics'
  },
  baloncesto: {
    'Atlanta Hawks': 'Atlanta Hawks',
    'Boston Celtics': 'Boston Celtics',
    'Brooklyn Nets': 'Brooklyn Nets',
    'Charlotte Hornets': 'Charlotte Hornets',
    'Chicago Bulls': 'Chicago Bulls',
    'Cleveland Cavaliers': 'Cleveland Cavaliers',
    'Dallas Mavericks': 'Dallas Mavericks',
    'Denver Nuggets': 'Denver Nuggets',
    'Detroit Pistons': 'Detroit Pistons',
    'Golden State Warriors': 'Golden State Warriors',
    'Houston Rockets': 'Houston Rockets',
    'Indiana Pacers': 'Indiana Pacers',
    'LA Clippers': 'Clippers',
    'Los Angeles Lakers': 'Los Angeles Lakers',
    'Memphis Grizzlies': 'Memphis Grizzlies',
    'Miami Heat': 'Miami Heat',
    'Milwaukee Bucks': 'Milwaukee Bucks',
    'Minnesota Timberwolves': 'Minnesota Timberwolves',
    'New Orleans Pelicans': 'New Orleans Pelicans',
    'New York Knicks': 'New York Knicks',
    'Oklahoma City Thunder': 'Oklahoma City Thunder',
    'Orlando Magic': 'Orlando Magic',
    'Philadelphia 76ers': 'Philadelphia 76ers',
    'Phoenix Suns': 'Phoenix Suns',
    'Portland Trail Blazers': 'Portland Trail Blazers',
    'Sacramento Kings': 'Sacramento Kings',
    'San Antonio Spurs': 'San Antonio Spurs',
    'Toronto Raptors': 'Toronto Raptors',
    'Utah Jazz': 'Utah Jazz',
    'Washington Wizards': 'Washington Wizards'
  },
  nfl: {
    'Arizona Cardinals': 'Arizona Cardinals',
    'Atlanta Falcons': 'Atlanta Falcons',
    'Baltimore Ravens': 'Baltimore Ravens',
    'Buffalo Bills': 'Buffalo Bills',
    'Carolina Panthers': 'Carolina Panthers',
    'Chicago Bears': 'Chicago Bears',
    'Cincinnati Bengals': 'Cincinnati Bengals',
    'Cleveland Browns': 'Cleveland Browns',
    'Dallas Cowboys': 'Dallas Cowboys',
    'Denver Broncos': 'Denver Broncos',
    'Detroit Lions': 'Detroit Lions',
    'Green Bay Packers': 'Green Bay Packers',
    'Houston Texans': 'Houston Texans',
    'Indianapolis Colts': 'Indianapolis Colts',
    'Jacksonville Jaguars': 'Jacksonville Jaguars',
    'Kansas City Chiefs': 'Kansas City Chiefs',
    'Las Vegas Raiders': 'Las Vegas Raiders',
    'Los Angeles Chargers': 'Chargers',
    'Los Angeles Rams': 'Rams',
    'Miami Dolphins': 'Miami Dolphins',
    'Minnesota Vikings': 'Minnesota Vikings',
    'New England Patriots': 'New England Patriots',
    'New Orleans Saints': 'New Orleans Saints',
    'New York Giants': 'New York Giants',
    'New York Jets': 'New York Jets',
    'Philadelphia Eagles': 'Philadelphia Eagles',
    'Pittsburgh Steelers': 'Pittsburgh Steelers',
    'San Francisco 49ers': 'San Francisco 49ers',
    'Seattle Seahawks': 'Seattle Seahawks',
    'Tampa Bay Buccaneers': 'Tampa Bay Buccaneers',
    'Tennessee Titans': 'Tennessee Titans',
    'Washington Commanders': 'Washington Commanders'
  },
  nhl: {
    'Anaheim Ducks': 'Anaheim Ducks',
    'Boston Bruins': 'Boston Bruins',
    'Buffalo Sabres': 'Buffalo Sabres',
    'Calgary Flames': 'Calgary Flames',
    'Carolina Hurricanes': 'Carolina Hurricanes',
    'Chicago Blackhawks': 'Chicago Blackhawks',
    'Colorado Avalanche': 'Colorado Avalanche',
    'Columbus Blue Jackets': 'Columbus Blue Jackets',
    'Dallas Stars': 'Dallas Stars',
    'Detroit Red Wings': 'Detroit Red Wings',
    'Edmonton Oilers': 'Edmonton Oilers',
    'Florida Panthers': 'Florida Panthers',
    'Los Angeles Kings': 'Kings',
    'Minnesota Wild': 'Minnesota Wild',
    'Montreal Canadiens': 'Montreal Canadiens',
    'Nashville Predators': 'Nashville Predators',
    'New Jersey Devils': 'New Jersey Devils',
    'New York Islanders': 'New York Islanders',
    'New York Rangers': 'New York Rangers',
    'Ottawa Senators': 'Ottawa Senators',
    'Philadelphia Flyers': 'Philadelphia Flyers',
    'Pittsburgh Penguins': 'Pittsburgh Penguins',
    'San Jose Sharks': 'San Jose Sharks',
    'Seattle Kraken': 'Seattle Kraken',
    'St. Louis Blues': 'St. Louis Blues',
    'Tampa Bay Lightning': 'Tampa Bay Lightning',
    'Toronto Maple Leafs': 'Toronto Maple Leafs',
    'Utah Mammoth': 'Utah Mammoth',
    'Vancouver Canucks': 'Vancouver Canucks',
    'Vegas Golden Knights': 'Vegas Golden Knights',
    'Washington Capitals': 'Washington Capitals',
    'Winnipeg Jets': 'Winnipeg Jets'
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

// Busca el nombre en inglés de un equipo a partir de lo que el admin haya
// escrito, sin exigir coincidencia exacta: tolera espacios de más,
// mayúsculas distintas, tildes faltantes, etc.
function lookupEnglishTeam(sport, spanishName) {
  var map = TEAM_ES_TO_EN[sport];
  if (!map || !spanishName) return null;
  if (map[spanishName]) return map[spanishName];
  var target = normTeam(spanishName);
  var keys = Object.keys(map);
  for (var i = 0; i < keys.length; i++) {
    if (normTeam(keys[i]) === target) return map[keys[i]];
  }
  for (var j = 0; j < keys.length; j++) {
    var nk = normTeam(keys[j]);
    if (nk.indexOf(target) !== -1 || target.indexOf(nk) !== -1) return map[keys[j]];
  }
  return null;
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
    const dateParam = todayISO().replace(/-/g, '');
    const url = 'https://site.api.espn.com/apis/site/v2/sports/' + espnPath + '/scoreboard?dates=' + dateParam;
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
// marcados "En vivo" a mano) y los compara contra el estado real en ESPN.
// Si el admin puso los equipos al revés (local/visitante invertidos
// respecto al juego real), también lo reconoce y acomoda el marcador
// correctamente. Un partido que no aparezca en ESPN (por ejemplo LIDOM,
// que ESPN no cubre) se deja intacto para que el admin lo actualice a mano.
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
      if (SPORT_ESPN_PATH[m.sport] && lookupEnglishTeam(m.sport, m.home) && lookupEnglishTeam(m.sport, m.away)) {
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
      var homeEn = lookupEnglishTeam(m.sport, m.home);
      var awayEn = lookupEnglishTeam(m.sport, m.away);
      if (!homeEn || !awayEn) return;
      var games = gamesBySport[m.sport] || [];
      var g = games.find(function (x) { return teamNamesMatch(x.home, homeEn) && teamNamesMatch(x.away, awayEn); });
      var reversed = false;
      if (!g) {
        // El admin pudo haber puesto los equipos al revés (local/visitante
        // invertidos respecto al juego real): buscamos también así.
        g = games.find(function (x) { return teamNamesMatch(x.home, awayEn) && teamNamesMatch(x.away, homeEn); });
        reversed = true;
      }
      if (!g) return;
      var realHomeScore = reversed ? g.awayScore : g.homeScore;
      var realAwayScore = reversed ? g.homeScore : g.awayScore;
      // El juego real ya empezó: márcalo "en vivo" aunque el admin nunca haya
      // tocado la casilla, y súbele el marcador.
      if (g.state === 'in') {
        if (realHomeScore === undefined || realAwayScore === undefined || isNaN(realHomeScore) || isNaN(realAwayScore)) return;
        if (!m.live) changed = true;
        m.live = true;
        m.score = { home: realHomeScore, away: realAwayScore, period: periodLabel(m.sport, g) };
        changed = true;
      } else if (g.state === 'post') {
        // El juego real ya terminó: lo bajamos de "en vivo" y dejamos el marcador final.
        if (m.live) changed = true;
        if (realHomeScore !== undefined && realAwayScore !== undefined && !isNaN(realHomeScore) && !isNaN(realAwayScore)) {
          m.score = { home: realHomeScore, away: realAwayScore, period: 'Final' };
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

app.get('/api/admin/debug-live', async (c) => {
  if (!isAdminReq(c)) return c.json({ error: 'forbidden' }, 403);
  const rows = await sql`SELECT value FROM app_state WHERE key = 'matches'`;
  var matches = rows[0] ? rows[0].value : [];
  if (typeof matches === 'string') {
    try { matches = JSON.parse(matches); } catch (e) { matches = []; }
  }
  var out = [];
  for (const m of matches) {
    if (!SPORT_ESPN_PATH[m.sport]) continue;
    var homeEn = lookupEnglishTeam(m.sport, m.home);
    var awayEn = lookupEnglishTeam(m.sport, m.away);
    var games = await fetchEspnGames(SPORT_ESPN_PATH[m.sport]);
    out.push({
      guardado_home: m.home,
      guardado_away: m.away,
      guardado_live: !!m.live,
      traducido_home: homeEn,
      traducido_away: awayEn,
      espn_juegos_hoy: games.map(function (g) { return g.away + ' @ ' + g.home + ' (' + g.state + ')'; })
    });
  }
  return c.json(out);
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

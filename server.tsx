import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';

// Ninguna consulta a otra página puede quedarse esperando para siempre:
// si ESPN, la NBA o MLB no contestan en 20 segundos, se corta y se vuelve a intentar.
// (Antes una consulta colgada dejaba el marcador en vivo frisado.)
const _rdFetch = globalThis.fetch;
globalThis.fetch = function (input, init) {
  if (!init || !init.signal) init = Object.assign({}, init || {}, { signal: AbortSignal.timeout(20000) });
  return _rdFetch(input, init);
};

const sql = Bun.sql;

await sql`CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  balance NUMERIC NOT NULL DEFAULT 0,
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

await sql`ALTER TABLE bets ADD COLUMN IF NOT EXISTS leg_results JSONB`;

await sql`CREATE TABLE IF NOT EXISTS app_state (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL
)`;

// Juego responsable y verificación de edad
await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS limit_period TEXT DEFAULT 'day'`;
await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS limit_amount NUMERIC DEFAULT 0`;
await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS limit_pending_period TEXT`;
await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS limit_pending_amount NUMERIC`;
await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS limit_pending_at TIMESTAMPTZ`;
await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS verify_status TEXT DEFAULT 'none'`;
await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS dob DATE`;

await sql`ALTER TABLE bets ADD COLUMN IF NOT EXISTS win_seen BOOLEAN DEFAULT false`;
await sql`ALTER TABLE bets ADD COLUMN IF NOT EXISTS cashout_at TIMESTAMPTZ`;
// Tickets eliminados por el admin: se ocultan y ya no se califican, pero se guardan para que las cuentas cuadren.
await sql`ALTER TABLE bets ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`;

await sql`CREATE TABLE IF NOT EXISTS deposits (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  amount NUMERIC NOT NULL,
  status TEXT DEFAULT 'approved',
  created_at TIMESTAMPTZ DEFAULT now()
)`;


await sql`CREATE TABLE IF NOT EXISTS withdrawals (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  amount NUMERIC NOT NULL,
  status TEXT DEFAULT 'pending',
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  reviewed_at TIMESTAMPTZ
)`;

// Retiro "de vuelta por donde entró": cada depósito guarda con qué tarjeta o cuenta
// se pagó (lo que mande Stride), y el retiro solo se puede enviar ahí.
await sql`ALTER TABLE deposits ADD COLUMN IF NOT EXISTS method_ref TEXT`;
await sql`ALTER TABLE deposits ADD COLUMN IF NOT EXISTS method_label TEXT`;
await sql`ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS method_ref TEXT`;
await sql`ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS method_label TEXT`;

// Recargas y descuentos hechos a mano por el admin (positivo = recarga, negativo = descuento).
await sql`CREATE TABLE IF NOT EXISTS balance_adjustments (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  amount NUMERIC NOT NULL,
  note TEXT,
  balance_after NUMERIC,
  created_at TIMESTAMPTZ DEFAULT now()
)`;
await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen TIMESTAMPTZ`;

// Recuperar contraseña: se guarda solo el "hash" del enlace, nunca el enlace en sí.
await sql`CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
)`;

async function payoutMethod(userId) {
  const rows = await sql`SELECT method_ref, method_label FROM deposits
    WHERE user_id = ${userId} AND status = 'approved' AND method_ref IS NOT NULL
    ORDER BY created_at DESC LIMIT 1`;
  return rows[0] ? { ref: rows[0].method_ref, label: rows[0].method_label || 'Método de depósito' } : null;
}

// Resultados guardados: cada partido terminado se guarda aquí con su fecha,
// aunque después el admin lo borre de la lista.
await sql`CREATE TABLE IF NOT EXISTS results (
  match_id TEXT PRIMARY KEY,
  sport TEXT, away TEXT, home TEXT,
  away_score NUMERIC, home_score NUMERIC,
  start_at TIMESTAMPTZ, finished_at TIMESTAMPTZ DEFAULT now(),
  data JSONB
)`;
async function saveResults(list) {
  try {
    for (const m of (Array.isArray(list) ? list : [])) {
      if (!m || !m.finished || !m.score || m.id === undefined) continue;
      var a = Number(m.score.away), h = Number(m.score.home);
      if (isNaN(a) || isNaN(h)) continue;
      var st = m.startAt && !isNaN(Date.parse(m.startAt)) ? new Date(m.startAt).toISOString() : null;
      await sql`INSERT INTO results (match_id, sport, away, home, away_score, home_score, start_at, data)
        VALUES (${String(m.id)}, ${m.sport || ''}, ${m.away || ''}, ${m.home || ''}, ${a}, ${h}, ${st}, ${JSON.stringify(m)}::jsonb)
        ON CONFLICT (match_id) DO UPDATE SET away_score = EXCLUDED.away_score, home_score = EXCLUDED.home_score,
          away = EXCLUDED.away, home = EXCLUDED.home, sport = EXCLUDED.sport, start_at = EXCLUDED.start_at, data = EXCLUDED.data`;
    }
  } catch (e) {}
}

const adminTokens = new Set();
// Las sesiones del admin se guardan en la base para que no se cierren cada vez que el servidor se reinicia (al subir cambios).
await sql`CREATE TABLE IF NOT EXISTS admin_sessions (token TEXT PRIMARY KEY, created_at TIMESTAMPTZ DEFAULT now())`;
await sql`DELETE FROM admin_sessions WHERE created_at < now() - interval '8 hours'`;
(await sql`SELECT token FROM admin_sessions`).forEach(function (r) { adminTokens.add(r.token); });

// ---------- Quién está en la plataforma ahora mismo ----------
// Cada jugador con sesión abierta avisa cada 30 s (/api/ping). Se cuenta "en línea"
// si avisó en los últimos 75 s. La última conexión también se guarda en la base.
const ONLINE_MS = 75 * 1000;
const lastSeenMem = new Map();
const lastSeenSaved = new Map();
function touchUser(id) {
  const now = Date.now();
  lastSeenMem.set(id, now);
  if (now - (lastSeenSaved.get(id) || 0) > 60 * 1000) {
    lastSeenSaved.set(id, now);
    sql`UPDATE users SET last_seen = now() WHERE id = ${id}`.catch(function () {});
  }
}
function isOnline(id) { return Date.now() - (lastSeenMem.get(id) || 0) < ONLINE_MS; }

async function getUserFromCookie(c) {
  const token = getCookie(c, 'session');
  if (!token) return null;
  const rows = await sql`
    SELECT u.id, u.email, u.balance
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ${token}
  `;
  if (rows[0]) touchUser(rows[0].id);
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
  nhl: 'hockey/nhl',
  lidom: 'statsapi/winter' // LIDOM: marcador de la API oficial de MLB (ligas de invierno), no de ESPN
};

const TEAM_ES_TO_EN = {
  // LIDOM: palabra con la que termina el nombre oficial de cada equipo (sin acentos).
  lidom: {
    'Tigres del Licey': 'Licey', 'Águilas Cibaeñas': 'Cibaenas', 'Leones del Escogido': 'Escogido',
    'Gigantes del Cibao': 'Cibao', 'Estrellas Orientales': 'Orientales', 'Toros del Este': 'Este'
  },
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
// Los equipos de LIDOM se escriben de muchas formas ("Licey", "Tigres del Licey",
// "Estrellas de Oriente"…): se reducen a una clave fija para emparejarlos.
function lidomKey(n) {
  var t = normTeam(n);
  if (/licey/.test(t)) return 'licey';
  if (/aguila|cibaen/.test(t)) return 'aguilas';
  if (/escogido/.test(t)) return 'escogido';
  if (/gigante|cibao/.test(t)) return 'gigantes';
  if (/estrella|orient/.test(t)) return 'estrellas';
  if (/toros|\beste\b/.test(t)) return 'toros';
  return null;
}
function teamNamesMatch(a, b) {
  var na = normTeam(a), nb = normTeam(b);
  if (!na || !nb) return false;
  return na === nb || na.endsWith(nb) || nb.endsWith(na);
}

// Busca el nombre en inglés de un equipo a partir de lo que el admin haya
// escrito en español, sin exigir coincidencia exacta: tolera espacios de
// más, mayúsculas distintas, tildes faltantes, etc.
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

// Después de medianoche (hora del Este) los juegos de anoche siguen en "hoy" hasta las 8 a. m.,
// para que un juego que terminó tarde no se quede pegado "en vivo".
function liveDays() {
  var now = new Date();
  var h = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }).format(now)) % 24;
  var t = todayISO();
  if (h >= 8) return [t];
  var y = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now.getTime() - 24 * 3600e3));
  return [y, t];
}
function todayISO() {
  // Usamos la fecha en hora del Este de EE.UU. (la misma que usan las
  // ligas y ESPN para "el día de hoy"), sin depender de en qué zona
  // horaria esté configurado el propio contenedor del servidor.
  var fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
  return fmt.format(new Date());
}

// Líderes del partido de un equipo (puntos, rebotes, asistencias) tal como
// los publica ESPN en su scoreboard. Si ESPN no los manda, devuelve null.
function espnLeaderVal(top) {
  var dv = top.displayValue !== undefined ? String(top.displayValue) : '';
  // NFL trae textos largos ("22/31, 287 YDS, 2 TD"): se muestra solo el número de yardas.
  var v = dv.length > 6 && top.value !== undefined ? String(Math.round(Number(top.value))) : (dv || String(top.value !== undefined ? top.value : ''));
  return { name: String(top.athlete.shortName || top.athlete.displayName || ''), value: v };
}
// NFL: ESPN pone los líderes del juego en la competencia (uno por categoría, con su equipo).
function espnCompLeaders(comp, homeId, awayId) {
  var out = { home: {}, away: {} };
  (comp.leaders || []).forEach(function (cat) {
    var key = cat.name || cat.abbreviation;
    if (['passingYards', 'rushingYards', 'receivingYards', 'goals', 'assists', 'points'].indexOf(key) < 0) return;
    (cat.leaders || []).forEach(function (top) {
      if (!top || !top.athlete) return;
      var tid = String((top.team && top.team.id) || (top.athlete.team && top.athlete.team.id) || '');
      var side = tid && tid === String(homeId) ? 'home' : tid && tid === String(awayId) ? 'away' : null;
      if (side && !out[side][key]) out[side][key] = espnLeaderVal(top);
    });
  });
  return { home: Object.keys(out.home).length ? out.home : null, away: Object.keys(out.away).length ? out.away : null };
}
function espnLeaders(c) {
  var out = {};
  var cats = (c && c.leaders) || [];
  for (var i = 0; i < cats.length; i++) {
    var cat = cats[i] || {};
    var key = cat.name || cat.abbreviation;
    // NBA: puntos/rebotes/asistencias · NHL: goles/asistencias/puntos · NFL: yardas de pase/carrera/recepción.
    if (['points', 'rebounds', 'assists', 'goals', 'passingYards', 'rushingYards', 'receivingYards'].indexOf(key) < 0) continue;
    var top = cat.leaders && cat.leaders[0];
    if (!top || !top.athlete) continue;
    out[key] = espnLeaderVal(top);
  }
  return Object.keys(out).length ? out : null;
}

// Consulta el "scoreboard" público de ESPN (sin clave) para una liga y arma
// una lista simple de los partidos de hoy con marcador y estado.
// ---------- NBA: marcador oficial (el mismo de NBA.com) ----------
// Se usa encima de ESPN para el marcador, el cuarto y el reloj, que llegan más rápido.
// Si la NBA no responde, se queda lo de ESPN.
function nbaClockText(iso) {
  var m = /^PT(\d+)M(\d+)(?:\.\d+)?S$/.exec(String(iso || ''));
  if (!m) return '';
  return Number(m[1]) + ':' + String(Number(m[2])).padStart(2, '0');
}
async function fetchNbaOfficial() {
  try {
    const ctl = new AbortController(); const tm = setTimeout(function () { ctl.abort(); }, 5000);
    const res = await fetch('https://cdn.nba.com/static/json/liveData/scoreboard/todaysScoreboard_00.json?t=' + Date.now(), {
      signal: ctl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36', 'Referer': 'https://www.nba.com/', 'Accept': 'application/json' }
    });
    clearTimeout(tm);
    if (!res.ok) return [];
    const data = await res.json();
    return ((data.scoreboard && data.scoreboard.games) || []).map(function (g) {
      var h = g.homeTeam || {}, a = g.awayTeam || {};
      return {
        homeName: h.teamName || '', awayName: a.teamName || '',
        homeFull: ((h.teamCity || '') + ' ' + (h.teamName || '')).trim(), awayFull: ((a.teamCity || '') + ' ' + (a.teamName || '')).trim(),
        homeScore: Number(h.score), awayScore: Number(a.score),
        state: g.gameStatus === 2 ? 'in' : (g.gameStatus === 3 && /final/i.test(g.gameStatusText || '')) ? 'post' : 'pre',
        period: Number(g.period) || undefined,
        clock: nbaClockText(g.gameClock),
        statusText: g.gameStatusText || ''
      };
    });
  } catch (e) { return []; }
}
function nbaSameTeam(espnName, full, nick) {
  espnName = String(espnName || '').toLowerCase();
  return !!nick && (espnName === String(full).toLowerCase() || espnName.endsWith(' ' + String(nick).toLowerCase()));
}
async function overlayNbaOfficial(games) {
  var nba = await fetchNbaOfficial();
  if (!nba.length) return games;
  games.forEach(function (g) {
    var n = nba.find(function (x) { return nbaSameTeam(g.home, x.homeFull, x.homeName) && nbaSameTeam(g.away, x.awayFull, x.awayName); });
    if (!n || n.state === 'pre') return;
    if (isNaN(n.homeScore) || isNaN(n.awayScore)) return;
    // Si ESPN ya dice que terminó, se queda terminado (la NBA a veces se queda pegada en un cuarto).
    if (g.state === 'post' && n.state !== 'post') return;
    // Si la NBA tiene menos puntos que ESPN, la NBA está atrasada: se usa ESPN.
    var eh = Number(g.homeScore), ea = Number(g.awayScore);
    if (!isNaN(eh) && !isNaN(ea) && (n.homeScore < eh || n.awayScore < ea)) return;
    if (!isNaN(eh) && !isNaN(ea) && n.state === g.state && Number(g.period) > Number(n.period)) return;
    g.homeScore = n.homeScore; g.awayScore = n.awayScore; g.state = n.state;
    if (n.period) g.period = n.period;
    g.clock = /halftime|half/i.test(n.statusText) ? '' : n.clock;
    if (/halftime|half/i.test(n.statusText)) g.half = true;
    g.source = 'nba';
  });
  return games;
}

// "3er cuarto · 0:00" se ve raro: al terminar un cuarto se dice "Fin del 3er cuarto" o "Medio tiempo".
function quarterInfo(g) {
  if (!g.period) return { label: null, clock: g.clock || null };
  var n = g.period, name = n > 4 ? 'Tiempo extra' : n + ['', 'er', 'do', 'er', 'to'][n] + ' cuarto';
  var zero = !g.clock || /^0?0?:?0{1,2}(\.0+)?$/.test(String(g.clock).trim());
  if (g.endPeriod && !g.half && n !== 2) return { label: n > 4 ? 'Fin del tiempo extra' : 'Fin del ' + name, clock: null };
  if (g.half || (n === 2 && zero && g.clock !== null && g.clock !== undefined && g.clock !== '')) return { label: 'Medio tiempo', clock: null };
  if (zero && g.clock) return { label: n > 4 ? 'Fin del tiempo extra' : 'Fin del ' + name, clock: null };
  return { label: name, clock: g.clock || null };
}
async function fetchEspnGames(espnPath) {
  try {
    // Un día a la vez (hoy, y de madrugada también ayer), y se juntan.
    const data = { events: [] };
    var okAny = false;
    for (const day of liveDays()) {
      const url = 'https://site.api.espn.com/apis/site/v2/sports/' + espnPath + '/scoreboard?dates=' + day.replace(/-/g, '');
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36' } });
      if (!res.ok) continue;
      okAny = true;
      const dj = await res.json();
      (dj.events || []).forEach(function (ev) { if (!data.events.some(function (x) { return x.id === ev.id; })) data.events.push(ev); });
    }
    if (!okAny) return [];
    const games = [];
    for (const ev of (data.events || [])) {
      const comp = ev.competitions && ev.competitions[0];
      if (!comp) continue;
      const competitors = comp.competitors || [];
      const home = competitors.find(function (x) { return x.homeAway === 'home'; });
      const away = competitors.find(function (x) { return x.homeAway === 'away'; });
      if (!home || !away) continue;
      games.push({
        id: ev.id,
        home: home.team ? home.team.displayName : '',
        away: away.team ? away.team.displayName : '',
        homeScore: home.score !== undefined ? Number(home.score) : undefined,
        awayScore: away.score !== undefined ? Number(away.score) : undefined,
        // ESPN marca "post" también a los juegos pospuestos/cancelados (completed=false):
        // esos NO se tratan como terminados (si no, se pagarían con 0-0).
        state: (function () { var ty = comp.status && comp.status.type ? comp.status.type : {}; var stt = ty.state || ''; return stt === 'post' && ty.completed === false ? 'pre' : stt; })(),
        estadoDetallado: (function () { var ty = comp.status && comp.status.type ? comp.status.type : {}; if (ty.state !== 'post' || ty.completed !== false) return null; return /cancel/i.test(ty.name || '') ? 'Cancelado' : /suspend/i.test(ty.name || '') ? 'Suspendido' : 'Pospuesto'; })(),
        startTimeUtc: ev.date || null,
        // ESPN dice "STATUS_HALFTIME" en el medio tiempo y "STATUS_END_PERIOD" al terminar un cuarto.
        half: !!(comp.status && comp.status.type && (comp.status.type.name === 'STATUS_HALFTIME' || /^half/i.test(comp.status.type.detail || comp.status.type.shortDetail || ''))),
        endPeriod: !!(comp.status && comp.status.type && comp.status.type.name === 'STATUS_END_PERIOD'),
        lsHome: (home.linescores || []).map(function (x) { return Number(x.value); }),
        lsAway: (away.linescores || []).map(function (x) { return Number(x.value); }),
        period: comp.status ? comp.status.period : undefined,
        clock: comp.status ? comp.status.displayClock : '',
        leaders: (function () {
          var L = { home: espnLeaders(home), away: espnLeaders(away) };
          if (!L.home || !L.away) {
            var C = espnCompLeaders(comp, home.team && home.team.id, away.team && away.team.id);
            L.home = L.home || C.home; L.away = L.away || C.away;
          }
          return L;
        })()
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
  if (sport === 'baloncesto' || sport === 'nfl') {
    var q = quarterInfo(g);
    if (g.half || q.label === 'Medio tiempo') return 'Medio tiempo';
    if (g.endPeriod && g.period) return g.period > 4 ? 'Fin del tiempo extra' : 'Fin del ' + g.period + ['', 'er', 'do', 'er', 'to'][g.period] + ' cuarto';
    if (q.label && /^Fin/.test(q.label)) return q.label;
  }
  var word = PERIOD_WORD[sport] || 'Período';
  var label = word + ' ' + g.period;
  if (g.clock) label += ' · ' + g.clock;
  return label;
}

// Revisa los partidos guardados marcados "En vivo", agrupados por deporte,
// y si encuentra el juego real correspondiente en ESPN actualiza su
// marcador automáticamente. Un partido que no aparezca en ESPN (por
// ejemplo LIDOM, que ESPN no cubre) se deja intacto para que el admin lo
// siga actualizando a mano.
// Consulta la API OFICIAL y gratuita de MLB (statsapi.mlb.com, otra
// empresa/infraestructura distinta a ESPN) para el marcador, el estado y
// los lanzadores probables de hoy. La usamos en vez de ESPN para béisbol.

// Trae outs y corredores en base de un juego de MLB EN VIVO ahora mismo.
// Solo se llama para juegos con state 'in', así que el costo es bajo
// (normalmente 0 a 4 llamadas por minuto).
async function fetchMlbLiveDetail(gamePk) {
  try {
    var url = 'https://statsapi.mlb.com/api/v1.1/game/' + gamePk + '/feed/live';
    var res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36' } });
    if (!res.ok) return null;
    var data = await res.json();
    var ls = data.liveData && data.liveData.linescore;
    if (!ls) return null;
    var offense = ls.offense || {};

    // Lanzamientos del turno al bate ACTUAL, con su ubicación real en la
    // zona de strike. MLB ya devuelve solo los del turno en curso, así que
    // se reinician solos cuando cambia el bateador — no acumulamos nada
    // nosotros ni inventamos posiciones.
    var pitches = [];
    var currentPlay = data.liveData.plays && data.liveData.plays.currentPlay;
    if (currentPlay) {
      (currentPlay.playEvents || []).forEach(function (ev) {
        if (!ev.isPitch || !ev.pitchData || !ev.pitchData.coordinates) return;
        var c = ev.pitchData.coordinates;
        if (typeof c.pX !== 'number' || typeof c.pZ !== 'number') return;
        pitches.push({
          px: c.pX, pz: c.pZ,
          szTop: ev.pitchData.strikeZoneTop, szBot: ev.pitchData.strikeZoneBottom,
          isStrike: !!(ev.details && ev.details.isStrike),
          isBall: !!(ev.details && ev.details.isBall),
          isInPlay: !!(ev.details && ev.details.isInPlay)
        });
      });
    }

    return {
      outs: typeof ls.outs === 'number' ? ls.outs : 0,
      balls: typeof ls.balls === 'number' ? ls.balls : 0,
      strikes: typeof ls.strikes === 'number' ? ls.strikes : 0,
      bases: { first: !!offense.first, second: !!offense.second, third: !!offense.third },
      pitches: pitches
    };
  } catch (e) {
    return null;
  }
}

var MLB_DETAILED_STATE_ES = {
  'Suspended': 'Suspendido', 'Postponed': 'Pospuesto', 'Delayed Start': 'Retrasado',
  'Delayed': 'Retrasado', 'Rain Delay': 'Retrasado por lluvia', 'Game Over': 'Final', 'Final': 'Final',
  'Cancelled': 'Cancelado', 'Canceled': 'Cancelado'
};

// sportId 1 = MLB, 17 = ligas de invierno (ahí está la LIDOM).
var LIDOM_KEYS = ['licey', 'cibaenas', 'escogido', 'cibao', 'orientales', 'este'];
function isLidomTeamName(n) { var t = normTeam(n); return LIDOM_KEYS.some(function (k) { return t.endsWith(' ' + k) || t === k; }); }
async function fetchMlbGamesFromStatsApi(sportId) {
  sportId = sportId || 1;
  var games = [];
  try {
    var ld = liveDays();
    var url = 'https://statsapi.mlb.com/api/v1/schedule?sportId=' + sportId + '&startDate=' + ld[0] + '&endDate=' + ld[ld.length - 1] + '&hydrate=linescore,probablePitcher';
    var res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36' } });
    if (!res.ok) return games;
    var data = await res.json();
    var rawGames = [];
    (data.dates || []).forEach(function (d) { (d.games || []).forEach(function (g) { rawGames.push(g); }); });
    if (sportId === 17) rawGames = rawGames.filter(function (g) {
      var h = g.teams && g.teams.home && g.teams.home.team, a = g.teams && g.teams.away && g.teams.away.team;
      return h && a && isLidomTeamName(h.name) && isLidomTeamName(a.name);
    });

    for (var i = 0; i < rawGames.length; i++) {
      var g = rawGames[i];
      var homeTeam = g.teams && g.teams.home, awayTeam = g.teams && g.teams.away;
      var abstract = g.status ? g.status.abstractGameState : '';
      var detailed = g.status ? g.status.detailedState : '';
      var state = abstract === 'Live' ? 'in' : abstract === 'Final' ? 'post' : 'pre';
      // Un juego "en vivo" que en realidad está suspendido/retrasado no se
      // trata como si estuviera corriendo normalmente.
      var estadoDetallado = null;
      if (MLB_DETAILED_STATE_ES[detailed] && detailed !== 'Final' && detailed !== 'Game Over') {
        estadoDetallado = MLB_DETAILED_STATE_ES[detailed];
        if (/suspend|delay|postpon|cancel/i.test(detailed)) state = 'pre'; // no lo marcamos "en vivo" mientras está detenido
      }
      var ls = g.linescore || {};
      var inningWord = ls.inningState === 'Top' ? 'Alta' : ls.inningState === 'Bottom' ? 'Baja' : ls.inningState === 'Middle' ? 'Entre' : ls.inningState === 'End' ? 'Fin' : (ls.inningState || '');
      var liveDetail = null;
      if (state === 'in') liveDetail = await fetchMlbLiveDetail(g.gamePk);
      games.push({
        id: g.gamePk,
        home: homeTeam && homeTeam.team ? homeTeam.team.name : '',
        away: awayTeam && awayTeam.team ? awayTeam.team.name : '',
        startTimeUtc: g.gameDate || null,
        homeScore: ls.teams && ls.teams.home ? ls.teams.home.runs : undefined,
        awayScore: ls.teams && ls.teams.away ? ls.teams.away.runs : undefined,
        state: state,
        estadoDetallado: estadoDetallado,
        innings: (ls.innings || []).map(function (x) { return { a: Number(x.away && x.away.runs) || 0, h: Number(x.home && x.home.runs) || 0 }; }),
        precomputedPeriod: ls.currentInning ? ((inningWord ? inningWord + ' ' : '') + ls.currentInning + 'ª entrada') : '',
        sportDetail: {
          inning: ls.currentInning || null,
          half: ls.inningState || null,
          outs: liveDetail ? liveDetail.outs : null,
          balls: liveDetail ? liveDetail.balls : null,
          strikes: liveDetail ? liveDetail.strikes : null,
          bases: liveDetail ? liveDetail.bases : null,
          pitches: liveDetail ? liveDetail.pitches : null
        },
        awayPitcher: awayTeam && awayTeam.probablePitcher ? awayTeam.probablePitcher.fullName : null,
        homePitcher: homeTeam && homeTeam.probablePitcher ? homeTeam.probablePitcher.fullName : null
      });
    }
  } catch (e) {
    // devolvemos lo que se haya podido armar hasta el momento del fallo
  }
  return games;
}

// Consulta la API OFICIAL y gratuita de la NHL (api-web.nhle.com, otra
// infraestructura distinta a ESPN) para el marcador, período y reloj
// exactos de hoy.
var NHL_TEAM_ABBREV = {
  'Anaheim Ducks': 'ANA', 'Boston Bruins': 'BOS', 'Buffalo Sabres': 'BUF', 'Calgary Flames': 'CGY',
  'Carolina Hurricanes': 'CAR', 'Chicago Blackhawks': 'CHI', 'Colorado Avalanche': 'COL', 'Columbus Blue Jackets': 'CBJ',
  'Dallas Stars': 'DAL', 'Detroit Red Wings': 'DET', 'Edmonton Oilers': 'EDM', 'Florida Panthers': 'FLA',
  'Los Angeles Kings': 'LAK', 'Minnesota Wild': 'MIN', 'Montreal Canadiens': 'MTL', 'Nashville Predators': 'NSH',
  'New Jersey Devils': 'NJD', 'New York Islanders': 'NYI', 'New York Rangers': 'NYR', 'Ottawa Senators': 'OTT',
  'Philadelphia Flyers': 'PHI', 'Pittsburgh Penguins': 'PIT', 'San Jose Sharks': 'SJS', 'Seattle Kraken': 'SEA',
  'St. Louis Blues': 'STL', 'Tampa Bay Lightning': 'TBL', 'Toronto Maple Leafs': 'TOR', 'Utah Mammoth': 'UTA',
  'Vancouver Canucks': 'VAN', 'Vegas Golden Knights': 'VGK', 'Washington Capitals': 'WSH', 'Winnipeg Jets': 'WPG'
};
function nhlAbbrevFor(name) {
  if (NHL_TEAM_ABBREV[name]) return NHL_TEAM_ABBREV[name];
  var target = normTeam(name);
  var keys = Object.keys(NHL_TEAM_ABBREV);
  for (var i = 0; i < keys.length; i++) { if (normTeam(keys[i]) === target) return NHL_TEAM_ABBREV[keys[i]]; }
  return null;
}
function nhlTeamFullName(team) {
  if (!team) return '';
  var place = team.placeName && team.placeName.default ? team.placeName.default : '';
  var common = team.commonName && team.commonName.default ? team.commonName.default : (team.name && team.name.default ? team.name.default : '');
  return (place + ' ' + common).trim();
}
// NHL: el marcador y el reloj salen de la API oficial de la NHL; los líderes
// (goles, asistencias, puntos) se toman de ESPN solo si hay un juego en vivo.
async function nhlWithLeaders() {
  var games = await fetchNhlGamesFromStatsApi();
  if (!games.some(function (g) { return g.state === 'in' || g.state === 'post'; })) return games;
  try {
    var es = await fetchEspnGames(SPORT_ESPN_PATH.nhl);
    games.forEach(function (g) {
      var e = es.find(function (x) { return teamNamesMatch(x.home, g.home) && teamNamesMatch(x.away, g.away); });
      if (e && e.leaders && (e.leaders.home || e.leaders.away)) g.leaders = e.leaders;
      if (e && e.lsHome && e.lsHome.length) { g.lsHome = e.lsHome; g.lsAway = e.lsAway; }
    });
  } catch (e) {}
  return games;
}
async function fetchNhlGamesFromStatsApi() {
  var games = [];
  try {
    var data = { games: [] }, okAny = false;
    for (const day of liveDays()) {
      var res = await fetch('https://api-web.nhle.com/v1/score/' + day, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36' } });
      if (!res.ok) continue;
      okAny = true;
      var dj = await res.json();
      (dj.games || []).forEach(function (x) { if (!data.games.some(function (y) { return y.id === x.id; })) data.games.push(x); });
    }
    if (!okAny) return games;
    (data.games || []).forEach(function (g) {
      var gs = g.gameState || '';
      var state = (gs === 'LIVE' || gs === 'CRIT') ? 'in' : (gs === 'OFF' || gs === 'FINAL') ? 'post' : 'pre';
      var estadoDetallado = gs === 'PPD' ? 'Pospuesto' : null;
      if (gs === 'PPD') state = 'pre';
      var pd = g.periodDescriptor || {};
      var clock = g.clock || {};
      games.push({
        id: g.id,
        home: nhlTeamFullName(g.homeTeam),
        away: nhlTeamFullName(g.awayTeam),
        homeAbbrev: g.homeTeam ? g.homeTeam.abbrev : null,
        awayAbbrev: g.awayTeam ? g.awayTeam.abbrev : null,
        startTimeUtc: g.startTimeUTC || null,
        homeScore: g.homeTeam ? g.homeTeam.score : undefined,
        awayScore: g.awayTeam ? g.awayTeam.score : undefined,
        state: state,
        estadoDetallado: estadoDetallado,
        precomputedPeriod: (function () {
          if (!pd.number) return '';
          var label = pd.periodType === 'OT' ? 'OT' : pd.periodType === 'SO' ? 'Tanda de penales' : pd.number + (['', 'er', 'do', 'er'][pd.number] || 'to') + ' período';
          if (clock.inIntermission) return label + ' · Intermedio';
          return label + (clock.timeRemaining ? ' · ' + clock.timeRemaining : '');
        })(),
        sportDetail: {
          period: pd.number || null,
          periodType: pd.periodType || 'REG',
          clock: clock.timeRemaining || null,
          running: typeof clock.running === 'boolean' ? clock.running : null,
          inIntermission: !!clock.inIntermission
        }
      });
    });
  } catch (e) {
    // devolvemos lo que se haya podido armar hasta el momento del fallo
  }
  return games;
}

var anyLiveNow = true, lastLiveUpdate = 0;
async function updateLiveScores() {
  lastLiveUpdate = Date.now();
  try {
    const rows = await sql`SELECT value FROM app_state WHERE key = 'matches'`;
    var matches = rows[0] ? rows[0].value : [];
    if (typeof matches === 'string') {
      try { matches = JSON.parse(matches); } catch (e) { matches = []; }
    }
    if (!Array.isArray(matches) || matches.length === 0) { anyLiveNow = false; return; }
    // ¿Hay algún juego en vivo (o por empezar)? Entonces se revisa el marcador más seguido.
    anyLiveNow = matches.some(function (m) {
      if (m.live) return true;
      var t = m.startAt ? Date.parse(m.startAt) : NaN;
      return !m.finished && t <= Date.now() + 5 * 60 * 1000 && t >= Date.now() - 6 * 3600 * 1000;
    });

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
      gamesBySport[sport] = sport === 'beisbol' ? await fetchMlbGamesFromStatsApi()
        : sport === 'lidom' ? await fetchMlbGamesFromStatsApi(17)
        : sport === 'nhl' ? await nhlWithLeaders()
        : sport === 'baloncesto' ? await overlayNbaOfficial(await fetchEspnGames(SPORT_ESPN_PATH[sport]))
        : await fetchEspnGames(SPORT_ESPN_PATH[sport]);
    }

    // NBA: ESPN no trae triples en los líderes; se sacan del box score (cada 45 s por juego).
    if (gamesBySport.baloncesto) {
      for (const g of gamesBySport.baloncesto) {
        if (g.state !== 'in' || !g.id) continue;
        try {
          var th = await nbaThreesLeaders(g.id);
          var bx = gameStatsCache[g.id] && gameStatsCache[g.id].data; if (bx && bx.wp) g.wp = bx.wp;
          if (bx && bx.teams) g.ps = nbaLivePlayers(bx);
          if (th) { g.leaders = g.leaders || {}; ['home', 'away'].forEach(function (sd) { if (th[sd]) { g.leaders[sd] = g.leaders[sd] || {}; g.leaders[sd].threes = th[sd]; } }); }
        } catch (e) {}
      }
    }

    // NHL: lo que lleva cada jugador (goles, asistencias, tiros, atajadas), cada minuto.
    if (gamesBySport.nhl) {
      for (const g of gamesBySport.nhl) {
        if (g.state !== 'in' || !g.id) continue;
        try { var hb = await fetchNhlBox(g.id); if (hb && hb.players) g.ps = hb.players.map(function (p) { return { n: p.name, s: p.stats }; }); } catch (e) {}
      }
    }
    // NFL: ESPN solo da el mejor del juego en cada categoría; el de cada equipo sale del box score.
    if (gamesBySport.nfl) {
      for (const g of gamesBySport.nfl) {
        if (g.state !== 'in' || !g.id) continue;
        try {
          var nb = await nflBoxLeaders(g.id);
          if (nb) { g.leaders = g.leaders || {}; ['home', 'away'].forEach(function (sd) { if (nb[sd]) g.leaders[sd] = Object.assign({}, g.leaders[sd] || {}, nb[sd]); }); if (nb.wp) g.wp = nb.wp; if (nb.ps && nb.ps.length) g.ps = nb.ps; }
        } catch (e) {}
      }
    }

    // Guardamos los cambios calculados por id, sin tocar todavía la lista
    // real — así, si el admin borró o editó un partido mientras tanto,
    // no lo deshacemos al escribir.
    var updatesById = {};
    matches.forEach(function (m) {
      if (!SPORT_ESPN_PATH[m.sport]) return;
      var homeEn = lookupEnglishTeam(m.sport, m.home);
      var awayEn = lookupEnglishTeam(m.sport, m.away);
      if (!homeEn || !awayEn) return;
      var games = gamesBySport[m.sport] || [];
      // Si el partido tiene hora, solo se empareja con juegos reales cercanos a esa
      // hora (y el más cercano): así una doble cartelera o el juego de ayer entre
      // los mismos equipos nunca le pasa su marcador al partido equivocado.
      var mT = m.startAt ? Date.parse(m.startAt) : NaN;
      if (!isNaN(mT)) {
        games = games.filter(function (x) { var t = x.startTimeUtc ? Date.parse(x.startTimeUtc) : NaN; return isNaN(t) || Math.abs(t - mT) <= 10 * 3600000; })
          .slice().sort(function (a, b) {
            var ta = a.startTimeUtc ? Date.parse(a.startTimeUtc) : NaN, tb = b.startTimeUtc ? Date.parse(b.startTimeUtc) : NaN;
            return (isNaN(ta) ? 9e15 : Math.abs(ta - mT)) - (isNaN(tb) ? 9e15 : Math.abs(tb - mT));
          });
      }
      var g, reversed = false;
      if (m.sport === 'nhl') {
        var homeAbbrev = nhlAbbrevFor(m.home), awayAbbrev = nhlAbbrevFor(m.away);
        if (!homeAbbrev || !awayAbbrev) return;
        g = games.find(function (x) { return x.homeAbbrev === homeAbbrev && x.awayAbbrev === awayAbbrev; });
        if (!g) { g = games.find(function (x) { return x.homeAbbrev === awayAbbrev && x.awayAbbrev === homeAbbrev; }); reversed = true; }
      } else {
        g = games.find(function (x) { return teamNamesMatch(x.home, homeEn) && teamNamesMatch(x.away, awayEn); });
        if (!g) {
          // El admin pudo haber puesto los equipos al revés (local/visitante
          // invertidos respecto al juego real): buscamos también así.
          g = games.find(function (x) { return teamNamesMatch(x.home, awayEn) && teamNamesMatch(x.away, homeEn); });
          reversed = true;
        }
      }
      if (!g) return;
      var realHomeScore = reversed ? g.awayScore : g.homeScore;
      var realAwayScore = reversed ? g.homeScore : g.awayScore;
      var update = { espnEventId: g.id || m.espnEventId };
      var hs = halfFromGame(m.sport, g);
      if (hs) update.halfScore = reversed ? { away: hs.home, home: hs.away, done: hs.done, voided: hs.voided } : hs;

      // Arma el detalle específico del deporte para la nueva interfaz de
      // "En vivo": bases/outs en béisbol, período+reloj en NHL/NBA.
      // Siempre a partir de lo que reportó la fuente oficial — nunca
      // inventado ni calculado con un reloj local.
      var sportDetail = null;
      if ((m.sport === 'beisbol' || m.sport === 'lidom') && g.sportDetail) {
        sportDetail = g.sportDetail;
      } else if (m.sport === 'nhl' && g.sportDetail) {
        var hl2 = g.leaders || {};
        sportDetail = Object.assign({}, g.sportDetail, { leaders: (hl2.home || hl2.away) ? (reversed ? { home: hl2.away || null, away: hl2.home || null } : { home: hl2.home || null, away: hl2.away || null }) : null });
      } else if (m.sport === 'nfl') {
        var nl = g.leaders || {};
        var qn = quarterInfo(g);
        sportDetail = { quarter: g.period || null, quarterLabel: qn.label, clock: qn.clock,
          leaders: (nl.home || nl.away) ? (reversed ? { home: nl.away || null, away: nl.home || null } : { home: nl.home || null, away: nl.away || null }) : null };
      } else if (m.sport === 'baloncesto') {
        var qb = quarterInfo(g), quarterLabel = qb.label;
        var gl = g.leaders || {};
        var leaders = (gl.home || gl.away) ? (reversed ? { home: gl.away || null, away: gl.home || null } : { home: gl.home || null, away: gl.away || null }) : null;
        sportDetail = { quarter: g.period || null, quarterLabel: quarterLabel, clock: qb.clock, leaders: leaders };
      }
      if (sportDetail && g.ps && g.ps.length) sportDetail.ps = g.ps;
      if (sportDetail && g.wp && g.wp.hist) {
        sportDetail.wp = reversed ? { home: 1 - g.wp.home, hist: g.wp.hist.map(function (x) { return Math.round((1 - x) * 1000) / 1000; }) } : g.wp;
      }

      // El juego real ya empezó: márcalo "en vivo" aunque el admin nunca haya
      // tocado la casilla, y súbele el marcador.
      if (g.state === 'in') {
        if (realHomeScore === undefined || realAwayScore === undefined || isNaN(realHomeScore) || isNaN(realAwayScore)) return;
        update.live = true;
        update.score = {
          home: realHomeScore, away: realAwayScore,
          period: g.precomputedPeriod !== undefined ? g.precomputedPeriod : periodLabel(m.sport, g),
          detail: sportDetail,
          estadoDetallado: g.estadoDetallado || null
        };
      } else if (g.state === 'post') {
        // El juego real ya terminó: lo bajamos de "en vivo", dejamos el
        // marcador final, y lo marcamos "finished" para que no vuelva a
        // aparecer como si fuera a comenzar.
        update.live = false;
        update.finished = true;
        if (realHomeScore !== undefined && realAwayScore !== undefined && !isNaN(realHomeScore) && !isNaN(realAwayScore)) {
          update.score = { home: realHomeScore, away: realAwayScore, period: 'Final', detail: null, estadoDetallado: null };
        }
      } else {
        // El partido no está en curso según la fuente oficial. Si tiene un
        // estado especial (suspendido/pospuesto/retrasado), lo guardamos
        // para mostrarlo aunque no lo marquemos "en vivo".
        if (g.estadoDetallado) {
          update.estadoDetallado = g.estadoDetallado;
        } else {
          return;
        }
      }
      updatesById[m.id] = update;
    });

    if (Object.keys(updatesById).length === 0) return;

    // Releemos la lista justo antes de guardar, para partir de lo más
    // reciente (por si el admin agregó, borró o editó algo mientras
    // consultábamos a ESPN) y solo aplicamos los cambios a los partidos
    // que todavía existen.
    const freshRows = await sql`SELECT value FROM app_state WHERE key = 'matches'`;
    var freshMatches = freshRows[0] ? freshRows[0].value : [];
    if (typeof freshMatches === 'string') {
      try { freshMatches = JSON.parse(freshMatches); } catch (e) { freshMatches = []; }
    }
    if (!Array.isArray(freshMatches)) return;
    var anyApplied = false;
    freshMatches.forEach(function (m) {
      var u = updatesById[m.id];
      if (!u) return;
      anyApplied = true;
      if (u.espnEventId) m.espnEventId = u.espnEventId;
      if (u.live !== undefined) m.live = u.live;
      if (u.finished !== undefined) m.finished = u.finished;
      if (u.halfScore && !(m.halfScore && m.halfScore.done)) m.halfScore = u.halfScore;
      if (u.score) {
        // ¿El reloj del juego está corriendo? NHL lo dice; en NBA/NFL se sabe
        // comparando con la lectura anterior: si no cambió, está parado
        // (tiempo muerto, falta, tiros libres, revisión…).
        var pd2 = (m.score && m.score.detail) || {}, nd = u.score.detail;
        if (nd && nd.clock) {
          var samePer = (pd2.quarter || pd2.period) === (nd.quarter || nd.period);
          var sameClock = samePer && pd2.clock === nd.clock;
          if (nd.inIntermission) nd.clockRunning = false;
          else if (typeof nd.running === 'boolean') nd.clockRunning = nd.running;
          else nd.clockRunning = samePer && !!pd2.clock && !sameClock;
          nd.clockAt = sameClock && pd2.clockAt ? pd2.clockAt : Date.now();
        }
        m.score = u.score;
      }
      else if (u.estadoDetallado) m.estadoDetallado = u.estadoDetallado;
    });

    if (anyApplied) {
      await sql`
        INSERT INTO app_state (key, value) VALUES ('matches', ${JSON.stringify(freshMatches)}::jsonb)
        ON CONFLICT (key) DO UPDATE SET value = ${JSON.stringify(freshMatches)}::jsonb
      `;
      await saveResults(freshMatches.filter(function (m) { return m.finished && updatesById[m.id]; }));
    }
  } catch (e) {
    // No tumbamos el servidor por un fallo de la API externa.
  }
}

// ---------- Calificación automática de apuestas (Ganador, Hándicap, Total) ----------
// Cuando un partido queda "finished" (ver updateLiveScores arriba), revisamos
// las apuestas pendientes que dependen de ese partido y las marcamos
// ganadas/perdidas usando el marcador final real. Las apuestas de
// medio tiempo y lanzadores no se tocan aquí — se quedan pendientes para
// que el admin las califique a mano.

function matchKey(away, home) { return String(away) + ' @ ' + String(home); }

// Saca el/los partido(s) al que se refiere una apuesta (una sencilla
// referencia uno; una combinada, uno por cada pata), para poder validar
// en el servidor que ninguno esté ya cerrado — sin confiar en lo que
// mande el navegador.
function extractMatchRefs(desc, matchText) {
  if (/^Combinada/i.test(desc || '')) {
    var legs = String(matchText || '').split(' · ');
    var refs = [];
    for (var i = 0; i < legs.length; i++) {
      var parts = legs[i].split('@@@');
      if (parts.length !== 3) return null;
      var tm = /^(Ganador|Hándicap|Total) (.*) vs (.*)$/.exec(parts[0]);
      if (!tm) return null;
      var grp = tm[1] === 'Total' ? 'total' : / — /.test(parts[1]) ? 'x:' + parts[1].split(' — ')[0] + '|' + (parts[1].match(/[\d.]+\s*$/) || [''])[0].trim() : 'lado';
      refs.push({ away: tm[2], home: tm[3], group: grp });
    }
    return refs;
  }
  var mm = /^(.*) @ (.*)$/.exec(matchText || '');
  if (!mm) return null;
  return [{ away: mm[1], home: mm[2], group: 'sencilla' }];
}

// Un partido deja de aceptar apuestas nuevas en cuanto: ya está en vivo,
// ya terminó, o ya llegó su hora oficial de inicio (aunque ESPN todavía
// no lo haya confirmado como "en vivo").
function isBettingClosedServer(m) {
  if (!m) return true;
  if (m.live || m.finished) return true;
  // Sin hora de inicio no se sabe cuándo cerrar: no se acepta (evita apuestas con el juego ya empezado).
  var t = m.startAt ? Date.parse(m.startAt) : NaN;
  if (isNaN(t)) return true;
  if (Date.now() >= t) return true;
  return false;
}
// Índice "Visitante @ Local" -> partido. Si hay dos con los mismos equipos
// (serie, doble cartelera), gana el que todavía no ha terminado.
function indexMatches(list) {
  var byKey = {};
  (Array.isArray(list) ? list : []).forEach(function (m) {
    var k = matchKey(m.away, m.home), cur = byKey[k];
    if (!cur || (cur.finished && !m.finished) || (!!cur.finished === !!m.finished && Date.parse(m.startAt || 0) >= Date.parse(cur.startAt || 0))) byKey[k] = m;
  });
  return byKey;
}
// Para calificar: el partido al que pertenece una apuesta es el primero con esos
// equipos que empezó DESPUÉS de hecha la apuesta (nunca uno ya jugado antes).
// ---------- Medio tiempo / primeras 5 entradas / primer período ----------
// Marcador de esa parte del juego y si ya terminó.
function halfFromGame(sport, g) {
  if (!g) return null;
  if (sport === 'beisbol' || sport === 'lidom') {
    var inn = g.innings || []; if (!inn.length) return null;
    var cur = Number((g.sportDetail && g.sportDetail.inning) || 0), half = (g.sportDetail && g.sportDetail.half) || '';
    var five = inn.slice(0, 5), a = five.reduce(function (x, i) { return x + i.a; }, 0), h = five.reduce(function (x, i) { return x + i.h; }, 0);
    var done = g.state === 'post' ? inn.length >= 5 : (cur >= 6 || (cur === 5 && /end/i.test(half)));
    if (g.state === 'post' && inn.length < 5) return { away: a, home: h, done: true, voided: true }; // juego acortado
    return { away: a, home: h, done: !!done };
  }
  var la = g.lsAway || [], lh = g.lsHome || [], need = sport === 'nhl' ? 1 : 2;
  if (lh.length < need || la.length < need) return null;
  var sa = 0, sh = 0; for (var i = 0; i < need; i++) { sa += Number(la[i]) || 0; sh += Number(lh[i]) || 0; }
  var per = Number(g.period) || 0;
  // En el medio tiempo (o al terminar el período que cuenta) ya se sabe el resultado: se cierra sin esperar.
  var ended = (g.half && need === 2 && per >= 2) || (g.endPeriod && per >= need && g.state === 'in');
  return { away: sa, home: sh, done: g.state === 'post' || per > need || !!ended };
}
var HALF_RE = /^(Medio tiempo|Primeras 5 entradas|Primer período) — (.*)$/;
function gradeHalf(pick, m) {
  var mm = HALF_RE.exec(String(pick || '').trim()); if (!mm || !m || !m.halfScore || !m.halfScore.done) return null;
  var hs = m.halfScore, team = mm[2].trim();
  if (hs.voided || hs.away === hs.home) return 'push';
  var winner = hs.away > hs.home ? m.away : m.home;
  if (team !== m.away && team !== m.home) return null;
  return team === winner ? 'won' : 'lost';
}
function halfViewFor(createdAt, allByKey) {
  var bt = createdAt ? new Date(createdAt).getTime() : NaN, out = {};
  Object.keys(allByKey).forEach(function (k) {
    var list = allByKey[k], pick = null;
    if (list.length === 1 && !list[0].startAt) pick = list[0];
    else list.forEach(function (m) {
      var t = m.startAt ? Date.parse(m.startAt) : NaN;
      if (isNaN(t) || isNaN(bt) || t < bt - 60000) return;
      if (!pick || t < Date.parse(pick.startAt)) pick = m;
    });
    if (pick && pick.halfScore && pick.halfScore.done) out[k] = pick;
  });
  return out;
}
function finishedViewFor(createdAt, allByKey) {
  var bt = createdAt ? new Date(createdAt).getTime() : NaN;
  var out = {};
  Object.keys(allByKey).forEach(function (k) {
    var list = allByKey[k], pick = null;
    if (list.length === 1 && !list[0].startAt) pick = list[0];
    else {
      list.forEach(function (m) {
        var t = m.startAt ? Date.parse(m.startAt) : NaN;
        if (isNaN(t) || isNaN(bt) || t < bt - 60000) return;
        if (!pick || t < Date.parse(pick.startAt)) pick = m;
      });
    }
    if (pick && pick.finished) out[k] = pick;
  });
  return out;
}

// Decide el resultado de una selección de "Ganador" (moneyline).
function gradeWinner(pick, away, home, awayScore, homeScore) {
  if (awayScore === homeScore) return pick === 'Empate' ? 'won' : 'lost';
  var winnerName = awayScore > homeScore ? away : home;
  if (pick === 'Empate') return 'lost';
  return pick === winnerName ? 'won' : 'lost';
}

// pick es el número de línea tal como se guardó en el texto (ej. "-1.5" o "+1.5").
function gradeHandicap(pick, m, awayScore, homeScore) {
  // Formato nuevo: "Equipo +1.5" (el equipo y la línea van en la apuesta).
  var tp = /^(.*\S)\s+([+-]?\d+(?:\.\d+)?)$/.exec(String(pick || '').trim());
  if (tp && (tp[1] === m.away || tp[1] === m.home)) {
    var ln = parseFloat(tp[2]);
    var d = tp[1] === m.away ? (awayScore + ln) - homeScore : (homeScore + ln) - awayScore;
    if (d === 0) return 'push';
    return d > 0 ? 'won' : 'lost';
  }
  // Formato viejo: solo la línea ("-4.5"); el lado sale de la línea del partido.
  if (!m.handicap) return null;
  var pickNum = parseFloat(pick);
  var awayLine = Number(m.handicap.awayLine), homeLine = Number(m.handicap.homeLine);
  var isAway = Math.abs(pickNum - awayLine) < 0.001;
  var isHome = Math.abs(pickNum - homeLine) < 0.001;
  if (!isAway && !isHome) return null;
  var diff = isAway ? (awayScore + awayLine) - homeScore : (homeScore + homeLine) - awayScore;
  if (diff === 0) return 'push';
  return diff > 0 ? 'won' : 'lost';
}

// pick es "Más" o "Menos" (el lado de la apuesta de total).
function gradeTotal(side, m, awayScore, homeScore, pickLine) {
  // La línea es la que tenía la apuesta cuando se hizo (la del partido puede haber cambiado después).
  var line = pickLine > 0 ? pickLine : (m.total ? Number(m.total.line) : NaN);
  if (isNaN(line)) return null;
  var total = awayScore + homeScore;
  if (total === line) return 'push';
  if (side === 'over') return total > line ? 'won' : 'lost';
  if (side === 'under') return total < line ? 'won' : 'lost';
  return null;
}

// Intenta calificar UNA selección (de una apuesta sencilla o una pata de
// combinada) contra el mapa de partidos finalizados. Devuelve 'won',
// 'lost', 'push', o null si no se pudo calificar (partido no terminado,
// tipo de apuesta no soportado, etc).
function gradeSelection(mainType, away, home, pick, finishedByKey) {
  var m = finishedByKey[matchKey(away, home)];
  if (!m || !m.finished || !m.score) return null;
  var awayScore = Number(m.score.away), homeScore = Number(m.score.home);
  if (isNaN(awayScore) || isNaN(homeScore)) return null;
  if (mainType === 'Ganador') return gradeWinner(pick, away, home, awayScore, homeScore);
  if (mainType === 'Hándicap') return gradeHandicap(pick, m, awayScore, homeScore);
  if (mainType === 'Total') {
    var side = /^(Más|>)\s/.test(pick) ? 'over' : /^(Menos|<)\s/.test(pick) ? 'under' : null;
    if (!side) return null;
    var pl = /([\d.]+)\s*$/.exec(pick);
    return gradeTotal(side, m, awayScore, homeScore, pl ? parseFloat(pl[1]) : NaN);
  }
  return null;
}

// Califica una apuesta SENCILLA a partir de su desc_text/match_text tal
// como los guarda index.html.
function gradeSingleBet(descText, matchText, finishedByKey, statsByEventId) {
  var mm = /^(.*) @ (.*)$/.exec(matchText || '');
  if (!mm) return null;
  var away = mm[1], home = mm[2];
  var descBody = String(descText || '').replace(/\s*\([^)]*\)\s*$/, ''); // quita " (1.91)" del final
  if (/ — (Más|Menos) [\d.]+$/.test(descBody)) {
    var m = finishedByKey[matchKey(away, home)];
    if (!m || !m.finished || !m.espnEventId) return null;
    var stats = statsByEventId[m.espnEventId];
    if (!stats) return null;
    return gradePlayerProp(m, descBody, stats);
  }
  if (/^Hándicap /.test(descBody)) {
    return gradeSelection('Hándicap', away, home, descBody.replace(/^Hándicap /, ''), finishedByKey);
  }
  if (/^Más /.test(descBody) || /^Menos /.test(descBody)) {
    return gradeSelection('Total', away, home, descBody, finishedByKey);
  }
  if (descBody === away || descBody === home || descBody === 'Empate') {
    return gradeSelection('Ganador', away, home, descBody, finishedByKey);
  }
  return null; // medio tiempo u otro formato que no reconocemos: se deja pendiente
}

// Califica una apuesta COMBINADA: cada pata va como
// "main@@@pick@@@cuota" separada por " · ". Solo se califica cuando
// TODAS las patas tienen su partido finalizado.
// Resultado de cada jugada de una combinada (null = todavía no se sabe).
function gradeParlayLegs(matchText, finishedByKey, statsByEventId, halfByKey) {
  var legs = String(matchText || '').split(' · '), out = [];
  for (var i = 0; i < legs.length; i++) {
    var parts = legs[i].split('@@@');
    if (parts.length !== 3) { out.push(null); continue; }
    var main = parts[0], pick = parts[1], r = null;
    var tm = /^(Ganador|Hándicap|Total) (.*) vs (.*)$/.exec(main);
    if (tm) {
      if (/ — (Más|Menos) [\d.]+$/.test(pick)) {
        var m = finishedByKey[matchKey(tm[2], tm[3])];
        var st = m && m.finished && m.espnEventId ? statsByEventId[m.espnEventId] : null;
        if (st) r = gradePlayerProp(m, pick, st);
      } else if (HALF_RE.test(pick)) r = gradeHalf(pick, (halfByKey || {})[matchKey(tm[2], tm[3])]);
      else if (!/ — /.test(pick)) r = gradeSelection(tm[1], tm[2], tm[3], pick, finishedByKey);
    }
    out.push(r === undefined ? null : r);
  }
  return out;
}
function gradeParlayBet(matchText, finishedByKey, statsByEventId, halfByKey) {
  // Si ya se perdió una jugada, la combinada está perdida (no hay que esperar las demás).
  var lr = gradeParlayLegs(matchText, finishedByKey, statsByEventId, halfByKey);
  if (lr.some(function (r) { return r === 'lost'; })) return 'lost';
  var legs = String(matchText || '').split(' · ');
  var results = [], pushDiv = 1;
  for (var i = 0; i < legs.length; i++) {
    var parts = legs[i].split('@@@');
    if (parts.length !== 3) return null;
    var main = parts[0], pick = parts[1];
    var typeMatch = /^(Ganador|Hándicap|Total) (.*) vs (.*)$/.exec(main);
    if (!typeMatch) return null;
    var mainType = typeMatch[1], away = typeMatch[2], home = typeMatch[3];
    var result;
    if (/ — (Más|Menos) [\d.]+$/.test(pick)) {
      // Es una apuesta de lanzador, aunque el texto diga "Ganador" (así se
      // guardan las patas de lanzador dentro de una combinada).
      var m = finishedByKey[matchKey(away, home)];
      if (!m || !m.finished || !m.espnEventId) return null;
      var stats = statsByEventId[m.espnEventId];
      if (!stats) return null;
      result = gradePlayerProp(m, pick, stats);
    } else if (HALF_RE.test(pick)) {
      result = gradeHalf(pick, (halfByKey || {})[matchKey(away, home)]);
    } else if (/ — /.test(pick)) {
      return null;
    } else {
      result = gradeSelection(mainType, away, home, pick, finishedByKey);
    }
    if (result === null) return null; // esta pata aún no se puede calificar
    results.push(result);
    // Jugada anulada (no jugó / empate exacto): su cuota se quita del pago.
    if (result === 'push') { var od = parseFloat(parts[2]); if (od > 1) pushDiv *= od; }
  }
  if (results.some(function (r) { return r === 'lost'; })) return 'lost';
  if (results.every(function (r) { return r === 'push'; })) return 'push';
  // Ganó, pero con jugadas anuladas: se le paga sin las cuotas de esas jugadas.
  if (pushDiv > 1) return { won: true, div: pushDiv };
  return 'won';
}

// Trae los ponches (K) de cada lanzador de un juego de MLB ya terminado,
// usando el boxscore oficial de MLB (statsapi.mlb.com), con el gamePk
// que guardamos al detectar el partido. Devuelve un mapa
// "apellido en minúsculas" -> ponches, o {} si algo falla. El emparejamiento
// por apellido es una aproximación: si dos lanzadores del mismo juego
// comparten apellido, esto puede confundirse (muy poco común).
async function fetchPitcherStrikeouts(gamePk) {
  var out = {};
  try {
    var url = 'https://statsapi.mlb.com/api/v1/game/' + gamePk + '/boxscore';
    var res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36' } });
    if (!res.ok) return out;
    var data = await res.json();
    ['home', 'away'].forEach(function (side) {
      var team = data.teams && data.teams[side];
      var players = team ? team.players : null;
      if (!players) return;
      Object.keys(players).forEach(function (pid) {
        var p = players[pid];
        var so = p.stats && p.stats.pitching ? p.stats.pitching.strikeOuts : undefined;
        if (so === undefined || so === null || !p.person || !p.person.fullName) return;
        var surname = normTeam(String(p.person.fullName).trim().split(/\s+/).pop());
        var k = Number(so);
        if (!isNaN(k)) out[surname] = k;
      });
    });
  } catch (e) {
    // no pasa nada, esta apuesta se deja pendiente
  }
  return out;
}

// pick: "Nombre del jugador — Más 6.5" o "... — Menos 6.5"
function gradePitcherProp(pick, statsBySurname) {
  var m = /^(.*) — (Más|Menos) ([\d.]+)$/.exec(String(pick || ''));
  if (!m) return null;
  var playerLabel = m[1], side = m[2] === 'Más' ? 'over' : 'under', line = parseFloat(m[3]);
  // Solo se califican ponches; otra estadística (hits, carreras…) la decide el admin.
  var stm = /\(([^()]*)\)\s*$/.exec(playerLabel);
  if (stm && !/ponche|strikeout|^k$/i.test(stm[1].trim())) return null;
  var surname = normTeam(playerLabel.replace(/\s*\([^)]*\)\s*$/, '').trim().split(/\s+/).pop());
  var k = statsBySurname[surname];
  if (k === undefined) return null;
  if (k === line) return 'push';
  return side === 'over' ? (k > line ? 'won' : 'lost') : (k < line ? 'won' : 'lost');
}

// ---------- Apuestas de jugadores de la NBA ----------
// El texto de la apuesta es "J. Harden (Puntos) — Más 24.5". Se califica con
// el box score final del partido. Si el jugador no jugó, la apuesta se
// devuelve (push). Si no se encuentra al jugador, se deja pendiente.
var NBA_PROP_COL = { puntos: 'PTS', rebotes: 'REB', asistencias: 'AST', triples: '3PT', robos: 'STL', tapones: 'BLK' };
function nbaNameTokens(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z\s'-]/g, ' ').split(/\s+/)
    .filter(function (t) { return t && ['jr', 'sr', 'ii', 'iii', 'iv'].indexOf(t) < 0; });
}
function gradeNbaProp(pick, box) {
  if (!box || box.state !== 'post' || !box.teams) return null;
  var mm = /^(.*) — (Más|Menos) ([\d.]+)$/.exec(String(pick || ''));
  if (!mm) return null;
  var label = mm[1], side = mm[2] === 'Más' ? 'over' : 'under', line = parseFloat(mm[3]);
  var pm = /\(([^()]*)\)\s*$/.exec(label);
  if (!pm) return null;
  var col = NBA_PROP_COL[normTeam(pm[1])];
  if (!col) return null;
  var want = nbaNameTokens(label.replace(/\s*\([^)]*\)/g, ''));
  if (!want.length) return null;
  var surname = want[want.length - 1], initial = want.length > 1 ? want[0].charAt(0) : '';
  var found = [];
  box.teams.forEach(function (t) {
    (t.players || []).forEach(function (p) {
      var tk = nbaNameTokens(p.name);
      if (tk.length && tk[tk.length - 1] === surname) found.push({ p: p, t: t, first: tk.length > 1 ? tk[0].charAt(0) : '' });
    });
  });
  if (found.length > 1 && initial) found = found.filter(function (f) { return f.first === initial; });
  if (found.length !== 1) return null;
  var f = found[0];
  if (f.p.dnp) return 'push';
  var idx = (f.t.labels || []).indexOf(col);
  if (idx < 0) return null;
  var raw = String(f.p.stats[idx] || '');
  var val = col === '3PT' ? parseInt(raw.split('-')[0], 10) : parseFloat(raw);
  if (isNaN(val)) return null;
  if (val === line) return 'push';
  return side === 'over' ? (val > line ? 'won' : 'lost') : (val < line ? 'won' : 'lost');
}
function gradePlayerProp(m, pick, stats) {
  if (m.sport === 'baloncesto') return gradeNbaProp(pick, stats);
  if (m.sport === 'nfl' || m.sport === 'nhl') return gradeBoxProp(pick, stats);
  return gradePitcherProp(pick, stats);
}
// ---------- Jugadores de NFL y NHL ----------
// box = { state: 'post'|..., players: [{ name, stats: { 'Yardas pase': 245, ... } }] }
// Si el jugador no aparece en las estadísticas del juego terminado, no jugó: se devuelve.
function gradeBoxProp(pick, box) {
  if (!box || box.state !== 'post' || !box.players) return null;
  var mm = /^(.*) — (Más|Menos) ([\d.]+)$/.exec(String(pick || ''));
  if (!mm) return null;
  var pm = /\(([^()]*)\)\s*$/.exec(mm[1]); if (!pm) return null;
  var stat = pm[1].trim(), side = mm[2] === 'Más' ? 'over' : 'under', line = parseFloat(mm[3]);
  var want = nbaNameTokens(mm[1].replace(/\s*\([^)]*\)/g, '')); if (!want.length) return null;
  var surname = want[want.length - 1], initial = want.length > 1 ? want[0].charAt(0) : '';
  var found = box.players.filter(function (p) { var tk = nbaNameTokens(p.name); return tk.length && tk[tk.length - 1] === surname; });
  if (found.length > 1 && initial) found = found.filter(function (p) { var tk = nbaNameTokens(p.name); return tk.length > 1 && tk[0].charAt(0) === initial; });
  if (found.length > 1) return null;
  if (!found.length) return 'push';
  var v = found[0].stats[stat];
  if (v === undefined) v = box.zeroIfMissing ? 0 : undefined;
  if (v === undefined || isNaN(v)) return null;
  if (v === line) return 'push';
  return side === 'over' ? (v > line ? 'won' : 'lost') : (v < line ? 'won' : 'lost');
}
var propBoxCache = {};
async function cachedBox(key, fn) {
  var h = propBoxCache[key]; if (h && Date.now() - h.t < 60000) return h.v;
  var v = await fn(); propBoxCache[key] = { t: Date.now(), v: v }; return v;
}
// NFL: estadísticas finales de ESPN (pase, carrera, recepción).
async function fetchNflBox(eventId) { return cachedBox('nfl' + eventId, function () { return fetchNflBoxRaw(eventId); }); }
async function fetchNhlBox(gameId) { return cachedBox('nhl' + gameId, function () { return fetchNhlBoxRaw(gameId); }); }
async function fetchNflBoxRaw(eventId) {
  var res = await fetch('https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=' + encodeURIComponent(eventId), { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36' } });
  if (!res.ok) return null;
  var data = await res.json();
  var comp = data.header && data.header.competitions && data.header.competitions[0];
  var byName = {};
  ((data.boxscore && data.boxscore.players) || []).forEach(function (tp) {
    (tp.statistics || []).forEach(function (cat) {
      var labels = cat.labels || [], iY = labels.indexOf('YDS'), iR = labels.indexOf('REC');
      var map = cat.name === 'passing' ? { 'Yardas pase': iY } : cat.name === 'rushing' ? { 'Yardas carrera': iY } : cat.name === 'receiving' ? { 'Yardas recepción': iY, 'Recepciones': iR } : null;
      if (!map) return;
      (cat.athletes || []).forEach(function (a) {
        var nm = String((a.athlete && (a.athlete.displayName || a.athlete.shortName)) || ''); if (!nm) return;
        var p = byName[nm] = byName[nm] || { name: nm, stats: {} };
        Object.keys(map).forEach(function (k) { var i = map[k]; if (i >= 0) { var v = parseInt(String((a.stats || [])[i] || ''), 10); if (!isNaN(v)) p.stats[k] = v; } });
      });
    });
  });
  // En la NFL, quien jugó pero no tuvo jugadas de ese tipo no sale en esa tabla: cuenta como 0.
  return { state: comp && comp.status && comp.status.type ? (comp.status.type.completed === false && comp.status.type.state === 'post' ? 'pre' : comp.status.type.state) : '', players: Object.keys(byName).map(function (k) { return byName[k]; }), zeroIfMissing: true };
}
// NHL: estadísticas finales de la API oficial de la NHL.
async function fetchNhlBoxRaw(gameId) {
  var res = await fetch('https://api-web.nhle.com/v1/gamecenter/' + encodeURIComponent(gameId) + '/boxscore', { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36' } });
  if (!res.ok) return null;
  var data = await res.json(), players = [];
  var pbg = data.playerByGameStats || {};
  ['awayTeam', 'homeTeam'].forEach(function (side) {
    var t = pbg[side] || {};
    (t.forwards || []).concat(t.defense || []).forEach(function (p) {
      var nm = p.name && (p.name.default || p.name); if (!nm) return;
      players.push({ name: String(nm), stats: { 'Goles': Number(p.goals) || 0, 'Asistencias': Number(p.assists) || 0, 'Puntos': Number(p.points !== undefined ? p.points : (Number(p.goals) || 0) + (Number(p.assists) || 0)), 'Tiros al arco': Number(p.sog !== undefined ? p.sog : p.shots) || 0 } });
    });
    (t.goalies || []).forEach(function (p) {
      var nm = p.name && (p.name.default || p.name); if (!nm) return;
      var sv = p.saves !== undefined ? Number(p.saves) : parseInt(String(p.saveShotsAgainst || '').split('/')[0], 10);
      // Un portero que no entró a jugar no tiene tiempo en hielo: no cuenta (se devuelve).
      if (!p.toi || p.toi === '00:00') return;
      players.push({ name: String(nm), stats: { 'Atajadas': isNaN(sv) ? undefined : sv } });
    });
  });
  var gs = String(data.gameState || '');
  return { state: gs === 'OFF' || gs === 'FINAL' ? 'post' : gs === 'LIVE' || gs === 'CRIT' ? 'in' : 'pre', players: players };
}

async function settleBets() {
  try {
    const rows = await sql`SELECT value FROM app_state WHERE key = 'matches'`;
    var matches = rows[0] ? rows[0].value : [];
    if (typeof matches === 'string') {
      try { matches = JSON.parse(matches); } catch (e) { matches = []; }
    }
    if (!Array.isArray(matches)) return;
    var finishedByKey = {}, allByKey = {};
    matches.forEach(function (m) {
      var k = matchKey(m.away, m.home);
      (allByKey[k] = allByKey[k] || []).push(m);
      if (m.finished) finishedByKey[k] = m;
    });
    var anyHalf = matches.some(function (m) { return m.halfScore && m.halfScore.done; });
    if (Object.keys(finishedByKey).length === 0 && !anyHalf) return;

    const pending = await sql`SELECT id, user_id, desc_text, match_text, stake, payout, created_at, leg_results FROM bets WHERE status = 'pending' AND deleted_at IS NULL`;
    var anyPropPending = pending.some(function (b) { return / — (Más|Menos) [\d.]+/.test(b.desc_text || '') || / — (Más|Menos) [\d.]+/.test(b.match_text || ''); });

    // Solo pedimos el boxscore (ponches) si hay al menos una apuesta de
    // lanzador pendiente, y una vez por cada juego de MLB ya terminado.
    var statsByEventId = {};
    if (anyPropPending) {
      for (const key of Object.keys(finishedByKey)) {
        var fm = finishedByKey[key];
        if ((fm.sport === 'beisbol' || fm.sport === 'lidom') && fm.espnEventId) {
          statsByEventId[fm.espnEventId] = await fetchPitcherStrikeouts(fm.espnEventId);
        } else if (fm.sport === 'baloncesto' && fm.espnEventId) {
          try { statsByEventId[fm.espnEventId] = await fetchNbaBoxscore(fm.espnEventId); } catch (e) {}
        } else if (fm.sport === 'nfl' && fm.espnEventId) {
          try { statsByEventId[fm.espnEventId] = await fetchNflBox(fm.espnEventId); } catch (e) {}
        } else if (fm.sport === 'nhl' && fm.espnEventId) {
          try { statsByEventId[fm.espnEventId] = await fetchNhlBox(fm.espnEventId); } catch (e) {}
        }
      }
    }

    for (const b of pending) {
      var isParlay = /^Combinada/i.test(b.desc_text || '');
      var fk = finishedViewFor(b.created_at, allByKey); // solo el juego que empezó después de la apuesta
      var hk = halfViewFor(b.created_at, allByKey);
      var sDesc = String(b.desc_text || '').replace(/\s*\([\d.]+\)\s*$/, ''), smm = /^(.*) @ (.*)$/.exec(b.match_text || '');
      if (isParlay) {
        // Se guarda cuál jugada ganó y cuál perdió, para marcarlas en el ticket.
        var legRes = gradeParlayLegs(b.match_text, fk, statsByEventId, hk);
        var prevLr = b.leg_results; if (typeof prevLr === 'string') { try { prevLr = JSON.parse(prevLr); } catch (e) { prevLr = null; } }
        if (JSON.stringify(legRes) !== JSON.stringify(prevLr || null) && legRes.some(function (r) { return r !== null; })) {
          try { await sql`UPDATE bets SET leg_results = ${JSON.stringify(legRes)}::jsonb WHERE id = ${b.id}`; } catch (e) {}
        }
      }
      var result = isParlay
        ? gradeParlayBet(b.match_text, fk, statsByEventId, hk)
        : HALF_RE.test(sDesc) ? (smm ? gradeHalf(sDesc, hk[matchKey(smm[1], smm[2])]) : null)
        : gradeSingleBet(b.desc_text, b.match_text, fk, statsByEventId);
      if (result === null) continue; // todavía no se puede calificar

      // "AND status = 'pending'" evita pagar dos veces si la apuesta ya se cobró (cash out).
      if (result === 'push') {
        var vr = await sql`UPDATE bets SET status = 'void' WHERE id = ${b.id} AND status = 'pending' RETURNING id`;
        if (vr[0]) await sql`UPDATE users SET balance = balance + ${Number(b.stake)} WHERE id = ${b.user_id}`;
      } else if (result === 'won' || (result && result.won)) {
        var pay = Number(b.payout);
        if (result.div) pay = Math.max(Number(b.stake), Math.round(pay / result.div * 100) / 100);
        var wr = await sql`UPDATE bets SET status = 'won', payout = ${pay} WHERE id = ${b.id} AND status = 'pending' RETURNING id`;
        if (wr[0]) await sql`UPDATE users SET balance = balance + ${pay} WHERE id = ${b.user_id}`;
      } else {
        await sql`UPDATE bets SET status = 'lost' WHERE id = ${b.id} AND status = 'pending'`;
      }
    }
  } catch (e) {
    // No tumbamos el servidor por un fallo al calificar apuestas.
  }
}

// Con juegos en vivo el marcador se trae cada 7 segundos; sin juegos, cada 20.
var tickBusy = false, lastSettle = 0, tickStart = 0;
async function tick() {
  // Si una revisión lleva más de 90 segundos, se da por perdida y se empieza otra.
  if (tickBusy && Date.now() - tickStart < 90000) return;
  tickStart = Date.now();
  if (!anyLiveNow && Date.now() - lastLiveUpdate < 20000) return;
  tickBusy = true;
  try {
    await updateLiveScores();
    if (Date.now() - lastSettle >= 20000) { lastSettle = Date.now(); await settleBets(); }
  } finally { tickBusy = false; }
}
setInterval(tick, 7000);
tick();

// ---------- Cuotas automáticas (OddsPapi / PokerStars) ----------
// Los juegos traídos con "Traer juegos" (m.auto) se re-cotizan solos antes de
// empezar. Las consultas se reparten para no pasarse del plan del mes.
function decToAm(d) {
  d = Number(d); if (!(d > 1)) return null;
  var n = d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1));
  return (n > 0 ? '+' : '') + n;
}
// Margen de la casa por pares (como PokerStars): se quita el margen de la fuente,
// se reparte el margen de la casa igual en los dos lados (el underdog baja más)
// y nunca se paga más que la fuente.
function marginPair(a, b, pc) {
  a = Number(a); b = Number(b);
  if (!(a > 1) || !(b > 1)) return [a > 1 ? cutDec(a, pc) : a, b > 1 ? cutDec(b, pc) : b];
  var ia = 1 / a, ib = 1 / b, s = ia + ib, m = Math.max(0, Number(pc) || 0) / 100;
  var f = function (p, src) { var q = p / s + m / 2; var d = q >= 0.99 ? 1.01 : 1 / q; d = Math.min(d, src); return Math.max(1.01, Math.floor(d * 100 + 1e-9) / 100); };
  return [f(ia, a), f(ib, b)];
}
function cutDec(d, pc) { return Math.max(1.01, Math.round((1 + (Number(d) - 1) * (1 - pc / 100)) * 100) / 100); }
var autoBusy = false, autoLastCheck = 0;
const AUTO_RESERVE = 25; // consultas que se guardan para cuando el admin busca juegos
async function papiUsedThisMonth() {
  const r = await sql`SELECT value FROM app_state WHERE key = 'papi_usage'`;
  var v = r[0] ? r[0].value : null; if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { v = null; } }
  return v && v.month === new Date().toISOString().slice(0, 7) ? Number(v.count) || 0 : 0;
}
// Aplica las cuotas nuevas de PokerStars (g.odds, en decimal) a un partido. Devuelve true si algo cambió.
function applyAutoOdds(m, o) {
  var pc = o.ps ? 0 : Math.min(20, Math.max(0, Number(m.auto && m.auto.cut) || 0)), ch = false;
  var A2 = function (a, b) { var r = marginPair(a, b, pc); return [decToAm(r[0]), decToAm(r[1])]; };
  // Jugadores: si vienen de PokerStars van tal cual; si vienen de DraftKings llevan el %.
  var pcP = o.propsPs ? 0 : Math.min(20, Math.max(0, Number(m.auto && m.auto.cut) || 0));
  var A2P = function (a, b) { var r = marginPair(a, b, pcP); return [decToAm(r[0]), decToAm(r[1])]; };
  var set = function (obj, k, v) { if (v !== null && v !== undefined && String(obj[k]) !== String(v)) { obj[k] = v; ch = true; } };
  var r;
  if (o.home > 1 && o.away > 1 && m.odds) { r = A2(o.home, o.away); if (m.odds[0]) set(m.odds[0], 'v', r[0]); if (m.odds[2]) set(m.odds[2], 'v', r[1]); }
  if (o.hcap && m.handicap) { r = A2(o.hcap.homeOdds, o.hcap.awayOdds); set(m.handicap, 'homeLine', o.hcap.homeLine); set(m.handicap, 'awayLine', o.hcap.awayLine); set(m.handicap, 'homeOdds', r[0]); set(m.handicap, 'awayOdds', r[1]); }
  if (o.half && m.halftime) { r = A2(o.half.home, o.half.away); set(m.halftime, 'home', r[0]); set(m.halftime, 'away', r[1]); }
  if (o.total && m.total) { r = A2(o.total.over, o.total.under); set(m.total, 'line', o.total.line); set(m.total, 'over', r[0]); set(m.total, 'under', r[1]); }
  // Jugadores solo en NBA y béisbol (MLB / LIDOM). NFL y NHL: solo juego y medio tiempo.
  if (!PROPS_SPORTS[m.sport]) { if (m.props && m.props.length) { m.props = []; ch = true; } return ch; }
  if (o.props && o.props.length && (m.autoProps || m.autoAddedAt || m.auto) && aiPropsOn && !m.noAutoProps) {
    // Juego con jugadores puestos por la página: se ponen TODOS los que tienen apuesta hoy
    // (entran los nuevos, se quitan los que ya no salen) y las cuotas se actualizan.
    var all = aiPickProps(o.props, pcP);
    if (all.length && JSON.stringify(all) !== JSON.stringify(m.props || [])) { m.props = all; m.autoProps = true; ch = true; }
  } else if (o.props && o.props.length && m.props && m.props.length) {
    // Si PokerStars quitó a un jugador (lesión, no juega), se quita también aquí para que no le apuesten.
    var keep = m.props.filter(function (p) {
      var np = o.props.find(function (x) { return x.player === p.player && x.stat === p.stat; });
      if (!np) return false;
      var rp = A2P(np.over, np.under); set(p, 'line', np.line); set(p, 'over', rp[0]); set(p, 'under', rp[1]);
      return true;
    });
    if (keep.length !== m.props.length) { m.props = keep; ch = true; }
  } else if (o.props && o.props.length && !m.props && !m.noAutoProps && aiPropsOn) {
    // Juego con cuotas automáticas y sin jugadores: si la fuente ya los trae, se le ponen.
    var pk = aiPickProps(o.props, pcP); if (pk.length) { m.props = pk; m.autoProps = true; ch = true; }
  }
  return ch;
}
// Botón del admin: revisar cuotas y jugadores ya mismo (sin esperar el turno).
async function autoOddsNow() {
  try {
    const lr = await sql`SELECT value FROM app_state WHERE key = 'papi_auto'`;
    var last = lr[0] ? lr[0].value : {}; if (typeof last === 'string') { try { last = JSON.parse(last); } catch (e) { last = {}; } }
    last = last || {};
    Object.keys(last).forEach(function (k) { if (/^sgo_|^toab_/.test(k)) delete last[k]; });
    await sql`INSERT INTO app_state (key, value) VALUES ('papi_auto', ${JSON.stringify(last)}::jsonb) ON CONFLICT (key) DO UPDATE SET value = ${JSON.stringify(last)}::jsonb`;
  } catch (e) {}
  for (var i = 0; i < 20 && autoBusy; i++) await new Promise(function (r) { setTimeout(r, 1000); });
  autoLastCheck = 0;
  await autoOdds();
}
async function autoOdds() {
  if (autoBusy || !((PAPI_ENABLED && Bun.env.ODDSPAPI_KEY) || Bun.env.SPORTSGAMEODDS_KEY || Bun.env.APISPORTS_KEY || Bun.env.THE_ODDS_API_KEY) || Date.now() - autoLastCheck < 60000) return;
  autoBusy = true; autoLastCheck = Date.now();
  try {
    const rows = await sql`SELECT value FROM app_state WHERE key = 'matches'`;
    var list = rows[0] ? rows[0].value : []; if (typeof list === 'string') { try { list = JSON.parse(list); } catch (e) { list = []; } }
    if (!Array.isArray(list)) return;
    var now = Date.now();
    var due = list.filter(function (m) {
      var t = m.startAt ? Date.parse(m.startAt) : NaN;
      return m.auto && (PAPI_SPORT[m.sport] || APIS_HOST[m.sport] || TOA_SPORT[m.sport]) && !m.live && !m.finished && t - now > 5 * 60000 && t - now < 24 * 3600000;
    });
    if (!due.length) return;
    var sports = Array.from(new Set(due.map(function (m) { return m.sport; })));
    // Presupuesto: lo que queda del mes (menos la reserva) repartido entre los días que faltan.
    var limit = Number(Bun.env.ODDSPAPI_LIMIT) || 250;
    var left = limit - (await papiUsedThisMonth()) - AUTO_RESERVE;
    if (left <= 0 && !Bun.env.SPORTSGAMEODDS_KEY && !Bun.env.APISPORTS_KEY && !Bun.env.THE_ODDS_API_KEY) return;
    var d = new Date(), daysLeft = new Date(d.getUTCFullYear(), d.getUTCMonth() + 1, 0).getDate() - d.getUTCDate() + 1;
    var perDay = Math.max(1, left / daysLeft);
    // Cada liga se refresca cada tanto, según cuántas ligas haya hoy (mín. 45 min, máx. 6 h).
    var every = Math.min(6 * 3600000, Math.max(45 * 60000, (16 * 3600000 * sports.length) / perDay));
    const lr = await sql`SELECT value FROM app_state WHERE key = 'papi_auto'`;
    var last = lr[0] ? lr[0].value : {}; if (typeof last === 'string') { try { last = JSON.parse(last); } catch (e) { last = {}; } }
    last = last || {};
    // SportsGameOdds: lo que queda del mes (menos 300 de reserva) entre los días que faltan;
    // cada revisión gasta 1 por juego.
    var sgoLeft = Bun.env.SPORTSGAMEODDS_KEY ? (Number(Bun.env.SGO_LIMIT) || 2500) - (await sgoUsedThisMonth()) - 300 : 0;
    var sgoEvery = sgoLeft > 0 ? Math.min(6 * 3600000, Math.max(30 * 60000, (16 * 3600000 * due.length) / Math.max(1, sgoLeft / daysLeft))) : Infinity;
    var changedById = {};
    for (const sp of sports) {
      var sgoDue = !!(Bun.env.SPORTSGAMEODDS_KEY && SGO_LEAGUE[sp] && now - (Number(last['sgo_' + sp]) || 0) >= sgoEvery);
      var papiDue = PAPI_ENABLED && left > 0 && now - (Number(last[sp]) || 0) >= every;
      var apisDue = !!(Bun.env.APISPORTS_KEY && APIS_HOST[sp] && now - (Number(last['apis_' + sp]) || 0) >= 3 * 3600000);
      // The Odds API con plan pagado: refresca cuotas y jugadores cada 3 horas.
      var toaDue = !!(Bun.env.THE_ODDS_API_KEY && TOA_SPORT[sp] && toaBig() && Number(toaLast.remaining) > 1500 && now - (Number(last['toab_' + sp]) || 0) >= 3 * 3600000);
      if (!sgoDue && !papiDue && !apisDue && !toaDue && !Bun.env.THE_ODDS_API_KEY) continue;
      var games = due.filter(function (m) { return m.sport === sp; }).map(function (m) { return { id: m.id, away: m.away, home: m.home, startAt: m.startAt }; });
      if (apisDue) {
        last['apis_' + sp] = now;
        try { await apisFill(sp, '', games); } catch (e) {}
      }
      if (papiDue && games.some(function (g) { return !g.odds; })) { last[sp] = now; await addPapiOdds(sp, new Date().toISOString().slice(0, 10), games); }
      if (sgoDue && games.some(function (g) { return !g.odds || (g.odds.ps && !g.odds.props); })) {
        last['sgo_' + sp] = now;
        // Si falló (clave, error de la fuente), se vuelve a intentar en 15 minutos y no en horas.
        try { var sr = await sgoFill(sp, '', games); if (sr && sr.msg) last['sgo_' + sp] = now - sgoEvery + 15 * 60000; } catch (e) { last['sgo_' + sp] = now - sgoEvery + 15 * 60000; }
      }
      if (toaDue) {
        last['toab_' + sp] = now; last['toa_' + sp] = now;
        try { await toaFill(sp, games, true); } catch (e) {}
      } else if (Bun.env.THE_ODDS_API_KEY && !toaBig() && now - (Number(last['toa_' + sp]) || 0) > 20 * 3600000 && !(toaLast.remaining !== null && toaLast.remaining < 150)) {
        // Plan gratis: 1 vez al día por deporte, y se guardan 150 créditos para "Traer juegos".
        last['toa_' + sp] = now;
        try { await toaFill(sp, games, true); } catch (e) {}
      }
      games.forEach(function (g) { if (g.odds) changedById[g.id] = g.odds; });
    }
    await sql`INSERT INTO app_state (key, value) VALUES ('papi_auto', ${JSON.stringify(last)}::jsonb)
      ON CONFLICT (key) DO UPDATE SET value = ${JSON.stringify(last)}::jsonb`;
    if (!Object.keys(changedById).length) return;
    // Se relee la lista justo antes de guardar y solo se tocan las cuotas.
    const fr = await sql`SELECT value FROM app_state WHERE key = 'matches'`;
    var fresh = fr[0] ? fr[0].value : []; if (typeof fresh === 'string') { try { fresh = JSON.parse(fresh); } catch (e) { fresh = []; } }
    var any = false;
    fresh.forEach(function (m) {
      var o = changedById[m.id];
      if (!o || !m.auto || m.live || m.finished) return;
      if (applyAutoOdds(m, o)) any = true;
      m.auto.at = now;
    });
    await sql`INSERT INTO app_state (key, value) VALUES ('matches', ${JSON.stringify(fresh)}::jsonb)
      ON CONFLICT (key) DO UPDATE SET value = ${JSON.stringify(fresh)}::jsonb`;
  } catch (e) {
  } finally { autoBusy = false; }
}
setInterval(autoOdds, 60000);

// ---------- Juegos del día solos ----------
// Cada mañana (hora de Puerto Rico) la página agrega sola los juegos del día con sus cuotas
// (ganador, hándicap, total y medio tiempo). Los que todavía no tienen cuotas se vuelven a
// buscar 4 y 8 horas después. Los juegos quedan con "cuotas automáticas", así que también cambian solas.
const AI_SPORTS = ['baloncesto', 'nfl', 'nhl', 'beisbol', 'lidom'];
const AI_LABEL = { beisbol: 'Béisbol', lidom: 'LIDOM', baloncesto: 'Baloncesto', nfl: 'NFL', nhl: 'NHL' };
var aiPropsOn = true;
async function aiSettings() {
  const r = await sql`SELECT value FROM app_state WHERE key = 'auto_import'`;
  var v = r[0] ? r[0].value : null; if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { v = null; } }
  v = v || {};
  aiPropsOn = v.props === undefined ? true : !!v.props;
  var spd = Object.assign({ baloncesto: true, nfl: true, nhl: true, beisbol: true, lidom: true }, v.sports || {});
  return { on: !!v.on, props: v.props === undefined ? true : !!v.props, sports: spd, cut: v.cut === undefined ? 9 : Number(v.cut), hour: v.hour === undefined ? 9 : Number(v.hour), days: v.days === undefined ? 1 : Math.min(3, Math.max(1, Number(v.days) || 1)), last: v.last || {}, log: v.log || [] };
}
function addDaysYmd(ymd, n) { var d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
async function aiSave(v) {
  await sql`INSERT INTO app_state (key, value) VALUES ('auto_import', ${JSON.stringify(v)}::jsonb) ON CONFLICT (key) DO UPDATE SET value = ${JSON.stringify(v)}::jsonb`;
}
function prParts(d) {
  var f = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Puerto_Rico', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
  var o = {}; f.forEach(function (p) { o[p.type] = p.value; });
  return { ymd: o.year + '-' + o.month + '-' + o.day, hm: (o.hour === '24' ? '00' : o.hour) + ':' + o.minute, hour: Number(o.hour) % 24 };
}
function aiTimeLabel(iso) {
  var d = new Date(iso), p = prParts(d), t = prParts(new Date()), tm = prParts(new Date(Date.now() + 864e5));
  var day = p.ymd === t.ymd ? 'Hoy' : p.ymd === tm.ymd ? 'Mañana' : new Intl.DateTimeFormat('es-DO', { timeZone: 'America/Puerto_Rico', weekday: 'short', day: 'numeric', month: 'short' }).format(d);
  return day + ' ' + new Intl.DateTimeFormat('es-DO', { timeZone: 'America/Puerto_Rico', hour: 'numeric', minute: '2-digit', hour12: true }).format(d);
}
function aiBuildMatch(sport, g, cut, i, props) {
  var o = g.odds, pc = o.ps ? 0 : cut;
  var P = function (a, b) { var r = marginPair(a, b, pc); return [decToAm(r[0]), decToAm(r[1])]; };
  var ml = P(o.home, o.away); if (!ml[0] || !ml[1]) return null;
  var p = prParts(new Date(g.startAt));
  var m = { id: 'm' + Date.now() + 'a' + i, sport: sport, sportLabel: AI_LABEL[sport], time: aiTimeLabel(g.startAt), live: false,
    startAt: p.ymd + 'T' + p.hm + ':00-04:00', home: g.home, away: g.away,
    odds: [{ k: 'Local', v: ml[0] }, { k: 'Empate', v: null }, { k: 'Visitante', v: ml[1] }],
    auto: { cut: cut, at: Date.now() }, autoAddedAt: Date.now() };
  var r;
  if (o.hcap) { r = P(o.hcap.homeOdds, o.hcap.awayOdds); if (r[0] && r[1]) m.handicap = { homeLine: o.hcap.homeLine, homeOdds: r[0], awayLine: o.hcap.awayLine, awayOdds: r[1] }; }
  if (o.half) { r = P(o.half.home, o.half.away); if (r[0] && r[1]) m.halftime = { home: r[0], away: r[1] }; }
  if (o.total) { r = P(o.total.over, o.total.under); if (r[0] && r[1]) m.total = { line: o.total.line, over: r[0], under: r[1] }; }
  if (props && PROPS_SPORTS[sport] && o.props && o.props.length) { var pk = aiPickProps(o.props, o.propsPs ? 0 : cut); if (pk.length) { m.props = pk; m.autoProps = true; } }
  return m;
}
// Jugadores: los principales de cada estadística (los de línea más alta son las estrellas).
// Todos los jugadores que tienen apuesta ese día: por jugador y estadística, la línea más pareja
// (la principal). Se saltan las líneas casi imposibles (ej. 1.5 goles a 21.00).
const PROPS_SPORTS = { baloncesto: true, beisbol: true, lidom: true };
function aiPickProps(list, cut) {
  var ORD = ['Puntos', 'Rebotes', 'Asistencias', 'Triples', 'Pts+Reb+Ast', 'Robos', 'Tapones', 'Yardas pase', 'Pases completos', 'TD pase', 'Yardas carrera', 'Yardas recepción', 'Recepciones', 'Goles', 'Tiros al arco', 'Atajadas', 'Ponches'];
  var best = {};
  list.forEach(function (pr) {
    var lo = Math.min(pr.over, pr.under), hi = Math.max(pr.over, pr.under);
    if (!(lo >= 1.3 && hi <= 4)) return;
    var sk = pr.player + '|' + pr.stat, cur = best[sk];
    if (!cur || Math.abs(pr.over - pr.under) < Math.abs(cur.over - cur.under)) best[sk] = pr;
  });
  var picked = [];
  Object.keys(best).forEach(function (k) {
    var pr = best[k], rp = marginPair(pr.over, pr.under, cut), ov = decToAm(rp[0]), un = decToAm(rp[1]);
    if (ov && un) picked.push({ player: pr.player, stat: pr.stat, line: pr.line, over: ov, under: un });
  });
  var oi = function (st) { var i = ORD.indexOf(st); return i < 0 ? 99 : i; };
  picked.sort(function (a, b) { return (oi(a.stat) - oi(b.stat)) || (b.line - a.line); });
  return picked.slice(0, 120);
}
async function aiFillOdds(sport, date, games, firstRun) {
  try { await apisFill(sport, date, games); } catch (e) {}
  if (games.some(function (g) { return !g.odds; })) { try { await addPapiOdds(sport, date, games); } catch (e) {} }
  if (games.some(function (g) { return !g.odds; })) { try { await sgoFill(sport, date, games); } catch (e) {} }
  // The Odds API gratis: solo en la primera búsqueda del día (gasta 3 créditos por deporte).
  if (games.some(function (g) { return !g.odds; }) && (firstRun || toaBig()) && !(toaLast.remaining !== null && toaLast.remaining < 150)) { try { await toaFill(sport, games); } catch (e) {} }
}
var aiBusy = false;
async function runAutoImport(force) {
  if (aiBusy) return { added: 0 };
  aiBusy = true;
  var total = 0, detail = [];
  try {
    var S = await aiSettings();
    if (!S.on && !force) return { added: 0 };
    var now = prParts(new Date());
    if (!force && now.hour < S.hour) return { added: 0 };
    // Días por adelantado: 1 = solo hoy, 2 = hoy y mañana, 3 = hasta pasado mañana.
    var nDays = S.days || 1;
    for (var dOff = 0; dOff < nDays; dOff++) {
    var ymd = addDaysYmd(now.ymd, dOff);
    for (const sp of AI_SPORTS) {
      if (!S.sports[sp]) continue;
      var key = sp + '|' + ymd, L = S.last[key] || { runs: 0, at: 0 };
      // 1ª búsqueda a la hora escogida; 2ª y 3ª, 4 y 8 horas después (solo si faltaron cuotas).
      // Lo que se trae con el botón ("ahora") no cuenta: la de la hora escogida igual se hace.
      var sr = Number(L.sched) || 0;
      if (!force && (sr >= 3 || (sr > 0 && ((!L.missing && !L.pend) || Date.now() - L.at < 4 * 3600e3)) || (dOff === 0 && now.hour >= 22))) continue;
      var games = [];
      try { games = await fetchSchedule(sp, ymd); } catch (e) { games = []; }
      games = games.filter(function (g) { return g.startAt && Date.parse(g.startAt) > Date.now() + 10 * 60e3; });
      const rows = await sql`SELECT value FROM app_state WHERE key = 'matches'`;
      var list = rows[0] ? rows[0].value : []; if (typeof list === 'string') { try { list = JSON.parse(list); } catch (e) { list = []; } }
      if (!Array.isArray(list)) list = [];
      var same = function (m, g) { return m.sport === sp && ((m.away === g.away && m.home === g.home) || (m.away === g.home && m.home === g.away)) && m.startAt && Math.abs(Date.parse(m.startAt) - Date.parse(g.startAt)) < 12 * 3600e3; };
      var hasOdds = function (m) { var o = m.odds || []; return !!(o[0] && o[0].v && o[2] && o[2].v); };
      // Ya está con cuotas: no se toca. Si está como borrador puesto por la página (sin cuotas), se le buscan cuotas otra vez.
      var exists = function (g) { return list.some(function (m) { return same(m, g) && (hasOdds(m) || !m.draftAuto); }); };
      var draftOf = function (g) { return list.find(function (m) { return same(m, g) && m.draftAuto && !hasOdds(m); }); };
      var need = games.filter(function (g) { return !exists(g); });
      // LIDOM: si el borrador entró sin abridores y ya los anunciaron, se le ponen los ponches.
      if (sp === 'lidom') {
        var upd = false;
        games.forEach(function (g) {
          var m = list.find(function (x) { return x.sport === 'lidom' && x.draftAuto && x.away === g.away && x.home === g.home && Math.abs(Date.parse(x.startAt) - Date.parse(g.startAt)) < 12 * 3600e3; });
          if (!m || (m.props && m.props.length) || !(g.awayPitcher || g.homePitcher)) return;
          m.props = [];
          if (g.awayPitcher) m.props.push({ player: g.awayPitcher, stat: 'Ponches', line: 4.5, over: null, under: null });
          if (g.homePitcher) m.props.push({ player: g.homePitcher, stat: 'Ponches', line: 4.5, over: null, under: null });
          upd = true;
        });
        if (upd) await sql`INSERT INTO app_state (key, value) VALUES ('matches', ${JSON.stringify(list)}::jsonb) ON CONFLICT (key) DO UPDATE SET value = ${JSON.stringify(list)}::jsonb`;
      }
      if (need.length) await aiFillOdds(sp, ymd, need, sr === 0 || force);
      var add = [];
      var upgrade = [];
      need.forEach(function (g, i) {
        var dr = draftOf(g);
        if (g.odds) { var m = aiBuildMatch(sp, g, Math.min(20, Math.max(0, S.cut)), i, S.props); if (m) {
          if (dr) { m.id = dr.id; if (!m.props && dr.props) m.props = dr.props; if (dr.pitchers) m.pitchers = dr.pitchers; upgrade.push(m); } else add.push(m); return; } }
        if (dr) return;
        // Sin cuotas todavía: entra como borrador. En la página sale con "Cuotas no disponibles aún".
        if (sp !== 'lidom') {
          var p0 = prParts(new Date(g.startAt));
          add.push({ id: 'm' + Date.now() + 'd' + i, sport: sp, sportLabel: AI_LABEL[sp], time: aiTimeLabel(g.startAt), live: false,
            startAt: p0.ymd + 'T' + p0.hm + ':00-04:00', home: g.home, away: g.away,
            odds: [{ k: 'Local', v: null }, { k: 'Empate', v: null }, { k: 'Visitante', v: null }], autoAddedAt: Date.now(), draftAuto: true });
          return;
        }
        // LIDOM sin cuotas: entra como borrador para que solo le pongas las cuotas.
        if (sp === 'lidom') {
          var p = prParts(new Date(g.startAt));
          var d = { id: 'm' + Date.now() + 'd' + i, sport: sp, sportLabel: AI_LABEL[sp], time: aiTimeLabel(g.startAt), live: false,
            startAt: p.ymd + 'T' + p.hm + ':00-04:00', home: g.home, away: g.away,
            odds: [{ k: 'Local', v: null }, { k: 'Empate', v: null }, { k: 'Visitante', v: null }], autoAddedAt: Date.now(), draftAuto: true };
          if (g.awayPitcher || g.homePitcher) d.pitchers = { away: g.awayPitcher || null, home: g.homePitcher || null };
          // Ponches de los abridores ya puestos: solo falta escribir la línea y las cuotas.
          var pp = [];
          if (g.awayPitcher) pp.push({ player: g.awayPitcher, stat: 'Ponches', line: 4.5, over: null, under: null });
          if (g.homePitcher) pp.push({ player: g.homePitcher, stat: 'Ponches', line: 4.5, over: null, under: null });
          if (pp.length) d.props = pp;
          add.push(d);
        }
      });
      if (add.length || upgrade.length) {
        // Se relee justo antes de guardar para no pisar lo que el admin cambió.
        const fr = await sql`SELECT value FROM app_state WHERE key = 'matches'`;
        var fresh = fr[0] ? fr[0].value : []; if (typeof fresh === 'string') { try { fresh = JSON.parse(fresh); } catch (e) { fresh = []; } }
        if (!Array.isArray(fresh)) fresh = [];
        add = add.filter(function (m) { return !fresh.some(function (x) { return x.sport === m.sport && x.away === m.away && x.home === m.home && x.startAt && Math.abs(Date.parse(x.startAt) - Date.parse(m.startAt)) < 12 * 3600e3; }); });
        var upd2 = 0;
        upgrade.forEach(function (m) {
          var ix = fresh.findIndex(function (x) { return x.id === m.id; });
          var cur = fresh[ix];
          // Solo si sigue siendo borrador sin cuotas (el admin no lo tocó).
          if (ix >= 0 && cur.draftAuto && !hasOdds(cur)) { fresh[ix] = m; upd2++; }
        });
        if (add.length || upd2) {
          fresh = fresh.concat(add);
          await sql`INSERT INTO app_state (key, value) VALUES ('matches', ${JSON.stringify(fresh)}::jsonb) ON CONFLICT (key) DO UPDATE SET value = ${JSON.stringify(fresh)}::jsonb`;
        }
      }
      // LIDOM también se vuelve a buscar más tarde: PokerStars saca su línea en la tarde.
      var missing = need.filter(function (g) { return !g.odds; }).length;
      var drafts = add.filter(function (m) { return m.draftAuto; }).length;
      add = add.concat(upgrade);
      S = await aiSettings();
      var pend = sp === 'lidom' ? games.filter(function (g) { return !(g.awayPitcher && g.homePitcher); }).length : 0;
      S.last[key] = { runs: (L.runs || 0) + 1, sched: sr + (force ? 0 : 1), at: force ? (L.at || 0) : Date.now(), missing: missing, pend: pend };
      // Se guardan solo los últimos 3 días.
      Object.keys(S.last).forEach(function (k) { var d = k.split('|')[1]; if (d && Date.parse(d) < Date.now() - 3 * 864e5) delete S.last[k]; });
      S.log = [{ at: Date.now(), day: dOff, sport: sp, added: add.length - drafts, drafts: drafts, missing: missing, games: games.length, already: games.length - need.length }].concat(S.log || []).slice(0, 12);
      await aiSave({ on: S.on, props: S.props, sports: S.sports, cut: S.cut, hour: S.hour, days: S.days, last: S.last, log: S.log });
      total += add.length; detail.push({ sport: sp, day: dOff, added: add.length, missing: missing, games: games.length });
    }
    }
  } catch (e) { console.error('auto-import:', e && e.message); }
  finally { aiBusy = false; }
  return { added: total, detail: detail };
}
setInterval(function () { runAutoImport(false); }, 5 * 60000);

(async function () {
  try {
    const r0 = await sql`SELECT value FROM app_state WHERE key = 'matches'`;
    var l0 = r0[0] ? r0[0].value : []; if (typeof l0 === 'string') { try { l0 = JSON.parse(l0); } catch (e) { l0 = []; } }
    await saveResults(l0);
  } catch (e) {}
})();

const app = new Hono();

// ---------- Próximamente ----------
// Prendido: la gente ve "Próximamente" y no puede registrarse, entrar ni apostar.
// Tú (con la sesión del admin abierta en ese navegador) sigues viendo la página normal.
var comingSoon = true;
async function loadSoon() { try { const r = await sql`SELECT value FROM app_state WHERE key = 'coming_soon'`; var v = r[0] ? r[0].value : null; if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) {} } if (v !== null && v !== undefined) comingSoon = v === true || v === 'true'; } catch (e) {} }
await loadSoon(); setInterval(loadSoon, 30000);
app.use('/api/*', async (c, next) => {
  if (!comingSoon || isAdminReq(c) || c.req.method === 'GET') return next();
  var path = new URL(c.req.url).pathname;
  if (/^\/api\/(admin|stripe\/webhook|logout)/.test(path)) return next();
  return c.json({ error: 'coming_soon', message: 'Próximamente' }, 503);
});
app.get('/api/admin/coming-soon', async (c) => { if (!isAdminReq(c)) return c.json({ error: 'forbidden' }, 403); await loadSoon(); return c.json({ on: comingSoon }); });
app.post('/api/admin/coming-soon', async (c) => {
  if (!isAdminReq(c)) return c.json({ error: 'forbidden' }, 403);
  let b; try { b = await c.req.json(); } catch (e) { return c.json({ error: 'bad_request' }, 400); }
  comingSoon = !!b.on;
  await sql`INSERT INTO app_state (key, value) VALUES ('coming_soon', ${JSON.stringify(comingSoon)}::jsonb) ON CONFLICT (key) DO UPDATE SET value = ${JSON.stringify(comingSoon)}::jsonb`;
  return c.json({ on: comingSoon });
});
function soonHtml(wa) {
  var waBtn = wa ? '<a class="wa" href="https://wa.me/' + wa + '?text=' + encodeURIComponent('Hola, quiero saber cuándo abre RapiDeportes') + '" target="_blank" rel="noopener">💬 Escríbenos por WhatsApp</a>' : '';
  return '<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>RapiDeportes · Próximamente</title><meta name="description" content="RapiDeportes abre muy pronto.">' +
    '<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Inter:wght@500;600;800;900&display=swap" rel="stylesheet">' +
    '<style>*{box-sizing:border-box;margin:0}html,body{height:100%}body{font-family:Inter,system-ui,sans-serif;background:#0B1530;color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:32px 20px;text-align:center;' +
    'background-image:radial-gradient(900px 500px at 50% -10%,rgba(232,30,60,.28),transparent 60%),radial-gradient(700px 400px at 50% 110%,rgba(59,92,180,.25),transparent 60%)}' +
    '.logo{font-weight:900;font-size:clamp(40px,11vw,72px);letter-spacing:-.03em;line-height:1}.logo i{font-style:normal;color:#E81E3C}.logo small{font-size:.32em;font-weight:800;color:#8C9BBE;margin-left:2px}' +
    '.line{width:56px;height:4px;border-radius:4px;background:#E81E3C;margin:26px auto}' +
    'h1{font-size:clamp(30px,8vw,48px);font-weight:900;letter-spacing:-.02em}' +
    'p{color:#C8D2EB;font-size:17px;line-height:1.55;max-width:440px;margin:14px auto 0;font-weight:500}' +
    '.sp{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin:26px 0 0}.sp span{border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.06);border-radius:999px;padding:8px 14px;font-size:14px;font-weight:600}' +
    '.wa{display:inline-block;margin-top:30px;background:#16A34A;color:#fff;text-decoration:none;font-weight:800;padding:14px 22px;border-radius:14px;font-size:16px}' +
    'footer{margin-top:44px;color:#6F7FA6;font-size:13px}</style></head><body>' +
    '<div class="logo">Rapi<i>deportes</i><small>.com</small></div><div class="line"></div>' +
    '<h1>Próximamente</h1><p>Estamos preparando todo para ti. Muy pronto vas a poder apostar en tus deportes favoritos, en vivo y desde tu celular.</p>' +
    '<div class="sp"><span>🏀 NBA</span><span>⚾ MLB</span><span>⚾ LIDOM</span><span>🏈 NFL</span><span>🏒 NHL</span></div>' + waBtn +
    '<footer>© ' + new Date().getFullYear() + ' RapiDeportes · Solo para mayores de 18 años</footer></body></html>';
}

// ---------- Recuperar contraseña ----------
// Se activa al poner RESEND_API_KEY (y MAIL_FROM, ej. "RapiDeportes <no-responder@rapideportes.com>") en Railway.
function emailEnabled() { return !!Bun.env.RESEND_API_KEY; }
function sha256Hex(t) { return new Bun.CryptoHasher('sha256').update(t).digest('hex'); }
function randomToken(bytes) { var a = new Uint8Array(bytes); crypto.getRandomValues(a); return Array.from(a, function (b) { return b.toString(16).padStart(2, '0'); }).join(''); }
function publicBase(c) {
  if (Bun.env.PUBLIC_URL) return String(Bun.env.PUBLIC_URL).replace(/\/+$/, '');
  var u = new URL(c.req.url);
  var proto = c.req.header('x-forwarded-proto') || u.protocol.replace(':', '');
  var host = c.req.header('x-forwarded-host') || c.req.header('host') || u.host;
  return proto + '://' + host;
}
var resetLimiter = new Map(); // correo o IP -> últimos pedidos (para que no abusen)
function tooMany(key, max, ms) {
  var now = Date.now(), arr = (resetLimiter.get(key) || []).filter(function (t) { return now - t < ms; });
  if (arr.length >= max) { resetLimiter.set(key, arr); return true; }
  arr.push(now); resetLimiter.set(key, arr); return false;
}
async function sendResetEmail(to, link) {
  var from = Bun.env.MAIL_FROM || 'RapiDeportes <no-responder@rapideportes.com>';
  var html = '<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;color:#101828">' +
    '<div style="background:#0B1630;border-bottom:3px solid #F01446;padding:18px 22px;border-radius:12px 12px 0 0"><b style="color:#fff;font-size:20px">Rapi<span style="color:#F01446">deportes</span></b></div>' +
    '<div style="border:1px solid #EAECF0;border-top:none;padding:22px;border-radius:0 0 12px 12px">' +
    '<h2 style="margin:0 0 10px">Crea una contraseña nueva</h2>' +
    '<p style="color:#475467;line-height:1.5">Recibimos un pedido para cambiar la contraseña de tu cuenta. Toca el botón para crear una nueva. El enlace vence en 1 hora y sirve una sola vez.</p>' +
    '<p style="margin:22px 0"><a href="' + link + '" style="background:#F01446;color:#fff;text-decoration:none;padding:13px 22px;border-radius:999px;font-weight:bold;display:inline-block">Crear contraseña nueva</a></p>' +
    '<p style="color:#667085;font-size:13px;line-height:1.5">Si tú no lo pediste, ignora este correo: tu contraseña sigue igual.</p></div></div>';
  var res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + Bun.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: from, to: [to], subject: 'Recupera tu contraseña de RapiDeportes', html: html })
  });
  return res.ok;
}
app.get('/api/password/status', (c) => c.json({ emailEnabled: emailEnabled() }));
app.post('/api/password/forgot', async (c) => {
  let body = {};
  try { body = await c.req.json(); } catch (e) {}
  const email = String(body.email || '').trim().toLowerCase();
  if (!emailEnabled()) return c.json({ ok: false, emailEnabled: false });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return c.json({ error: 'invalid' }, 400);
  const ip = c.req.header('x-forwarded-for') || 'ip';
  // Siempre contestamos lo mismo, exista o no la cuenta (así nadie averigua qué correos están registrados).
  if (tooMany('e:' + email, 3, 15 * 60 * 1000) || tooMany('i:' + ip, 10, 15 * 60 * 1000)) return c.json({ ok: true });
  const u = await sql`SELECT id FROM users WHERE email = ${email}`;
  if (u[0]) {
    const token = randomToken(32);
    await sql`INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (${sha256Hex(token)}, ${u[0].id}, now() + interval '1 hour')`;
    try { await sendResetEmail(email, publicBase(c) + '/?reset=' + token); } catch (e) {}
  }
  return c.json({ ok: true });
});
app.post('/api/password/reset', async (c) => {
  let body = {};
  try { body = await c.req.json(); } catch (e) {}
  const token = String(body.token || ''), password = String(body.password || '');
  if (password.length < 6) return c.json({ error: 'short' }, 400);
  if (!/^[a-f0-9]{64}$/.test(token)) return c.json({ error: 'invalid_link' }, 400);
  const rows = await sql`UPDATE password_resets SET used_at = now()
    WHERE token_hash = ${sha256Hex(token)} AND used_at IS NULL AND expires_at > now() RETURNING user_id`;
  if (!rows[0]) return c.json({ error: 'invalid_link' }, 400);
  const hash = await Bun.password.hash(password);
  await sql`UPDATE users SET password_hash = ${hash} WHERE id = ${rows[0].user_id}`;
  await sql`DELETE FROM sessions WHERE user_id = ${rows[0].user_id}`; // cierra la sesión en todos los aparatos
  return c.json({ ok: true });
});

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
      VALUES (${email}, ${hash}, 0)
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

// ---------- Estadísticas completas de un partido de la NBA ----------
// Toma el resumen público del partido (box score) y lo devuelve ya
// ordenado: jugadores de cada equipo y comparación de equipos.
// Se guarda 20 segundos para no pedirlo de nuevo con cada visita.
var gameStatsCache = {};
// Box score de béisbol (MLB y LIDOM) desde la API oficial de MLB: bateo y pitcheo de cada jugador.
async function fetchBaseballBoxscore(gamePk) {
  var key = 'bb' + gamePk, hit = gameStatsCache[key];
  if (hit && Date.now() - hit.t < 20000) return hit.data;
  var res = await fetch('https://statsapi.mlb.com/api/v1/game/' + encodeURIComponent(gamePk) + '/boxscore', { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36' } });
  if (!res.ok) return null;
  var data = await res.json();
  if (!data || !data.teams) return null;
  function side(t) {
    if (!t) return null;
    var P = t.players || {};
    var pl = function (id) { return P['ID' + id] || {}; };
    var batters = (t.batters || []).map(function (id) {
      var p = pl(id), b = (p.stats && p.stats.batting) || {};
      return { name: (p.person && p.person.fullName) || '', pos: (p.position && p.position.abbreviation) || '', sub: !!(p.battingOrder && String(p.battingOrder).slice(-2) !== '00'),
        ab: b.atBats, r: b.runs, h: b.hits, rbi: b.rbi, hr: b.homeRuns, bb: b.baseOnBalls, k: b.strikeOuts };
    }).filter(function (b) { return b.name && b.pos !== 'P' || (b.ab || 0) > 0; });
    var pitchers = (t.pitchers || []).map(function (id) {
      var p = pl(id), x = (p.stats && p.stats.pitching) || {};
      return { name: (p.person && p.person.fullName) || '', ip: x.inningsPitched, h: x.hits, r: x.runs, er: x.earnedRuns, bb: x.baseOnBalls, k: x.strikeOuts, pc: x.numberOfPitches || x.pitchesThrown };
    }).filter(function (p) { return p.name; });
    var ts = t.teamStats || {}, tb = ts.batting || {}, tf = ts.fielding || {};
    return { name: (t.team && t.team.name) || '', batters: batters, pitchers: pitchers,
      totals: { r: tb.runs, h: tb.hits, hr: tb.homeRuns, bb: tb.baseOnBalls, k: tb.strikeOuts, lob: tb.leftOnBase, avg: tb.avg, e: tf.errors } };
  }
  var out = { kind: 'baseball', away: side(data.teams.away), home: side(data.teams.home) };
  gameStatsCache[key] = { t: Date.now(), data: out };
  return out;
}
// Probabilidad oficial de ESPN (la misma de su gráfica "Win Probability"):
// el último valor y unos 40 puntos de cómo ha ido cambiando en el juego.
function espnWinProb(data) {
  var wp = data && data.winprobability;
  if (!Array.isArray(wp) || !wp.length) return null;
  var vals = wp.map(function (x) { return Number(x.homeWinPercentage); }).filter(function (x) { return !isNaN(x); });
  if (!vals.length) return null;
  var hist = [], step = Math.max(1, Math.floor(vals.length / 40));
  for (var i = 0; i < vals.length; i += step) hist.push(Math.round(vals[i] * 1000) / 1000);
  if (hist[hist.length - 1] !== vals[vals.length - 1]) hist.push(Math.round(vals[vals.length - 1] * 1000) / 1000);
  return { home: vals[vals.length - 1], hist: hist };
}
var nflBoxCache = {};
async function nflBoxLeaders(eventId) {
  var hit = nflBoxCache[eventId];
  if (hit && Date.now() - hit.t < 60000) return hit.v;
  var v = null;
  try {
    var res = await fetch('https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=' + encodeURIComponent(eventId), { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36' } });
    if (res.ok) {
      var data = await res.json(), sideOf = {};
      var comp = data.header && data.header.competitions && data.header.competitions[0];
      ((comp && comp.competitors) || []).forEach(function (x) { if (x.team) sideOf[String(x.team.id)] = x.homeAway; });
      var KEY = { passing: 'passingYards', rushing: 'rushingYards', receiving: 'receivingYards' };
      v = { wp: espnWinProb(data), ps: [] };
      var psBy = {};
      ((data.boxscore && data.boxscore.players) || []).forEach(function (tp) {
        (tp.statistics || []).forEach(function (cat) {
          var labels = cat.labels || [], iY = labels.indexOf('YDS'), iR = labels.indexOf('REC');
          var map = cat.name === 'passing' ? { 'Yardas pase': iY } : cat.name === 'rushing' ? { 'Yardas carrera': iY } : cat.name === 'receiving' ? { 'Yardas recepción': iY, 'Recepciones': iR } : null;
          if (!map) return;
          (cat.athletes || []).forEach(function (a) {
            var nm = String((a.athlete && (a.athlete.shortName || a.athlete.displayName)) || ''); if (!nm) return;
            var e = psBy[nm] = psBy[nm] || { n: nm, s: {} };
            Object.keys(map).forEach(function (k) { var i = map[k]; if (i >= 0) { var x = parseInt(String((a.stats || [])[i] || ''), 10); if (!isNaN(x)) e.s[k] = x; } });
          });
        });
      });
      v.ps = Object.keys(psBy).map(function (k) { return psBy[k]; });
      ((data.boxscore && data.boxscore.players) || []).forEach(function (tp) {
        var side = tp.team ? sideOf[String(tp.team.id)] : null; if (!side) return;
        (tp.statistics || []).forEach(function (cat) {
          var key = KEY[cat.name]; if (!key) return;
          var idx = (cat.labels || cat.keys || []).indexOf('YDS'); if (idx < 0) idx = (cat.keys || []).indexOf(cat.name + 'Yards');
          if (idx < 0) return;
          var best = null;
          (cat.athletes || []).forEach(function (a) {
            var yd = parseInt(String((a.stats || [])[idx] || ''), 10);
            if (!isNaN(yd) && (!best || yd > best.yd)) best = { yd: yd, name: String((a.athlete && (a.athlete.shortName || a.athlete.displayName)) || '') };
          });
          if (best) { v[side] = v[side] || {}; v[side][key] = { name: best.name, value: String(best.yd) }; }
        });
      });
    }
  } catch (e) {}
  nflBoxCache[eventId] = { t: Date.now(), v: v };
  return v;
}
// Lo que lleva cada jugador en el juego (para "Lleva 28 pts · faltan 7" en los tickets).
function nbaLivePlayers(box) {
  var out = [], MAP = { PTS: 'Puntos', REB: 'Rebotes', AST: 'Asistencias', '3PT': 'Triples', STL: 'Robos', BLK: 'Tapones' };
  (box.teams || []).forEach(function (t) {
    var lab = t.labels || [];
    (t.players || []).forEach(function (p) {
      if (p.dnp || !p.name) return;
      var st = {};
      Object.keys(MAP).forEach(function (k) { var i = lab.indexOf(k); if (i < 0) return; var raw = String(p.stats[i] || ''); var v = k === '3PT' ? parseInt(raw.split('-')[0], 10) : parseFloat(raw); if (!isNaN(v)) st[MAP[k]] = v; });
      if (Object.keys(st).length) out.push({ n: p.name, s: st });
    });
  });
  return out;
}
var threesCache = {};
async function nbaThreesLeaders(eventId) {
  var hit = threesCache[eventId];
  if (hit && Date.now() - hit.t < 45000) return hit.v;
  var box = await fetchNbaBoxscore(eventId), v = null;
  if (box && box.teams) {
    v = {};
    box.teams.forEach(function (t) {
      var idx = (t.labels || []).indexOf('3PT'); if (idx < 0 || !t.side) return;
      var best = null;
      (t.players || []).forEach(function (p) {
        if (p.dnp) return;
        var made = parseInt(String(p.stats[idx] || '').split('-')[0], 10);
        if (!isNaN(made) && made > 0 && (!best || made > best.made)) best = { made: made, name: p.name };
      });
      if (best) v[t.side] = { name: best.name, value: String(best.made) };
    });
  }
  threesCache[eventId] = { t: Date.now(), v: v };
  return v;
}
async function fetchNbaBoxscore(eventId) {
  var hit = gameStatsCache[eventId];
  if (hit && Date.now() - hit.t < 20000) return hit.data;
  var url = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=' + encodeURIComponent(eventId);
  var res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36' } });
  if (!res.ok) return null;
  var data = await res.json();
  var box = data && data.boxscore;
  if (!box) return null;
  var sideOf = {};
  var comp = data.header && data.header.competitions && data.header.competitions[0];
  ((comp && comp.competitors) || []).forEach(function (x) { if (x.team) sideOf[String(x.team.id)] = x.homeAway; });
  var teams = (box.players || []).map(function (tp) {
    var st = (tp.statistics && tp.statistics[0]) || {};
    var labels = st.labels || st.names || [];
    var players = (st.athletes || []).map(function (a) {
      return {
        name: String((a.athlete && (a.athlete.shortName || a.athlete.displayName)) || ''),
        starter: !!a.starter,
        dnp: !!a.didNotPlay || !(a.stats && a.stats.length),
        stats: (a.stats || []).map(String)
      };
    });
    return {
      name: tp.team ? String(tp.team.displayName || '') : '',
      side: tp.team ? (sideOf[String(tp.team.id)] || '') : '',
      labels: labels.map(String),
      players: players,
      totals: (st.totals || []).map(String)
    };
  });
  var tstats = {};
  (box.teams || []).forEach(function (t) {
    var side = t.homeAway || (t.team ? sideOf[String(t.team.id)] : '');
    (t.statistics || []).forEach(function (x) {
      var k = x.name || x.label; if (!k) return;
      tstats[k] = tstats[k] || { label: String(x.label || x.abbreviation || k) };
      tstats[k][side === 'home' ? 'home' : 'away'] = String(x.displayValue !== undefined ? x.displayValue : '');
    });
  });
  var out = { teams: teams, teamStats: tstats, state: comp && comp.status && comp.status.type ? comp.status.type.state : '', wp: espnWinProb(data) };
  gameStatsCache[eventId] = { t: Date.now(), data: out };
  return out;
}

app.get('/api/game-stats/:id', async (c) => {
  try {
    const rows = await sql`SELECT value FROM app_state WHERE key = 'matches'`;
    var list = rows[0] ? rows[0].value : [];
    if (typeof list === 'string') { try { list = JSON.parse(list); } catch (e) { list = []; } }
    var id = c.req.param('id');
    var m = (Array.isArray(list) ? list : []).find(function (x) { return String(x.id) === String(id); });
    if (!m) { var ar = await sql`SELECT data FROM results WHERE match_id = ${String(id)}`; if (ar[0] && ar[0].data) m = ar[0].data; }
    if (!m || !m.espnEventId) return c.json({ error: 'not_available' }, 404);
    if (m.sport === 'beisbol' || m.sport === 'lidom') {
      var bb = await fetchBaseballBoxscore(m.espnEventId);
      if (!bb) return c.json({ error: 'not_available' }, 404);
      return c.json(bb);
    }
    if (m.sport !== 'baloncesto') return c.json({ error: 'not_available' }, 404);
    var stats = await fetchNbaBoxscore(m.espnEventId);
    if (!stats || !stats.teams.length) return c.json({ error: 'not_available' }, 404);
    return c.json(stats);
  } catch (e) {
    return c.json({ error: 'not_available' }, 404);
  }
});

/* ---------- Posiciones (tabla de cada liga) ----------
   NBA, NFL y NHL salen de ESPN. LIDOM se calcula con los juegos
   terminados de la API oficial de MLB (ligas de invierno, sportId 17).
   Se guarda 10 minutos en memoria para no pedirlo en cada visita. */
var STANDINGS_CACHE = {};
var STANDINGS_TTL = 10 * 60 * 1000;
var STANDINGS_SPORT = { nba: 'baloncesto', nfl: 'nfl', nhl: 'nhl', lidom: 'lidom' };
var STANDINGS_PATH = { nba: 'basketball/nba', nfl: 'football/nfl', nhl: 'hockey/nhl' };
var LIDOM_ABBR = { 'Tigres del Licey': 'LIC', 'Águilas Cibaeñas': 'AGU', 'Leones del Escogido': 'ESC', 'Gigantes del Cibao': 'GIG', 'Estrellas Orientales': 'EST', 'Toros del Este': 'TOR' };

function stPct(w, l, t) { var g = w + l + (t || 0); return g ? (w + (t || 0) / 2) / g : 0; }
function stGb(lw, ll, w, l) { return ((lw - w) + (l - ll)) / 2; }

function espnStat(stats, names) {
  for (var i = 0; i < names.length; i++) {
    var want = names[i].toLowerCase();
    var s = (stats || []).find(function (x) {
      return String(x.name || '').toLowerCase() === want || String(x.type || '').toLowerCase() === want || String(x.abbreviation || '').toLowerCase() === want;
    });
    if (s) return s;
  }
  return null;
}
function espnNum(stats, names) { var s = espnStat(stats, names); return s ? Number(s.value) || 0 : 0; }
function espnTxt(stats, names) { var s = espnStat(stats, names); return s ? String(s.summary || s.displayValue || '') : ''; }
function espnLeaves(node, out) {
  if (node && node.standings && Array.isArray(node.standings.entries) && node.standings.entries.length) out.push(node);
  else (node && node.children || []).forEach(function (ch) { espnLeaves(ch, out); });
  return out;
}

async function fetchEspnStandings(league) {
  var level = league === 'nba' ? '' : '?level=3'; // NBA por conferencia; NFL y NHL por división
  var res = await fetch('https://site.api.espn.com/apis/v2/sports/' + STANDINGS_PATH[league] + '/standings' + level, { headers: UA_HEADERS });
  if (!res.ok) throw new Error('espn ' + res.status);
  var data = await res.json();
  var leaves = espnLeaves(data, []);
  var sport = STANDINGS_SPORT[league];
  return leaves.map(function (node) {
    var rows = node.standings.entries.map(function (e) {
      var st = e.stats || [], t = e.team || {};
      var w = espnNum(st, ['wins']), l = espnNum(st, ['losses']), ties = espnNum(st, ['ties']), otl = espnNum(st, ['otLosses', 'overtimeLosses', 'OTL']);
      var streak = espnTxt(st, ['streak']);
      return {
        team: canonTeam(sport, t.displayName || t.name || '', t.abbreviation),
        abbr: t.abbreviation || '',
        gp: espnNum(st, ['gamesPlayed']) || (w + l + ties + otl),
        w: w, l: l, t: ties, otl: otl,
        pts: league === 'nhl' ? (espnNum(st, ['points']) || (w * 2 + otl)) : 0,
        pct: stPct(w, l, ties),
        home: espnTxt(st, ['home', 'Home']), road: espnTxt(st, ['road', 'away', 'Road']),
        streak: streak.replace(/^W/, 'G').replace(/^L/, 'P').replace(/^T/, 'E'),
        l10: espnTxt(st, ['lasttengames', 'Last Ten Games', 'L10'])
      };
    });
    if (league === 'nhl') rows.sort(function (a, b) { return b.pts - a.pts || a.gp - b.gp || b.w - a.w; });
    else rows.sort(function (a, b) { return b.pct - a.pct || b.w - a.w; });
    rows.forEach(function (r) { r.gb = stGb(rows[0].w, rows[0].l, r.w, r.l); });
    return { name: node.name || node.abbreviation || '', rows: rows };
  });
}

async function fetchLidomStandings() {
  var today = todayISO();
  var y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7));
  var start = (m >= 9 ? y : y - 1) + '-10-01';
  var url = 'https://statsapi.mlb.com/api/v1/schedule?sportId=17&startDate=' + start + '&endDate=' + today;
  var res = await fetch(url, { headers: UA_HEADERS });
  if (!res.ok) throw new Error('statsapi ' + res.status);
  var data = await res.json();
  var games = [];
  (data.dates || []).forEach(function (d) { (d.games || []).forEach(function (g) { games.push(g); }); });
  games = games.filter(function (g) {
    var h = g.teams && g.teams.home, a = g.teams && g.teams.away;
    if (!h || !a || !h.team || !a.team) return false;
    if (!isLidomTeamName(h.team.name) || !isLidomTeamName(a.team.name)) return false;
    if (g.gameType && g.gameType !== 'R') return false; // solo serie regular
    var st = g.status || {};
    return st.abstractGameState === 'Final' && !/postpon|cancel|suspend/i.test(st.detailedState || '') && typeof h.score === 'number' && typeof a.score === 'number' && h.score !== a.score;
  });
  games.sort(function (a, b) { return Date.parse(a.gameDate) - Date.parse(b.gameDate); });
  var T = {};
  Object.keys(LIDOM_ABBR).forEach(function (n) { T[n] = { team: n, abbr: LIDOM_ABBR[n], w: 0, l: 0, hw: 0, hl: 0, rw: 0, rl: 0, log: [] }; });
  games.forEach(function (g) {
    var home = canonTeam('lidom', g.teams.home.team.name), away = canonTeam('lidom', g.teams.away.team.name);
    var homeWon = g.teams.home.score > g.teams.away.score;
    [[home, homeWon, true], [away, !homeWon, false]].forEach(function (x) {
      var r = T[x[0]]; if (!r) return;
      if (x[1]) { r.w++; if (x[2]) r.hw++; else r.rw++; } else { r.l++; if (x[2]) r.hl++; else r.rl++; }
      r.log.push(x[1]);
    });
  });
  var rows = Object.keys(T).map(function (k) {
    var r = T[k], log = r.log, n = 0, last = log[log.length - 1];
    for (var i = log.length - 1; i >= 0 && log[i] === last; i--) n++;
    var ten = log.slice(-10), tw = ten.filter(Boolean).length;
    return { team: r.team, abbr: r.abbr, gp: r.w + r.l, w: r.w, l: r.l, t: 0, otl: 0, pts: 0, pct: stPct(r.w, r.l, 0),
      home: r.hw + '-' + r.hl, road: r.rw + '-' + r.rl, streak: log.length ? (last ? 'G' : 'P') + n : '', l10: tw + '-' + (ten.length - tw) };
  });
  rows.sort(function (a, b) { return b.pct - a.pct || b.w - a.w || a.l - b.l; });
  rows.forEach(function (r) { r.gb = stGb(rows[0].w, rows[0].l, r.w, r.l); });
  return [{ name: 'LIDOM', rows: rows }];
}

app.get('/api/standings', async (c) => {
  var league = String(c.req.query('league') || 'lidom').toLowerCase();
  if (!STANDINGS_SPORT[league]) return c.json({ error: 'bad_league' }, 400);
  var hit = STANDINGS_CACHE[league];
  if (hit && Date.now() - hit.updatedAt < STANDINGS_TTL) return c.json(hit);
  try {
    var groups = league === 'lidom' ? await fetchLidomStandings() : await fetchEspnStandings(league);
    if (!groups.length || !groups.some(function (g) { return g.rows.length; })) throw new Error('empty');
    STANDINGS_CACHE[league] = { league: league, updatedAt: Date.now(), groups: groups };
    return c.json(STANDINGS_CACHE[league]);
  } catch (e) {
    // Si la fuente falla, mostramos la última tabla buena que tengamos.
    if (hit) return c.json(hit);
    return c.json({ error: 'not_available' }, 503);
  }
});

// Juegos del día que todavía no tienen cuotas: salen en la página con "Cuotas no disponibles aún".
app.get('/api/upcoming', async (c) => {
  const rows = await sql`SELECT value FROM app_state WHERE key = 'matches'`;
  var val = rows[0] ? rows[0].value : []; if (typeof val === 'string') { try { val = JSON.parse(val); } catch (e) { val = []; } }
  var now = Date.now();
  var out = (Array.isArray(val) ? val : []).filter(function (m) {
    var o = m.odds || [], t = Date.parse(m.startAt);
    return !((o[0] && o[0].v) && (o[2] && o[2].v)) && !m.finished && !m.live && t > now && t - now < 36 * 3600e3;
  }).map(function (m) { return { id: m.id, sport: m.sport, sportLabel: m.sportLabel, startAt: m.startAt, home: m.home, away: m.away }; });
  return c.json(out);
});

app.get('/api/matches', async (c) => {
  const rows = await sql`SELECT value FROM app_state WHERE key = 'matches'`;
  var val = rows[0] ? rows[0].value : [];
  if (typeof val === 'string') {
    try { val = JSON.parse(val); } catch (e) { val = []; }
  }
  // Un juego sin las cuotas de Ganador es un borrador: solo lo ve el admin.
  if (Array.isArray(val)) val = val.filter(function (m) { var o = m.odds || []; return (o[0] && o[0].v) && (o[2] && o[2].v); });
  return c.json(val);
});

app.post('/api/admin/login', async (c) => {
  let body;
  try { body = await c.req.json(); } catch (e) { return c.json({ error: 'bad_request' }, 400); }
  if (body.password !== Bun.env.ADMIN_PASS) return c.json({ error: 'invalid' }, 401);
  const token = crypto.randomUUID();
  adminTokens.add(token);
  await sql`INSERT INTO admin_sessions (token) VALUES (${token}) ON CONFLICT DO NOTHING`;
  setCookie(c, 'admin_session', token, { httpOnly: true, path: '/', maxAge: 60 * 60 * 8, sameSite: 'Lax' });
  return c.json({ ok: true });
});

app.get('/api/admin/check', async (c) => {
  return c.json({ ok: isAdminReq(c) });
});

// ---------- Apuestas de partidos que el admin borró ----------
// Una apuesta pendiente cuyo partido ya no está en la línea nunca se podría
// calificar. Al resolverla: una sencilla se anula y se devuelve lo apostado;
// en una combinada se quita esa selección y se recalcula el pago con las demás
// (si no queda ninguna, se anula y se devuelve).
function betLegs(b) {
  if (/^Combinada/i.test(b.desc_text || '')) {
    return String(b.match_text || '').split(' · ').map(function (leg) {
      var parts = leg.split('@@@');
      var tm = /^(Ganador|Hándicap|Total) (.*) vs (.*)$/.exec(parts[0] || '');
      return { raw: leg, key: tm ? matchKey(tm[2], tm[3]) : null, odds: parseFloat(parts[2]), label: tm ? tm[2] + ' vs ' + tm[3] : leg };
    });
  }
  var mm = /^(.*) @ (.*)$/.exec(b.match_text || '');
  return [{ raw: b.match_text, key: mm ? matchKey(mm[1], mm[2]) : null, odds: NaN, label: b.match_text }];
}
async function currentMatchKeys() {
  const rows = await sql`SELECT value FROM app_state WHERE key = 'matches'`;
  var list = rows[0] ? rows[0].value : [];
  if (typeof list === 'string') { try { list = JSON.parse(list); } catch (e) { list = []; } }
  var keys = {};
  (Array.isArray(list) ? list : []).forEach(function (m) { keys[matchKey(m.away, m.home)] = true; });
  return keys;
}
async function findOrphanBets(onlyKey) {
  const keys = await currentMatchKeys();
  const pending = await sql`SELECT b.id, b.user_id, b.desc_text, b.match_text, b.stake, b.payout, b.created_at, u.email
    FROM bets b JOIN users u ON u.id = b.user_id WHERE b.status = 'pending' AND b.deleted_at IS NULL ORDER BY b.created_at ASC`;
  var out = [];
  pending.forEach(function (b) {
    var legs = betLegs(b);
    var missing = legs.filter(function (l) { return l.key && !keys[l.key] && (!onlyKey || l.key === onlyKey); });
    if (missing.length) out.push({ bet: b, legs: legs, missing: missing });
  });
  return out;
}
async function resolveOrphan(o) {
  var b = o.bet, stake = Number(b.stake);
  var keep = o.legs.filter(function (l) { return o.missing.indexOf(l) < 0; });
  var isParlay = /^Combinada/i.test(b.desc_text || '');
  if (!isParlay || !keep.length || keep.some(function (l) { return !(l.odds > 1); })) {
    var vr = await sql`UPDATE bets SET status = 'void' WHERE id = ${b.id} AND status = 'pending' RETURNING id`;
    if (vr[0]) await sql`UPDATE users SET balance = balance + ${stake} WHERE id = ${b.user_id}`;
    return { id: b.id, action: 'refund', amount: stake };
  }
  var dec = keep.reduce(function (p, l) { return p * l.odds; }, 1);
  var payout = Math.round(stake * dec * 100) / 100;
  var desc = 'Combinada (' + keep.length + (keep.length === 1 ? ' selección)' : ' selecciones)');
  await sql`UPDATE bets SET match_text = ${keep.map(function (l) { return l.raw; }).join(' · ')}, desc_text = ${desc}, payout = ${payout}
    WHERE id = ${b.id} AND status = 'pending'`;
  return { id: b.id, action: 'leg_removed', payout: payout };
}
function orphanView(o) {
  var b = o.bet;
  return { id: b.id, email: b.email, desc: b.desc_text, stake: Number(b.stake), payout: Number(b.payout), createdAt: b.created_at,
    parlay: /^Combinada/i.test(b.desc_text || ''), legs: o.legs.length, missing: o.missing.map(function (l) { return l.label; }) };
}
// Borra de una vez los partidos de días pasados. Los que todavía tienen apuestas
// pendientes NO se borran (para no dejar apuestas sin calificar).
app.post('/api/admin/clear-old', async (c) => {
  if (!isAdminReq(c)) return c.json({ error: 'forbidden' }, 403);
  const rows = await sql`SELECT value FROM app_state WHERE key = 'matches'`;
  var list = rows[0] ? rows[0].value : []; if (typeof list === 'string') { try { list = JSON.parse(list); } catch (e) { list = []; } }
  if (!Array.isArray(list)) list = [];
  var fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Puerto_Rico' }), today = fmt.format(new Date());
  const pending = await sql`SELECT desc_text, match_text FROM bets WHERE status = 'pending' AND deleted_at IS NULL`;
  var busy = {};
  pending.forEach(function (b) { betLegs(b).forEach(function (l) { if (l.key) busy[l.key] = true; }); });
  var keep = [], removed = 0, kept = 0;
  list.forEach(function (m) {
    var t = m.startAt ? Date.parse(m.startAt) : NaN;
    var old = !isNaN(t) && fmt.format(new Date(t)) < today;
    if (!old) { keep.push(m); return; }
    if (busy[matchKey(m.away, m.home)] && !m.finished) { keep.push(m); kept++; return; }
    if (busy[matchKey(m.away, m.home)]) { keep.push(m); kept++; return; }
    removed++;
  });
  if (removed) {
    await saveResults(list.filter(function (m) { return keep.indexOf(m) < 0; }));
    await sql`INSERT INTO app_state (key, value) VALUES ('matches', ${JSON.stringify(keep)}::jsonb)
      ON CONFLICT (key) DO UPDATE SET value = ${JSON.stringify(keep)}::jsonb`;
  }
  return c.json({ ok: true, removed: removed, kept: kept });
});
// Apuestas pendientes de un partido (para avisar antes de borrarlo).
app.get('/api/admin/match-bets', async (c) => {
  if (!isAdminReq(c)) return c.json({ error: 'forbidden' }, 403);
  const key = matchKey(c.req.query('away') || '', c.req.query('home') || '');
  const pending = await sql`SELECT id, desc_text, match_text, stake FROM bets WHERE status = 'pending' AND deleted_at IS NULL`;
  var n = 0, total = 0, parlays = 0;
  pending.forEach(function (b) {
    if (betLegs(b).some(function (l) { return l.key === key; })) { n++; total += Number(b.stake); if (/^Combinada/i.test(b.desc_text || '')) parlays++; }
  });
  return c.json({ count: n, stake: Math.round(total * 100) / 100, parlays: parlays });
});
app.get('/api/admin/orphan-bets', async (c) => {
  if (!isAdminReq(c)) return c.json({ error: 'forbidden' }, 403);
  return c.json((await findOrphanBets()).map(orphanView));
});
// Resuelve las apuestas de partidos borrados. Con "away"/"home" solo las de ese partido.
app.post('/api/admin/orphan-bets/resolve', async (c) => {
  if (!isAdminReq(c)) return c.json({ error: 'forbidden' }, 403);
  let body = {};
  try { body = await c.req.json(); } catch (e) {}
  const onlyKey = body && body.away && body.home ? matchKey(body.away, body.home) : null;
  const ids = body && Array.isArray(body.ids) ? body.ids.map(Number) : null;
  var list = await findOrphanBets(onlyKey);
  if (ids) list = list.filter(function (o) { return ids.indexOf(o.bet.id) >= 0; });
  var done = [];
  for (const o of list) done.push(await resolveOrphan(o));
  return c.json({ ok: true, resolved: done });
});

// ---------- Copias de seguridad ----------
// Todo lo que importa del dinero: jugadores y saldos, apuestas, retiros, depósitos y ajustes.
async function buildBackup() {
  const users = await sql`SELECT id, email, balance, created_at FROM users ORDER BY id`;
  const bets = await sql`SELECT id, user_id, desc_text, match_text, stake, payout, status, created_at, deleted_at FROM bets
    WHERE status = 'pending' OR created_at > now() - interval '120 days' ORDER BY id`;
  var safe = async function (q) { try { return await q; } catch (e) { return []; } };
  const withdrawals = await safe(sql`SELECT * FROM withdrawals WHERE status = 'pending' OR created_at > now() - interval '120 days' ORDER BY id`);
  const deposits = await safe(sql`SELECT * FROM deposits WHERE created_at > now() - interval '120 days' ORDER BY id`);
  const adjustments = await safe(sql`SELECT * FROM balance_adjustments WHERE created_at > now() - interval '120 days' ORDER BY id`);
  var total = users.reduce(function (a, u) { return a + Number(u.balance); }, 0);
  return {
    sitio: 'RapiDeportes', hecho: new Date().toISOString(),
    resumen: { jugadores: users.length, saldo_total: Math.round(total * 100) / 100, apuestas_pendientes: bets.filter(function (b) { return b.status === 'pending' && !b.deleted_at; }).length },
    users: users, bets: bets, withdrawals: withdrawals, deposits: deposits, balance_adjustments: adjustments
  };
}
app.get('/api/admin/backup', async (c) => {
  if (!isAdminReq(c)) return c.json({ error: 'forbidden' }, 403);
  var data = await buildBackup();
  var day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Puerto_Rico' }).format(new Date());
  return new Response(JSON.stringify(data, null, 1), { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="rapideportes-copia-' + day + '.json"' } });
});
app.get('/api/admin/backup-status', async (c) => {
  if (!isAdminReq(c)) return c.json({ error: 'forbidden' }, 403);
  const r = await sql`SELECT value FROM app_state WHERE key = 'backup_last'`;
  var v = r[0] ? r[0].value : null; if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { v = null; } }
  return c.json({ email: !!(Bun.env.BACKUP_EMAIL && emailEnabled()), to: Bun.env.BACKUP_EMAIL ? String(Bun.env.BACKUP_EMAIL).replace(/^(.).*(@.*)$/, '$1***$2') : null, last: v });
});
// Cada día (después de las 4 a. m. de PR) se manda la copia al correo BACKUP_EMAIL (Railway → Variables).
async function dailyBackup() {
  try {
    if (!Bun.env.BACKUP_EMAIL || !emailEnabled()) return;
    var now = new Date();
    var hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Puerto_Rico', hour: 'numeric', hour12: false }).format(now));
    var day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Puerto_Rico' }).format(now);
    if (hour < 4) return;
    const r = await sql`SELECT value FROM app_state WHERE key = 'backup_last'`;
    var v = r[0] ? r[0].value : null; if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { v = null; } }
    if (v && v.day === day) return;
    var data = await buildBackup();
    var json = JSON.stringify(data);
    var res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + Bun.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: Bun.env.MAIL_FROM || 'RapiDeportes <no-responder@rapideportes.com>', to: [Bun.env.BACKUP_EMAIL],
        subject: 'Copia de seguridad RapiDeportes · ' + day,
        html: '<p>Copia del día ' + day + '.</p><p>Jugadores: <b>' + data.resumen.jugadores + '</b> · Saldo total de jugadores: <b>$' + data.resumen.saldo_total.toFixed(2) + '</b> · Apuestas pendientes: <b>' + data.resumen.apuestas_pendientes + '</b></p><p>Guarda este correo: el archivo adjunto tiene todo para recuperar los saldos y las apuestas si algo falla.</p>',
        attachments: [{ filename: 'rapideportes-copia-' + day + '.json', content: Buffer.from(json).toString('base64') }]
      })
    });
    var st = { day: day, at: now.toISOString(), ok: res.ok, kb: Math.round(json.length / 1024) };
    await sql`INSERT INTO app_state (key, value) VALUES ('backup_last', ${JSON.stringify(st)}::jsonb) ON CONFLICT (key) DO UPDATE SET value = ${JSON.stringify(st)}::jsonb`;
  } catch (e) {}
}
setInterval(dailyBackup, 30 * 60 * 1000);
setTimeout(dailyBackup, 60 * 1000);

// Eliminar un ticket: desaparece de las listas. Si estaba pendiente, se le devuelve lo apostado al jugador.
app.post('/api/admin/bets/:id/delete', async (c) => {
  if (!isAdminReq(c)) return c.json({ error: 'forbidden' }, 403);
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.json({ error: 'not_found' }, 404);
  // Si estaba pendiente, se anula y se le devuelve lo que apostó.
  const pend = await sql`UPDATE bets SET deleted_at = now(), status = 'void' WHERE id = ${id} AND deleted_at IS NULL AND status = 'pending' RETURNING user_id, stake`;
  if (pend[0]) {
    await sql`UPDATE users SET balance = balance + ${Number(pend[0].stake)} WHERE id = ${pend[0].user_id}`;
    return c.json({ ok: true, refunded: Number(pend[0].stake) });
  }
  const rows = await sql`UPDATE bets SET deleted_at = now() WHERE id = ${id} AND deleted_at IS NULL RETURNING id`;
  if (!rows[0]) return c.json({ error: 'not_found' }, 404);
  return c.json({ ok: true, refunded: 0 });
});

// El admin ve todos los juegos, también los borradores sin cuotas.
app.get('/api/admin/matches', async (c) => {
  if (!isAdminReq(c)) return c.json({ error: 'unauthorized' }, 401);
  const rows = await sql`SELECT value FROM app_state WHERE key = 'matches'`;
  var val = rows[0] ? rows[0].value : [];
  if (typeof val === 'string') { try { val = JSON.parse(val); } catch (e) { val = []; } }
  return c.json(Array.isArray(val) ? val : []);
});

app.post('/api/admin/matches', async (c) => {
  if (!isAdminReq(c)) return c.json({ error: 'forbidden' }, 403);
  let matches;
  try { matches = await c.req.json(); } catch (e) { return c.json({ error: 'bad_request' }, 400); }
  if (!Array.isArray(matches)) return c.json({ error: 'bad_request' }, 400);
  // El panel puede tener una copia vieja: en los juegos automáticos se conservan
  // las cuotas más nuevas que puso el servidor (salvo que el admin apagara lo automático).
  try {
    const cur = await sql`SELECT value FROM app_state WHERE key = 'matches'`;
    var curList = cur[0] ? cur[0].value : []; if (typeof curList === 'string') { try { curList = JSON.parse(curList); } catch (e) { curList = []; } }
    var curById = {}; (Array.isArray(curList) ? curList : []).forEach(function (m) { curById[m.id] = m; });
    matches.forEach(function (m) {
      var old = curById[m.id];
      if (!m || !m.auto || !old || !old.auto) return;
      if ((Number(old.auto.at) || 0) > (Number(m.auto.at) || 0)) {
        ['odds', 'handicap', 'total', 'props'].forEach(function (k) { if (old[k] !== undefined) m[k] = old[k]; });
        m.auto = old.auto;
      }
    });
  } catch (e) {}
  // Juegos que la página agregó sola después de que el admin abrió su lista: se quedan
  // (el admin no los tenía, así que no los borró a propósito).
  var keptNew = [];
  try {
    var since = Number(c.req.query('since')) || 0;
    if (since) {
      const cur2 = await sql`SELECT value FROM app_state WHERE key = 'matches'`;
      var cl2 = cur2[0] ? cur2[0].value : []; if (typeof cl2 === 'string') { try { cl2 = JSON.parse(cl2); } catch (e) { cl2 = []; } }
      var ids = {}; matches.forEach(function (m) { if (m && m.id) ids[m.id] = 1; });
      keptNew = (Array.isArray(cl2) ? cl2 : []).filter(function (m) { return m && m.autoAddedAt && m.autoAddedAt > since - 60000 && !ids[m.id]; });
      if (keptNew.length) matches = matches.concat(keptNew);
    }
  } catch (e) {}
  await sql`
    INSERT INTO app_state (key, value) VALUES ('matches', ${JSON.stringify(matches)}::jsonb)
    ON CONFLICT (key) DO UPDATE SET value = ${JSON.stringify(matches)}::jsonb
  `;
  await saveResults(matches);
  return c.json({ ok: true, added: keptNew });
});

// ---------- Traer juegos del calendario (para que el admin no los escriba a mano) ----------
// Devuelve los juegos de una liga en una fecha, con los nombres como los usa el panel.
function canonTeam(sport, name, abbrev) {
  if (sport === 'nhl' && abbrev) { var k = Object.keys(NHL_TEAM_ABBREV).find(function (x) { return NHL_TEAM_ABBREV[x] === abbrev; }); if (k) return k; }
  var map = TEAM_ES_TO_EN[sport] || {};
  var keys = Object.keys(map);
  if (sport === 'lidom') {
    var t = normTeam(name);
    var hit = keys.find(function (k) { var v = normTeam(map[k]); return t === v || t.endsWith(' ' + v); });
    return hit || name;
  }
  var exact = keys.find(function (k) { return normTeam(map[k]) === normTeam(name) || normTeam(k) === normTeam(name); });
  if (exact) return exact;
  var loose = keys.find(function (k) { return teamNamesMatch(map[k], name); });
  return loose || name;
}
async function fetchSchedule(sport, date) {
  const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36' };
  var out = [];
  try {
    if (sport === 'beisbol' || sport === 'lidom') {
      var sid = sport === 'lidom' ? 17 : 1;
      var r = await fetch('https://statsapi.mlb.com/api/v1/schedule?sportId=' + sid + '&date=' + date + '&hydrate=probablePitcher', { headers: UA });
      if (!r.ok) return out;
      var d = await r.json();
      (d.dates || []).forEach(function (dd) { (dd.games || []).forEach(function (g) {
        var h = g.teams && g.teams.home && g.teams.home.team, a = g.teams && g.teams.away && g.teams.away.team;
        if (!h || !a) return;
        if (sport === 'lidom' && !(isLidomTeamName(h.name) && isLidomTeamName(a.name))) return;
        var pa = g.teams.away.probablePitcher, ph = g.teams.home.probablePitcher;
        out.push({ away: canonTeam(sport, a.name), home: canonTeam(sport, h.name), startAt: g.gameDate, done: g.status && g.status.abstractGameState !== 'Preview',
          awayPitcher: pa && pa.fullName ? pa.fullName : null, homePitcher: ph && ph.fullName ? ph.fullName : null });
      }); });
    } else if (sport === 'nhl') {
      var rn = await fetch('https://api-web.nhle.com/v1/schedule/' + date, { headers: UA });
      if (!rn.ok) return out;
      var dn = await rn.json();
      var day = (dn.gameWeek || []).find(function (w) { return w.date === date; });
      ((day && day.games) || []).forEach(function (g) {
        out.push({ away: canonTeam('nhl', nhlTeamFullName(g.awayTeam), g.awayTeam && g.awayTeam.abbrev), home: canonTeam('nhl', nhlTeamFullName(g.homeTeam), g.homeTeam && g.homeTeam.abbrev), startAt: g.startTimeUTC, done: g.gameState && g.gameState !== 'FUT' && g.gameState !== 'PRE' });
      });
    } else if (SPORT_ESPN_PATH[sport]) {
      var re = await fetch('https://site.api.espn.com/apis/site/v2/sports/' + SPORT_ESPN_PATH[sport] + '/scoreboard?dates=' + date.replace(/-/g, ''), { headers: UA });
      if (!re.ok) return out;
      var de = await re.json();
      (de.events || []).forEach(function (ev) {
        var comp = ev.competitions && ev.competitions[0], cs = (comp && comp.competitors) || [];
        var h = cs.find(function (x) { return x.homeAway === 'home'; }), a = cs.find(function (x) { return x.homeAway === 'away'; });
        if (!h || !a || !h.team || !a.team) return;
        var stt = comp.status && comp.status.type ? comp.status.type.state : 'pre';
        out.push({ away: canonTeam(sport, a.team.displayName), home: canonTeam(sport, h.team.displayName), startAt: ev.date, done: stt !== 'pre' });
      });
    }
  } catch (e) {}
  return out.filter(function (g) { return g.startAt && !g.done; }).sort(function (x, y) { return Date.parse(x.startAt) - Date.parse(y.startAt); });
}
app.get('/api/admin/schedule', async (c) => {
  if (!isAdminReq(c)) return c.json({ error: 'unauthorized' }, 401);
  var sport = String(c.req.query('sport') || '');
  var date = String(c.req.query('date') || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !(sport in SPORT_ESPN_PATH)) return c.json({ error: 'bad_request' }, 400);
  var games = await fetchSchedule(sport, date);
  var aps = await apisFill(sport, date, games);
  // PokerStars primero; SportsGameOdds llena los que falten y les pone jugadores.
  var withOdds = games.some(function (g) { return !g.odds; }) ? await addPapiOdds(sport, date, games) : games;
  var sgo = await sgoFill(sport, date, withOdds);
  if (aps.msg) sgo.msg = aps.msg + (sgo.msg ? ' · ' + sgo.msg : '');
  var info = (games.some(function (g) { return !g.odds; }) || !sgo.n) ? (papiLastInfo || {}) : {};
  if (sgo.msg) info.msg = sgo.msg + (info.msg ? ' · ' + info.msg : '');
  var toa = await toaFill(sport, withOdds);
  if (toa.msg && !withOdds.some(function (g) { return g.odds; })) info.msg = (info.msg ? info.msg + ' ' : '') + toa.msg;
  var nOdds = withOdds.filter(function (g) { return g.odds; }).length;
  if (!info.msg && withOdds.length && !nOdds) info.msg = (PAPI_ENABLED ? 'PokerStars tiene ' + (info.fixtures || 0) + ' juegos con cuotas, pero ninguno de este día' + (info.next && info.next.length ? ' (los próximos: ' + info.next.map(function (t) { return prLabelServer(t); }).join(', ') + ')' : '') + '. Las cuotas suelen salir el mismo día o la víspera.'
    : (Bun.env.APISPORTS_KEY || Bun.env.SPORTSGAMEODDS_KEY || Bun.env.THE_ODDS_API_KEY) ? 'La fuente de cuotas todavía no tiene cuotas de este día. Suelen salir el mismo día o la víspera.' : 'No hay ninguna fuente de cuotas conectada: los juegos entran sin cuotas y las pones tú.');
  return c.json({ games: withOdds, papi: nOdds ? null : (info.msg || null) });
});

// ---------- Fuente principal: SportsGameOdds (DraftKings, FanDuel, BetMGM, Caesars…) ----------
// Clave en Railway: SPORTSGAMEODDS_KEY. Plan gratis: 2,500 "objetos" (juegos) al mes.
// Cada juego que devuelve cuenta 1, así que se guarda 10 min y se cuenta lo gastado.
const SGO_LEAGUE = { baloncesto: 'NBA', nfl: 'NFL', nhl: 'NHL', beisbol: 'MLB' };
const SGO_BOOKS = ['draftkings', 'fanduel', 'betmgm', 'caesars', 'espnbet', 'bovada'];
// Estadísticas de jugadores que la página sabe calificar sola (por deporte).
const SGO_PROP_STATS = {
  baloncesto: { points: 'Puntos', rebounds: 'Rebotes', assists: 'Asistencias', threePointersMade: 'Triples', steals: 'Robos', blocks: 'Tapones' },
  nfl: { passing_yards: 'Yardas pase', rushing_yards: 'Yardas carrera', receiving_yards: 'Yardas recepción', receiving_receptions: 'Recepciones' },
  nhl: { points: 'Goles', assists: 'Asistencias', 'goals+assists': 'Puntos', shots_onGoal: 'Tiros al arco', goalie_saves: 'Atajadas' }
};
const SGO_BOOK_NAME = { pokerstars: 'PokerStars', draftkings: 'DraftKings', fanduel: 'FanDuel', betmgm: 'BetMGM', caesars: 'Caesars', espnbet: 'ESPN BET', bovada: 'Bovada' };
var sgoCache = {};
async function sgoUsedThisMonth() {
  const r = await sql`SELECT value FROM app_state WHERE key = 'sgo_usage'`;
  var v = r[0] ? r[0].value : null; if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { v = null; } }
  return v && v.month === new Date().toISOString().slice(0, 7) ? Number(v.count) || 0 : 0;
}
async function sgoCount(n) {
  if (!n) return;
  var month = new Date().toISOString().slice(0, 7);
  try {
    await sql`INSERT INTO app_state (key, value) VALUES ('sgo_usage', jsonb_build_object('month', ${month}::text, 'count', ${n}::int))
      ON CONFLICT (key) DO UPDATE SET value = jsonb_build_object('month', ${month}::text, 'count',
        CASE WHEN app_state.value->>'month' = ${month}::text THEN COALESCE((app_state.value->>'count')::int, 0) + ${n}::int ELSE ${n}::int END)`;
  } catch (e) {}
}
// Juegos de una liga entre dos horas (con cuotas abiertas).
async function sgoEvents(sport, fromIso, toIso) {
  var key = sport + '|' + fromIso + '|' + toIso, hit = sgoCache[key];
  if (hit && Date.now() - hit.t < 10 * 60e3) return hit.v;
  var url = 'https://api.sportsgameodds.com/v2/events?leagueID=' + SGO_LEAGUE[sport] + '&oddsAvailable=true&startsAfter=' + encodeURIComponent(fromIso) +
    '&startsBefore=' + encodeURIComponent(toIso) + '&bookmakerID=' + SGO_BOOKS.join(',') + '&limit=50';
  var r = await fetch(url, { headers: { 'x-api-key': Bun.env.SPORTSGAMEODDS_KEY } });
  var body = null; try { body = await r.json(); } catch (e) {}
  if (!r.ok || !body || body.success === false) throw new Error('status ' + r.status + (body && (body.error || body.message) ? ' · ' + String(body.error || body.message).slice(0, 160) : ''));
  var list = Array.isArray(body.data) ? body.data : [];
  await sgoCount(list.length);
  sgoCache[key] = { t: Date.now(), v: list };
  return list;
}
// Precio de un mercado: primero DraftKings, luego las otras casas; si no, el de consenso.
function sgoPick(o) {
  if (!o) return null;
  var bb = o.byBookmaker || {};
  for (var i = 0; i < SGO_BOOKS.length; i++) {
    var b = bb[SGO_BOOKS[i]];
    if (b && b.available !== false && b.odds) return { dec: amToDec(b.odds), spread: b.spread, ou: b.overUnder, book: SGO_BOOKS[i] };
  }
  if (o.bookOdds && o.bookOddsAvailable !== false) return { dec: amToDec(o.bookOdds), spread: o.bookSpread, ou: o.bookOverUnder, book: null };
  return null;
}
function sgoPlayerName(p) {
  if (!p) return '';
  var fn = String(p.firstName || '').trim(), ln = String(p.lastName || '').trim();
  if (fn && ln) return fn.charAt(0) + '. ' + ln;
  return String(p.name || '').trim();
}
// Llena g.odds (en decimal, igual que PokerStars) con SportsGameOdds.
// Solo PokerStars: no se usan otras casas (DraftKings, FanDuel…). Se cambia en el admin.
var onlyPs = true;
async function loadOnlyPs() { try { const r = await sql`SELECT value FROM app_state WHERE key = 'only_ps'`; var v = r[0] ? r[0].value : null; if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) {} } if (v !== null && v !== undefined) onlyPs = v === true || v === 'true'; } catch (e) {} }
loadOnlyPs(); setInterval(loadOnlyPs, 60000);
app.get('/api/admin/only-ps', async (c) => { if (!isAdminReq(c)) return c.json({ error: 'forbidden' }, 403); await loadOnlyPs(); return c.json({ on: onlyPs }); });
app.post('/api/admin/only-ps', async (c) => {
  if (!isAdminReq(c)) return c.json({ error: 'forbidden' }, 403);
  let b; try { b = await c.req.json(); } catch (e) { return c.json({ error: 'bad_request' }, 400); }
  onlyPs = !!b.on;
  await sql`INSERT INTO app_state (key, value) VALUES ('only_ps', ${JSON.stringify(onlyPs)}::jsonb) ON CONFLICT (key) DO UPDATE SET value = ${JSON.stringify(onlyPs)}::jsonb`;
  return c.json({ on: onlyPs });
});
async function sgoFill(sport, date, games) {
  if (onlyPs) return { n: 0, msg: null };
  if (!Bun.env.SPORTSGAMEODDS_KEY || !SGO_LEAGUE[sport]) return { n: 0, msg: null };
  // Juegos sin cuotas, y juegos con cuotas de PokerStars a los que les faltan jugadores / medio tiempo.
  var need = games.filter(function (g) { return !g.odds || (g.odds.ps && !g.odds.props); }); if (!need.length) return { n: 0, msg: null };
  var ts = need.map(function (g) { return Date.parse(g.startAt); }).filter(function (x) { return !isNaN(x); });
  if (!ts.length) return { n: 0, msg: null };
  var from = new Date(Math.min.apply(null, ts) - 3 * 3600e3).toISOString(), to = new Date(Math.max.apply(null, ts) + 3 * 3600e3).toISOString();
  var evs;
  try { evs = await sgoEvents(sport, from, to); } catch (e) { return { n: 0, msg: 'SportsGameOdds: ' + String(e.message || e) }; }
  var n = 0;
  need.forEach(function (g) {
    var t = Date.parse(g.startAt);
    var ev = evs.find(function (e) {
      var h = e.teams && e.teams.home && e.teams.home.names, a = e.teams && e.teams.away && e.teams.away.names;
      return h && a && Math.abs(Date.parse(e.status && e.status.startsAt) - t) < 3 * 3600e3 && teamNamesMatch(h.long, g.home) && teamNamesMatch(a.long, g.away);
    });
    if (!ev || !ev.odds) return;
    var O = ev.odds, keepPs = g.odds && g.odds.ps ? g.odds : null;
    var mh = sgoPick(O['points-home-game-ml-home']), ma = sgoPick(O['points-away-game-ml-away']);
    if (!mh || !ma || !(mh.dec > 1) || !(ma.dec > 1)) return;
    g.odds = { home: mh.dec, away: ma.dec };
    var sh = sgoPick(O['points-home-game-sp-home']), sa = sgoPick(O['points-away-game-sp-away']);
    if (sh && sa && sh.dec > 1 && sa.dec > 1 && !isNaN(Number(sh.spread)) && !isNaN(Number(sa.spread))) g.odds.hcap = { homeLine: Number(sh.spread), homeOdds: sh.dec, awayLine: Number(sa.spread), awayOdds: sa.dec };
    var hp = { baloncesto: '1h', nfl: '1h', nhl: '1p', beisbol: '1ix5' }[sport];
    if (hp) { var hh = sgoPick(O['points-home-' + hp + '-ml-home']), ha = sgoPick(O['points-away-' + hp + '-ml-away']); if (hh && ha && hh.dec > 1 && ha.dec > 1) g.odds.half = { home: hh.dec, away: ha.dec }; }
    var to2 = sgoPick(O['points-all-game-ou-over']), tu = sgoPick(O['points-all-game-ou-under']);
    if (to2 && tu && to2.dec > 1 && tu.dec > 1 && Number(to2.ou) > 0) g.odds.total = { line: Number(to2.ou), over: to2.dec, under: tu.dec };
    var PS = SGO_PROP_STATS[sport];
    if (PS) {
      var props = [];
      Object.keys(O).forEach(function (id) {
        var o = O[id];
        if (!o || !o.playerID || o.periodID !== 'game' || o.betTypeID !== 'ou' || o.sideID !== 'over' || !PS[o.statID]) return;
        var ov = sgoPick(o), un = sgoPick(O[o.opposingOddID || id.replace(/-over$/, '-under')]);
        if (!ov || !un || !(ov.dec > 1) || !(un.dec > 1) || !(Number(ov.ou) > 0.4)) return;
        props.push({ player: sgoPlayerName(ev.players && ev.players[o.playerID]) || o.playerID, stat: PS[o.statID], line: Number(ov.ou), over: ov.dec, under: un.dec });
      });
      var ORDER = {}; Object.keys(PS).forEach(function (k, i) { ORDER[PS[k]] = i; });
      props.sort(function (a, b) { return (ORDER[a.stat] - ORDER[b.stat]) || (b.line - a.line); });
      if (props.length) g.odds.props = props;
    }
    if (mh.book === 'pokerstars' && ma.book === 'pokerstars') g.odds.ps = true;
    if (keepPs) { if (g.odds.props) keepPs.props = g.odds.props; if (g.odds.half && !keepPs.half) keepPs.half = g.odds.half; g.odds = keepPs; return; }
    g.oddsSrc = SGO_BOOK_NAME[mh.book] || 'SportsGameOdds'; n++;
  });
  return { n: n, msg: null };
}

// ---------- API-Sports (api-sports.io): NBA, NFL, NHL, MLB y LIDOM ----------
// Clave en Railway: APISPORTS_KEY. Plan gratis: 100 consultas por día en CADA deporte.
const APIS_HOST = { baloncesto: 'v1.basketball.api-sports.io', nfl: 'v1.american-football.api-sports.io', nhl: 'v1.hockey.api-sports.io', beisbol: 'v1.baseball.api-sports.io', lidom: 'v1.baseball.api-sports.io' };
const APIS_LEAGUE = { baloncesto: 'NBA', nfl: 'NFL', nhl: 'NHL', beisbol: 'MLB', lidom: 'LIDOM' };
const APIS_DAILY = 100;
var apisCache = {}, apisLastErr = null;
function apisDay() { return new Date().toISOString().slice(0, 10); }
async function apisUsed(host) {
  try {
    const r = await sql`SELECT value FROM app_state WHERE key = 'apis_usage'`;
    var v = r[0] ? r[0].value : null; if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { v = null; } }
    return v && v.day === apisDay() ? Number(v[host]) || 0 : 0;
  } catch (e) { return 0; }
}
async function apisCount(host) {
  try {
    const r = await sql`SELECT value FROM app_state WHERE key = 'apis_usage'`;
    var v = r[0] ? r[0].value : null; if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { v = null; } }
    if (!v || v.day !== apisDay()) v = { day: apisDay() };
    v[host] = (Number(v[host]) || 0) + 1;
    await sql`INSERT INTO app_state (key, value) VALUES ('apis_usage', ${JSON.stringify(v)}::jsonb) ON CONFLICT (key) DO UPDATE SET value = ${JSON.stringify(v)}::jsonb`;
  } catch (e) {}
}
async function apisGet(host, path, ttl) {
  var ck = host + path, hit = apisCache[ck];
  if (hit && Date.now() - hit.t < (ttl || 10 * 60e3)) return hit.v;
  if ((await apisUsed(host)) >= APIS_DAILY - 3) throw new Error('se acabaron las 100 consultas de hoy de este deporte');
  var r = await fetch('https://' + host + path, { headers: { 'x-apisports-key': Bun.env.APISPORTS_KEY } });
  await apisCount(host);
  var body = null; try { body = await r.json(); } catch (e) {}
  var errs = body && body.errors && (Array.isArray(body.errors) ? body.errors.length : Object.keys(body.errors).length) ? JSON.stringify(body.errors).slice(0, 200) : null;
  if (!r.ok || errs) { apisLastErr = 'status ' + r.status + (errs ? ' · ' + errs : ''); throw new Error(apisLastErr); }
  apisCache[ck] = { t: Date.now(), v: body };
  return body;
}
// Liga y temporada actual (se guardan un día).
async function apisLeague(sport) {
  var host = APIS_HOST[sport], name = APIS_LEAGUE[sport];
  var b = await apisGet(host, '/leagues?search=' + encodeURIComponent(name), 24 * 3600e3);
  var list = (b && b.response) || [];
  var pickL = list.find(function (x) { var n = x.name || (x.league && x.league.name) || ''; return n.toUpperCase() === name; }) || list[0];
  if (!pickL) return null;
  var id = pickL.id || (pickL.league && pickL.league.id), seasons = pickL.seasons || [];
  var cur = seasons.find(function (x) { return x.current; }) || seasons[seasons.length - 1];
  var season = cur ? (cur.season !== undefined ? cur.season : cur.year) : new Date().getFullYear();
  return { id: id, season: season };
}
function apisNum(x) { var n = parseFloat(x); return n > 1 ? n : null; }
// Saca ganador, total, hándicap y medio tiempo de la lista de apuestas de una casa.
function apisLines(bets) {
  var out = {}, totals = [], spreads = [];
  (bets || []).forEach(function (bt) {
    var nm = String(bt.name || ''), vals = bt.values || [];
    var get = function (v) { var f = vals.find(function (x) { return String(x.value) === v; }); return f ? apisNum(f.odd) : null; };
    var half = /1st half|first half|1st period|first period|1st 5|first 5|1st five/i.test(nm);
    if (/^(home\/away|moneyline|match winner|3way result)$/i.test(nm.replace(/\s*\(.*\)$/, '')) || /^home\/away/i.test(nm)) {
      var h = get('Home'), a = get('Away');
      if (h && a && !get('Draw')) { if (half && !out.half) out.half = { home: h, away: a }; else if (!half && !out.ml) out.ml = { home: h, away: a }; }
      return;
    }
    if (half) return;
    if (/^over\/under$/i.test(nm) || /^total( points| runs| goals)?$/i.test(nm)) {
      var by = {};
      vals.forEach(function (v) { var m = /^(Over|Under)\s+([\d.]+)$/.exec(String(v.value)); if (m) { by[m[2]] = by[m[2]] || {}; by[m[2]][m[1]] = apisNum(v.odd); } });
      Object.keys(by).forEach(function (L) { if (by[L].Over && by[L].Under) totals.push({ line: parseFloat(L), over: by[L].Over, under: by[L].Under }); });
      return;
    }
    if (/asian handicap|run line|puck line|point spread|^handicap$|^spread$/i.test(nm)) {
      var hb = {};
      vals.forEach(function (v) { var m = /^(Home|Away)\s*([+-]?[\d.]+)$/.exec(String(v.value)); if (m) { var hl = parseFloat(m[2]), key = m[1] === 'Home' ? hl : -hl; hb[key] = hb[key] || {}; hb[key][m[1]] = apisNum(v.odd); } });
      Object.keys(hb).forEach(function (k) { if (hb[k].Home && hb[k].Away) spreads.push({ homeLine: parseFloat(k), home: hb[k].Home, away: hb[k].Away }); });
    }
  });
  var closest = function (list, a, b) { return list.length ? list.slice().sort(function (x, y) { return Math.abs(x[a] - x[b]) - Math.abs(y[a] - y[b]); })[0] : null; };
  out.total = closest(totals, 'over', 'under');
  out.spread = closest(spreads, 'home', 'away');
  return out;
}
async function apisFill(sport, date, games) {
  if (onlyPs) return { n: 0, msg: null };
  if (!Bun.env.APISPORTS_KEY || !APIS_HOST[sport]) return { n: 0, msg: null };
  var need = games.filter(function (g) { return !g.odds; }); if (!need.length) return { n: 0, msg: null };
  var host = APIS_HOST[sport], n = 0;
  try {
    var L = await apisLeague(sport); if (!L) return { n: 0, msg: 'API-Sports no encontró la liga ' + APIS_LEAGUE[sport] + '.' };
    var days = {}; need.forEach(function (g) { days[new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(g.startAt))] = 1; if (date) days[date] = 1; });
    var fixtures = [];
    for (const d of Object.keys(days)) {
      var gb = await apisGet(host, '/games?league=' + L.id + '&season=' + L.season + '&date=' + d);
      fixtures = fixtures.concat((gb && gb.response) || []);
    }
    for (const g of need) {
      var t = Date.parse(g.startAt);
      var fx = fixtures.find(function (f) {
        var hn = f.teams && f.teams.home && f.teams.home.name, an = f.teams && f.teams.away && f.teams.away.name;
        var ft = Date.parse(f.date || (f.game && f.game.date && (f.game.date.date + 'T' + (f.game.date.time || '00:00') + ':00Z')) || '');
        if (!isNaN(ft) && Math.abs(ft - t) > 6 * 3600e3) return false;
        if (sport === 'lidom') return lidomKey(hn) && lidomKey(hn) === lidomKey(g.home) && lidomKey(an) === lidomKey(g.away);
        return teamNamesMatch(hn, g.home) && teamNamesMatch(an, g.away);
      });
      if (!fx) continue;
      var gid = fx.id || (fx.game && fx.game.id);
      var ob = await apisGet(host, '/odds?game=' + gid);
      var books = ((ob && ob.response && ob.response[0]) || {}).bookmakers || [];
      var bk = books.find(function (b) { return /bet365/i.test(b.name); }) || books.find(function (b) { return /pinnacle|1xbet|bwin|unibet/i.test(b.name); }) || books[0];
      if (!bk) continue;
      var Ls = apisLines(bk.bets);
      if (!Ls.ml) continue;
      g.odds = { home: Ls.ml.home, away: Ls.ml.away };
      if (Ls.spread) g.odds.hcap = { homeLine: Ls.spread.homeLine, homeOdds: Ls.spread.home, awayLine: -Ls.spread.homeLine, awayOdds: Ls.spread.away };
      if (Ls.total) g.odds.total = { line: Ls.total.line, over: Ls.total.over, under: Ls.total.under };
      if (Ls.half) g.odds.half = { home: Ls.half.home, away: Ls.half.away };
      g.oddsSrc = bk.name; n++;
    }
  } catch (e) { return { n: n, msg: 'API-Sports: ' + String(e.message || e) }; }
  return { n: n, msg: null };
}
// Prueba: liga encontrada, juegos de hoy y qué apuestas trae el primero.
// Para revisar por qué un juego no se actualiza: lo que trae la fuente para cada juego en vivo.
app.get('/api/admin/auto-import', async (c) => {
  if (!isAdminReq(c)) return c.json({ error: 'forbidden' }, 403);
  var S = await aiSettings();
  return c.json({ on: S.on, props: S.props, sports: S.sports, cut: S.cut, hour: S.hour, days: S.days, log: S.log });
});
app.post('/api/admin/auto-import', async (c) => {
  if (!isAdminReq(c)) return c.json({ error: 'forbidden' }, 403);
  let b; try { b = await c.req.json(); } catch (e) { return c.json({ error: 'bad_request' }, 400); }
  var S = await aiSettings();
  if (b.on !== undefined) S.on = !!b.on;
  if (b.props !== undefined) S.props = !!b.props;
  if (b.sports && typeof b.sports === 'object') AI_SPORTS.forEach(function (sp) { if (b.sports[sp] !== undefined) S.sports[sp] = !!b.sports[sp]; });
  if (b.cut !== undefined) S.cut = Math.min(20, Math.max(0, Number(b.cut) || 0));
  if (b.hour !== undefined) S.hour = Math.min(20, Math.max(5, Math.floor(Number(b.hour) || 9)));
  if (b.days !== undefined) S.days = Math.min(3, Math.max(1, Math.floor(Number(b.days) || 1)));
  await aiSave({ on: S.on, props: S.props, sports: S.sports, cut: S.cut, hour: S.hour, days: S.days, last: S.last, log: S.log });
  var res = null;
  if (b.now) res = await runAutoImport(true);
  return c.json({ ok: true, on: S.on, props: S.props, sports: S.sports, cut: S.cut, hour: S.hour, days: S.days, result: res });
});
// Prueba de SportsGameOdds: qué juegos y cuántos jugadores trae hoy (gasta 1 por juego).
app.get('/api/admin/sgo-test', async (c) => {
  if (!isAdminReq(c)) return c.json({ error: 'forbidden' }, 403);
  if (!Bun.env.SPORTSGAMEODDS_KEY) return c.json({ clave: false, msg: 'No encontré SPORTSGAMEODDS_KEY en Railway.' });
  var sport = String(c.req.query('sport') || 'nhl'); if (sport === 'nba') sport = 'baloncesto';
  var day = prParts(new Date()).ymd, games = [];
  try { games = await fetchSchedule(sport, day); } catch (e) {}
  var r = { n: 0, msg: null };
  try { r = await sgoFill(sport, day, games); } catch (e) { r.msg = String(e.message || e); }
  return c.json({ clave: true, deporte: sport, dia: day, usadosEsteMes: await sgoUsedThisMonth(), error: r.msg,
    juegos: games.map(function (g) { return { juego: g.away + ' @ ' + g.home, cuotas: !!g.odds, de: g.oddsSrc || null, jugadores: g.odds && g.odds.props ? g.odds.props.length : 0, ejemplo: g.odds && g.odds.props ? g.odds.props.slice(0, 3) : [] }; }) });
});
app.post('/api/admin/refresh-odds', async (c) => {
  if (!isAdminReq(c)) return c.json({ error: 'forbidden' }, 403);
  await autoOddsNow();
  const rows = await sql`SELECT value FROM app_state WHERE key = 'matches'`;
  var list = rows[0] ? rows[0].value : []; if (typeof list === 'string') { try { list = JSON.parse(list); } catch (e) { list = []; } }
  var auto = (list || []).filter(function (m) { return m.auto && !m.finished; });
  return c.json({ ok: true, juegos: auto.length, conJugadores: auto.filter(function (m) { return m.props && m.props.length; }).length });
});
app.get('/api/admin/live-debug', async (c) => {
  if (!isAdminReq(c)) return c.json({ error: 'forbidden' }, 403);
  const rows = await sql`SELECT value FROM app_state WHERE key = 'matches'`;
  var list = rows[0] ? rows[0].value : []; if (typeof list === 'string') { try { list = JSON.parse(list); } catch (e) { list = []; } }
  var live = (list || []).filter(function (m) { return m.live || (!m.finished && m.startAt && Date.parse(m.startAt) < Date.now()); });
  var out = { dias: liveDays(), ultimaRevision: lastLiveUpdate ? new Date(lastLiveUpdate).toISOString() : null, haceSegundos: lastLiveUpdate ? Math.round((Date.now() - lastLiveUpdate) / 1000) : null, revisandoAhora: tickBusy, juegos: [] };
  var cache = {};
  for (const m of live) {
    if (!cache[m.sport]) {
      try {
        cache[m.sport] = m.sport === 'beisbol' ? await fetchMlbGamesFromStatsApi() : m.sport === 'lidom' ? await fetchMlbGamesFromStatsApi(17) : m.sport === 'nhl' ? await fetchNhlGamesFromStatsApi()
          : m.sport === 'baloncesto' ? await overlayNbaOfficial(await fetchEspnGames(SPORT_ESPN_PATH[m.sport])) : await fetchEspnGames(SPORT_ESPN_PATH[m.sport]);
      } catch (e) { cache[m.sport] = []; }
    }
    var cand = (cache[m.sport] || []).filter(function (g) { return teamNamesMatch(g.home, lookupEnglishTeam(m.sport, m.home) || m.home) || teamNamesMatch(g.away, lookupEnglishTeam(m.sport, m.away) || m.away); });
    out.juegos.push({ partido: m.away + ' @ ' + m.home, startAt: m.startAt, live: !!m.live, finished: !!m.finished,
      fuente: cand.map(function (g) { return { estado: g.state, marcador: g.awayScore + '-' + g.homeScore, periodo: g.period, hora: g.startTimeUtc, de: g.source || 'espn' }; }),
      totalJuegosFuente: (cache[m.sport] || []).length });
  }
  return c.json(out);
});
app.get('/api/admin/apisports-test', async (c) => {
  if (!isAdminReq(c)) return c.json({ error: 'forbidden' }, 403);
  if (!Bun.env.APISPORTS_KEY) return c.json({ key: false });
  var sport = String(c.req.query('sport') || 'lidom'), out = { key: true, liga: APIS_LEAGUE[sport] };
  try {
    var L = await apisLeague(sport); out.encontrada = L;
    if (L) {
      var day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
      var gb = await apisGet(APIS_HOST[sport], '/games?league=' + L.id + '&season=' + L.season + '&date=' + day);
      var gl = (gb && gb.response) || [];
      out.juegosHoy = gl.slice(0, 4).map(function (f) { return (f.teams.away && f.teams.away.name) + ' @ ' + (f.teams.home && f.teams.home.name); });
      if (gl[0]) {
        var ob = await apisGet(APIS_HOST[sport], '/odds?game=' + (gl[0].id || (gl[0].game && gl[0].game.id)));
        var books = ((ob && ob.response && ob.response[0]) || {}).bookmakers || [];
        out.casas = books.map(function (b) { return b.name; }).slice(0, 8);
        out.apuestas = books[0] ? books[0].bets.map(function (b) { return b.name; }).slice(0, 15) : [];
        out.lineas = books[0] ? apisLines(books[0].bets) : null;
      }
    }
  } catch (e) { out.error = String(e.message || e); }
  out.usadasHoy = await apisUsed(APIS_HOST[sport]);
  return c.json(out);
});

// ---------- Segunda fuente de cuotas: The Odds API (DraftKings / FanDuel) ----------
// Se usa solo cuando PokerStars (OddsPapi) no trae cuotas. Clave en Railway: THE_ODDS_API_KEY.
// Cada búsqueda gasta 3 créditos (ganador + hándicap + total). El plan gratis trae 500 al mes.
const TOA_SPORT = { baloncesto: 'basketball_nba', nfl: 'americanfootball_nfl', nhl: 'icehockey_nhl', beisbol: 'baseball_mlb' };
var toaCache = {}, toaLast = { remaining: null, used: null, at: 0 };
(async function () { try { var r = await sql`SELECT value FROM app_state WHERE key = 'toa_usage'`; var v = r[0] && r[0].value; if (typeof v === 'string') v = JSON.parse(v); if (v && v.remaining !== undefined && toaLast.remaining === null) toaLast = v; } catch (e) {} })();
async function toaFetch(sport) {
  var hit = toaCache[sport];
  if (hit && Date.now() - hit.t < 10 * 60e3) return hit.v;
  var url = 'https://api.the-odds-api.com/v4/sports/' + TOA_SPORT[sport] + '/odds?apiKey=' + encodeURIComponent(Bun.env.THE_ODDS_API_KEY) +
    '&bookmakers=draftkings,fanduel&markets=h2h,spreads,totals&oddsFormat=decimal&dateFormat=iso';
  var r = await fetch(url);
  var rem = r.headers.get('x-requests-remaining'), used = r.headers.get('x-requests-used');
  if (rem !== null) { toaLast = { remaining: Number(rem), used: Number(used), at: Date.now() }; try { await sql`INSERT INTO app_state (key, value) VALUES ('toa_usage', ${JSON.stringify(toaLast)}::jsonb) ON CONFLICT (key) DO UPDATE SET value = ${JSON.stringify(toaLast)}::jsonb`; } catch (e) {} }
  if (!r.ok) { var tx = ''; try { tx = (await r.text()).slice(0, 160); } catch (e) {} throw new Error('status ' + r.status + (tx ? ' · ' + tx : '')); }
  var v = await r.json();
  toaCache[sport] = { t: Date.now(), v: Array.isArray(v) ? v : [] };
  return toaCache[sport].v;
}
// Llena g.odds (en decimal, igual que PokerStars) en los juegos que no tengan.
// Plan pagado (20,000 créditos o más): se traen también los jugadores y se refrescan las cuotas solas.
function toaBig() { return toaLast.remaining !== null && (Number(toaLast.used) || 0) + Number(toaLast.remaining) >= 10000; }
const TOA_PROPS = {
  baloncesto: { player_points: 'Puntos', player_rebounds: 'Rebotes', player_assists: 'Asistencias', player_threes: 'Triples' },
  nfl: { player_pass_yds: 'Yardas pase', player_rush_yds: 'Yardas carrera', player_reception_yds: 'Yardas recepción', player_receptions: 'Recepciones' },
  nhl: { player_points: 'Puntos', player_assists: 'Asistencias', player_shots_on_goal: 'Tiros al arco', player_total_saves: 'Atajadas' },
  beisbol: { pitcher_strikeouts: 'Ponches' }
};
var toaPropCache = {};
// Jugadores de un juego (cada estadística gasta 1 crédito).
async function toaEventProps(sport, evId) {
  var PS = TOA_PROPS[sport]; if (!PS) return [];
  var hit = toaPropCache[evId];
  if (hit && Date.now() - hit.t < 2 * 3600e3) return hit.v;
  var url = 'https://api.the-odds-api.com/v4/sports/' + TOA_SPORT[sport] + '/events/' + encodeURIComponent(evId) + '/odds?apiKey=' + encodeURIComponent(Bun.env.THE_ODDS_API_KEY) +
    '&bookmakers=draftkings,fanduel&markets=' + Object.keys(PS).join(',') + '&oddsFormat=decimal';
  var r = await fetch(url);
  var rem = r.headers.get('x-requests-remaining'), used = r.headers.get('x-requests-used');
  if (rem !== null) { toaLast = { remaining: Number(rem), used: Number(used), at: Date.now() }; try { await sql`INSERT INTO app_state (key, value) VALUES ('toa_usage', ${JSON.stringify(toaLast)}::jsonb) ON CONFLICT (key) DO UPDATE SET value = ${JSON.stringify(toaLast)}::jsonb`; } catch (e) {} }
  if (!r.ok) return [];
  var ev = await r.json(), books = (ev && ev.bookmakers) || [], seen = {}, props = [];
  books.sort(function (a, b) { return (a.key === 'draftkings' ? 0 : 1) - (b.key === 'draftkings' ? 0 : 1); });
  books.forEach(function (bk) {
    (bk.markets || []).forEach(function (m) {
      var stat = PS[m.key]; if (!stat) return;
      var by = {};
      (m.outcomes || []).forEach(function (o) {
        if (!o.description || !(o.price > 1) || !(Number(o.point) > 0.4)) return;
        var k = o.description + '|' + o.point; by[k] = by[k] || { player: String(o.description), line: Number(o.point) };
        if (o.name === 'Over') by[k].over = Number(o.price); else if (o.name === 'Under') by[k].under = Number(o.price);
      });
      // Por jugador, la línea donde Más y Menos están más parejos (la línea principal).
      var best = {};
      Object.keys(by).forEach(function (k) {
        var x = by[k]; if (!x.over || !x.under) return;
        var b = best[x.player]; if (!b || Math.abs(x.over - x.under) < Math.abs(b.over - b.under)) best[x.player] = x;
      });
      Object.keys(best).forEach(function (pl) {
        var sk = pl + '|' + stat; if (seen[sk]) return; seen[sk] = 1;
        var x = best[pl]; props.push({ player: x.player, stat: stat, line: x.line, over: x.over, under: x.under });
      });
    });
  });
  var ORDER = {}; Object.keys(PS).forEach(function (k, i) { ORDER[PS[k]] = i; });
  props.sort(function (a, b) { return (ORDER[a.stat] - ORDER[b.stat]) || (b.line - a.line); });
  toaPropCache[evId] = { t: Date.now(), v: props };
  return props;
}
async function toaFill(sport, games, refresh) {
  if (onlyPs) return { n: 0, msg: null };
  if (!Bun.env.THE_ODDS_API_KEY || !TOA_SPORT[sport]) return { n: 0, msg: null };
  var need = games.filter(function (g) { return refresh ? !(g.odds && g.odds.ps) : !g.odds; }); if (!need.length) return { n: 0, msg: null };
  var evs;
  try { evs = await toaFetch(sport); } catch (e) { return { n: 0, msg: 'The Odds API: ' + String(e.message || e) }; }
  var n = 0;
  need.forEach(function (g) {
    var t = Date.parse(g.startAt);
    var ev = evs.find(function (e) { return Math.abs(Date.parse(e.commence_time) - t) < 3 * 3600e3 && teamNamesMatch(e.home_team, g.home) && teamNamesMatch(e.away_team, g.away); });
    if (!ev) return;
    var bk = (ev.bookmakers || []).find(function (b) { return b.key === 'draftkings'; }) || (ev.bookmakers || [])[0];
    if (!bk) return;
    var mk = {}; (bk.markets || []).forEach(function (m) { mk[m.key] = m.outcomes || []; });
    var side = function (list, name) { return list.find(function (o) { return o.name === name; }); };
    var hH = side(mk.h2h || [], ev.home_team), hA = side(mk.h2h || [], ev.away_team);
    if (!hH || !hA || !(hH.price > 1) || !(hA.price > 1)) return;
    g.odds = { home: Number(hH.price), away: Number(hA.price) };
    var sH = side(mk.spreads || [], ev.home_team), sA = side(mk.spreads || [], ev.away_team);
    if (sH && sA && sH.price > 1 && sA.price > 1) g.odds.hcap = { homeLine: Number(sH.point), homeOdds: Number(sH.price), awayLine: Number(sA.point), awayOdds: Number(sA.price) };
    var tO = side(mk.totals || [], 'Over'), tU = side(mk.totals || [], 'Under');
    if (tO && tU && tO.price > 1 && tU.price > 1) g.odds.total = { line: Number(tO.point), over: Number(tO.price), under: Number(tU.price) };
    g.oddsSrc = bk.title || bk.key; g.toaEv = ev.id; n++;
  });
  // Jugadores: solo con el plan pagado y si quedan créditos de sobra.
  if (toaBig() && TOA_PROPS[sport]) {
    for (const g of need) {
      if (!g.odds || !g.toaEv || Number(toaLast.remaining) < 1500) continue;
      try { var pr = await toaEventProps(sport, g.toaEv); if (pr.length) g.odds.props = pr; } catch (e) {}
    }
  }
  need.forEach(function (g) { delete g.toaEv; });
  return { n: n, msg: null };
}
function prLabelServer(t) {
  var d = new Date(t); if (isNaN(d)) return String(t);
  return new Intl.DateTimeFormat('es-PR', { timeZone: 'America/Puerto_Rico', weekday: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(d);
}
// ---------- OddsPapi: cuotas de PokerStars para "Traer juegos" ----------
// Deportes de OddsPapi: 11 baloncesto, 13 béisbol, 14 fútbol americano, 15 hockey.
const PAPI_SPORT = { baloncesto: 11, beisbol: 13, lidom: 13, nfl: 14, nhl: 15 };
const PAPI_TOURN = { baloncesto: /^nba$/i, beisbol: /^mlb$/i, lidom: /lidom|dominican/i, nfl: /^nfl$/i, nhl: /^nhl$/i };
const papiCache = {};
async function papiCached(key, ms, fn) {
  var c = papiCache[key];
  if (c && Date.now() - c.at < ms) return c.val;
  var val = await fn();
  if (val) papiCache[key] = { at: Date.now(), val: val };
  return val;
}
function papiList(d) { return Array.isArray(d) ? d : d && (d.data || d.items || d.results) || []; }
async function papiTournamentId(sport) {
  return papiCached('t' + sport, 7 * 864e5, async function () {
    var r = await oddsPapi('tournaments', { sportId: PAPI_SPORT[sport] });
    var cands = papiList(r.data).filter(function (x) { return PAPI_TOURN[sport].test(x.tournamentName || '') || PAPI_TOURN[sport].test(x.tournamentSlug || ''); });
    if (sport === 'lidom') {
      // Que no agarre la liga de verano (DSL) ni otras: se prefiere la LIDOM / liga de invierno.
      cands = cands.filter(function (x) { return !/summer|verano|women|femen|u\d|youth/i.test((x.tournamentName || '') + ' ' + (x.tournamentSlug || '')); });
      cands.sort(function (a, b) {
        var sc = function (x) { var n = (x.tournamentName || '') + ' ' + (x.tournamentSlug || ''); return (/lidom/i.test(n) ? 4 : 0) + (/winter|invierno|profesional|professional/i.test(n) ? 2 : 0) + (x.futureFixtures > 0 || x.upcomingFixtures > 0 ? 1 : 0); };
        return sc(b) - sc(a);
      });
    }
    var t = cands[0];
    return t ? t.tournamentId : null;
  });
}
// marketId → { type, handicap, period, names: { outcomeId: '1'|'2'|'X'|'Over'|'Under' } }
async function papiMarkets(sport) {
  return papiCached('m' + PAPI_SPORT[sport], 7 * 864e5, async function () {
    var r = await oddsPapi('markets', { sportId: PAPI_SPORT[sport] });
    var map = {};
    papiList(r.data).forEach(function (m) {
      var names = {}; (m.outcomes || []).forEach(function (o) { names[o.outcomeId] = String(o.outcomeName); });
      map[m.marketId] = { type: String(m.marketType || ''), handicap: Number(m.handicap) || 0, period: String(m.period || ''), names: names, prop: !!m.playerProp };
    });
    return Object.keys(map).length ? map : null;
  });
}
// participantId → nombre (si OddsPapi lo da).
async function papiParticipants(sport) {
  return papiCached('p' + PAPI_SPORT[sport], 7 * 864e5, async function () {
    var r = await oddsPapi('participants', { sportId: PAPI_SPORT[sport] });
    var d = r.data, map = {};
    if (d && !Array.isArray(d) && typeof d === 'object' && !d.data) { Object.keys(d).forEach(function (k) { var v = d[k]; map[k] = typeof v === 'string' ? v : v && (v.participantName || v.name); }); }
    papiList(d).forEach(function (x) { var id = x.participantId || x.id, nm = x.participantName || x.name || x.participantNameEn; if (id != null && nm) map[id] = nm; });
    return Object.keys(map).length ? map : null;
  });
}
// Saca Ganador, hándicap principal y total principal de un partido.
// Qué estadística es un mercado de jugador de OddsPapi. Los triples se miran primero
// ("threepoints", "3pt-made"… también dicen "points" y no deben caer en Puntos).
// Las combinadas (puntos+rebotes, PRA, dobles-dobles) se saltan.
// Jugadores de NHL, NFL y béisbol (PokerStars). Solo lo que la página sabe calificar sola.
const PAPI_PROP_OTHER = {
  nhl: [[/shots?.?on.?goal|\bsog\b|shots/i, 'Tiros al arco'], [/saves?/i, 'Atajadas'], [/goals?(?!ie)/i, 'Goles'], [/assists?/i, 'Asistencias'], [/points?/i, 'Puntos']],
  nfl: [[/pass(ing)?.?y(ar)?ds/i, 'Yardas pase'], [/rush(ing)?.?y(ar)?ds/i, 'Yardas carrera'], [/rec(eiving)?.?y(ar)?ds/i, 'Yardas recepción'], [/receptions?/i, 'Recepciones']],
  beisbol: [[/strike.?outs?|\bks?\b/i, 'Ponches']],
  lidom: [[/strike.?outs?|\bks?\b/i, 'Ponches']]
};
function papiPropStat(type, sport) {
  var t = String(type || '').toLowerCase();
  if (sport && sport !== 'baloncesto') {
    if (/combo|\+|-and-|_and_|&|first|1st|anytime.?td|touchdown|power.?play|ppp|batter|hits?.?allowed|earned/.test(t)) return null;
    var L = PAPI_PROP_OTHER[sport] || [];
    for (var i = 0; i < L.length; i++) if (L[i][0].test(t)) return L[i];
    return null;
  }
  if (/combo|\+|pra|double|-and-|_and_|&/.test(t)) return null;
  if (/three|3pt|3-?point|3pm|threes|3p\b/.test(t)) return [null, 'Triples'];
  var hits = PAPI_PROP_STAT.filter(function (x) { return x[1] !== 'Triples' && x[0].test(t); });
  return hits.length === 1 ? hits[0] : null;
}
const PAPI_PROP_STAT = [[/points/i, 'Puntos'], [/rebound/i, 'Rebotes'], [/assist/i, 'Asistencias'], [/three|3pt|3-point|threes/i, 'Triples'], [/steal/i, 'Robos'], [/block/i, 'Tapones']];
// "Walsh, Jordan" → "J. Walsh" (igual que la lista de jugadores del panel).
function papiPlayerName(n) {
  var m = /^([^,]+),\s*(.+)$/.exec(String(n || '').trim());
  if (m) return m[2].charAt(0).toUpperCase() + '. ' + m[1].trim();
  var w = String(n || '').trim().split(/\s+/); return w.length > 1 ? w[0].charAt(0).toUpperCase() + '. ' + w.slice(1).join(' ') : String(n || '');
}
const PAPI_HALF_RE = /1st.?half|first.?half|firsthalf|\bh1\b|\b1h\b|halftime|1st.?period|first.?period|\bp1\b|\b1p\b|period1|1st.?5|first.?5|f5|1-5/i;
function papiLines(fx, markets, sport) {
  var bk = fx.bookmakerOdds && fx.bookmakerOdds.pokerstars;
  if (!bk || !bk.markets) return null;
  var ml = null, spreads = [], totals = [], halfMl = null;
  var props = {};
  Object.keys(bk.markets).forEach(function (mid) {
    var def = markets[mid]; if (!def) return;
    if (def.prop) {
      // Jugadores (NBA): solo las estadísticas que la página sabe calificar sola.
      // Las combinadas ("points-rebounds", "pra"…) se saltan: la página no las califica sola.
      var stat = papiPropStat(def.type, sport);
      if (!stat || (def.period && def.period !== 'result' && def.period !== 'fulltime')) return;
      var po = bk.markets[mid].outcomes || {}, byPl = {};
      Object.keys(po).forEach(function (oid) {
        var side = def.names[oid], pls = po[oid].players || {};
        Object.keys(pls).forEach(function (pid) {
          var pl = pls[pid]; if (!pl || pl.active === false || !(pl.price > 1) || !pl.playerName) return;
          var e = byPl[pid] = byPl[pid] || { name: pl.playerName, main: false };
          if (side === 'Over') e.over = Number(pl.price); else if (side === 'Under') e.under = Number(pl.price);
          if (pl.mainLine) e.main = true;
        });
      });
      Object.keys(byPl).forEach(function (pid) {
        var e = byPl[pid]; if (!e.over || !e.under) return;
        var k = pid + '|' + stat[1];
        (props[k] = props[k] || []).push({ player: e.name, stat: stat[1], line: def.handicap, over: e.over, under: e.under, main: e.main });
      });
      return;
    }
    var outs = bk.markets[mid].outcomes || {}, pr = {}, main = false;
    Object.keys(outs).forEach(function (oid) {
      var pl = outs[oid].players && outs[oid].players['0'];
      if (!pl || pl.active === false || !(pl.price > 1)) return;
      pr[def.names[oid]] = Number(pl.price); if (pl.mainLine) main = true;
    });
    var full = def.period === 'result' || def.period === 'fulltime' || def.period === '';
    if (!full) {
      // Medio tiempo / 1er período / primeras 5 entradas: ganador a 2 lados (sin empate).
      if (PAPI_HALF_RE.test(def.period + ' ' + def.type) && pr['1'] && pr['2'] && !pr.X && !def.handicap && !/total|handicap|spread/i.test(def.type) && !halfMl) halfMl = { p1: pr['1'], p2: pr['2'] };
      return;
    }
    if (/total/i.test(def.type) && pr.Over && pr.Under) totals.push({ line: def.handicap, over: pr.Over, under: pr.Under, main: main, period: def.period });
    else if (pr['1'] && pr['2'] && !pr.X) {
      if (!def.handicap && !/handicap|spread/i.test(def.type)) { if (!ml || def.period === 'result') ml = { p1: pr['1'], p2: pr['2'] }; }
      else if (def.handicap) spreads.push({ h1: def.handicap, p1: pr['1'], p2: pr['2'], main: main, period: def.period });
    }
  });
  function best(list, a, b) {
    if (!list.length) return null;
    var res = list.filter(function (x) { return x.period === 'result'; }); if (res.length) list = res;
    return list.find(function (x) { return x.main; }) || list.slice().sort(function (x, y) { return Math.abs(x[a] - x[b]) - Math.abs(y[a] - y[b]); })[0];
  }
  if (!ml) return null;
  var sp = best(spreads, 'p1', 'p2');
  // El favorito (cuota más baja) siempre da puntos: si el signo sale al revés, se voltea.
  if (sp && ((ml.p1 < ml.p2 && sp.h1 > 0) || (ml.p1 > ml.p2 && sp.h1 < 0))) sp = { h1: -sp.h1, p1: sp.p1, p2: sp.p2, main: sp.main, period: sp.period };
  var propList = Object.keys(props).map(function (k) {
    var l = props[k];
    return l.find(function (x) { return x.main; }) || l.slice().sort(function (x, y) { return Math.abs(x.over - x.under) - Math.abs(y.over - y.under); })[0];
  }).filter(function (x) { return x.line > 0.4; });
  var ORDER = { Puntos: 0, Rebotes: 1, Asistencias: 2, Triples: 3, Robos: 4, Tapones: 5, 'Yardas pase': 6, 'Yardas carrera': 7, 'Yardas recepción': 8, Recepciones: 9, Goles: 10, 'Tiros al arco': 11, Atajadas: 12, Ponches: 13 };
  propList.sort(function (a, b) { return ((ORDER[a.stat] || 0) - (ORDER[b.stat] || 0)) || (b.line - a.line); });
  return { ml: ml, spread: sp, total: best(totals, 'over', 'under'), props: propList, half: halfMl };
}
// Lo que pasó en la última búsqueda (para que el admin sepa por qué salen sin cuotas).
var papiLastInfo = null;
function papiErrText(x) {
  if (!x) return 'sin respuesta';
  if (x.status === 429) return 'OddsPapi dice que se pasó del límite de consultas (429). La página espera 15 minutos antes de volver a preguntar. Si sigue igual, se acabaron las consultas del mes en tu cuenta de OddsPapi';
  if (x.error) return String(x.error);
  var e = x.data && (x.data.error || x.data.message);
  var msg = e ? (typeof e === 'string' ? e : (e.message || e.code || JSON.stringify(e))) : (x.text || '');
  return 'status ' + x.status + (msg ? ' · ' + String(msg).slice(0, 160) : '');
}
async function addPapiOdds(sport, date, games) {
  papiLastInfo = { sport: sport };
  if (!PAPI_ENABLED || !Bun.env.ODDSPAPI_KEY) return games;
  if (!PAPI_SPORT[sport] || !games.length) return games;
  try {
    var tid = await papiTournamentId(sport); if (!tid) { papiLastInfo.msg = 'OddsPapi no encontró la liga.'; return games; }
    var markets = await papiMarkets(sport); if (!markets) { papiLastInfo.msg = 'OddsPapi no devolvió los tipos de apuesta.'; return games; }
    var parts = await papiParticipants(sport);
    var lastRaw = null;
    var r = await papiCached('o' + tid + date, 10 * 60e3, async function () {
      var x = await oddsPapi('odds-by-tournaments', { bookmaker: 'pokerstars', tournamentIds: String(tid), oddsFormat: 'decimal' });
      lastRaw = x;
      return papiList(x.data).length ? x : null;
    });
    var fixtures = r ? papiList(r.data) : [];
    papiLastInfo.fixtures = fixtures.length;
    if (!fixtures.length) papiLastInfo.msg = 'PokerStars no tiene cuotas de esta liga ahora (' + papiErrText(lastRaw) + ').';
    else papiLastInfo.next = fixtures.map(function (f) { return f.startTime; }).filter(Boolean).sort().slice(0, 3);
    games.forEach(function (g) {
      if (g.odds) return; // ya trae cuotas de SportsGameOdds
      var t = Date.parse(g.startAt);
      var near = fixtures.filter(function (f) { return Math.abs(Date.parse(f.startTime) - t) < 3 * 3600e3; });
      var fx = null, p1Home = true;
      if (parts) {
        near.some(function (f) {
          var n1 = parts[f.participant1Id], n2 = parts[f.participant2Id];
          if (sport === 'lidom') {
            var k1 = lidomKey(n1), k2 = lidomKey(n2), kh = lidomKey(g.home), ka = lidomKey(g.away);
            if (k1 && k2 && k1 === kh && k2 === ka) { fx = f; p1Home = true; return true; }
            if (k1 && k2 && k1 === ka && k2 === kh) { fx = f; p1Home = false; return true; }
            return false;
          }
          if (teamNamesMatch(n1, g.home) && teamNamesMatch(n2, g.away)) { fx = f; p1Home = true; return true; }
          if (teamNamesMatch(n1, g.away) && teamNamesMatch(n2, g.home)) { fx = f; p1Home = false; return true; }
          return false;
        });
      }
      // Sin nombres: solo si es el único partido a esa hora exacta.
      if (!fx) { var same = fixtures.filter(function (f) { return Math.abs(Date.parse(f.startTime) - t) < 60e3; }); var sameG = games.filter(function (x) { return Math.abs(Date.parse(x.startAt) - t) < 60e3; }); if (same.length === 1 && sameG.length === 1) fx = same[0]; }
      if (!fx) return;
      var L = papiLines(fx, markets, sport); if (!L) return;
      // En deportes de EE. UU. el "1" de OddsPapi es el local.
      var H = function (a, b) { return p1Home ? a : b; };
      g.odds = { home: H(L.ml.p1, L.ml.p2), away: H(L.ml.p2, L.ml.p1), ps: true }; g.oddsSrc = 'PokerStars';
      if (L.spread) { var hl = p1Home ? L.spread.h1 : -L.spread.h1; g.odds.hcap = { homeLine: hl, homeOdds: H(L.spread.p1, L.spread.p2), awayLine: -hl, awayOdds: H(L.spread.p2, L.spread.p1) }; }
      if (L.total) g.odds.total = { line: L.total.line, over: L.total.over, under: L.total.under };
      if (L.half) g.odds.half = { home: H(L.half.p1, L.half.p2), away: H(L.half.p2, L.half.p1) };
      // Jugadores de PokerStars (todos los deportes): van tal cual.
      if (L.props && L.props.length) g.odds.propsPs = true;
      if (L.props && L.props.length) g.odds.props = L.props.map(function (x) { return { player: papiPlayerName(x.player), stat: x.stat, line: x.line, over: x.over, under: x.under }; });
    });
  } catch (e) {}
  return games;
}

app.get('/api/admin/oddspapi-usage', async (c) => {
  if (!isAdminReq(c)) return c.json({ error: 'unauthorized' }, 401);
  const r = await sql`SELECT value FROM app_state WHERE key = 'papi_usage'`;
  var v = r[0] ? r[0].value : null; if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { v = null; } }
  var month = new Date().toISOString().slice(0, 7);
  return c.json({ key: PAPI_ENABLED && !!Bun.env.ODDSPAPI_KEY, used: v && v.month === month ? Number(v.count) || 0 : 0, limit: Number(Bun.env.ODDSPAPI_LIMIT) || 250,
    sgo: Bun.env.SPORTSGAMEODDS_KEY ? { used: await sgoUsedThisMonth(), limit: Number(Bun.env.SGO_LIMIT) || 2500 } : null,
    toa: Bun.env.THE_ODDS_API_KEY ? await (async function () { var t = toaLast; if (t.remaining === null) { try { var rr = await sql`SELECT value FROM app_state WHERE key = 'toa_usage'`; var vv = rr[0] && rr[0].value; if (typeof vv === 'string') vv = JSON.parse(vv); if (vv && vv.remaining !== undefined) t = vv; } catch (e) {} } return { remaining: t.remaining, used: t.used }; })() : null,
    apis: Bun.env.APISPORTS_KEY ? await (async function () { var o = {}; for (const sp of ['baloncesto', 'nfl', 'nhl', 'beisbol']) o[sp] = await apisUsed(APIS_HOST[sp]); return o; })() : null });
});

// ---------- OddsPapi: prueba de conexión ----------
// Trae una muestra de lo que devuelve OddsPapi (deportes, casas, ligas y mercados)
// para terminar de conectar las cuotas. Gasta unas 5 consultas del plan.
// Si OddsPapi contesta 429 (demasiadas consultas), se deja de preguntar un rato
// para no gastar más ni empeorar el bloqueo.
var papiBlockedUntil = 0, papiLast429 = 0;
// OddsPapi (PokerStars) está APAGADO. Para volver a usarlo: PAPI_ENABLED = true.
const PAPI_ENABLED = true;
async function oddsPapi(path, params) {
  var key = Bun.env.ODDSPAPI_KEY;
  if (!PAPI_ENABLED || !key) return { error: 'no_key' };
  if (Date.now() < papiBlockedUntil) return { status: 429, data: null, text: 'pausado por límite' };
  // Se acabaron las consultas del mes: no se le pregunta más a OddsPapi hasta el mes que viene
  // (las cuotas salen de DraftKings mientras tanto).
  try { if ((await papiUsedThisMonth()) >= (Number(Bun.env.ODDSPAPI_LIMIT) || 250)) return { status: 429, data: null, text: 'se acabaron las consultas de este mes' }; } catch (e) {}
  var qs = new URLSearchParams(Object.assign({}, params || {}, { apiKey: key })).toString();
  // Cuenta cada consulta del mes (para que el admin vea cuántas le quedan).
  try {
    var month = new Date().toISOString().slice(0, 7);
    await sql`INSERT INTO app_state (key, value) VALUES ('papi_usage', jsonb_build_object('month', ${month}::text, 'count', 1))
      ON CONFLICT (key) DO UPDATE SET value = jsonb_build_object('month', ${month}::text, 'count',
        CASE WHEN app_state.value->>'month' = ${month}::text THEN COALESCE((app_state.value->>'count')::int, 0) + 1 ELSE 1 END)`;
  } catch (e) {}
  try {
    var r = await fetch('https://api.oddspapi.io/v4/' + path + '?' + qs, { headers: { 'Accept': 'application/json' } });
    var text = await r.text();
    if (r.status === 429) { papiLast429 = Date.now(); papiBlockedUntil = Date.now() + 15 * 60 * 1000; }
    var data = null; try { data = JSON.parse(text); } catch (e) {}
    return { status: r.status, data: data, text: data ? null : text.slice(0, 300) };
  } catch (e) { return { error: String(e && e.message || e) }; }
}
function papiShort(x, n) { var t = JSON.stringify(x); return t && t.length > (n || 1500) ? t.slice(0, n || 1500) + '…' : t; }
app.get('/api/admin/oddspapi-test', async (c) => {
  if (!isAdminReq(c)) return c.json({ error: 'unauthorized' }, 401);
  if (!Bun.env.ODDSPAPI_KEY) return c.json({ key: false });
  if (Date.now() < papiBlockedUntil) return c.json({ key: true, aviso: 'OddsPapi bloqueó las consultas por exceso (429) hace ' + Math.round((Date.now() - papiLast429) / 60000) + ' min. Espera 15 minutos y prueba otra vez. Si sigue igual, revisa en oddspapi.io cuántas consultas te quedan del mes.' });
  var out = { key: true };
  var sp = await oddsPapi('sports');
  out.sportsStatus = sp.status || sp.error;
  if (sp.status === 429) return c.json({ key: true, aviso: 'OddsPapi dice que se pasó del límite de consultas (429). Espera 15 minutos y prueba otra vez. Si sigue igual, revisa en oddspapi.io cuántas consultas te quedan del mes.' });
  var sports = Array.isArray(sp.data) ? sp.data : (sp.data && (sp.data.data || sp.data.sports)) || [];
  var want = /basket|baseball|hockey|american/i;
  out.sports = papiShort(sports.filter(function (x) { return want.test(JSON.stringify(x)); }), 800) || papiShort(sp.data || sp.text, 600);
  var bk = await oddsPapi('bookmakers');
  var bks = Array.isArray(bk.data) ? bk.data : (bk.data && (bk.data.data || bk.data.bookmakers)) || [];
  out.bookmakers = papiShort(bks.filter(function (x) { return /poker|stars/i.test(JSON.stringify(x)); }), 600) || papiShort(bk.data || bk.text, 400);
  try {
    var lt = await oddsPapi('tournaments', { sportId: 13 });
    out.lidom = papiShort(papiList(lt.data).filter(function (x) { return /lidom|dominican|winter|invierno/i.test((x.tournamentName || '') + ' ' + (x.tournamentSlug || '')); }).slice(0, 5), 700) || 'no aparece';
    out.lidomUsado = await papiTournamentId('lidom');
    // Mercados de medio tiempo / 1er período / 5 entradas que existen
    try { var mk2 = await papiMarkets('baloncesto'); if (mk2) out.medioTiempo = Object.keys(mk2).map(function (k) { return mk2[k]; }).filter(function (d) { return !d.prop && d.period && d.period !== 'result' && d.period !== 'fulltime'; }).map(function (d) { return d.period + ' · ' + d.type; }).filter(function (x, i, a) { return a.indexOf(x) === i; }).slice(0, 12).join('\n') || 'ninguno'; } catch (e) {}
    // ¿PokerStars tiene cuotas de LIDOM? (para saber por qué salen sin cuotas)
    var lid = out.lidomUsado;
    if (lid) {
      var lo = await oddsPapi('odds-by-tournaments', { bookmaker: 'pokerstars', tournamentIds: String(lid), oddsFormat: 'decimal' });
      var lfx = papiList(lo.data);
      var lparts = await papiParticipants('lidom');
      out.lidomPokerstars = lfx.length + ' juegos con cuotas' + (lo.status && lo.status !== 200 ? ' (status ' + lo.status + ')' : '') + '\n' +
        (lfx.slice(0, 4).map(function (f) { return (lparts && lparts[f.participant1Id] || f.participant1Id) + ' vs ' + (lparts && lparts[f.participant2Id] || f.participant2Id) + ' · ' + f.startTime; }).join('\n') || papiShort(lo.data || lo.text, 400));
      if (!lfx.length) {
        var fxr = await oddsPapi('fixtures', { tournamentId: String(lid) });
        var fxs = papiList(fxr.data);
        var f0 = fxs.find(function (f) { return Date.parse(f.startTime) > Date.now(); }) || fxs[0];
        if (f0) {
          var or = await oddsPapi('odds', { fixtureId: f0.fixtureId, oddsFormat: 'decimal' });
          var bo = or.data && (or.data.bookmakerOdds || (or.data.data && or.data.data.bookmakerOdds));
          out.lidomCasas = 'Juego ' + f0.fixtureId + ' · ' + f0.startTime + '\nCasas con cuotas: ' + (bo ? Object.keys(bo).join(', ') : papiShort(or.data || or.text, 300));
        } else out.lidomCasas = papiShort(fxr.data || fxr.text, 300);
      }
    }
  } catch (e) { out.lidom = 'error'; }
  var bb = sports.find(function (x) { return /basket/i.test(JSON.stringify(x)); });
  var bbId = bb && (bb.sportId || bb.id);
  if (bbId) {
    var tn = await oddsPapi('tournaments', { sportId: bbId });
    var tns = Array.isArray(tn.data) ? tn.data : [];
    out.nba = papiShort(tns.filter(function (x) { return /nba/i.test(JSON.stringify(x)); }).slice(0, 3), 600) || papiShort(tn.data || tn.text, 400);
    var mk = await oddsPapi('markets', { sportId: bbId });
    var mks = Array.isArray(mk.data) ? mk.data : [];
    out.markets = papiShort(mks.filter(function (m) { return !m.playerProp && !/total/i.test(m.marketType || ''); }).slice(0, 8), 1500) || papiShort(mk.data || mk.text, 600);
    var pp = await oddsPapi('participants', { sportId: bbId });
    out.participants = papiShort(Array.isArray(pp.data) ? pp.data.slice(0, 3) : pp.data, 500) || pp.text;
    var nbaT = tns.find(function (x) { return /^nba$/i.test(x.tournamentName || '') || /nba/i.test(x.tournamentSlug || ''); });
    if (nbaT) {
      var bkSlug = (bks.find(function (x) { return /pokerstars/i.test(JSON.stringify(x)); }) || {}).slug || 'pokerstars';
      var od = await oddsPapi('odds-by-tournaments', { bookmaker: bkSlug, tournamentIds: String(nbaT.tournamentId), oddsFormat: 'decimal' });
      var ods = Array.isArray(od.data) ? od.data : [];
      out.oddsStatus = od.status || od.error;
      out.oddsSample = papiShort(ods.slice(0, 1), 1200) || papiShort(od.data || od.text, 600);
      // Jugadores: qué mercados de jugador trae PokerStars y cómo vienen.
      var propDefs = mks.filter(function (m) { return m.playerProp; });
      out.playerMarkets = papiShort(propDefs.slice(0, 6).map(function (m) { return { marketId: m.marketId, marketName: m.marketName, marketType: m.marketType, handicap: m.handicap, period: m.period, outcomes: m.outcomes }; }), 1500) || 'sin mercados de jugador';
      var types = {}; propDefs.forEach(function (m) { types[m.marketType] = (types[m.marketType] || 0) + 1; });
      out.playerTypes = JSON.stringify(types);
      var propIds = {}; propDefs.forEach(function (m) { propIds[m.marketId] = m.marketName; });
      var seenTypes = {};
      ods.forEach(function (f) { var bm = f.bookmakerOdds && f.bookmakerOdds.pokerstars && f.bookmakerOdds.pokerstars.markets || {}; Object.keys(bm).forEach(function (mid) { var d = propDefs.find(function (x) { return String(x.marketId) === mid; }); if (d) seenTypes[d.marketType] = (seenTypes[d.marketType] || 0) + 1; }); });
      out.pokerstarsPlayerTypes = JSON.stringify(seenTypes);
      var sample = [];
      ods.some(function (f) {
        var bm = f.bookmakerOdds && f.bookmakerOdds.pokerstars && f.bookmakerOdds.pokerstars.markets || {};
        Object.keys(bm).forEach(function (mid) { if (propIds[mid] && sample.length < 3) sample.push({ marketId: mid, name: propIds[mid], outcomes: bm[mid].outcomes }); });
        return sample.length >= 3;
      });
      out.playerOdds = papiShort(sample, 2000) || 'PokerStars no trae jugadores en esta muestra';
    }
  }
  return c.json(out);
});

// Resultados de los últimos días (por defecto 14, máximo 60).
app.get('/api/results', async (c) => {
  var days = Math.min(60, Math.max(1, Number(c.req.query('days')) || 14));
  const rows = await sql`SELECT match_id, sport, away, home, away_score, home_score, start_at, finished_at, data FROM results
    WHERE COALESCE(start_at, finished_at) > now() - make_interval(days => ${days})
    ORDER BY COALESCE(start_at, finished_at) DESC LIMIT 400`;
  return c.json(rows.map(function (r) {
    var d = r.data || {};
    return { id: r.match_id, sport: r.sport, away: r.away, home: r.home,
      score: { away: Number(r.away_score), home: Number(r.home_score), period: 'Final' },
      startAt: r.start_at || r.finished_at, finished: true, espnEventId: d.espnEventId || null, archived: true };
  }));
});

// ---------- Precio de cada apuesta, calculado por el servidor ----------
// El pago ya no se toma del teléfono del jugador: se calcula aquí con las
// cuotas actuales de la lista. Si no cuadra con lo que vio el jugador
// (la cuota cambió), se le avisa en vez de aceptar la apuesta.
function amToDec(v) {
  var n = parseInt(v, 10);
  if (!n || isNaN(n)) return null;
  return n > 0 ? 1 + n / 100 : 1 + 100 / Math.abs(n);
}
function numEq(a, b) { return Math.abs(Number(a) - Number(b)) < 0.001; }
// Devuelve la cuota (americana) de una selección, o null si no existe.
function priceOf(m, market, pick) {
  if (!m) return null;
  pick = String(pick || '').trim();
  var mm;
  if (/ — /.test(pick)) {
    var left = pick.split(' — ')[0], right = pick.split(' — ').slice(1).join(' — ');
    if ((mm = /^(Más|Menos)\s+([\d.]+)/.exec(right))) {
      var pr = (m.props || []).find(function (p) { return (left === p.player || left === p.player + ' (' + p.stat + ')') && numEq(p.line, mm[2]); });
      return pr ? (mm[1] === 'Más' ? pr.over : pr.under) : null;
    }
    if (m.halftime) { if (right === m.away) return m.halftime.away; if (right === m.home) return m.halftime.home; }
    return null;
  }
  if ((mm = /^(?:>|Más)\s*([\d.]+)/.exec(pick))) return m.total && numEq(m.total.line, mm[1]) ? m.total.over : null;
  if ((mm = /^(?:<|Menos)\s*([\d.]+)/.exec(pick))) return m.total && numEq(m.total.line, mm[1]) ? m.total.under : null;
  if (market === 'Hándicap' || /^Hándicap\s/.test(pick)) {
    if (!m.handicap) return null;
    var hp = pick.replace(/^Hándicap\s+/, ''), side = null, line;
    if ((mm = /^(.*\S)\s+([+-]?\d+(?:\.\d+)?)$/.exec(hp)) && (mm[1] === m.away || mm[1] === m.home)) { side = mm[1] === m.away ? 'away' : 'home'; line = mm[2]; }
    else if ((mm = /^([+-]?\d+(?:\.\d+)?)$/.exec(hp))) {
      line = mm[1];
      if (numEq(m.handicap.awayLine, line) && !numEq(m.handicap.homeLine, line)) side = 'away';
      else if (numEq(m.handicap.homeLine, line) && !numEq(m.handicap.awayLine, line)) side = 'home';
    }
    if (!side) return null;
    if (side === 'away') return numEq(m.handicap.awayLine, line) ? m.handicap.awayOdds : null;
    return numEq(m.handicap.homeLine, line) ? m.handicap.homeOdds : null;
  }
  var o = m.odds || [];
  if (pick === m.away) return o[2] && o[2].v;
  if (pick === m.home) return o[0] && o[0].v;
  if (pick === 'Empate') return o[1] && o[1].v;
  return null;
}
// Calcula el pago de una apuesta (sencilla o combinada). null si algo no cuadra.
function priceBet(b, byKey) {
  var stake = Number(b.stake);
  if (/^Combinada/i.test(b.desc || '')) {
    var legs = String(b.match || '').split(' · '), dec = 1;
    if (legs.length < 2) return null;
    for (var i = 0; i < legs.length; i++) {
      var p = legs[i].split('@@@'); if (p.length !== 3) return null;
      var tm = /^(Ganador|Hándicap|Total) (.*) vs (.*)$/.exec(p[0]); if (!tm) return null;
      var d = amToDec(priceOf(byKey[matchKey(tm[2], tm[3])], tm[1], p[1]));
      if (!d) return null;
      dec *= d;
    }
    return Math.round(stake * dec * 100) / 100;
  }
  var mm = /^(.*) @ (.*)$/.exec(b.match || ''); if (!mm) return null;
  var key = String(b.desc || '').replace(/\s*\([^)]*\)\s*$/, '');
  var d1 = amToDec(priceOf(byKey[matchKey(mm[1], mm[2])], '', key));
  return d1 ? Math.round(stake * d1 * 100) / 100 : null;
}
// Límites de apuesta (el admin los cambia en el panel).
const DEFAULT_LIMITS = { maxStake: Number(Bun.env.MAX_STAKE) || 500, maxPayout: Number(Bun.env.MAX_PAYOUT) || 5000, maxPropStake: 100, minStake: 1 };
// ¿La apuesta tiene alguna jugada de jugador? ("Nombre (Puntos) — Más 24.5")
function hasPlayerProp(b) {
  var re = / — (Más|Menos) [\d.]+\s*$/;
  if (/^Combinada/i.test(b.desc || '')) return String(b.match || '').split(' · ').some(function (l) { var p = l.split('@@@'); return re.test(p[1] || ''); });
  return re.test(String(b.desc || '').replace(/\s*\([\d.]+\)\s*$/, ''));
}
async function betLimits() {
  const r = await sql`SELECT value FROM app_state WHERE key = 'bet_limits'`;
  var v = r[0] ? r[0].value : null;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { v = null; } }
  return Object.assign({}, DEFAULT_LIMITS, v || {});
}
app.get('/api/bet-limits', async (c) => c.json(await betLimits()));
app.get('/api/admin/bet-limits', async (c) => {
  if (!isAdminReq(c)) return c.json({ error: 'unauthorized' }, 401);
  return c.json(await betLimits());
});
app.post('/api/admin/bet-limits', async (c) => {
  if (!isAdminReq(c)) return c.json({ error: 'unauthorized' }, 401);
  let body = {}; try { body = await c.req.json(); } catch (e) { return c.json({ error: 'bad_request' }, 400); }
  var maxStake = Math.round(Number(body.maxStake) * 100) / 100, maxPayout = Math.round(Number(body.maxPayout) * 100) / 100;
  var maxPropStake = Math.round(Number(body.maxPropStake) * 100) / 100;
  if (!(maxStake >= 1) || !(maxPayout >= maxStake)) return c.json({ error: 'bad_request' }, 400);
  if (!(maxPropStake >= 1)) maxPropStake = Math.min(100, maxStake);
  var v = { maxStake: maxStake, maxPayout: maxPayout, maxPropStake: Math.min(maxPropStake, maxStake), minStake: 1 };
  await sql`INSERT INTO app_state (key, value) VALUES ('bet_limits', ${JSON.stringify(v)}::jsonb)
    ON CONFLICT (key) DO UPDATE SET value = ${JSON.stringify(v)}::jsonb`;
  return c.json(v);
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

  // Validación del lado del servidor: aunque alguien mande la apuesta
  // directo (sin pasar por la pantalla), revisamos que ningún partido
  // referenciado esté ya cerrado para apuestas.
  const matchRows = await sql`SELECT value FROM app_state WHERE key = 'matches'`;
  var currentMatches = matchRows[0] ? matchRows[0].value : [];
  if (typeof currentMatches === 'string') {
    try { currentMatches = JSON.parse(currentMatches); } catch (e) { currentMatches = []; }
  }
  if (!Array.isArray(currentMatches)) currentMatches = [];
  var matchesByKey = indexMatches(currentMatches);
  for (const b of bets) {
    var refs = extractMatchRefs(b.desc, b.match);
    if (!refs) return c.json({ error: 'bad_request' }, 400);
    // En una combinada no puede ir Ganador + Hándicap del mismo partido
    // (ni los dos lados de una misma jugada). Ganador + Total sí se permite.
    var seenGames = {};
    for (const r of refs) {
      var gk = matchKey(r.away, r.home) + '|' + r.group;
      if (seenGames[gk]) return c.json({ error: 'same_game' }, 400);
      seenGames[gk] = true;
    }
    for (const r of refs) {
      if (isBettingClosedServer(matchesByKey[matchKey(r.away, r.home)])) {
        return c.json({ error: 'closed' }, 400);
      }
    }
  }

  // El servidor calcula el pago de cada apuesta y revisa los límites.
  const lim = await betLimits();
  for (const b of bets) {
    var st = Math.round(Number(b.stake) * 100) / 100;
    if (st < lim.minStake) return c.json({ error: 'min_stake', limit: lim.minStake }, 400);
    if (st > lim.maxStake) return c.json({ error: 'max_stake', limit: lim.maxStake }, 400);
    if (hasPlayerProp(b) && st > lim.maxPropStake) return c.json({ error: 'max_prop_stake', limit: lim.maxPropStake }, 400);
    var fair = priceBet(b, matchesByKey);
    if (fair === null) return c.json({ error: 'odds_changed' }, 409);
    // Lo que vio el jugador debe coincidir (con un margen de 1 centavo por redondeo).
    if (Math.abs(fair - Number(b.payout)) > Math.max(0.05, fair * 0.005)) return c.json({ error: 'odds_changed' }, 409);
    if (fair > lim.maxPayout) return c.json({ error: 'max_payout', limit: lim.maxPayout }, 400);
    b.payout = fair;
    b.stake = st;
    // Cada pata de la combinada se guarda con la cuota del SERVIDOR (no la del
    // teléfono): esa cuota se usa luego para anular patas y para el cash out.
    if (/^Combinada/i.test(b.desc || '')) {
      b.match = String(b.match || '').split(' · ').map(function (leg) {
        var p = leg.split('@@@'), tm = /^(Ganador|Hándicap|Total) (.*) vs (.*)$/.exec(p[0]);
        var d = amToDec(priceOf(matchesByKey[matchKey(tm[2], tm[3])], tm[1], p[1]));
        return p[0] + '@@@' + p[1] + '@@@' + d.toFixed(2);
      }).join(' · ');
    }
  }

  // Tope por jugada: lo que un jugador tenga pendiente en la MISMA jugada (aunque
  // lo parta en varios tickets) no puede pasar el máximo por apuesta.
  const prevRows = await sql`SELECT desc_text, match_text, stake FROM bets WHERE user_id = ${user.id} AND status = 'pending' AND deleted_at IS NULL`;
  function selKey(desc, match) { return String(desc || '').replace(/\s*\([\d.]+\)\s*$/, '') + '||' + String(match || '').replace(/@@@[\d.]+/g, ''); }
  var expo = {};
  prevRows.forEach(function (r) { var k = selKey(r.desc_text, r.match_text); expo[k] = (expo[k] || 0) + Number(r.stake); });
  for (const b of bets) {
    var k2 = selKey(b.desc, b.match);
    expo[k2] = (expo[k2] || 0) + Number(b.stake);
    var cap = hasPlayerProp(b) ? lim.maxPropStake : lim.maxStake;
    if (expo[k2] > cap + 0.001) return c.json({ error: 'max_selection', limit: cap, left: Math.max(0, Math.round((cap - (expo[k2] - Number(b.stake))) * 100) / 100) }, 400);
  }

  stakeSum = bets.reduce(function (a, b) { return a + Number(b.stake); }, 0);
  // Se descuenta de una sola vez y solo si alcanza (evita que dos toques seguidos gasten de más).
  const upd = await sql`UPDATE users SET balance = balance - ${stakeSum} WHERE id = ${user.id} AND balance >= ${stakeSum} RETURNING balance`;
  if (!upd[0]) return c.json({ error: 'insufficient' }, 400);
  const newBalance = Number(upd[0].balance);
  const ids = [];
  for (const b of bets) {
    const ins = await sql`
      INSERT INTO bets (user_id, desc_text, match_text, stake, payout)
      VALUES (${user.id}, ${String(b.desc || '')}, ${String(b.match || '')}, ${Number(b.stake)}, ${Number(b.payout) || 0})
      RETURNING id
    `;
    ids.push(ins[0].id);
  }
  return c.json({ balance: newBalance, ids: ids });
});

// Cash out: antes de que empiece el partido, el jugador puede cobrar su apuesta
// por un porcentaje de lo que apostó (CASHOUT_RATE, 0.90 = 90% si no se pone).
const CASHOUT_RATE = Math.min(1, Math.max(0, Number(Bun.env.CASHOUT_RATE) || 0.9));
async function loadMatchesByKey() {
  const matchRows = await sql`SELECT value FROM app_state WHERE key = 'matches'`;
  var list = matchRows[0] ? matchRows[0].value : [];
  if (typeof list === 'string') { try { list = JSON.parse(list); } catch (e) { list = []; } }
  if (!Array.isArray(list)) list = [];
  return indexMatches(list);
}
// Cash out:
// - Sencilla: antes de que empiece el juego, 90% de lo apostado.
// - Combinada: solo cuando ya ganó todas las jugadas y le queda el último juego
//   (que todavía no empieza): pago × probabilidad del último × 90%.
// - Con un juego de la apuesta en curso no hay oferta.
const CASHOUT_MAX_LEFT = 1;
function cashoutQuote(bet, byKey) {
  if (bet.status !== 'pending') return null;
  var stakeOffer = Math.round(Number(bet.stake) * CASHOUT_RATE * 100) / 100;
  if (!/^Combinada/i.test(bet.desc_text || '')) {
    var refs = extractMatchRefs(bet.desc_text, bet.match_text);
    if (!refs || !refs.length) return null;
    for (const r of refs) { if (isBettingClosedServer(byKey[matchKey(r.away, r.home)])) return null; }
    return { amount: stakeOffer, won: 0, left: 1 };
  }
  var legs = String(bet.match_text || '').split(' · ');
  var won = 0, leftOdds = [], payout = Number(bet.payout);
  var LR = bet.leg_results; if (typeof LR === 'string') { try { LR = JSON.parse(LR); } catch (e) { LR = null; } }
  for (var i = 0; i < legs.length; i++) {
    var p = legs[i].split('@@@'); if (p.length !== 3) return null;
    var tm = /^(Ganador|Hándicap|Total) (.*) vs (.*)$/.exec(p[0]); if (!tm) return null;
    var dec = parseFloat(p[2]); if (!(dec > 1)) return null;
    // Jugada ya calificada (incluye jugadores y medio tiempo).
    var lr = Array.isArray(LR) ? LR[i] : null;
    if (lr === 'lost') return null;
    if (lr === 'won') { won++; continue; }
    if (lr === 'push') { payout = payout / dec; continue; }
    var m = byKey[matchKey(tm[2], tm[3])];
    if (!m) return null;
    if (!isBettingClosedServer(m)) { leftOdds.push(dec); continue; }   // todavía no empieza
    if (!m.finished) return null;                                       // se está jugando
    if (/ — /.test(p[1])) return null;                                  // jugador / medio tiempo: lo califica el admin
    var res = gradeSelection(tm[1], tm[2], tm[3], p[1], byKey);
    if (res === null || res === 'lost') return null;
    if (res === 'push') { payout = payout / dec; continue; }
    won++;
  }
  if (!leftOdds.length) return null;                 // ya terminó todo: se paga solo
  // En combinadas solo se ofrece cuando ya ganó todo y le queda el último juego.
  if (!won || leftOdds.length > CASHOUT_MAX_LEFT) return null;
  var chance = leftOdds.reduce(function (a, d) { return a / d; }, 1);
  var amount = Math.floor(payout * chance * CASHOUT_RATE * 100) / 100;
  amount = Math.min(amount, Math.floor(payout * 0.95 * 100) / 100);
  if (!(amount >= 0.5)) return null;
  return { amount: amount, won: won, left: leftOdds.length };
}
function cashoutOffer(bet, matchesByKey) {
  var q = cashoutQuote(bet, matchesByKey);
  return q ? q.amount : null;
}

app.get('/api/bets', async (c) => {
  const user = await getUserFromCookie(c);
  if (!user) return c.json([]);
  const rows = await sql`
    SELECT id, desc_text, match_text, stake, payout, status, created_at, win_seen, leg_results
    FROM bets WHERE user_id = ${user.id} AND deleted_at IS NULL
    ORDER BY created_at DESC LIMIT 60
  `;
  const byKey = await loadMatchesByKey();
  return c.json(rows.map(function (r) {
    return {
      id: r.id,
      desc: r.desc_text, match: r.match_text,
      stake: Number(r.stake), payout: Number(r.payout),
      status: r.status,
      cashout: cashoutOffer(r, byKey),
      cashoutWon: (function () { var q = cashoutQuote(r, byKey); return q ? q.won : 0; })(),
      cashoutLeft: (function () { var q = cashoutQuote(r, byKey); return q ? q.left : 0; })(),
      winSeen: !!r.win_seen,
      legRes: (function () { var v = r.leg_results; if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { v = null; } } return Array.isArray(v) ? v : null; })(),
      createdAt: r.created_at,
      date: new Date(r.created_at).toLocaleDateString('es-DO')
    };
  }));
});

app.post('/api/bets/:id/cashout', async (c) => {
  const user = await getUserFromCookie(c);
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  const id = Number(c.req.param('id'));
  const rows = await sql`SELECT id, desc_text, match_text, stake, status FROM bets WHERE id = ${id} AND user_id = ${user.id} AND deleted_at IS NULL`;
  if (!rows[0]) return c.json({ error: 'not_found' }, 404);
  const offer = cashoutOffer(rows[0], await loadMatchesByKey());
  if (offer === null) return c.json({ error: 'closed' }, 400);
  let body = {}; try { body = await c.req.json(); } catch (e) {}
  const expect = Number(body && body.expect);
  if (expect > 0 && offer < expect - 0.009) return c.json({ error: 'changed', offer: offer }, 409);
  const upd = await sql`UPDATE bets SET status = 'cashout', payout = ${offer}, cashout_at = now()
    WHERE id = ${id} AND status = 'pending' RETURNING id`;
  if (!upd[0]) return c.json({ error: 'closed' }, 400);
  const bal = await sql`UPDATE users SET balance = balance + ${offer} WHERE id = ${user.id} RETURNING balance`;
  return c.json({ balance: Number(bal[0].balance), amount: offer });
});

app.post('/api/bets/seen', async (c) => {
  const user = await getUserFromCookie(c);
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  await sql`UPDATE bets SET win_seen = true WHERE user_id = ${user.id} AND status = 'won' AND win_seen = false`;
  return c.json({ ok: true });
});


// ---------- Juego responsable ----------
const LIMIT_PERIODS = { day: '1 day', week: '7 days', month: '30 days' };

async function limitInfo(userId) {
  // Aplica un cambio pendiente (subir o quitar límite) cuando ya pasaron 24 horas.
  await sql`UPDATE users SET limit_period = limit_pending_period, limit_amount = limit_pending_amount,
    limit_pending_period = NULL, limit_pending_amount = NULL, limit_pending_at = NULL
    WHERE id = ${userId} AND limit_pending_at IS NOT NULL AND limit_pending_at <= now()`;
  const rows = await sql`SELECT limit_period, limit_amount, limit_pending_period, limit_pending_amount, limit_pending_at FROM users WHERE id = ${userId}`;
  const u = rows[0];
  const period = LIMIT_PERIODS[u.limit_period] ? u.limit_period : 'day';
  const used = await sql`SELECT COALESCE(SUM(amount), 0) AS total FROM deposits
    WHERE user_id = ${userId} AND status = 'approved' AND created_at > now() - ${LIMIT_PERIODS[period]}::interval`;
  return {
    period,
    amount: Number(u.limit_amount) || 0,
    used: Number(used[0].total) || 0,
    pending: u.limit_pending_at ? { period: u.limit_pending_period, amount: Number(u.limit_pending_amount) || 0, at: u.limit_pending_at } : null
  };
}

// Llama esto antes de aprobar un depósito (cuando se conecte Stride).
async function depositAllowed(userId, amount) {
  const info = await limitInfo(userId);
  if (info.amount && info.used + amount > info.amount) return { ok: false, error: 'over_limit', left: Math.max(0, info.amount - info.used) };
  return { ok: true };
}

app.get('/api/limits', async (c) => {
  const user = await getUserFromCookie(c);
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  return c.json(await limitInfo(user.id));
});

app.post('/api/limits', async (c) => {
  const user = await getUserFromCookie(c);
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  let body;
  try { body = await c.req.json(); } catch (e) { return c.json({ error: 'bad_request' }, 400); }
  const period = LIMIT_PERIODS[body.period] ? body.period : null;
  const amount = Math.max(0, Math.floor(Number(body.amount) || 0));
  if (!period) return c.json({ error: 'bad_request' }, 400);
  const cur = await limitInfo(user.id);
  // Bajar el límite (o ponerlo por primera vez) aplica enseguida.
  // Subirlo, quitarlo o cambiar el período aplica en 24 horas.
  const stricter = amount > 0 && period === cur.period && (cur.amount === 0 || amount <= cur.amount);
  const firstTime = cur.amount === 0 && amount > 0;
  if (stricter || firstTime) {
    await sql`UPDATE users SET limit_period = ${period}, limit_amount = ${amount},
      limit_pending_period = NULL, limit_pending_amount = NULL, limit_pending_at = NULL WHERE id = ${user.id}`;
    return c.json(await limitInfo(user.id));
  }
  await sql`UPDATE users SET limit_pending_period = ${period}, limit_pending_amount = ${amount},
    limit_pending_at = now() + interval '24 hours' WHERE id = ${user.id}`;
  return c.json(await limitInfo(user.id));
});


// ---------- Verificación de edad ----------
app.get('/api/verify', async (c) => {
  const user = await getUserFromCookie(c);
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  const rows = await sql`SELECT verify_status FROM users WHERE id = ${user.id}`;
  return c.json({ status: rows[0] ? rows[0].verify_status || 'none' : 'none' });
});

app.post('/api/verify', async (c) => {
  const user = await getUserFromCookie(c);
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  let body;
  try { body = await c.req.json(); } catch (e) { return c.json({ error: 'bad_request' }, 400); }
  const dob = new Date(body.dob);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.dob || '')) || isNaN(dob.getTime())) return c.json({ error: 'bad_request' }, 400);
  const age = (Date.now() - dob.getTime()) / (365.25 * 86400000);
  if (age < 18 || age > 120) return c.json({ error: 'underage' }, 400);
  const cur = await sql`SELECT verify_status FROM users WHERE id = ${user.id}`;
  if (cur[0] && cur[0].verify_status === 'verified') return c.json({ status: 'verified' });
  await sql`UPDATE users SET dob = ${body.dob}, verify_status = 'verified' WHERE id = ${user.id}`;
  return c.json({ status: 'verified' });
});


// ---------- Retiros ----------
// El jugador pide el retiro: el dinero sale de su saldo enseguida (queda "apartado")
// y el administrador lo aprueba o lo rechaza. Si se rechaza, vuelve a su saldo.
app.post('/api/withdraw', async (c) => {
  const user = await getUserFromCookie(c);
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  let body;
  try { body = await c.req.json(); } catch (e) { return c.json({ error: 'bad_request' }, 400); }
  const amount = Math.round(Number(body.amount) * 100) / 100;
  if (!amount || amount < 1) return c.json({ error: 'bad_request' }, 400);
  const v = await sql`SELECT verify_status FROM users WHERE id = ${user.id}`;
  if (!v[0] || v[0].verify_status !== 'verified') return c.json({ error: 'not_verified' }, 403);
  var method = await payoutMethod(user.id);
  if (!method) {
    // Sin depósito con tarjeta (saldo puesto por el admin): el jugador dice a dónde se le paga
    // y el admin lo paga a mano al aprobar.
    var pt = body.payTo || {}, ty = pt.type === 'PayPal' ? 'PayPal' : pt.type === 'Zelle' ? 'Zelle' : null;
    var to = String(pt.to || '').trim().slice(0, 120);
    var okTo = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to) || (ty === 'Zelle' && /^\+?[\d\s()-]{10,16}$/.test(to));
    if (!ty || !okTo) return c.json({ error: 'no_deposit_method' }, 400);
    method = { ref: 'manual:' + ty + ':' + to, label: ty + ' · ' + to };
  }
  const upd = await sql`UPDATE users SET balance = balance - ${amount} WHERE id = ${user.id} AND balance >= ${amount} RETURNING balance`;
  if (!upd[0]) return c.json({ error: 'insufficient' }, 400);
  await sql`INSERT INTO withdrawals (user_id, amount, method_ref, method_label) VALUES (${user.id}, ${amount}, ${method.ref}, ${method.label})`;
  return c.json({ balance: Number(upd[0].balance) });
});

// ---------- Stripe: depósitos con tarjeta ----------
// Claves en Railway (NUNCA en el código): STRIPE_SECRET_KEY y STRIPE_WEBHOOK_SECRET.
// Opcionales: STRIPE_MIN (mínimo por depósito, 10) y STRIPE_MAX (máximo por depósito, 1000).
await sql`ALTER TABLE deposits ADD COLUMN IF NOT EXISTS stripe_session TEXT`;
await sql`CREATE UNIQUE INDEX IF NOT EXISTS deposits_stripe_session_uq ON deposits (stripe_session) WHERE stripe_session IS NOT NULL`;
const STRIPE_MIN = () => Math.max(1, Number(Bun.env.STRIPE_MIN) || 10);
const STRIPE_MAX = () => Math.max(STRIPE_MIN(), Number(Bun.env.STRIPE_MAX) || 1000);
function stripeForm(obj, prefix, out) {
  out = out || [];
  Object.keys(obj).forEach(function (k) {
    var v = obj[k], key = prefix ? prefix + '[' + k + ']' : k;
    if (v === undefined || v === null) return;
    if (typeof v === 'object') stripeForm(v, key, out);
    else out.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(v)));
  });
  return out.join('&');
}
async function stripeApi(method, path, params, idem) {
  var h = { Authorization: 'Bearer ' + Bun.env.STRIPE_SECRET_KEY };
  var body = undefined;
  if (method === 'POST') { h['Content-Type'] = 'application/x-www-form-urlencoded'; body = stripeForm(params || {}); if (idem) h['Idempotency-Key'] = idem; }
  var r = await fetch('https://api.stripe.com/v1' + path, { method: method, headers: h, body: body });
  var j = null; try { j = await r.json(); } catch (e) {}
  if (!r.ok) throw new Error((j && j.error && j.error.message) || ('Stripe ' + r.status));
  return j;
}
function siteOrigin(c) {
  if (Bun.env.PUBLIC_URL) return String(Bun.env.PUBLIC_URL).replace(/\/+$/, '');
  var host = c.req.header('x-forwarded-host') || c.req.header('host') || 'www.rapideportes.com';
  var proto = c.req.header('x-forwarded-proto') || (/localhost|127\.0\.0\.1/.test(host) ? 'http' : 'https');
  return proto.split(',')[0].trim() + '://' + host.split(',')[0].trim();
}
// Suma el depósito una sola vez (el webhook y el regreso del jugador pueden llegar los dos).
async function stripeCredit(sessionId) {
  var s = await stripeApi('GET', '/checkout/sessions/' + encodeURIComponent(sessionId) + '?expand[]=payment_intent.payment_method');
  if (!s || s.payment_status !== 'paid' || s.mode !== 'payment') return { ok: false, status: s && s.payment_status };
  var uid = Number((s.metadata && s.metadata.user_id) || s.client_reference_id);
  var amount = Math.round(Number(s.amount_total) || 0) / 100;
  if (!uid || !(amount > 0) || String(s.currency).toLowerCase() !== 'usd') return { ok: false, status: 'bad_session' };
  var pm = s.payment_intent && s.payment_intent.payment_method, card = pm && pm.card;
  var ref = card && card.fingerprint ? 'stripe:card:' + card.fingerprint : 'stripe:' + ((pm && pm.id) || (s.payment_intent && s.payment_intent.id) || s.id);
  var brand = card ? String(card.brand || 'tarjeta') : (pm && pm.type) || 'Stripe';
  var label = card ? brand.charAt(0).toUpperCase() + brand.slice(1) + ' •••• ' + card.last4 : brand;
  var ins = await sql`INSERT INTO deposits (user_id, amount, status, method_ref, method_label, stripe_session)
    VALUES (${uid}, ${amount}, 'approved', ${ref}, ${label}, ${s.id}) ON CONFLICT DO NOTHING RETURNING id`;
  if (ins[0]) await sql`UPDATE users SET balance = balance + ${amount} WHERE id = ${uid}`;
  return { ok: true, uid: uid, amount: amount, fresh: !!ins[0] };
}
app.post('/api/deposit/checkout', async (c) => {
  const user = await getUserFromCookie(c);
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  if (!Bun.env.STRIPE_SECRET_KEY) return c.json({ error: 'not_ready' }, 503);
  let body; try { body = await c.req.json(); } catch (e) { return c.json({ error: 'bad_request' }, 400); }
  const amount = Math.floor(Number(body.amount) || 0);
  if (amount < STRIPE_MIN() || amount > STRIPE_MAX()) return c.json({ error: 'bad_amount', min: STRIPE_MIN(), max: STRIPE_MAX() }, 400);
  const v = await sql`SELECT verify_status FROM users WHERE id = ${user.id}`;
  if (!v[0] || v[0].verify_status !== 'verified') return c.json({ error: 'not_verified' }, 403);
  const lim = await depositAllowed(user.id, amount);
  if (!lim.ok) return c.json({ error: 'over_limit', left: lim.left }, 400);
  const origin = siteOrigin(c);
  try {
    var s = await stripeApi('POST', '/checkout/sessions', {
      mode: 'payment',
      adaptive_pricing: { enabled: 'false' }, // siempre en dólares (USD), sin cambiar a la moneda del país
      client_reference_id: String(user.id),
      customer_email: user.email || undefined,
      line_items: { 0: { quantity: 1, price_data: { currency: 'usd', unit_amount: amount * 100, product_data: { name: 'Depósito a tu saldo RapiDeportes' } } } },
      metadata: { user_id: String(user.id), amount: String(amount) },
      payment_intent_data: { metadata: { user_id: String(user.id) } },
      success_url: origin + '/?deposito=ok&sid={CHECKOUT_SESSION_ID}',
      cancel_url: origin + '/?deposito=cancelado',
      locale: 'es'
    }, 'dep-' + user.id + '-' + amount + '-' + Math.floor(Date.now() / 30000));
    return c.json({ url: s.url });
  } catch (e) {
    console.error('Stripe checkout:', e && e.message);
    return c.json({ error: 'stripe_error' }, 502);
  }
});
// El jugador regresa de Stripe: se confirma el pago y se suma (si el webhook no lo hizo ya).
app.get('/api/deposit/confirm', async (c) => {
  const user = await getUserFromCookie(c);
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  const sid = String(c.req.query('sid') || '');
  if (!/^cs_[A-Za-z0-9_]+$/.test(sid) || !Bun.env.STRIPE_SECRET_KEY) return c.json({ error: 'bad_request' }, 400);
  try {
    var r = await stripeCredit(sid);
    if (!r.ok) return c.json({ status: r.status || 'pending' });
    if (r.uid !== user.id) return c.json({ error: 'forbidden' }, 403);
    const b = await sql`SELECT balance FROM users WHERE id = ${user.id}`;
    return c.json({ status: 'paid', amount: r.amount, balance: Number(b[0].balance) });
  } catch (e) { return c.json({ error: 'stripe_error' }, 502); }
});
// Webhook de Stripe (en Stripe: Developers → Webhooks → https://www.rapideportes.com/api/stripe/webhook).
async function stripeSigOk(raw, header, secret) {
  if (!header || !secret) return false;
  var parts = {}; String(header).split(',').forEach(function (kv) { var i = kv.indexOf('='); if (i > 0) { var k = kv.slice(0, i).trim(); (parts[k] = parts[k] || []).push(kv.slice(i + 1).trim()); } });
  var t = parts.t && parts.t[0]; if (!t || Math.abs(Date.now() / 1000 - Number(t)) > 600) return false;
  var key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  var sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(t + '.' + raw)));
  var hex = Array.prototype.map.call(sig, function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  return (parts.v1 || []).some(function (v) {
    if (v.length !== hex.length) return false;
    var d = 0; for (var i = 0; i < v.length; i++) d |= v.charCodeAt(i) ^ hex.charCodeAt(i); return d === 0;
  });
}
app.post('/api/stripe/webhook', async (c) => {
  const raw = await c.req.raw.text();
  if (!(await stripeSigOk(raw, c.req.header('stripe-signature'), Bun.env.STRIPE_WEBHOOK_SECRET))) return c.json({ error: 'bad_signature' }, 400);
  var ev; try { ev = JSON.parse(raw); } catch (e) { return c.json({ error: 'bad_request' }, 400); }
  if (ev && (ev.type === 'checkout.session.completed' || ev.type === 'checkout.session.async_payment_succeeded') && ev.data && ev.data.object && ev.data.object.id) {
    try { await stripeCredit(ev.data.object.id); } catch (e) { console.error('Stripe webhook:', e && e.message); return c.json({ error: 'retry' }, 500); }
  }
  return c.json({ received: true });
});
app.get('/api/deposit/info', async (c) => c.json({ ready: !!Bun.env.STRIPE_SECRET_KEY, min: STRIPE_MIN(), max: STRIPE_MAX() }));

app.get('/api/payout-method', async (c) => {
  const user = await getUserFromCookie(c);
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  const m = await payoutMethod(user.id);
  return c.json({ label: m ? m.label : null });
});

app.get('/api/withdrawals', async (c) => {
  const user = await getUserFromCookie(c);
  if (!user) return c.json([]);
  const rows = await sql`SELECT id, amount, status, note, created_at FROM withdrawals WHERE user_id = ${user.id} ORDER BY created_at DESC LIMIT 20`;
  return c.json(rows.map(function (r) {
    return { id: r.id, amount: Number(r.amount), status: r.status, note: r.note || '', date: new Date(r.created_at).toLocaleDateString('es-DO') };
  }));
});

app.get('/api/admin/payments', async (c) => {
  if (!isAdminReq(c)) return c.json({ error: 'unauthorized' }, 401);
  // "Hoy" en hora de Puerto Rico / República Dominicana (UTC-4), igual que el resto del panel.
  const dep = await sql`SELECT COALESCE(SUM(amount), 0) AS t, COUNT(*) AS n FROM deposits
    WHERE status = 'approved' AND (created_at - interval '4 hours')::date = (now() - interval '4 hours')::date`;
  const paid = await sql`SELECT COALESCE(SUM(amount), 0) AS t, COUNT(*) AS n FROM withdrawals
    WHERE status = 'approved' AND (reviewed_at - interval '4 hours')::date = (now() - interval '4 hours')::date`;
  const pend = await sql`SELECT COALESCE(SUM(amount), 0) AS t, COUNT(*) AS n FROM withdrawals WHERE status = 'pending'`;
  const pending = await sql`
    SELECT w.id, w.amount, w.created_at, w.method_label, u.email, u.balance, u.created_at AS joined,
      (SELECT COUNT(*) FROM bets b WHERE b.user_id = u.id) AS bets_count,
      (SELECT COALESCE(SUM(payout), 0) FROM bets b WHERE b.user_id = u.id AND b.status = 'won') AS won_total,
      (SELECT COALESCE(SUM(amount), 0) FROM deposits d WHERE d.user_id = u.id AND d.status = 'approved') AS deposited_total,
      (SELECT COALESCE(SUM(stake), 0) FROM bets b WHERE b.user_id = u.id) AS staked_total,
      (SELECT COALESCE(SUM(stake), 0) FROM bets b WHERE b.user_id = u.id AND b.status = 'void') AS refunded_total,
      (SELECT COALESCE(SUM(payout), 0) FROM bets b WHERE b.user_id = u.id AND b.status = 'cashout') AS cashout_total,
      (SELECT COALESCE(SUM(amount), 0) FROM withdrawals x WHERE x.user_id = u.id AND x.status <> 'rejected') AS withdrawn_total,
      (SELECT COALESCE(SUM(amount), 0) FROM balance_adjustments a WHERE a.user_id = u.id) AS adjusted_total
    FROM withdrawals w JOIN users u ON u.id = w.user_id
    WHERE w.status = 'pending' ORDER BY w.created_at ASC LIMIT 100`;
  const recentW = await sql`SELECT w.id, w.amount, w.status, w.note, w.created_at, w.reviewed_at, w.method_label, u.email
    FROM withdrawals w JOIN users u ON u.id = w.user_id WHERE w.status <> 'pending' ORDER BY w.reviewed_at DESC NULLS LAST LIMIT 30`;
  const recentD = await sql`SELECT d.id, d.amount, d.status, d.created_at, d.method_label, u.email
    FROM deposits d JOIN users u ON u.id = d.user_id WHERE d.status <> 'pending' ORDER BY d.created_at DESC LIMIT 30`;
  const pendD = await sql`SELECT d.id, d.amount, d.created_at, d.method_label, d.note, u.email, u.balance
    FROM deposits d JOIN users u ON u.id = d.user_id WHERE d.status = 'pending' ORDER BY d.created_at ASC LIMIT 100`;
  return c.json({
    summary: {
      depositsToday: Number(dep[0].t), depositsTodayCount: Number(dep[0].n),
      paidToday: Number(paid[0].t), paidTodayCount: Number(paid[0].n),
      pendingTotal: Number(pend[0].t), pendingCount: Number(pend[0].n)
    },
    pending: pending.map(function (r) {
      // Cuadre: lo que debería tener según su historial vs. su saldo real.
      // Depósitos + premios + reembolsos + cash out − todo lo apostado − retiros (pedidos o pagados).
      var expected = Number(r.deposited_total) + Number(r.won_total) + Number(r.refunded_total) + Number(r.cashout_total)
        - Number(r.staked_total) - Number(r.withdrawn_total) + Number(r.adjusted_total);
      expected = Math.round(expected * 100) / 100;
      return {
        audit: {
          deposited: Number(r.deposited_total), won: Number(r.won_total), refunded: Number(r.refunded_total), cashout: Number(r.cashout_total), adjusted: Number(r.adjusted_total),
          staked: Number(r.staked_total), withdrawn: Number(r.withdrawn_total), expected: expected,
          ok: Math.abs(expected - Number(r.balance)) < 0.01
        }, id: r.id, amount: Number(r.amount), createdAt: r.created_at, methodLabel: r.method_label || '', email: r.email, balance: Number(r.balance), joined: r.joined,
        betsCount: Number(r.bets_count), wonTotal: Number(r.won_total), depositedTotal: Number(r.deposited_total) };
    }),
    withdrawals: recentW.map(function (r) { return { id: r.id, amount: Number(r.amount), status: r.status, note: r.note || '', createdAt: r.created_at, reviewedAt: r.reviewed_at, methodLabel: r.method_label || '', email: r.email }; }),
    deposits: recentD.map(function (r) { return { id: r.id, amount: Number(r.amount), status: r.status, createdAt: r.created_at, methodLabel: r.method_label || '', email: r.email }; }),
    pendingDeposits: pendD.map(function (r) { return { id: r.id, amount: Number(r.amount), createdAt: r.created_at, methodLabel: r.method_label || '', note: r.note || '', email: r.email, balance: Number(r.balance) }; })
  });
});

// El jugador avisa que sigue en la página; de paso recibe su saldo al día.
app.get('/api/ping', async (c) => {
  const user = await getUserFromCookie(c);
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  return c.json({ balance: Number(user.balance) });
});

// ---------- Panel: Jugadores ----------
app.get('/api/admin/players', async (c) => {
  if (!isAdminReq(c)) return c.json({ error: 'unauthorized' }, 401);
  const q = String(c.req.query('q') || '').trim().slice(0, 100);
  const like = '%' + q.replace(/[\\%_]/g, '\\$&') + '%';
  const rows = q
    ? await sql`SELECT id, email, balance, created_at, last_seen FROM users WHERE email ILIKE ${like} OR CAST(id AS TEXT) = ${q} ORDER BY last_seen DESC NULLS LAST, id DESC LIMIT 300`
    : await sql`SELECT id, email, balance, created_at, last_seen FROM users ORDER BY last_seen DESC NULLS LAST, id DESC LIMIT 300`;
  const total = await sql`SELECT COUNT(*) AS n FROM users`;
  var online = 0;
  lastSeenMem.forEach(function (t) { if (Date.now() - t < ONLINE_MS) online++; });
  const list = rows.map(function (r) {
    const mem = lastSeenMem.get(r.id);
    return { id: r.id, email: r.email, balance: Number(r.balance), joined: r.created_at,
      lastSeen: mem ? new Date(mem).toISOString() : r.last_seen, online: isOnline(r.id) };
  });
  list.sort(function (a, b) { return (b.online ? 1 : 0) - (a.online ? 1 : 0); });
  return c.json({ online: online, total: Number(total[0].n), players: list });
});

app.get('/api/admin/players/:id', async (c) => {
  if (!isAdminReq(c)) return c.json({ error: 'unauthorized' }, 401);
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.json({ error: 'not_found' }, 404);
  const u = await sql`SELECT id, email, balance, created_at, last_seen, verify_status, dob, limit_period, limit_amount FROM users WHERE id = ${id}`;
  if (!u[0]) return c.json({ error: 'not_found' }, 404);
  const t = await sql`SELECT
      (SELECT COALESCE(SUM(amount), 0) FROM deposits WHERE user_id = ${id} AND status = 'approved') AS deposited,
      (SELECT COUNT(*) FROM deposits WHERE user_id = ${id} AND status = 'approved') AS deposits_n,
      (SELECT COALESCE(SUM(amount), 0) FROM withdrawals WHERE user_id = ${id} AND status = 'approved') AS withdrawn,
      (SELECT COALESCE(SUM(amount), 0) FROM withdrawals WHERE user_id = ${id} AND status = 'pending') AS withdraw_pending,
      (SELECT COALESCE(SUM(amount), 0) FROM withdrawals WHERE user_id = ${id} AND status <> 'rejected') AS withdrawn_all,
      (SELECT COALESCE(SUM(stake), 0) FROM bets WHERE user_id = ${id}) AS staked,
      (SELECT COUNT(*) FROM bets WHERE user_id = ${id}) AS bets_n,
      (SELECT COUNT(*) FROM bets WHERE user_id = ${id} AND status = 'won') AS won_n,
      (SELECT COUNT(*) FROM bets WHERE user_id = ${id} AND status = 'lost') AS lost_n,
      (SELECT COUNT(*) FROM bets WHERE user_id = ${id} AND status = 'pending' AND deleted_at IS NULL) AS pending_n,
      (SELECT COALESCE(SUM(stake), 0) FROM bets WHERE user_id = ${id} AND status = 'pending' AND deleted_at IS NULL) AS pending_stake,
      (SELECT COUNT(*) FROM bets WHERE user_id = ${id} AND deleted_at IS NOT NULL) AS deleted_n,
      (SELECT COALESCE(SUM(payout), 0) FROM bets WHERE user_id = ${id} AND status = 'won') AS won,
      (SELECT COALESCE(SUM(stake), 0) FROM bets WHERE user_id = ${id} AND status = 'void') AS refunded,
      (SELECT COALESCE(SUM(payout), 0) FROM bets WHERE user_id = ${id} AND status = 'cashout') AS cashout,
      (SELECT COALESCE(SUM(amount), 0) FROM balance_adjustments WHERE user_id = ${id} AND amount > 0) AS credited,
      (SELECT COALESCE(SUM(-amount), 0) FROM balance_adjustments WHERE user_id = ${id} AND amount < 0) AS debited`;
  const bets = await sql`SELECT id, desc_text, match_text, stake, payout, status, created_at, leg_results FROM bets WHERE user_id = ${id} AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 100`;
  const byKeyP = bets.some(function (b) { return b.status === 'pending'; }) ? await loadMatchesByKey() : {};
  const deps = await sql`SELECT id, amount, status, method_label, created_at FROM deposits WHERE user_id = ${id} ORDER BY created_at DESC LIMIT 100`;
  const wds = await sql`SELECT id, amount, status, note, method_label, created_at, reviewed_at FROM withdrawals WHERE user_id = ${id} ORDER BY created_at DESC LIMIT 100`;
  const adj = await sql`SELECT id, amount, note, balance_after, created_at FROM balance_adjustments WHERE user_id = ${id} ORDER BY created_at DESC LIMIT 100`;
  const T = t[0], N = function (x) { return Number(x) || 0; };
  const expected = Math.round((N(T.deposited) + N(T.won) + N(T.refunded) + N(T.cashout) - N(T.staked) - N(T.withdrawn_all) + N(T.credited) - N(T.debited)) * 100) / 100;
  const user = u[0], mem = lastSeenMem.get(id);
  const pm = await payoutMethod(id);
  return c.json({
    id: user.id, email: user.email, balance: N(user.balance), joined: user.created_at,
    lastSeen: mem ? new Date(mem).toISOString() : user.last_seen, online: isOnline(id),
    verify: user.verify_status || 'none', dob: user.dob, limit: { period: user.limit_period, amount: N(user.limit_amount) },
    payoutMethod: pm ? pm.label : null,
    totals: { deposited: N(T.deposited), depositsCount: N(T.deposits_n), withdrawn: N(T.withdrawn), withdrawPending: N(T.withdraw_pending),
      staked: N(T.staked), betsCount: N(T.bets_n), wonCount: N(T.won_n), lostCount: N(T.lost_n), pendingCount: N(T.pending_n), pendingStake: N(T.pending_stake), deletedCount: N(T.deleted_n),
      won: N(T.won), refunded: N(T.refunded), cashout: N(T.cashout), credited: N(T.credited), debited: N(T.debited),
      expected: expected, ok: Math.abs(expected - N(user.balance)) < 0.01 },
    bets: bets.map(function (b) { var q = b.status === 'pending' ? cashoutQuote(b, byKeyP) : null; var lr = b.leg_results; if (typeof lr === 'string') { try { lr = JSON.parse(lr); } catch (e) { lr = null; } }
      return { id: b.id, desc: b.desc_text, match: b.match_text, stake: N(b.stake), payout: N(b.payout), status: b.status, createdAt: b.created_at, legRes: Array.isArray(lr) ? lr : null, cashout: q ? q.amount : null, cashoutLeft: q ? q.left : 0 }; }),
    deposits: deps.map(function (d) { return { id: d.id, amount: N(d.amount), status: d.status, method: d.method_label || '', createdAt: d.created_at }; }),
    withdrawals: wds.map(function (w) { return { id: w.id, amount: N(w.amount), status: w.status, note: w.note || '', method: w.method_label || '', createdAt: w.created_at, reviewedAt: w.reviewed_at }; }),
    adjustments: adj.map(function (a) { return { id: a.id, amount: N(a.amount), note: a.note || '', balanceAfter: a.balance_after == null ? null : N(a.balance_after), createdAt: a.created_at }; })
  });
});

// Recargar (type: 'credit') o descontar (type: 'debit') saldo a mano.
// El admin le pone una contraseña temporal a un jugador (para dársela por WhatsApp).
app.post('/api/admin/players/:id/password', async (c) => {
  if (!isAdminReq(c)) return c.json({ error: 'unauthorized' }, 401);
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.json({ error: 'not_found' }, 404);
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  var r = new Uint8Array(8); crypto.getRandomValues(r);
  const temp = Array.from(r, function (b) { return abc[b % abc.length]; }).join('');
  const hash = await Bun.password.hash(temp);
  const rows = await sql`UPDATE users SET password_hash = ${hash} WHERE id = ${id} RETURNING email`;
  if (!rows[0]) return c.json({ error: 'not_found' }, 404);
  await sql`DELETE FROM sessions WHERE user_id = ${id}`;
  return c.json({ ok: true, email: rows[0].email, password: temp });
});

app.post('/api/admin/players/:id/adjust', async (c) => {
  if (!isAdminReq(c)) return c.json({ error: 'unauthorized' }, 401);
  let body;
  try { body = await c.req.json(); } catch (e) { return c.json({ error: 'bad_request' }, 400); }
  const id = Number(c.req.param('id'));
  const amount = Math.round(Number(body.amount) * 100) / 100;
  const type = body.type === 'debit' ? 'debit' : body.type === 'credit' ? 'credit' : null;
  const note = body.note ? String(body.note).trim().slice(0, 200) : null;
  if (!Number.isInteger(id) || !type || !(amount > 0) || amount > 1000000) return c.json({ error: 'bad_request' }, 400);
  const rows = type === 'credit'
    ? await sql`UPDATE users SET balance = balance + ${amount} WHERE id = ${id} RETURNING balance`
    : await sql`UPDATE users SET balance = balance - ${amount} WHERE id = ${id} AND balance >= ${amount} RETURNING balance`;
  if (!rows[0]) {
    const exists = await sql`SELECT balance FROM users WHERE id = ${id}`;
    if (!exists[0]) return c.json({ error: 'not_found' }, 404);
    return c.json({ error: 'insufficient', balance: Number(exists[0].balance) }, 400);
  }
  const after = Number(rows[0].balance);
  await sql`INSERT INTO balance_adjustments (user_id, amount, note, balance_after) VALUES (${id}, ${type === 'credit' ? amount : -amount}, ${note}, ${after})`;
  return c.json({ ok: true, balance: after });
});

app.post('/api/admin/withdrawals/:id', async (c) => {
  if (!isAdminReq(c)) return c.json({ error: 'unauthorized' }, 401);
  let body;
  try { body = await c.req.json(); } catch (e) { return c.json({ error: 'bad_request' }, 400); }
  const id = Number(c.req.param('id'));
  const approve = body.approve === true;
  const note = body.note ? String(body.note).slice(0, 300) : null;
  const rows = await sql`UPDATE withdrawals SET status = ${approve ? 'approved' : 'rejected'}, note = ${note}, reviewed_at = now()
    WHERE id = ${id} AND status = 'pending' RETURNING user_id, amount`;
  if (!rows[0]) return c.json({ error: 'not_found' }, 404);
  // Rechazado: el dinero vuelve al saldo del jugador.
  if (!approve) await sql`UPDATE users SET balance = balance + ${Number(rows[0].amount)} WHERE id = ${rows[0].user_id}`;
  return c.json({ ok: true });
});

// ---------- Otras formas de recargar (Zelle, PayPal, bancos de RD) ----------
// Los datos los pone el dueño en el admin. El jugador paga por su cuenta, avisa en la página
// ("Ya envié el pago") y el admin lo aprueba: ahí se le suma el saldo.
await sql`ALTER TABLE deposits ADD COLUMN IF NOT EXISTS note TEXT`;
await sql`ALTER TABLE deposits ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ`;
const PM_KEYS = ['zelle', 'paypal', 'rd'];
async function payMethods() {
  const r = await sql`SELECT value FROM app_state WHERE key = 'pay_methods'`;
  var v = r[0] ? r[0].value : null; if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { v = null; } }
  // Si todavía no se ha guardado nada en el admin, se usan las cuentas del dueño.
  v = v || { whatsapp: '', zelle: { on: true, id: 'elmcyey159@gmail.com', name: 'Jefry Pérez' }, paypal: { on: false },
    rd: { on: true, rate: 0, banks: [{ bank: 'Banreservas', holder: 'Yordy Tavarez', acct: '9603846627' }, { bank: 'Banco Popular', holder: 'Jefry Pérez', acct: '0836263665' }] } };
  var clean = function (x, n) { return String(x == null ? '' : x).trim().slice(0, n || 80); };
  return {
    // Por defecto las cuentas NO salen en la página: el jugador las pide por WhatsApp.
    showAccounts: v.showAccounts === true,
    whatsapp: clean(v.whatsapp, 20).replace(/[^0-9]/g, ''),
    zelle: { on: !!(v.zelle && v.zelle.on), id: clean(v.zelle && v.zelle.id), name: clean(v.zelle && v.zelle.name) },
    paypal: { on: !!(v.paypal && v.paypal.on), id: clean(v.paypal && v.paypal.id), link: clean(v.paypal && v.paypal.link, 160) },
    rd: { on: !!(v.rd && v.rd.on), rate: Number(v.rd && v.rd.rate) || 0, banks: ((v.rd && v.rd.banks) || []).slice(0, 4).map(function (b) {
      return { bank: clean(b.bank, 40), holder: clean(b.holder, 60), type: clean(b.type, 30), acct: clean(b.acct, 30), doc: clean(b.doc, 30) };
    }).filter(function (b) { return b.bank && b.acct; }) }
  };
}
app.get('/api/pay-methods', async (c) => {
  var P = await payMethods(), out = { whatsapp: P.whatsapp, showAccounts: P.showAccounts };
  if (P.zelle.on && P.zelle.id) out.zelle = P.showAccounts ? P.zelle : { on: true };
  if (P.paypal.on && (P.paypal.id || P.paypal.link)) out.paypal = P.showAccounts ? P.paypal : { on: true };
  if (P.rd.on && P.rd.banks.length) out.rd = P.showAccounts ? P.rd : { on: true, rate: P.rd.rate, banks: [] };
  return c.json(out);
});
app.get('/api/admin/pay-methods', async (c) => {
  if (!isAdminReq(c)) return c.json({ error: 'unauthorized' }, 401);
  return c.json(await payMethods());
});
app.post('/api/admin/pay-methods', async (c) => {
  if (!isAdminReq(c)) return c.json({ error: 'unauthorized' }, 401);
  let b; try { b = await c.req.json(); } catch (e) { return c.json({ error: 'bad_request' }, 400); }
  await sql`INSERT INTO app_state (key, value) VALUES ('pay_methods', ${JSON.stringify(b || {})}::jsonb) ON CONFLICT (key) DO UPDATE SET value = ${JSON.stringify(b || {})}::jsonb`;
  return c.json(await payMethods());
});
// El jugador avisa que ya pagó por Zelle / PayPal / banco.
app.post('/api/deposit/manual', async (c) => {
  const user = await getUserFromCookie(c);
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  let b; try { b = await c.req.json(); } catch (e) { return c.json({ error: 'bad_request' }, 400); }
  var P = await payMethods(), m = String(b.method || '');
  if (PM_KEYS.indexOf(m) < 0 || !P[m].on) return c.json({ error: 'bad_method' }, 400);
  const amount = Math.round((Number(b.amount) || 0) * 100) / 100;
  if (!(amount >= 1) || amount > 10000) return c.json({ error: 'bad_amount' }, 400);
  const v = await sql`SELECT verify_status FROM users WHERE id = ${user.id}`;
  if (!v[0] || v[0].verify_status !== 'verified') return c.json({ error: 'not_verified' }, 403);
  const lim = await depositAllowed(user.id, amount);
  if (!lim.ok) return c.json({ error: 'over_limit', left: lim.left }, 400);
  const open = await sql`SELECT COUNT(*) AS n FROM deposits WHERE user_id = ${user.id} AND status = 'pending'`;
  if (Number(open[0].n) >= 3) return c.json({ error: 'too_many' }, 429);
  var label = { zelle: 'Zelle', paypal: 'PayPal', rd: 'Transferencia RD' }[m];
  var ref = String(b.ref || '').trim().slice(0, 120);
  await sql`INSERT INTO deposits (user_id, amount, status, method_ref, method_label, note) VALUES (${user.id}, ${amount}, 'pending', ${'manual:' + m}, ${label}, ${ref || null})`;
  return c.json({ ok: true });
});
app.get('/api/deposit/mine', async (c) => {
  const user = await getUserFromCookie(c);
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  const rows = await sql`SELECT id, amount, status, method_label, note, created_at FROM deposits WHERE user_id = ${user.id} AND method_ref LIKE 'manual:%' ORDER BY id DESC LIMIT 10`;
  return c.json(rows.map(function (r) { return { id: r.id, amount: Number(r.amount), status: r.status, method: r.method_label, createdAt: r.created_at }; }));
});
app.post('/api/admin/deposits/:id', async (c) => {
  if (!isAdminReq(c)) return c.json({ error: 'unauthorized' }, 401);
  let b; try { b = await c.req.json(); } catch (e) { return c.json({ error: 'bad_request' }, 400); }
  const id = Number(c.req.param('id'));
  const approve = b.approve === true;
  // El admin puede corregir el monto si el jugador escribió otro.
  var amt = b.amount !== undefined ? Math.round((Number(b.amount) || 0) * 100) / 100 : null;
  if (approve && amt !== null && !(amt > 0)) return c.json({ error: 'bad_amount' }, 400);
  const rows = approve
    ? await sql`UPDATE deposits SET status = 'approved', amount = COALESCE(${amt}, amount), reviewed_at = now() WHERE id = ${id} AND status = 'pending' RETURNING user_id, amount`
    : await sql`UPDATE deposits SET status = 'rejected', reviewed_at = now() WHERE id = ${id} AND status = 'pending' RETURNING user_id, amount`;
  if (!rows[0]) return c.json({ error: 'not_found' }, 404);
  if (approve) await sql`UPDATE users SET balance = balance + ${Number(rows[0].amount)} WHERE id = ${rows[0].user_id}`;
  return c.json({ ok: true });
});

// El depósito de prueba ($1,000 gratis) y "Reiniciar saldo" se quitaron.
// Los depósitos reales entran cuando se conecte Stride (ver depositAllowed).
app.post('/api/deposit', async (c) => {
  const user = await getUserFromCookie(c);
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  return c.json({ error: 'payments_not_connected' }, 503);
});

// Trae los lanzadores probables de hoy (solo MLB por ahora, que es la
// única liga donde calificamos apuestas de lanzador), tal como MLB los
// reporta: nombre exacto y con acentos/espacios correctos, para que el
// admin solo tenga que buscarlos y tocarlos, sin escribirlos a mano.
async function fetchProbablePitchers() {
  var games = await fetchMlbGamesFromStatsApi();
  return games.map(function (g) {
    return { away: g.away, home: g.home, awayPitcher: g.awayPitcher, homePitcher: g.homePitcher };
  });
}

// ---------- Tickets de jugadores (panel admin) ----------
// Arma un "ticket" legible a partir de una fila de la tabla bets, sin
// volver a calcular nada de cuotas: todo sale de lo que ya quedó guardado
// en desc_text/match_text/stake/payout en el momento en que el jugador
// confirmó la jugada. Esa cuota queda congelada para siempre — este
// parseo nunca consulta el estado actual de las líneas.
function parseBetTicket(row) {
  var isParlay = /^Combinada/i.test(row.desc_text || '');
  var legs = [];
  if (isParlay) {
    String(row.match_text || '').split(' · ').forEach(function (leg) {
      var parts = leg.split('@@@');
      if (parts.length === 3) {
        legs.push({ descripcion: parts[0], seleccion: parts[1], cuota: parseFloat(parts[2]) });
      } else {
        legs.push({ descripcion: leg, seleccion: '', cuota: null });
      }
    });
  } else {
    var oddsMatch = /\(([\d.]+)\)\s*$/.exec(row.desc_text || '');
    var cuota = oddsMatch ? parseFloat(oddsMatch[1]) : null;
    var seleccion = String(row.desc_text || '').replace(/\s*\([^)]*\)\s*$/, '');
    legs.push({ descripcion: row.match_text, seleccion: seleccion, cuota: cuota });
  }
  var cuotaTotal = 1, anyNull = false;
  legs.forEach(function (l) { if (l.cuota === null || isNaN(l.cuota)) anyNull = true; else cuotaTotal *= l.cuota; });
  var stake = Number(row.stake), payout = Number(row.payout);
  return {
    ticket: 'T-' + String(row.id).padStart(6, '0'),
    id: row.id,
    jugador: row.email,
    fecha: row.created_at,
    tipo: isParlay ? 'Combinada' : 'Sencilla',
    num_selecciones: legs.length,
    selecciones: legs,
    cuota_total: anyNull ? null : cuotaTotal,
    monto_apostado: stake,
    ganancia_potencial: Math.max(0, payout - stake),
    total_a_cobrar: payout,
    estado: row.status
  };
}

app.get('/api/admin/tickets', async (c) => {
  if (!isAdminReq(c)) return c.json({ error: 'forbidden' }, 403);
  const q = (c.req.query('q') || '').trim().toLowerCase();
  const estadoFiltro = (c.req.query('estado') || '').trim();
  const tipoFiltro = (c.req.query('tipo') || '').trim();
  const fechaFiltro = (c.req.query('fecha') || '').trim(); // YYYY-MM-DD, día en hora de RD
  const rows = await sql`
    SELECT b.id, b.desc_text, b.match_text, b.stake, b.payout, b.status, b.created_at, b.leg_results, u.email
    FROM bets b JOIN users u ON u.id = b.user_id
    WHERE b.deleted_at IS NULL
    ORDER BY b.created_at DESC
    LIMIT 300
  `;
  const byKeyT = await loadMatchesByKey();
  var tickets = rows.map(function (r) {
    var t = parseBetTicket(r), lr = r.leg_results; if (typeof lr === 'string') { try { lr = JSON.parse(lr); } catch (e) { lr = null; } }
    t.legRes = Array.isArray(lr) ? lr : null;
    var q = r.status === 'pending' ? cashoutQuote(r, byKeyT) : null;
    t.cashout = q ? q.amount : null; t.cashoutLeft = q ? q.left : 0;
    return t;
  });
  if (q) {
    tickets = tickets.filter(function (t) {
      if (t.ticket.toLowerCase().indexOf(q) !== -1) return true;
      if ((t.jugador || '').toLowerCase().indexOf(q) !== -1) return true;
      return t.selecciones.some(function (l) {
        return (l.descripcion || '').toLowerCase().indexOf(q) !== -1 || (l.seleccion || '').toLowerCase().indexOf(q) !== -1;
      });
    });
  }
  if (estadoFiltro) tickets = tickets.filter(function (t) { return t.estado === estadoFiltro; });
  if (tipoFiltro) tickets = tickets.filter(function (t) { return t.tipo === tipoFiltro; });
  if (fechaFiltro) {
    tickets = tickets.filter(function (t) {
      var drDate = new Date(new Date(t.fecha).getTime() - 4 * 3600000);
      var drDateStr = drDate.toISOString().slice(0, 10);
      return drDateStr === fechaFiltro;
    });
  }
  return c.json(tickets);
});

// Panel financiero: números en vivo de lo que están apostando los
// jugadores ahora mismo, siempre calculados sobre lo que ya está
// guardado — nunca recalculando cuotas ya confirmadas.
app.get('/api/admin/finance-summary', async (c) => {
  if (!isAdminReq(c)) return c.json({ error: 'forbidden' }, 403);
  // "Hoy" en hora de RD (UTC-4 fijo, sin horario de verano).
  const hoyRows = await sql`
    SELECT COALESCE(SUM(stake), 0) AS total_apostado, COUNT(*) AS tickets
    FROM bets
    WHERE (created_at - interval '4 hours')::date = (now() - interval '4 hours')::date
  `;
  const pendRows = await sql`
    SELECT COALESCE(SUM(payout), 0) AS pago_potencial, COALESCE(SUM(payout - stake), 0) AS exposicion
    FROM bets WHERE status = 'pending' AND deleted_at IS NULL
  `;
  const ganRows = await sql`
    SELECT COALESCE(SUM(stake), 0) AS ganancia
    FROM bets
    WHERE status = 'lost' AND (created_at - interval '4 hours')::date = (now() - interval '4 hours')::date
  `;
  const perdRows = await sql`
    SELECT COALESCE(SUM(payout - stake), 0) AS perdida
    FROM bets
    WHERE status = 'won' AND (created_at - interval '4 hours')::date = (now() - interval '4 hours')::date
  `;
  const ganancia = Number(ganRows[0].ganancia);
  const perdida = Number(perdRows[0].perdida);
  return c.json({
    total_apostado_hoy: Number(hoyRows[0].total_apostado),
    tickets_hoy: Number(hoyRows[0].tickets),
    pago_potencial: Number(pendRows[0].pago_potencial),
    exposicion: Number(pendRows[0].exposicion),
    ganancia_hoy: ganancia,
    perdida_hoy: perdida,
    neto_hoy: ganancia - perdida
  });
});

// ---------- Plantilla (jugadores) de un equipo de la NBA, para el panel ----------
var nbaTeamsCache = { t: 0, list: [] };
var nbaRosterCache = {};
var UA_HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36' };
async function nbaTeamsList() {
  if (nbaTeamsCache.list.length && Date.now() - nbaTeamsCache.t < 24 * 3600 * 1000) return nbaTeamsCache.list;
  var res = await fetch('https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams', { headers: UA_HEADERS });
  if (!res.ok) return nbaTeamsCache.list;
  var data = await res.json();
  var teams = (((data.sports || [])[0] || {}).leagues || [])[0];
  var list = ((teams && teams.teams) || []).map(function (x) { var t = x.team || x; return { id: String(t.id), name: String(t.displayName || ''), abbr: String(t.abbreviation || '') }; });
  if (list.length) nbaTeamsCache = { t: Date.now(), list: list };
  return nbaTeamsCache.list;
}
async function nbaRoster(teamName) {
  var teams = await nbaTeamsList();
  var t = teams.find(function (x) { return teamNamesMatch(x.name, teamName); });
  if (!t) return null;
  var hit = nbaRosterCache[t.id];
  if (hit && Date.now() - hit.t < 6 * 3600 * 1000) return hit.data;
  var res = await fetch('https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/' + t.id + '/roster', { headers: UA_HEADERS });
  if (!res.ok) return hit ? hit.data : null;
  var data = await res.json();
  var raw = [];
  (data.athletes || []).forEach(function (a) { if (a && Array.isArray(a.items)) raw = raw.concat(a.items); else if (a) raw.push(a); });
  var players = raw.map(function (a) {
    return { id: String(a.id || ''), name: String(a.displayName || a.fullName || ''), short: String(a.shortName || ''), pos: String((a.position && (a.position.abbreviation || a.position.name)) || ''), jersey: String(a.jersey || '') };
  }).filter(function (p) { return p.name; }).sort(function (x, y) { return x.name.localeCompare(y.name); });
  var out = { team: t.name, abbr: t.abbr, players: players };
  nbaRosterCache[t.id] = { t: Date.now(), data: out };
  return out;
}
// ---------- Línea sugerida: promedio de la temporada del jugador ----------
// Busca al jugador en las plantillas de los dos equipos y lee su promedio por
// partido de la temporada. Si no se puede leer, devuelve null y el admin
// pone la línea a mano.
var NBA_AVG_KEYS = {
  Puntos: { names: ['avgPoints', 'points'], labels: ['PTS'] },
  Rebotes: { names: ['avgRebounds', 'rebounds'], labels: ['REB'] },
  Asistencias: { names: ['avgAssists', 'assists'], labels: ['AST'] },
  Triples: { names: ['avgThreePointFieldGoalsMade', 'threePointFieldGoalsMade', 'avgThreePointFieldGoalsMade-avgThreePointFieldGoalsAttempted'], labels: ['3PM', '3PT'] },
  Robos: { names: ['avgSteals', 'steals'], labels: ['STL'] },
  Tapones: { names: ['avgBlocks', 'blocks'], labels: ['BLK'] }
};
var playerAvgCache = {};
function findStatTables(obj, out, depth) {
  if (!obj || typeof obj !== 'object' || depth > 8) return out;
  if (Array.isArray(obj)) { obj.forEach(function (x) { findStatTables(x, out, depth + 1); }); return out; }
  var keys = Array.isArray(obj.names) ? obj.names : null, labels = Array.isArray(obj.labels) ? obj.labels : null;
  if ((keys || labels) && Array.isArray(obj.splits)) {
    obj.splits.forEach(function (sp) { if (sp && Array.isArray(sp.stats)) out.push({ names: keys || [], labels: labels || [], split: String(sp.displayName || ''), stats: sp.stats }); });
  }
  Object.keys(obj).forEach(function (k) { if (k !== 'splits') findStatTables(obj[k], out, depth + 1); });
  return out;
}
function pickAverage(tables, stat) {
  var want = NBA_AVG_KEYS[stat]; if (!want) return null;
  // Preferimos la temporada regular; si no, la primera tabla que tenga el dato.
  tables.sort(function (a, b) { return (/regular season/i.test(b.split) ? 1 : 0) - (/regular season/i.test(a.split) ? 1 : 0); });
  for (var i = 0; i < tables.length; i++) {
    var t = tables[i], idx = -1;
    for (var j = 0; j < want.names.length && idx < 0; j++) idx = t.names.indexOf(want.names[j]);
    for (var k = 0; k < want.labels.length && idx < 0; k++) idx = t.labels.indexOf(want.labels[k]);
    if (idx < 0) continue;
    var raw = String(t.stats[idx] === undefined ? '' : t.stats[idx]).split('-')[0];
    var v = parseFloat(raw);
    if (isNaN(v)) continue;
    var gpIdx = t.labels.indexOf('GP'); if (gpIdx < 0) gpIdx = t.names.indexOf('gamesPlayed');
    var gp = gpIdx >= 0 ? parseInt(t.stats[gpIdx], 10) : null;
    return { avg: v, games: isNaN(gp) ? null : gp };
  }
  return null;
}
async function nbaPlayerAverage(athleteId, stat) {
  var key = athleteId + '|' + stat;
  var hit = playerAvgCache[key];
  if (hit && Date.now() - hit.t < 6 * 3600 * 1000) return hit.data;
  var urls = [
    'https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/' + athleteId + '/overview',
    'https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/' + athleteId + '/stats'
  ];
  for (var i = 0; i < urls.length; i++) {
    try {
      var res = await fetch(urls[i], { headers: UA_HEADERS });
      if (!res.ok) continue;
      var found = pickAverage(findStatTables(await res.json(), [], 0), stat);
      if (found) { playerAvgCache[key] = { t: Date.now(), data: found }; return found; }
    } catch (e) {}
  }
  return null;
}
app.get('/api/admin/player-line', async (c) => {
  if (!isAdminReq(c)) return c.json({ error: 'forbidden' }, 403);
  try {
    var stat = c.req.query('stat') || '';
    if (!NBA_AVG_KEYS[stat]) return c.json({ error: 'bad_stat' }, 400);
    var want = nbaNameTokens(c.req.query('player') || '');
    if (!want.length) return c.json({ error: 'not_found' }, 404);
    var surname = want[want.length - 1], initial = want.length > 1 ? want[0].charAt(0) : '';
    var cands = [];
    for (const team of [c.req.query('away') || '', c.req.query('home') || '']) {
      if (!team) continue;
      var r = await nbaRoster(team);
      (r ? r.players : []).forEach(function (p) {
        var tk = nbaNameTokens(p.name);
        if (tk.length && tk[tk.length - 1] === surname) cands.push({ p: p, first: tk[0].charAt(0) });
      });
    }
    if (cands.length > 1 && initial) cands = cands.filter(function (x) { return x.first === initial; });
    if (cands.length !== 1 || !cands[0].p.id) return c.json({ error: 'not_found' }, 404);
    var a = await nbaPlayerAverage(cands[0].p.id, stat);
    if (!a) return c.json({ error: 'no_stats' }, 404);
    // Línea terminada en .5 lo más cerca del promedio (24.3 -> 24.5, 24.8 -> 24.5, 25.1 -> 25.5).
    var line = Math.max(0.5, Math.round(a.avg - 0.5) + 0.5);
    return c.json({ player: cands[0].p.name, stat: stat, avg: a.avg, games: a.games, line: line });
  } catch (e) {
    return c.json({ error: 'not_found' }, 404);
  }
});

app.get('/api/admin/roster', async (c) => {
  if (!isAdminReq(c)) return c.json({ error: 'forbidden' }, 403);
  try {
    var r = await nbaRoster(c.req.query('team') || '');
    if (!r) return c.json({ error: 'not_found' }, 404);
    return c.json(r);
  } catch (e) {
    return c.json({ error: 'not_found' }, 404);
  }
});

app.get('/api/admin/probable-pitchers', async (c) => {
  if (!isAdminReq(c)) return c.json({ error: 'forbidden' }, 403);
  const list = await fetchProbablePitchers();
  return c.json(list);
});

app.get('/api/admin/debug-live', async (c) => {
  if (!isAdminReq(c)) return c.json({ error: 'forbidden' }, 403);
  const rows = await sql`SELECT value FROM app_state WHERE key = 'matches'`;
  var matches = rows[0] ? rows[0].value : [];
  if (typeof matches === 'string') {
    try { matches = JSON.parse(matches); } catch (e) { matches = []; }
  }

  // Diagnóstico directo: qué pasa EXACTAMENTE al pedirle a la fuente de
  // hoy (MLB oficial para béisbol, ESPN para los demás), sin tragarnos el
  // error como hacen fetchMlbGamesFromStatsApi/fetchEspnGames.
  var rawDebug = { url: '', status: null, error: null, bodySnippet: '' };
  try {
    rawDebug.url = 'https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=' + todayISO() + '&hydrate=linescore,probablePitcher';
    var rawRes = await fetch(rawDebug.url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36' } });
    rawDebug.status = rawRes.status;
    var rawText = await rawRes.text();
    rawDebug.bodySnippet = rawText.slice(0, 300);
  } catch (e) {
    rawDebug.error = String(e && e.message ? e.message : e);
  }

  var out = [];
  for (const m of matches) {
    if (!SPORT_ESPN_PATH[m.sport]) continue;
    var homeEn = lookupEnglishTeam(m.sport, m.home);
    var awayEn = lookupEnglishTeam(m.sport, m.away);
    var games = m.sport === 'beisbol' ? await fetchMlbGamesFromStatsApi() : m.sport === 'lidom' ? await fetchMlbGamesFromStatsApi(17) : m.sport === 'nhl' ? await fetchNhlGamesFromStatsApi() : await fetchEspnGames(SPORT_ESPN_PATH[m.sport]);
    out.push({
      guardado_home: m.home,
      guardado_away: m.away,
      guardado_live: !!m.live,
      traducido_home: homeEn,
      traducido_away: awayEn,
      espn_juegos_hoy: games.map(function (g) { return g.away + ' @ ' + g.home + ' (' + g.state + ')'; })
    });
  }
  return c.json({ partidos: out, diagnostico_espn: rawDebug });
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

app.get('/terms-en', async (c) => {
  const file = Bun.file(new URL('./terms-en.html', import.meta.url));
  if (!(await file.exists())) return c.text('No encontré terms-en.html', 404);
  return c.html(await file.text());
});

app.get('/', async (c) => {
  if (comingSoon && !isAdminReq(c)) {
    var wa = ''; try { wa = String((await payMethods()).whatsapp || '').replace(/\D/g, ''); } catch (e) {}
    c.header('Cache-Control', 'no-store');
    return c.html(soonHtml(wa));
  }
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
  if (comingSoon) {
    // Solo tú la ves: aviso arriba para que sepas que la gente ve "Próximamente".
    c.header('Cache-Control', 'no-store');
    return c.html(html.replace(/<body([^>]*)>/i, '<body$1><div style="position:sticky;top:0;z-index:99999;background:#FDB022;color:#1a1a1a;font:600 13px/1.3 system-ui,sans-serif;text-align:center;padding:8px 12px">🚧 Modo Próximamente: solo tú ves la página. La gente ve "Próximamente". Se quita en el admin.</div>'));
  }
  return c.html(html);
});

export default {
  port: Number(Bun.env.PORT) || 3000,
  fetch: app.fetch
};

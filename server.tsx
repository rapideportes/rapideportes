import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';

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

function todayISO() {
  // Usamos la fecha en hora del Este de EE.UU. (la misma que usan las
  // ligas y ESPN para "el día de hoy"), sin depender de en qué zona
  // horaria esté configurado el propio contenedor del servidor.
  var fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
  return fmt.format(new Date());
}

// Líderes del partido de un equipo (puntos, rebotes, asistencias) tal como
// los publica ESPN en su scoreboard. Si ESPN no los manda, devuelve null.
function espnLeaders(c) {
  var out = {};
  var cats = (c && c.leaders) || [];
  for (var i = 0; i < cats.length; i++) {
    var cat = cats[i] || {};
    var key = cat.name || cat.abbreviation;
    if (key !== 'points' && key !== 'rebounds' && key !== 'assists') continue;
    var top = cat.leaders && cat.leaders[0];
    if (!top || !top.athlete) continue;
    out[key] = {
      name: String(top.athlete.shortName || top.athlete.displayName || ''),
      value: String(top.displayValue !== undefined ? top.displayValue : (top.value !== undefined ? top.value : ''))
    };
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
    g.homeScore = n.homeScore; g.awayScore = n.awayScore; g.state = n.state;
    if (n.period) g.period = n.period;
    g.clock = /halftime|half/i.test(n.statusText) ? '' : n.clock;
    g.source = 'nba';
  });
  return games;
}

async function fetchEspnGames(espnPath) {
  try {
    const dateParam = todayISO().replace(/-/g, '');
    const url = 'https://site.api.espn.com/apis/site/v2/sports/' + espnPath + '/scoreboard?dates=' + dateParam;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36' } });
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
        period: comp.status ? comp.status.period : undefined,
        clock: comp.status ? comp.status.displayClock : '',
        leaders: { home: espnLeaders(home), away: espnLeaders(away) }
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
    var url = 'https://statsapi.mlb.com/api/v1/schedule?sportId=' + sportId + '&date=' + todayISO() + '&hydrate=linescore,probablePitcher';
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
async function fetchNhlGamesFromStatsApi() {
  var games = [];
  try {
    var url = 'https://api-web.nhle.com/v1/score/' + todayISO();
    var res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36' } });
    if (!res.ok) return games;
    var data = await res.json();
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
          var label = pd.periodType === 'OT' ? 'OT' : pd.periodType === 'SO' ? 'Tanda de penales' : pd.number + 'er período';
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
        : sport === 'nhl' ? await fetchNhlGamesFromStatsApi()
        : sport === 'baloncesto' ? await overlayNbaOfficial(await fetchEspnGames(SPORT_ESPN_PATH[sport]))
        : await fetchEspnGames(SPORT_ESPN_PATH[sport]);
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

      // Arma el detalle específico del deporte para la nueva interfaz de
      // "En vivo": bases/outs en béisbol, período+reloj en NHL/NBA.
      // Siempre a partir de lo que reportó la fuente oficial — nunca
      // inventado ni calculado con un reloj local.
      var sportDetail = null;
      if ((m.sport === 'beisbol' || m.sport === 'lidom') && g.sportDetail) {
        sportDetail = g.sportDetail;
      } else if (m.sport === 'nhl' && g.sportDetail) {
        sportDetail = g.sportDetail;
      } else if (m.sport === 'nfl') {
        sportDetail = { quarter: g.period || null, quarterLabel: g.period ? (g.period > 4 ? 'Tiempo extra' : g.period + ['', 'er', 'do', 'er', 'to'][g.period] + ' cuarto') : null, clock: g.clock || null };
      } else if (m.sport === 'baloncesto') {
        var quarterLabel = g.period ? (g.period > 4 ? 'Tiempo extra' : g.period + ['', 'er', 'do', 'er', 'to'][g.period] + ' cuarto') : null;
        var gl = g.leaders || {};
        var leaders = (gl.home || gl.away) ? (reversed ? { home: gl.away || null, away: gl.home || null } : { home: gl.home || null, away: gl.away || null }) : null;
        sportDetail = { quarter: g.period || null, quarterLabel: quarterLabel, clock: g.clock || null, leaders: leaders };
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
function gradeTotal(side, m, awayScore, homeScore) {
  if (!m.total) return null;
  var total = awayScore + homeScore;
  var line = Number(m.total.line);
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
    return gradeTotal(side, m, awayScore, homeScore);
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
function gradeParlayBet(matchText, finishedByKey, statsByEventId) {
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
    } else if (/ — /.test(pick)) {
      return null; // medio tiempo / primer período: lo califica el admin (nunca se da por perdida sola)
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
  return m.sport === 'baloncesto' ? gradeNbaProp(pick, stats) : gradePitcherProp(pick, stats);
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
    if (Object.keys(finishedByKey).length === 0) return;

    const pending = await sql`SELECT id, user_id, desc_text, match_text, stake, payout, created_at FROM bets WHERE status = 'pending' AND deleted_at IS NULL`;
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
        }
      }
    }

    for (const b of pending) {
      var isParlay = /^Combinada/i.test(b.desc_text || '');
      var fk = finishedViewFor(b.created_at, allByKey); // solo el juego que empezó después de la apuesta
      var result = isParlay
        ? gradeParlayBet(b.match_text, fk, statsByEventId)
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
var tickBusy = false, lastSettle = 0;
async function tick() {
  if (tickBusy) return;
  if (!anyLiveNow && Date.now() - lastLiveUpdate < 20000) return;
  tickBusy = true;
  try {
    await updateLiveScores();
    if (Date.now() - lastSettle >= 20000) { lastSettle = Date.now(); await settleBets(); }
  } finally { tickBusy = false; }
}
setInterval(tick, 7000);
tick();
(async function () {
  try {
    const r0 = await sql`SELECT value FROM app_state WHERE key = 'matches'`;
    var l0 = r0[0] ? r0[0].value : []; if (typeof l0 === 'string') { try { l0 = JSON.parse(l0); } catch (e) { l0 = []; } }
    await saveResults(l0);
  } catch (e) {}
})();

const app = new Hono();

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
  var out = { teams: teams, teamStats: tstats, state: comp && comp.status && comp.status.type ? comp.status.type.state : '' };
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
  await sql`
    INSERT INTO app_state (key, value) VALUES ('matches', ${JSON.stringify(matches)}::jsonb)
    ON CONFLICT (key) DO UPDATE SET value = ${JSON.stringify(matches)}::jsonb
  `;
  await saveResults(matches);
  return c.json({ ok: true });
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
      var r = await fetch('https://statsapi.mlb.com/api/v1/schedule?sportId=' + sid + '&date=' + date, { headers: UA });
      if (!r.ok) return out;
      var d = await r.json();
      (d.dates || []).forEach(function (dd) { (dd.games || []).forEach(function (g) {
        var h = g.teams && g.teams.home && g.teams.home.team, a = g.teams && g.teams.away && g.teams.away.team;
        if (!h || !a) return;
        if (sport === 'lidom' && !(isLidomTeamName(h.name) && isLidomTeamName(a.name))) return;
        out.push({ away: canonTeam(sport, a.name), home: canonTeam(sport, h.name), startAt: g.gameDate, done: g.status && g.status.abstractGameState !== 'Preview' });
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
  return c.json({ games: await addPapiOdds(sport, date, games) });
});

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
const PAPI_PROP_STAT = [[/points/i, 'Puntos'], [/rebound/i, 'Rebotes'], [/assist/i, 'Asistencias'], [/three|3pt|3-point|threes/i, 'Triples'], [/steal/i, 'Robos'], [/block/i, 'Tapones']];
// "Walsh, Jordan" → "J. Walsh" (igual que la lista de jugadores del panel).
function papiPlayerName(n) {
  var m = /^([^,]+),\s*(.+)$/.exec(String(n || '').trim());
  if (m) return m[2].charAt(0).toUpperCase() + '. ' + m[1].trim();
  var w = String(n || '').trim().split(/\s+/); return w.length > 1 ? w[0].charAt(0).toUpperCase() + '. ' + w.slice(1).join(' ') : String(n || '');
}
function papiLines(fx, markets) {
  var bk = fx.bookmakerOdds && fx.bookmakerOdds.pokerstars;
  if (!bk || !bk.markets) return null;
  var ml = null, spreads = [], totals = [];
  var props = {};
  Object.keys(bk.markets).forEach(function (mid) {
    var def = markets[mid]; if (!def) return;
    if (def.prop) {
      // Jugadores (NBA): solo las estadísticas que la página sabe calificar sola.
      // Las combinadas ("points-rebounds", "pra"…) se saltan: la página no las califica sola.
      var hits = PAPI_PROP_STAT.filter(function (x) { return x[0].test(def.type); });
      var stat = hits.length === 1 && !/combo|\+|pra|double/i.test(def.type) ? hits[0] : null;
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
    if (!full) return;
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
  var ORDER = { Puntos: 0, Rebotes: 1, Asistencias: 2, Triples: 3, Robos: 4, Tapones: 5 };
  propList.sort(function (a, b) { return (ORDER[a.stat] - ORDER[b.stat]) || (b.line - a.line); });
  return { ml: ml, spread: sp, total: best(totals, 'over', 'under'), props: propList };
}
async function addPapiOdds(sport, date, games) {
  if (!Bun.env.ODDSPAPI_KEY || !PAPI_SPORT[sport] || !games.length) return games;
  try {
    var tid = await papiTournamentId(sport); if (!tid) return games;
    var markets = await papiMarkets(sport); if (!markets) return games;
    var parts = await papiParticipants(sport);
    var r = await papiCached('o' + tid + date, 10 * 60e3, async function () {
      var x = await oddsPapi('odds-by-tournaments', { bookmaker: 'pokerstars', tournamentIds: String(tid), oddsFormat: 'decimal' });
      return papiList(x.data).length ? x : null;
    });
    var fixtures = r ? papiList(r.data) : [];
    games.forEach(function (g) {
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
      var L = papiLines(fx, markets); if (!L) return;
      // En deportes de EE. UU. el "1" de OddsPapi es el local.
      var H = function (a, b) { return p1Home ? a : b; };
      g.odds = { home: H(L.ml.p1, L.ml.p2), away: H(L.ml.p2, L.ml.p1) };
      if (L.spread) { var hl = p1Home ? L.spread.h1 : -L.spread.h1; g.odds.hcap = { homeLine: hl, homeOdds: H(L.spread.p1, L.spread.p2), awayLine: -hl, awayOdds: H(L.spread.p2, L.spread.p1) }; }
      if (L.total) g.odds.total = { line: L.total.line, over: L.total.over, under: L.total.under };
      if (sport === 'baloncesto' && L.props && L.props.length) g.odds.props = L.props.map(function (x) { return { player: papiPlayerName(x.player), stat: x.stat, line: x.line, over: x.over, under: x.under }; });
    });
  } catch (e) {}
  return games;
}

app.get('/api/admin/oddspapi-usage', async (c) => {
  if (!isAdminReq(c)) return c.json({ error: 'unauthorized' }, 401);
  const r = await sql`SELECT value FROM app_state WHERE key = 'papi_usage'`;
  var v = r[0] ? r[0].value : null; if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { v = null; } }
  var month = new Date().toISOString().slice(0, 7);
  return c.json({ key: !!Bun.env.ODDSPAPI_KEY, used: v && v.month === month ? Number(v.count) || 0 : 0, limit: Number(Bun.env.ODDSPAPI_LIMIT) || 250 });
});

// ---------- OddsPapi: prueba de conexión ----------
// Trae una muestra de lo que devuelve OddsPapi (deportes, casas, ligas y mercados)
// para terminar de conectar las cuotas. Gasta unas 5 consultas del plan.
async function oddsPapi(path, params) {
  var key = Bun.env.ODDSPAPI_KEY;
  if (!key) return { error: 'no_key' };
  var qs = new URLSearchParams(Object.assign({}, params || {}, { apiKey: key })).toString();
  // Cuenta cada consulta del mes (para que el admin vea cuántas le quedan).
  try {
    var month = new Date().toISOString().slice(0, 7);
    await sql`INSERT INTO app_state (key, value) VALUES ('papi_usage', ${JSON.stringify({ month: month, count: 1 })}::jsonb)
      ON CONFLICT (key) DO UPDATE SET value = CASE WHEN app_state.value->>'month' = ${month}
        THEN jsonb_set(app_state.value, '{count}', to_jsonb(COALESCE((app_state.value->>'count')::int, 0) + 1))
        ELSE ${JSON.stringify({ month: month, count: 1 })}::jsonb END`;
  } catch (e) {}
  try {
    var r = await fetch('https://api.oddspapi.io/v4/' + path + '?' + qs, { headers: { 'Accept': 'application/json' } });
    var text = await r.text();
    var data = null; try { data = JSON.parse(text); } catch (e) {}
    return { status: r.status, data: data, text: data ? null : text.slice(0, 300) };
  } catch (e) { return { error: String(e && e.message || e) }; }
}
function papiShort(x, n) { var t = JSON.stringify(x); return t && t.length > (n || 1500) ? t.slice(0, n || 1500) + '…' : t; }
app.get('/api/admin/oddspapi-test', async (c) => {
  if (!isAdminReq(c)) return c.json({ error: 'unauthorized' }, 401);
  if (!Bun.env.ODDSPAPI_KEY) return c.json({ key: false });
  var out = { key: true };
  var sp = await oddsPapi('sports');
  out.sportsStatus = sp.status || sp.error;
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
  for (var i = 0; i < legs.length; i++) {
    var p = legs[i].split('@@@'); if (p.length !== 3) return null;
    var tm = /^(Ganador|Hándicap|Total) (.*) vs (.*)$/.exec(p[0]); if (!tm) return null;
    var dec = parseFloat(p[2]); if (!(dec > 1)) return null;
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
    SELECT id, desc_text, match_text, stake, payout, status, created_at, win_seen
    FROM bets WHERE user_id = ${user.id} AND deleted_at IS NULL
    ORDER BY created_at DESC LIMIT 20
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
  const method = await payoutMethod(user.id);
  if (!method) return c.json({ error: 'no_deposit_method' }, 400);
  const upd = await sql`UPDATE users SET balance = balance - ${amount} WHERE id = ${user.id} AND balance >= ${amount} RETURNING balance`;
  if (!upd[0]) return c.json({ error: 'insufficient' }, 400);
  await sql`INSERT INTO withdrawals (user_id, amount, method_ref, method_label) VALUES (${user.id}, ${amount}, ${method.ref}, ${method.label})`;
  return c.json({ balance: Number(upd[0].balance) });
});

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
    FROM deposits d JOIN users u ON u.id = d.user_id ORDER BY d.created_at DESC LIMIT 30`;
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
    deposits: recentD.map(function (r) { return { id: r.id, amount: Number(r.amount), status: r.status, createdAt: r.created_at, methodLabel: r.method_label || '', email: r.email }; })
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
  const bets = await sql`SELECT id, desc_text, match_text, stake, payout, status, created_at FROM bets WHERE user_id = ${id} AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 100`;
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
    bets: bets.map(function (b) { return { id: b.id, desc: b.desc_text, match: b.match_text, stake: N(b.stake), payout: N(b.payout), status: b.status, createdAt: b.created_at }; }),
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
    SELECT b.id, b.desc_text, b.match_text, b.stake, b.payout, b.status, b.created_at, u.email
    FROM bets b JOIN users u ON u.id = b.user_id
    WHERE b.deleted_at IS NULL
    ORDER BY b.created_at DESC
    LIMIT 300
  `;
  var tickets = rows.map(parseBetTicket);
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

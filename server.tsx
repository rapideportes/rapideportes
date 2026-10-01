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

// Consulta el "scoreboard" público de ESPN (sin clave) para una liga y arma
// una lista simple de los partidos de hoy con marcador y estado.
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
  'Delayed': 'Retrasado', 'Rain Delay': 'Retrasado por lluvia', 'Game Over': 'Final', 'Final': 'Final'
};

async function fetchMlbGamesFromStatsApi() {
  var games = [];
  try {
    var url = 'https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=' + todayISO() + '&hydrate=linescore,probablePitcher';
    var res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36' } });
    if (!res.ok) return games;
    var data = await res.json();
    var rawGames = [];
    (data.dates || []).forEach(function (d) { (d.games || []).forEach(function (g) { rawGames.push(g); }); });

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
        if (/suspend|delay|postpon/i.test(detailed)) state = 'pre'; // no lo marcamos "en vivo" mientras está detenido
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
          inIntermission: !!clock.inIntermission
        }
      });
    });
  } catch (e) {
    // devolvemos lo que se haya podido armar hasta el momento del fallo
  }
  return games;
}

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
      gamesBySport[sport] = sport === 'beisbol' ? await fetchMlbGamesFromStatsApi()
        : sport === 'nhl' ? await fetchNhlGamesFromStatsApi()
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
      if (m.sport === 'beisbol' && g.sportDetail) {
        sportDetail = g.sportDetail;
      } else if (m.sport === 'nhl' && g.sportDetail) {
        sportDetail = g.sportDetail;
      } else if (m.sport === 'baloncesto') {
        var quarterLabel = g.period ? (g.period > 4 ? 'OT' : g.period + 'er cuarto') : null;
        sportDetail = { quarter: g.period || null, quarterLabel: quarterLabel, clock: g.clock || null };
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
      if (u.score) m.score = u.score;
      else if (u.estadoDetallado) m.estadoDetallado = u.estadoDetallado;
    });

    if (anyApplied) {
      await sql`
        INSERT INTO app_state (key, value) VALUES ('matches', ${JSON.stringify(freshMatches)}::jsonb)
        ON CONFLICT (key) DO UPDATE SET value = ${JSON.stringify(freshMatches)}::jsonb
      `;
    }
  } catch (e) {
    // No tumbamos el servidor por un fallo de la API externa.
  }
}

// Corre cada 60 segundos mientras el servidor esté vivo.
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
      refs.push({ away: tm[2], home: tm[3] });
    }
    return refs;
  }
  var mm = /^(.*) @ (.*)$/.exec(matchText || '');
  if (!mm) return null;
  return [{ away: mm[1], home: mm[2] }];
}

// Un partido deja de aceptar apuestas nuevas en cuanto: ya está en vivo,
// ya terminó, o ya llegó su hora oficial de inicio (aunque ESPN todavía
// no lo haya confirmado como "en vivo").
function isBettingClosedServer(m) {
  if (!m) return true;
  if (m.live || m.finished) return true;
  if (m.startAt) {
    var t = Date.parse(m.startAt);
    if (!isNaN(t) && Date.now() >= t) return true;
  }
  return false;
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
    return gradePitcherProp(descBody, stats);
  }
  if (/^Hándicap /.test(descBody)) {
    return gradeSelection('Hándicap', away, home, descBody.replace(/^Hándicap /, '').split(' ')[0], finishedByKey);
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
  var results = [];
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
      result = gradePitcherProp(pick, stats);
    } else {
      result = gradeSelection(mainType, away, home, pick, finishedByKey);
    }
    if (result === null) return null; // esta pata aún no se puede calificar
    results.push(result);
  }
  if (results.some(function (r) { return r === 'lost'; })) return 'lost';
  if (results.every(function (r) { return r === 'push'; })) return 'push';
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
  var surname = normTeam(playerLabel.replace(/\s*\([^)]*\)\s*$/, '').trim().split(/\s+/).pop());
  var k = statsBySurname[surname];
  if (k === undefined) return null;
  if (k === line) return 'push';
  return side === 'over' ? (k > line ? 'won' : 'lost') : (k < line ? 'won' : 'lost');
}


async function settleBets() {
  try {
    const rows = await sql`SELECT value FROM app_state WHERE key = 'matches'`;
    var matches = rows[0] ? rows[0].value : [];
    if (typeof matches === 'string') {
      try { matches = JSON.parse(matches); } catch (e) { matches = []; }
    }
    if (!Array.isArray(matches)) return;
    var finishedByKey = {};
    matches.forEach(function (m) {
      if (m.finished) finishedByKey[matchKey(m.away, m.home)] = m;
    });
    if (Object.keys(finishedByKey).length === 0) return;

    const pending = await sql`SELECT id, user_id, desc_text, match_text, stake, payout FROM bets WHERE status = 'pending'`;
    var anyPropPending = pending.some(function (b) { return / — (Más|Menos) [\d.]+/.test(b.desc_text || '') || / — (Más|Menos) [\d.]+/.test(b.match_text || ''); });

    // Solo pedimos el boxscore (ponches) si hay al menos una apuesta de
    // lanzador pendiente, y una vez por cada juego de MLB ya terminado.
    var statsByEventId = {};
    if (anyPropPending) {
      for (const key of Object.keys(finishedByKey)) {
        var fm = finishedByKey[key];
        if (fm.sport === 'beisbol' && fm.espnEventId) {
          statsByEventId[fm.espnEventId] = await fetchPitcherStrikeouts(fm.espnEventId);
        }
      }
    }

    for (const b of pending) {
      var isParlay = /^Combinada/i.test(b.desc_text || '');
      var result = isParlay
        ? gradeParlayBet(b.match_text, finishedByKey, statsByEventId)
        : gradeSingleBet(b.desc_text, b.match_text, finishedByKey, statsByEventId);
      if (result === null) continue; // todavía no se puede calificar

      if (result === 'push') {
        await sql`UPDATE bets SET status = 'void' WHERE id = ${b.id}`;
        await sql`UPDATE users SET balance = balance + ${Number(b.stake)} WHERE id = ${b.user_id}`;
      } else if (result === 'won') {
        await sql`UPDATE bets SET status = 'won' WHERE id = ${b.id}`;
        await sql`UPDATE users SET balance = balance + ${Number(b.payout)} WHERE id = ${b.user_id}`;
      } else {
        await sql`UPDATE bets SET status = 'lost' WHERE id = ${b.id}`;
      }
    }
  } catch (e) {
    // No tumbamos el servidor por un fallo al calificar apuestas.
  }
}

// ---------- Agregar partidos automáticamente (MLB y NHL) ----------
// Convierte la hora UTC real del juego a la hora de RD (UTC-4 fijo) y
// arma tanto el texto bonito como el "hhmm" que el sitio ya sabe usar
// para que "Hoy/Mañana" se recalculen solos.
function drTimeParts(utcIso) {
  var d = new Date(utcIso);
  var dr = new Date(d.getTime() - 4 * 3600000);
  var y = dr.getUTCFullYear(), mo = String(dr.getUTCMonth() + 1).padStart(2, '0'), da = String(dr.getUTCDate()).padStart(2, '0');
  var hh = String(dr.getUTCHours()).padStart(2, '0'), mi = String(dr.getUTCMinutes()).padStart(2, '0');
  return { dateStr: y + '-' + mo + '-' + da, hhmm: hh + ':' + mi, startAt: y + '-' + mo + '-' + da + 'T' + hh + ':' + mi + ':00-04:00' };
}
function drDisplayTime(utcIso) {
  var parts = drTimeParts(utcIso);
  var today = todayISO();
  var tomorrowDate = new Date(new Date(today + 'T00:00:00-04:00').getTime() + 24 * 3600000);
  var tomorrow = drTimeParts(tomorrowDate.toISOString()).dateStr;
  var dayLabel = parts.dateStr === today ? 'Hoy' : parts.dateStr === tomorrow ? 'Mañana' : parts.dateStr;
  var hh24 = parseInt(parts.hhmm.split(':')[0], 10), mm = parts.hhmm.split(':')[1];
  var ampm = hh24 >= 12 ? 'p.m.' : 'a.m.';
  var hh12 = hh24 % 12; if (hh12 === 0) hh12 = 12;
  return dayLabel + ' ' + hh12 + ':' + mm + ' ' + ampm;
}
var AUTO_SPORT_LABEL = { beisbol: 'Béisbol', nhl: 'NHL' };
async function autoAddTodaysMatches() {
  try {
    var toAdd = [];
    var sources = [
      { sport: 'beisbol', games: await fetchMlbGamesFromStatsApi() },
      { sport: 'nhl', games: await fetchNhlGamesFromStatsApi() }
    ];
    sources.forEach(function (src) {
      src.games.forEach(function (g) {
        if (!g.home || !g.away || !g.startTimeUtc) return;
        toAdd.push({
          id: src.sport + '-' + g.id,
          sport: src.sport,
          sportLabel: AUTO_SPORT_LABEL[src.sport],
          time: drDisplayTime(g.startTimeUtc),
          hhmm: drTimeParts(g.startTimeUtc).hhmm,
          startAt: drTimeParts(g.startTimeUtc).startAt,
          live: false, finished: false,
          home: g.home, away: g.away,
          odds: [{ k: 'Local', v: null }, { k: 'Empate', v: null }, { k: 'Visitante', v: null }]
        });
      });
    });
    if (toAdd.length === 0) return;

    const rows = await sql`SELECT value FROM app_state WHERE key = 'matches'`;
    var matches = rows[0] ? rows[0].value : [];
    if (typeof matches === 'string') { try { matches = JSON.parse(matches); } catch (e) { matches = []; } }
    if (!Array.isArray(matches)) matches = [];
    var existingIds = {};
    matches.forEach(function (m) { existingIds[m.id] = true; });
    var changed = false;
    toAdd.forEach(function (nm) {
      if (!existingIds[nm.id]) { matches.push(nm); changed = true; }
    });
    if (changed) {
      await sql`
        INSERT INTO app_state (key, value) VALUES ('matches', ${JSON.stringify(matches)}::jsonb)
        ON CONFLICT (key) DO UPDATE SET value = ${JSON.stringify(matches)}::jsonb
      `;
    }
  } catch (e) {
    // no agregamos nada si algo falla; el admin siempre puede agregarlo a mano
  }
}

async function tick() {
  await updateLiveScores();
  await settleBets();
}
setInterval(tick, 20000);
tick();
setInterval(autoAddTodaysMatches, 300000); // cada 5 minutos alcanza de sobra para "nuevos partidos de hoy"
autoAddTodaysMatches();

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

  // Validación del lado del servidor: aunque alguien mande la apuesta
  // directo (sin pasar por la pantalla), revisamos que ningún partido
  // referenciado esté ya cerrado para apuestas.
  const matchRows = await sql`SELECT value FROM app_state WHERE key = 'matches'`;
  var currentMatches = matchRows[0] ? matchRows[0].value : [];
  if (typeof currentMatches === 'string') {
    try { currentMatches = JSON.parse(currentMatches); } catch (e) { currentMatches = []; }
  }
  if (!Array.isArray(currentMatches)) currentMatches = [];
  var matchesByKey = {};
  currentMatches.forEach(function (m) { matchesByKey[matchKey(m.away, m.home)] = m; });
  for (const b of bets) {
    var refs = extractMatchRefs(b.desc, b.match);
    if (!refs) return c.json({ error: 'bad_request' }, 400);
    for (const r of refs) {
      if (isBettingClosedServer(matchesByKey[matchKey(r.away, r.home)])) {
        return c.json({ error: 'closed' }, 400);
      }
    }
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
    FROM bets WHERE status = 'pending'
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
    var games = m.sport === 'beisbol' ? await fetchMlbGamesFromStatsApi() : m.sport === 'nhl' ? await fetchNhlGamesFromStatsApi() : await fetchEspnGames(SPORT_ESPN_PATH[m.sport]);
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

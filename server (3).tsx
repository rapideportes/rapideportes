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
      if (g.id) m.espnEventId = g.id;
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
        // El juego real ya terminó: lo bajamos de "en vivo", dejamos el
        // marcador final, y lo marcamos "finished" para que no vuelva a
        // aparecer como si fuera a comenzar.
        if (m.live || !m.finished) changed = true;
        if (realHomeScore !== undefined && realAwayScore !== undefined && !isNaN(realHomeScore) && !isNaN(realAwayScore)) {
          m.score = { home: realHomeScore, away: realAwayScore, period: 'Final' };
        }
        m.live = false;
        m.finished = true;
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
// ---------- Calificación automática de apuestas (Ganador, Hándicap, Total) ----------
// Cuando un partido queda "finished" (ver updateLiveScores arriba), revisamos
// las apuestas pendientes que dependen de ese partido y las marcamos
// ganadas/perdidas usando el marcador final real. Las apuestas de
// medio tiempo y lanzadores no se tocan aquí — se quedan pendientes para
// que el admin las califique a mano.

function matchKey(away, home) { return String(away) + ' @ ' + String(home); }

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
    var side = /^Más /.test(pick) ? 'over' : /^Menos /.test(pick) ? 'under' : null;
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
// usando el resumen/boxscore público de ESPN. Devuelve un mapa
// "apellido en minúsculas" -> ponches, o {} si algo falla. El emparejamiento
// por apellido es una aproximación: si dos lanzadores del mismo juego
// comparten apellido, esto puede confundirse (muy poco común).
async function fetchPitcherStrikeouts(eventId) {
  var out = {};
  try {
    var url = 'https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/summary?event=' + eventId;
    var res = await fetch(url);
    if (!res.ok) return out;
    var data = await res.json();
    var teams = (data.boxscore && data.boxscore.players) || [];
    teams.forEach(function (teamBlock) {
      (teamBlock.statistics || []).forEach(function (cat) {
        var labels = cat.labels || cat.names || [];
        var kIdx = -1;
        for (var i = 0; i < labels.length; i++) {
          if (labels[i] === 'K' || /strikeout/i.test(String(labels[i]))) { kIdx = i; break; }
        }
        if (kIdx === -1) return;
        (cat.athletes || []).forEach(function (a) {
          var name = a.athlete ? a.athlete.displayName : '';
          var stats = a.stats || [];
          if (!name || !stats[kIdx]) return;
          var surname = name.trim().split(/\s+/).pop().toLowerCase();
          var k = parseFloat(stats[kIdx]);
          if (!isNaN(k)) out[surname] = k;
        });
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
  var surname = playerLabel.replace(/\s*\([^)]*\)\s*$/, '').trim().split(/\s+/).pop().toLowerCase();
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

async function tick() {
  await updateLiveScores();
  await settleBets();
}
setInterval(tick, 60000);
tick();

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

// Trae los lanzadores probables de hoy (solo MLB por ahora, que es la
// única liga donde calificamos apuestas de lanzador), tal como ESPN los
// reporta: nombre exacto y con acentos/espacios correctos, para que el
// admin solo tenga que buscarlos y tocarlos, sin escribirlos a mano.
async function fetchProbablePitchers() {
  var out = [];
  try {
    var dateParam = todayISO().replace(/-/g, '');
    var url = 'https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=' + dateParam;
    var res = await fetch(url);
    if (!res.ok) return out;
    var data = await res.json();
    (data.events || []).forEach(function (ev) {
      var comp = ev.competitions && ev.competitions[0];
      if (!comp) return;
      var competitors = comp.competitors || [];
      var home = competitors.find(function (x) { return x.homeAway === 'home'; });
      var away = competitors.find(function (x) { return x.homeAway === 'away'; });
      if (!home || !away) return;
      function firstProbable(side) {
        var p = (side.probables || [])[0];
        return p && p.athlete ? p.athlete.displayName : null;
      }
      out.push({
        away: away.team ? away.team.displayName : '',
        home: home.team ? home.team.displayName : '',
        awayPitcher: firstProbable(away),
        homePitcher: firstProbable(home)
      });
    });
  } catch (e) {
    // devolvemos lo que se haya podido armar hasta el momento del fallo
  }
  return out;
}

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

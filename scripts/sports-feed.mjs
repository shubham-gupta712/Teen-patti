// Teen Patti Club - sports data job (version 7: stuck matches without a score time, results read from the status).
// Started by GitHub Actions (.github/workflows/sports-feed.yml) and then STAYS ON for up to ~5 h 45 min, updating
// every few minutes (the admin picks 1, 5, 15, 30 or 60 minutes on the console's Data feed tab). Each update:
//   1. reads matches, live scores and results from the data services (only what is needed: the full schedule
//      every 3 hours, live scores only while a listed match is live or about to start),
//   2. writes them to Firestore (/sports/{id}) and sets the club's odds for every market from the live score,
//   3. pauses betting for a few seconds after each score change, closes markets near the end,
//   4. settles bets market by market as soon as each one is decided (an innings total when the innings ends,
//      the match result at the end; a match called off gives every stake back),
//   5. records the requests used today for each data service in /sportsMeta/feed (shown on the console),
//      and stops asking a service once its daily limit is used up.
// Football and basketball: API-Sports (APISPORTS_KEY). Cricket: CricketData.org (CRICKETDATA_KEY).
// Firebase: the service account JSON in FIREBASE_SERVICE_ACCOUNT.

const FULL_EVERY_MS = 3 * 3600e3;     // the full schedule, every 3 hours
const DAYS_AHEAD = 2;                 // today and the next 2 days
const SOON_MS = 20 * 60000;           // a match this close to its start is checked every update
const KEEP_DONE_MS = 3 * 864e5;       // settled matches are removed after 3 days
const MAX_PER_SPORT = 60;             // at most this many upcoming matches per sport in the list
const LOCK_MS = 10000;                // markets pause this long after every score change
const MARGIN = 0.06;                  // the club's margin built into every market
const FB_DEFAULT = [39, 140, 135, 78, 61, 2, 3, 323, 1, 4, 5, 253, 307];   // football competitions (API-Sports ids)
const BK_DEFAULT = [12, 120];                                              // NBA, Euroleague
const LIMITS = { apisports: 100, cricketdata: 100 };                       // free plans, until the service says otherwise

export const payout = (stake, odds) => Math.floor(stake * odds + 0.000001);
const r2 = v => Math.round(v * 100) / 100;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30);
const lineKey = v => String(v).replace('.', '_');
// normal distribution
function phi(x) { const t = 1 / (1 + 0.2316419 * Math.abs(x)), d = 0.3989423 * Math.exp(-x * x / 2), p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p; }
// probabilities -> odds with the club's margin
export function priced(probs) {
  const tot = probs.reduce((a, b) => a + b, 0) || 1;
  return probs.map(p => { const q = clamp(p / tot, 0.01, 0.99); return clamp(r2(1 / (q * (1 + MARGIN))), 1.01, 100); });
}
function market(name, items, extra) {
  const odds = priced(items.map(x => x.p)), opts = {}, order = [];
  items.forEach((x, i) => { opts[x.key] = { label: x.label, odds: odds[i] }; order.push(x.key); });
  return Object.assign({ name, open: true, opts, order }, extra || {});
}
function ouMarket(name, line, pOver, extra) {
  const k = lineKey(line);
  return market(name, [{ key: 'o' + k, label: 'Over ' + line, p: pOver }, { key: 'u' + k, label: 'Under ' + line, p: 1 - pOver }], Object.assign({ pair: true, line }, extra || {}));
}
function rangeMarket(name, mean, sd, step) {
  const lo = Math.floor((mean - 2 * step) / step) * step, items = [];
  items.push({ key: 'rlt' + lo, label: 'Under ' + lo, p: phi((lo - 0.5 - mean) / sd) });
  for (let a = lo; a < lo + 5 * step; a += step) items.push({ key: 'r' + a + '_' + (a + step - 1), label: a + '–' + (a + step - 1), p: phi((a + step - 0.5 - mean) / sd) - phi((a - 0.5 - mean) / sd) });
  const hi = lo + 5 * step; items.push({ key: 'rge' + hi, label: hi + ' or more', p: 1 - phi((hi - 0.5 - mean) / sd) });
  return market(name, items, { range: true });
}
// how a pick on an over/under or range market is decided by a final number
export function decidePick(pick, value) {
  let m;
  if ((m = /^o(\d+)_(\d)$/.exec(pick))) return value > Number(m[1] + '.' + m[2]) ? 'won' : 'lost';
  if ((m = /^u(\d+)_(\d)$/.exec(pick))) return value < Number(m[1] + '.' + m[2]) ? 'won' : 'lost';
  if ((m = /^rlt(\d+)$/.exec(pick))) return value < Number(m[1]) ? 'won' : 'lost';
  if ((m = /^rge(\d+)$/.exec(pick))) return value >= Number(m[1]) ? 'won' : 'lost';
  if ((m = /^r(\d+)_(\d+)$/.exec(pick))) return value >= Number(m[1]) && value <= Number(m[2]) ? 'won' : 'lost';
  if (pick === 'yes' || pick === 'no') return null;
  return null;
}

/* ---- CRICKET: a simple model of a limited-overs innings ---- */
const CFMT = { t20: { ov: 20, par: 165, rpo: 8.25, sd: 22, step: 10 }, odi: { ov: 50, par: 275, rpo: 5.5, sd: 35, step: 20 }, t10: { ov: 10, par: 110, rpo: 11, sd: 14, step: 10 } };
const WKT = [1, 0.97, 0.93, 0.88, 0.81, 0.72, 0.61, 0.48, 0.34, 0.2, 0];
export const cricFormat = t => { t = String(t || '').toLowerCase(); return t.includes('t10') ? CFMT.t10 : (t.includes('odi') || t.includes('list') || t.includes('one')) ? CFMT.odi : t.includes('test') || t.includes('first') ? null : CFMT.t20; };
const balls = o => { const [a, b] = String(o == null ? 0 : o).split('.'); return (Number(a) || 0) * 6 + (Number(b) || 0); };
// expected runs still to come, and how uncertain that is
function cricRest(F, ballsUsed, wkts, runs) {
  const total = F.ov * 6, left = Math.max(0, total - ballsUsed);
  const crr = ballsUsed >= 24 ? runs / (ballsUsed / 6) : F.rpo, rate = 0.65 * F.rpo + 0.35 * crr;
  return { left, mean: left / 6 * rate * WKT[clamp(wkts, 0, 10)], sd: F.sd * Math.sqrt(left / total) + 3 };
}
// markets for a cricket match from its live state (inn: [{team: 'home'|'away', r, w, o}])
export function cricketMarkets(m, inn, batters) {
  const F = cricFormat(m.type); if (!F) return null;
  const names = { home: m.home.name, away: m.away.name }, out = {};
  const first = inn[0], second = inn[1];
  const b1 = first ? balls(first.o) : 0, done1 = !!second || (first && (first.w >= 10 || b1 >= F.ov * 6));
  let pFirst;      // chance the side batting first wins
  if (!first) { pFirst = 0.5; }
  else if (!second) { const R = cricRest(F, b1, first.w, first.r), P = first.r + R.mean; pFirst = phi((P - F.par) / Math.sqrt(R.sd * R.sd + F.sd * F.sd));
    out.tot1 = ouMarket('1st innings – ' + names[first.team] + ' total', Math.floor(P) + 0.5, 0.5, { team: first.team, inn: 1 });
    out.rng1 = rangeMarket('1st innings – ' + names[first.team] + ' run range', P, R.sd, F.step); out.rng1.inn = 1;
    if (R.left <= 6) { out.tot1.open = false; out.rng1.open = false; } }
  else { const need = first.r + 1 - second.r, b2 = balls(second.o), R = cricRest(F, b2, second.w, second.r);
    pFirst = need <= 0 ? 0 : (second.w >= 10 || R.left === 0) ? 1 : 1 - phi((R.mean - need + 0.5) / R.sd);
    const P = second.r + R.mean;
    out.tot2 = ouMarket('2nd innings – ' + names[second.team] + ' total', Math.floor(P) + 0.5, 0.5, { team: second.team, inn: 2 });
    out.rng2 = rangeMarket('2nd innings – ' + names[second.team] + ' run range', P, R.sd, F.step); out.rng2.inn = 2;
    if (R.left <= 6 || need <= 12) { out.tot2.open = false; out.rng2.open = false; } }
  const firstTeam = first ? first.team : 'home', pHome = firstTeam === 'home' ? pFirst : 1 - pFirst;
  out.win = market('Match winner', [{ key: 'home', label: names.home, p: pHome }, { key: 'away', label: names.away, p: 1 - pHome }]);
  // close the winner market in the last over, or when the result is all but certain
  const cur = second || first, curLeft = cur ? F.ov * 6 - balls(cur.o) : 999;
  if ((second && curLeft <= 6) || pHome > 0.97 || pHome < 0.03) out.win.open = false;
  // batters at the crease (only with the detailed scoreboard)
  (batters || []).filter(p => p.on).slice(0, 2).forEach(p => {
    const cb = cur ? balls(cur.o) : 0, R = cricRest(F, cb, cur ? cur.w : 0, cur ? cur.r : 0), add = clamp(R.left / 6 * F.rpo * 0.3, 2, 45);
    const k = 'bat_' + slug(p.name);
    out[k] = ouMarket(p.name + ' – runs', Math.floor(p.r + add) + 0.5, 0.5, { batter: p.name, inn: cur === second ? 2 : 1 });
    if (R.left <= 6) out[k].open = false;
  });
  if (!first) { out.tot1 = ouMarket('1st innings total', F.par - 0.5, 0.5, { inn: 1 }); out.rng1 = rangeMarket('1st innings run range', F.par, F.sd, F.step); out.rng1.inn = 1; }
  void done1;
  return out;
}

/* ---- FOOTBALL: goals as a Poisson process over the time left ---- */
const pois = (k, l) => { let p = Math.exp(-l); for (let i = 1; i <= k; i++) p *= l / i; return p; };
export function footballMarkets(m, minute, hg, ag) {
  const f = clamp((95 - minute) / 95, 0, 1), lh = 1.45 * f, la = 1.15 * f;
  let pH = 0, pD = 0, pA = 0, pBoth = 0, pOver = {};
  const tot0 = hg + ag, line = minute < 1 ? 2.5 : tot0 + (f > 0.35 ? 1.5 : 0.5);
  let pO = 0;
  for (let i = 0; i <= 10; i++) for (let j = 0; j <= 10; j++) {
    const p = pois(i, lh) * pois(j, la), H = hg + i, A = ag + j;
    if (H > A) pH += p; else if (H === A) pD += p; else pA += p;
    if (H > 0 && A > 0) pBoth += p;
    if (H + A > line) pO += p;
  }
  void pOver;
  const out = {
    win: market('Match result', [{ key: 'home', label: m.home.name, p: pH }, { key: 'draw', label: 'Draw', p: pD }, { key: 'away', label: m.away.name, p: pA }]),
    goals: ouMarket('Total goals', line, pO),
    btts: market('Both teams to score', [{ key: 'yes', label: 'Yes', p: pBoth }, { key: 'no', label: 'No', p: 1 - pBoth }], { pair: true })
  };
  if (minute >= 85) Object.values(out).forEach(x => { x.open = false; });
  if (Math.max(pH, pD, pA) > 0.97) out.win.open = false;
  if (pO > 0.97 || pO < 0.03) out.goals.open = false;
  if (pBoth > 0.97 || pBoth < 0.03) out.btts.open = false;
  return out;
}
/* ---- BASKETBALL: the points margin as a random walk over the time left ---- */
export function basketballMarkets(m, elapsedMin, hs, as, nba) {
  const len = nba ? 48 : 40, left = clamp(len - elapsedMin, 0, len), pace = elapsedMin > 6 ? (hs + as) / elapsedMin : (nba ? 228 : 160) / len;
  const sd = 13 * Math.sqrt(left / len) + 0.5, d = hs - as + 2.5 * (left / len), pH = phi(d / sd);
  const proj = hs + as + pace * left, line = Math.floor(proj) + 0.5;
  const out = {
    win: market('Match winner (incl. overtime)', [{ key: 'home', label: m.home.name, p: pH }, { key: 'away', label: m.away.name, p: 1 - pH }]),
    pts: ouMarket('Total points', line, 0.5)
  };
  if (left <= 2) Object.values(out).forEach(x => { x.open = false; });
  if (pH > 0.97 || pH < 0.03) out.win.open = false;
  return out;
}
// the markets a match starts with (before any live score)
export function openingMarkets(m) {
  if (m.sport === 'football') return footballMarkets(m, 0, 0, 0);
  if (m.sport === 'basketball') return basketballMarkets(m, 0, 0, 0, m.leagueId === 12);
  const c = cricFormat(m.type) ? cricketMarkets(m, [], []) : null;
  if (c) return c;
  const opts = { home: { label: m.home.name, odds: 1.9 } }, order = ['home'];
  if (m.draw) { opts.draw = { label: 'Draw', odds: 4.0 }; order.push('draw'); }
  opts.away = { label: m.away.name, odds: 1.9 }; order.push('away');
  return { win: { name: 'Match winner', open: true, opts, order } };
}

/* ---- turning each service's answer into one match shape ---- */
const FB_LIVE = ['1H', 'HT', '2H', 'ET', 'BT', 'P', 'SUSP', 'INT', 'LIVE'], FB_DONE = ['FT', 'AET', 'PEN'], FB_OFF = ['PST', 'CANC', 'ABD', 'AWD', 'WO'];
export function fromFootball(x) {
  const st = x.fixture.status.short, home = x.teams.home, away = x.teams.away;
  const status = FB_LIVE.includes(st) ? 'live' : FB_DONE.includes(st) ? 'finished' : FB_OFF.includes(st) ? 'cancelled' : 'upcoming';
  const g = x.goals || {};
  let win = '', hg = g.home || 0, ag = g.away || 0;
  if (status === 'finished') {
    const f = x.score && x.score.fulltime; if (f && f.home != null) { hg = f.home; ag = f.away; }
    win = hg > ag ? 'home' : ag > hg ? 'away' : 'draw';
  }
  return { id: 'fb_' + x.fixture.id, srcId: String(x.fixture.id), sport: 'football', league: x.league.name, leagueLogo: x.league.logo || '', leagueId: x.league.id,
    home: { name: home.name, short: '', logo: home.logo || '' }, away: { name: away.name, short: '', logo: away.logo || '' },
    startAt: x.fixture.timestamp * 1000, status,
    score: { home: g.home == null ? '' : String(g.home), away: g.away == null ? '' : String(g.away) },
    detail: status === 'live' ? (st === 'HT' ? 'Half time' : x.fixture.status.elapsed ? x.fixture.status.elapsed + "'" : st) : status === 'cancelled' ? x.fixture.status.long : '',
    win, minute: st === 'HT' ? 45 : x.fixture.status.elapsed || 0, goals: [hg, ag],
    info: { title: String(x.league.round || '').slice(0, 60), venue: [x.fixture.venue && x.fixture.venue.name, x.fixture.venue && x.fixture.venue.city].filter(Boolean).join(', ').slice(0, 90),
      referee: String(x.fixture.referee || '').slice(0, 60), ht: x.score && x.score.halftime && x.score.halftime.home != null ? x.score.halftime.home + ' – ' + x.score.halftime.away : '' } };
}
const BK_LIVE = ['Q1', 'Q2', 'Q3', 'Q4', 'OT', 'BT', 'HT'], BK_DONE = ['FT', 'AOT'], BK_OFF = ['POST', 'CANC', 'SUSP', 'AWD', 'ABD'];
export function fromBasketball(x) {
  const st = x.status.short, s = x.scores || {}, h0 = (s.home && s.home.total), a0 = (s.away && s.away.total);
  const status = BK_LIVE.includes(st) ? 'live' : BK_DONE.includes(st) ? 'finished' : BK_OFF.includes(st) ? 'cancelled' : 'upcoming';
  const nba = x.league.id === 12, q = nba ? 12 : 10, qn = { Q1: 1, Q2: 2, Q3: 3, Q4: 4, OT: 4, BT: 2, HT: 2 }[st] || 0;
  const elapsed = st === 'HT' || st === 'BT' ? q * qn : Math.max(0, (qn - 1) * q + (Number(x.status.timer) || 0));
  return { id: 'bk_' + x.id, srcId: String(x.id), sport: 'basketball', league: x.league.name, leagueLogo: x.league.logo || '', leagueId: x.league.id,
    home: { name: x.teams.home.name, short: '', logo: x.teams.home.logo || '' }, away: { name: x.teams.away.name, short: '', logo: x.teams.away.logo || '' },
    startAt: x.timestamp * 1000, status,
    score: { home: h0 == null ? '' : String(h0), away: a0 == null ? '' : String(a0) },
    detail: status === 'live' ? st + (x.status.timer ? ' ' + x.status.timer + "'" : '') : status === 'cancelled' ? x.status.long : '',
    win: status === 'finished' && h0 != null && a0 != null ? (h0 > a0 ? 'home' : a0 > h0 ? 'away' : 'void') : '', elapsed, pts: [h0 || 0, a0 || 0],
    info: { title: String(x.stage || x.week || '').slice(0, 60), venue: String((x.venue && (x.venue.name || x.venue)) || '').slice(0, 90),
      qs: ['quarter_1', 'quarter_2', 'quarter_3', 'quarter_4', 'over_time'].map((k, i) => ({ q: i < 4 ? 'Q' + (i + 1) : 'OT', h: s.home && s.home[k], a: s.away && s.away[k] })).filter(r => r.h != null || r.a != null).map(r => ({ q: r.q, h: r.h == null ? '' : String(r.h), a: r.a == null ? '' : String(r.a) })) } };
}
// "India vs Australia, 3rd T20I, India tour of Australia, 2026" -> "India tour of Australia 2026"
export function cricketLeague(x) {
  if (x.series) return String(x.series);
  const parts = String(x.name || '').split(',').map(t => t.trim()).filter(Boolean).slice(1);
  const rest = parts.filter(t => !/^(\d+(st|nd|rd|th)\b|match\b|final\b|semi|quarter|qualifier|eliminator|warm-?up|practice)/i.test(t));
  return (rest.join(' ') || parts.join(' ') || String(x.matchType || 'Cricket').toUpperCase()).slice(0, 60);
}
export function fromCricket(x) {
  const teams = x.teams || [], info = x.teamInfo || [], ti = n => info.find(t => t.name === n) || {};
  const [hn, an] = teams; if (!hn || !an) return null;
  const startAt = Date.parse((x.dateTimeGMT || x.date) + (/Z$|[+-]\d\d:?\d\d$/.test(x.dateTimeGMT || '') ? '' : 'Z'));
  const statusTxt = String(x.status || ''), low = statusTxt.toLowerCase();
  const off = /abandon|no result|cancel|postpon/.test(low);
  // a score means play has begun, even if the service has not flagged the start (it happens with multi-day matches)
  // the service sometimes leaves matchEnded off although its status already reads like a result
  const ended = x.matchEnded || /\bwon by\b|\bwon\b.*\b(runs?|wickets?|wkts?|innings)\b|match drawn|\bdrawn\b|match tied|no result|abandon/.test(low.replace(/[^.]*\btoss\b[^.]*/g, ''));
  const status = ended ? (off ? 'cancelled' : 'finished') : x.matchStarted || (x.score || []).length ? 'live' : off ? 'cancelled' : 'upcoming';
  const teamOf = s => { const t = String(s.inning || '').toLowerCase(); return t.startsWith(hn.toLowerCase()) ? 'home' : t.startsWith(an.toLowerCase()) ? 'away' : ''; };
  const inn = (x.score || []).map(s => ({ team: teamOf(s), r: Number(s.r) || 0, w: Number(s.w) || 0, o: s.o == null ? 0 : s.o })).filter(s => s.team);
  const txt = k => (x.score || []).filter(s => teamOf(s) === k).map(s => s.r + '/' + s.w + (s.o != null ? ' (' + s.o + ')' : '')).join(' & ');
  let win = '';
  if (status === 'finished') {
    if (/\bdrawn?\b/.test(low)) win = 'draw';
    else if (/\btied?\b/.test(low) && !/super over/.test(low)) win = 'void';
    else { const mm = /^(.*?)\s+won\b/i.exec(statusTxt); const w = mm ? mm[1].trim().toLowerCase() : '';
      win = w && (w === hn.toLowerCase() || hn.toLowerCase().startsWith(w) || w.startsWith(hn.toLowerCase())) ? 'home' : w && (w === an.toLowerCase() || an.toLowerCase().startsWith(w) || w.startsWith(an.toLowerCase())) ? 'away' : ''; }
  }
  return { id: 'cr_' + String(x.id).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 50), srcId: String(x.id), sport: 'cricket', league: cricketLeague(x), leagueLogo: '',
    home: { name: hn, short: ti(hn).shortname || '', logo: ti(hn).img || '' }, away: { name: an, short: ti(an).shortname || '', logo: ti(an).img || '' },
    startAt, status, score: { home: txt('home'), away: txt('away') }, detail: status === 'upcoming' ? '' : statusTxt.slice(0, 80),
    win, draw: String(x.matchType || '').toLowerCase() === 'test', type: x.matchType || '', inn,
    // match details for the match page: everything here comes free with the list the job already asks for
    info: { title: String(x.name || '').split(',').slice(1, 2).join('').trim().slice(0, 60), venue: String(x.venue || '').slice(0, 90),
      toss: x.tossWinner ? (String(x.tossWinner) + (x.tossChoice ? ' chose to ' + String(x.tossChoice).toLowerCase().replace(/^bowling$/, 'bowl').replace(/^batting$/, 'bat') : '')).slice(0, 80) : '',
      inns: (x.score || []).slice(0, 4).map(s => ({ t: String(s.inning || '').replace(/\s+Inning\s+(\d)/i, ' · innings $1').slice(0, 60), r: Number(s.r) || 0, w: Number(s.w) || 0, o: s.o == null ? '' : String(s.o) })) } };
}
// the detailed scoreboard (batters, bowler, this over) from CricketData's scorecard and ball-by-ball answers
export function cricketDetail(card, bbb) {
  const L = {};
  try {
    const sc = (card && card.data && card.data.scorecard) || [], last = sc[sc.length - 1];
    if (last) {
      L.batting = (last.batting || []).filter(p => /not out|batting/i.test(String(p['dismissal-text'] || p.dismissal || ''))).slice(0, 2)
        .map(p => ({ name: (p.batsman && p.batsman.name) || p.name || '', r: Number(p.r) || 0, b: Number(p.b) || 0, f4: Number(p['4s']) || 0, s6: Number(p['6s']) || 0 }));
      const bw = (last.bowling || [])[ (last.bowling || []).length - 1 ];
      if (bw) L.bowling = { name: (bw.bowler && bw.bowler.name) || '', o: bw.o || 0, m: Number(bw.m) || 0, r: Number(bw.r) || 0, w: Number(bw.w) || 0 };
      L.out = (last.batting || []).filter(p => !/not out|batting/i.test(String(p['dismissal-text'] || ''))).map(p => ({ name: (p.batsman && p.batsman.name) || '', r: Number(p.r) || 0 }));
    }
    const B = (bbb && bbb.data && bbb.data.bbb) || [];
    if (B.length) {
      const lb = B[B.length - 1], ov = lb.over;
      L.recent = B.filter(b => b.over === ov && b.inning === lb.inning).map(b => (b.wicket || b.dismissal) ? 'W' : String((Number(b.runs) || 0) + (Number(b.extras) || 0)).replace(/^0$/, '•'));
      if (lb.bowler && lb.bowler.name && L.bowling) L.bowling.name = lb.bowler.name;
      const on = lb.batsman && lb.batsman.name; if (on && L.batting) L.batting.forEach(p => { p.on = p.name === on; });
    }
  } catch (e) { /* a shape we did not expect: show what we have */ }
  if (L.batting && !L.batting.some(p => p.on)) L.batting.forEach((p, i) => { p.on = i === 0; });
  return L;
}

/* ---- one update ---- */
// teams not known yet (knockouts): "TBC v TBC" is never listed
const TBC = n => /^(tbc|tba|tbd|to be (confirmed|announced|decided))$/i.test(String(n || '').trim());
// a live cricket score that has not moved for this long is frozen: the service stopped updating it (usually the match is over)
const multiDay = m => /test|first|fc/i.test(m.type || '') || /^day \d/i.test(m.detail || '');
export const frozenMs = m => { const t = String(m.type || '').toLowerCase(); return multiDay(m) ? 20 * 3600e3 : t === 't10' ? 30 * 60000 : t === 'odi' ? 75 * 60000 : 45 * 60000; };
const maxMs = m => { const t = String(m.type || '').toLowerCase(); return multiDay(m) ? 5.5 * 864e5 : t === 't10' ? 3 * 3600e3 : t.startsWith('t20') ? 5 * 3600e3 : 10 * 3600e3; };
export const isFrozen = (m, now) => m.sport === 'cricket' && m.status === 'live' && now - (Number(m.scoreAt) || m.startAt || 0) > frozenMs(m);
export async function run({ db, inc, ts, fetchJson, env, now = Date.now(), log = console.log, existing, config = {} }) {
  const meta = db.doc('sportsMeta/feed'), M0 = (await meta.get()).data() || {}, sports = Object.assign({}, M0.sports || {});
  const errors = [], counts = { added: 0, updated: 0, settled: 0, paid: 0, removed: 0 };
  // requests used today, per service (the day starts at 00:00 GMT, like the services' own counters)
  const day = new Date(now).toISOString().slice(0, 10);
  const usage = M0.usage && M0.usage.day === day ? JSON.parse(JSON.stringify(M0.usage)) : { day, apisports: { used: 0, limit: LIMITS.apisports }, cricketdata: { used: 0, limit: LIMITS.cricketdata } };
  ['apisports', 'cricketdata'].forEach(k => { usage[k] = Object.assign({ used: 0, limit: LIMITS[k] }, usage[k]); });
  const over = k => usage[k].over || (usage[k].limit && usage[k].used >= usage[k].limit);
  let calls = 0;
  const call = async (api, url, headers) => {
    if (over(api)) throw new Error('daily limit used up');
    calls++; usage[api].used++;
    const { json, headers: hd } = await fetchJson(url, headers);
    if (api === 'apisports' && hd) { const lim = Number(hd['x-ratelimit-requests-limit']), rem = Number(hd['x-ratelimit-requests-remaining']); if (lim) { usage.apisports.limit = lim; if (!isNaN(rem)) usage.apisports.used = lim - rem; } }
    if (api === 'cricketdata' && json && json.info) { if (json.info.hitsLimit) usage.cricketdata.limit = Number(json.info.hitsLimit); if (json.info.hitsToday != null) usage.cricketdata.used = Number(json.info.hitsToday); }
    const msg = api === 'apisports' ? apiErr(json) : cricErr(json);
    if (msg) { if (/limit|quota|exceed|too many/i.test(msg)) usage[api].over = true; throw new Error(msg); }
    if (over(api)) usage[api].over = true;
    return json;
  };
  if (!existing) { existing = {}; (await db.collection('sports').get()).docs.forEach(d => { existing[d.id] = d.data(); }); }
  // matches listed before approvals existed: those not started yet wait for the admin; the rest carry on (they may have bets)
  for (const [id, m] of Object.entries(existing)) {
    if (m.approved === undefined) { const ok = m.source === 'manual' || m.status !== 'upcoming' || m.startAt <= now; await db.doc('sports/' + id).update({ approved: ok }); m.approved = ok; }
  }
  const tracked = sport => Object.entries(existing).filter(([, m]) => m.sport === sport && m.source !== 'manual');
  // only matches the admin approved for players are worth live requests
  const hot = m => m.approved === true && !m.adminCancelled && (m.status === 'live' || (m.status === 'upcoming' && m.startAt - now < SOON_MS));
  const off = config.off || {};          // the admin can switch each service's requests off
  const needsLive = sport => tracked(sport).some(([, m]) => hot(m) && !m.settled);
  const dates = Array.from({ length: DAYS_AHEAD + 1 }, (_, i) => new Date(now + i * 864e5).toISOString().slice(0, 10));
  const found = { football: [], basketball: [], cricket: [] };
  const fail = (sport, e) => { errors.push(sport + ': ' + e.message); sports[sport] = Object.assign({}, sports[sport], { ok: false, error: e.message }); };

  if (env.APISPORTS_KEY && !off.apisports) {
    const H = { 'x-apisports-key': env.APISPORTS_KEY };
    // FOOTBALL
    try {
      const B = 'https://v3.football.api-sports.io', L = ((env.FOOTBALL_LEAGUES || '').split(/[ ,]+/).map(Number).filter(Boolean));
      const LL = L.length ? L : FB_DEFAULT, full = !sports.football || !sports.football.full || now - sports.football.full > FULL_EVERY_MS;
      if (full) { for (const d of dates) { const r = await call('apisports', B + '/fixtures?date=' + d, H); (r.response || []).filter(x => LL.includes(x.league.id)).forEach(x => found.football.push(fromFootball(x))); } sports.football = { ok: true, full: now }; }
      else if (needsLive('football')) {
        const ids = tracked('football').filter(([, m]) => hot(m) && !m.settled).map(([, m]) => m.srcId).slice(0, 20);
        const r = await call('apisports', B + '/fixtures?ids=' + ids.join('-'), H); (r.response || []).forEach(x => found.football.push(fromFootball(x)));
        sports.football = Object.assign({}, sports.football, { ok: true, error: '' });
      }
    } catch (e) { fail('football', e); }
    // BASKETBALL
    try {
      const B = 'https://v1.basketball.api-sports.io', L = ((env.BASKETBALL_LEAGUES || '').split(/[ ,]+/).map(Number).filter(Boolean));
      const LL = L.length ? L : BK_DEFAULT, full = !sports.basketball || !sports.basketball.full || now - sports.basketball.full > FULL_EVERY_MS;
      const days = full ? dates : needsLive('basketball') ? [...new Set(tracked('basketball').filter(([, m]) => hot(m) && !m.settled).map(([, m]) => new Date(m.startAt).toISOString().slice(0, 10)))] : [];
      for (const d of days) { const r = await call('apisports', B + '/games?date=' + d, H); (r.response || []).filter(x => LL.includes(x.league.id)).forEach(x => found.basketball.push(fromBasketball(x))); }
      if (full) sports.basketball = { ok: true, full: now }; else if (days.length) sports.basketball = Object.assign({}, sports.basketball, { ok: true, error: '' });
    } catch (e) { fail('basketball', e); }
  }
  // CRICKET
  if (env.CRICKETDATA_KEY && !off.cricketdata) {
    const B = 'https://api.cricapi.com/v1', k = encodeURIComponent(env.CRICKETDATA_KEY);
    try {
      const full = !sports.cricket || !sports.cricket.full || now - sports.cricket.full > FULL_EVERY_MS;
      if (full) {
        const r = await call('cricketdata', B + '/matches?apikey=' + k + '&offset=0');
        (r.data || []).map(fromCricket).filter(Boolean).filter(m => m.startAt < now + (DAYS_AHEAD + 1) * 864e5 && m.startAt > now - 5 * 864e5).forEach(m => found.cricket.push(m));
        sports.cricket = { ok: true, full: now };
      }
      if (full || needsLive('cricket')) {
        const r = await call('cricketdata', B + '/currentMatches?apikey=' + k + '&offset=0');
        (r.data || []).map(fromCricket).filter(Boolean).forEach(m => { const i = found.cricket.findIndex(x => x.id === m.id); if (i >= 0) found.cricket[i] = m; else found.cricket.push(m); });
        sports.cricket = Object.assign({}, sports.cricket, { ok: true, error: '' });
        // matches we show as live (or that should have started) but the service no longer lists as current: they have
        // usually ended. Ask for each one by itself (a few per update, the longest unseen first) so they finish and settle.
        const seen = new Set(found.cricket.map(m => m.id));
        // also frozen scores (still listed, but not moving), at most every 30 min each
        const lost = tracked('cricket').filter(([id, m]) => !m.settled && m.approved === true && !m.adminCancelled &&
            ((!seen.has(id) && (m.status === 'live' || (m.status === 'upcoming' && m.startAt < now - 30 * 60000))) || (isFrozen(m, now) && now - (m.infoAt || 0) > 30 * 60000)))
          .sort((a, b) => (a[1].infoAt || a[1].seenAt || 0) - (b[1].infoAt || b[1].seenAt || 0)).slice(0, 3);
        for (const [id, m] of lost) {
          try { const r1 = await call('cricketdata', B + '/match_info?apikey=' + k + '&id=' + encodeURIComponent(m.srcId)); const x = r1.data && fromCricket(r1.data);
            await db.doc('sports/' + id).update({ infoAt: now }); m.infoAt = now;
            if (x) { const i = found.cricket.findIndex(y => y.id === x.id); if (i >= 0) found.cricket[i] = x; else found.cricket.push(x); } }
          catch (e) { errors.push('cricket match info: ' + e.message); break; }
        }
      }
      // the detailed scoreboard: two more requests per live match, only when the admin turned it on
      if (config.detail) for (const m of found.cricket.filter(x => x.status === 'live' && existing[x.id] && existing[x.id].approved === true)) {
        try { const card = await call('cricketdata', B + '/match_scorecard?apikey=' + k + '&id=' + encodeURIComponent(m.srcId)); let bbb = null;
          try { bbb = await call('cricketdata', B + '/match_bbb?apikey=' + k + '&id=' + encodeURIComponent(m.srcId)); } catch (e) { errors.push('cricket ball by ball: ' + e.message); }
          m.live = cricketDetail(card, bbb); }
        catch (e) { errors.push('cricket scorecard: ' + e.message); break; }
      }
    } catch (e) { fail('cricket', e); }
  }

  // write: new matches get opening markets; live ones get new odds from the score
  for (const sport of Object.keys(found)) {
    let list = found[sport].filter(m => m && m.startAt && !isNaN(m.startAt));
    const fresh = list.filter(m => !existing[m.id] && m.status === 'upcoming' && !TBC(m.home && m.home.name) && !TBC(m.away && m.away.name)).sort((a, b) => a.startAt - b.startAt).slice(0, MAX_PER_SPORT);
    // a match the club has not listed yet only joins before it starts: the admin approves it for players first
    list = list.filter(m => existing[m.id] || fresh.includes(m));
    for (const m of list) {
      const old = existing[m.id];
      const base = { sport: m.sport, league: m.league, leagueLogo: m.leagueLogo, home: m.home, away: m.away, startAt: m.startAt, status: m.status, score: m.score, detail: m.detail,
        source: m.sport === 'cricket' ? 'cricketdata' : 'apisports', srcId: m.srcId, type: m.type || '', seenAt: now, updatedAt: ts() };
      if (m.live) base.live = m.live;
      if (m.info) base.info = m.info;
      if (!old) {
        if (m.status === 'finished' || m.status === 'cancelled') continue;
        const mk = m.status === 'live' ? liveMarkets(m) || openingMarkets(m) : openingMarkets(m);
        Object.assign(base, { approved: false, bettingOpen: true, markets: mk, result: {}, decided: [], settled: false, lockUntil: m.status === 'live' ? now + LOCK_MS : 0, scoreAt: now, createdAt: ts() });
        await db.doc('sports/' + m.id).set(base); counts.added++; existing[m.id] = Object.assign({}, base, { createdAt: now, updatedAt: now, lockUntil: base.lockUntil });
        continue;
      }
      if (old.settled || old.adminCancelled) continue;
      const changed = JSON.stringify(old.score || {}) !== JSON.stringify(m.score) || old.status !== m.status || old.detail !== m.detail;
      if (changed) base.scoreAt = now;
      if (m.status === 'live') {
        const mk = liveMarkets(m);
        // live odds from the score; a match with no live model (a Test) keeps its prices but takes no bets during play
        base.markets = mk ? keepDecided(mk, old) : closeAll(old.markets);
        if (changed) base.lockUntil = now + LOCK_MS;
        // open during play, unless the admin closed it or the score has frozen
        base.bettingOpen = !old.adminClosed && !isFrozen(Object.assign({}, old, base, { scoreAt: changed ? now : old.scoreAt }), now);
      } else if (m.status !== 'upcoming') { base.bettingOpen = false; }
      if (changed || m.status === 'live' || old.status !== m.status || !old.seenAt || now - old.seenAt > 5 * 60000) { await db.doc('sports/' + m.id).update(base); counts.updated++; Object.assign(old, base, { lockUntil: base.lockUntil != null ? base.lockUntil : old.lockUntil }); }
      // settle every market whose outcome is now known
      const done = decidedNow(m, old);
      const newly = done.filter(k => !(old.decided || []).includes(k));
      if (newly.length || m.status === 'cancelled' || (m.status === 'finished' && !old.settled)) {
        const x = await settle(db, inc, ts, m.id, b => decideBet(b, m, old, newly));
        counts.settled += x.n; counts.paid += x.paid;
        const fin = m.status === 'finished' || m.status === 'cancelled';
        const upd = { decided: [...new Set((old.decided || []).concat(newly))], updatedAt: ts() };
        if (fin) Object.assign(upd, { settled: true, bettingOpen: false, result: { win: m.status === 'cancelled' ? 'void' : m.win || 'void' } });
        await db.doc('sports/' + m.id).update(upd); Object.assign(old, upd);
      }
    }
  }
  // any listed match that has started without the services telling us (e.g. a limit was reached): no more bets
  const staleMs = Math.max(12 * 60000, 2.5 * (Number(config.interval) || 15) * 60000);
  for (const [id, m] of Object.entries(existing)) {
    // not approved for players: no bets are possible, so nothing to pause; once it has started it can never be approved, so it goes
    if (m.approved === false) { if (m.startAt < now - 6 * 3600e3) { await db.doc('sports/' + id).delete(); delete existing[id]; counts.removed++; } continue; }
    // frozen long past the latest it could still be going on: no result will come, every open bet is given back
    if (isFrozen(m, now) && !m.settled && now > m.startAt + maxMs(m)) {
      const x = await settle(db, inc, ts, id, () => 'void'); counts.settled += x.n; counts.paid += x.paid;
      const upd = { status: 'cancelled', noResult: true, detail: 'No result: the data service stopped updating', settled: true, bettingOpen: false, result: { win: 'void' }, updatedAt: ts() };
      await db.doc('sports/' + id).update(upd); Object.assign(m, upd); continue;
    }
    if (isFrozen(m, now) && m.bettingOpen) { await db.doc('sports/' + id).update({ bettingOpen: false, updatedAt: ts() }); m.bettingOpen = false; }
    // a live match with no fresh score: betting pauses until the service sends one
    if (m.status === 'live' && !m.settled && m.bettingOpen && m.source !== 'manual' && now - (m.seenAt || 0) > staleMs) {
      await db.doc('sports/' + id).update({ bettingOpen: false, updatedAt: ts() }); m.bettingOpen = false; }
    if (m.status === 'upcoming' && m.bettingOpen && m.startAt <= now && m.source !== 'manual' && (over(m.sport === 'cricket' ? 'cricketdata' : 'apisports') || now - m.startAt > 30 * 60000)) {
      await db.doc('sports/' + id).update({ bettingOpen: false, updatedAt: ts() }); m.bettingOpen = false; }
    if (m.status === 'upcoming' && m.bettingOpen && m.startAt <= now && m.source === 'manual') { await db.doc('sports/' + id).update({ bettingOpen: false, updatedAt: ts() }); m.bettingOpen = false; }
    if (m.settled && m.startAt < now - KEEP_DONE_MS) { await db.doc('sports/' + id).delete(); delete existing[id]; counts.removed++; }
  }
  Object.keys(sports).forEach(k => { if (sports[k] && sports[k].ok) sports[k].matches = Object.values(existing).filter(m => m.sport === k && !m.settled).length; });
  const errs = (M0.errors || []).concat(errors.map(e => new Date(now).toISOString().slice(0, 16) + ' ' + e)).slice(-10);
  await meta.set({ lastRun: now, calls, counts, sports, usage, errors: errs, interval: config.interval || 15, off: { apisports: !!off.apisports, cricketdata: !!off.cricketdata }, detail: !!config.detail, updatedAt: ts() });
  log('update', JSON.stringify({ calls, counts, errors, usage: { a: usage.apisports.used, c: usage.cricketdata.used } }));
  return { calls, counts, errors, usage };
}
function liveMarkets(m) {
  if (m.sport === 'football') return footballMarkets(m, m.minute || 0, m.goals[0], m.goals[1]);
  if (m.sport === 'basketball') return basketballMarkets(m, m.elapsed || 0, m.pts[0], m.pts[1], m.leagueId === 12);
  return cricketMarkets(m, m.inn || [], (m.live && m.live.batting) || []);
}
function closeAll(mk) { const out = {}; Object.keys(mk || {}).forEach(k => { out[k] = Object.assign({}, mk[k], { open: false }); }); return out; }
// markets already decided stay as they were (shut); markets that disappeared stay shut so their bets still settle
function keepDecided(mk, old) {
  const out = Object.assign({}, mk);
  Object.keys(old.markets || {}).forEach(k => { if (!out[k] || (old.decided || []).includes(k)) out[k] = Object.assign({}, old.markets[k], { open: false }); });
  return out;
}
// which markets have an outcome now
function decidedNow(m, old) {
  const ks = Object.keys(old.markets || {});
  if (m.status === 'finished' || m.status === 'cancelled') return ks;
  if (m.sport !== 'cricket') return [];
  const out = [], inn = m.inn || [];
  if (inn[1]) out.push('tot1', 'rng1');
  const gone = ((m.live && m.live.out) || []).map(p => 'bat_' + slug(p.name));
  ks.filter(k => k.startsWith('bat_') && (gone.includes(k) || (old.markets[k].inn === 1 && inn[1]))).forEach(k => out.push(k));
  return out.filter(k => ks.includes(k));
}
// one bet: won, lost, void, or still open (null)
export function decideBet(b, m, old, newly) {
  if (m.status === 'cancelled') return 'void';
  const fin = m.status === 'finished';
  if (!fin && !newly.includes(b.market)) return null;
  const inn = m.inn || [], mk = b.market;
  if (mk === 'win') { const r = m.win || 'void'; if (r === 'void') return 'void'; const has = old.markets && old.markets.win && old.markets.win.opts && old.markets.win.opts[r]; return !has ? 'void' : r === b.pick ? 'won' : 'lost'; }
  if (mk === 'tot1' || mk === 'rng1') return inn[0] ? decidePick(b.pick, inn[0].r) || 'void' : 'void';
  if (mk === 'tot2' || mk === 'rng2') return inn[1] ? decidePick(b.pick, inn[1].r) || 'void' : 'void';
  if (mk.startsWith('bat_')) { const name = old.markets[mk] && old.markets[mk].batter, L = m.live || {}, all = (L.out || []).concat(L.batting || []), p = all.find(x => x.name === name); return p ? decidePick(b.pick, p.r) || 'void' : 'void'; }
  if (mk === 'goals') return decidePick(b.pick, (m.goals || [0, 0])[0] + (m.goals || [0, 0])[1]) || 'void';
  if (mk === 'btts') { const [hg, ag] = m.goals || [0, 0], yes = hg > 0 && ag > 0; return b.pick === (yes ? 'yes' : 'no') ? 'won' : 'lost'; }
  if (mk === 'pts') return decidePick(b.pick, (m.pts || [0, 0])[0] + (m.pts || [0, 0])[1]) || 'void';
  return 'void';
}
function apiErr(r) { const e = r && r.errors && (Array.isArray(r.errors) ? r.errors.join(' ') : Object.values(r.errors).join(' ')); return e ? String(e).slice(0, 200) : ''; }
function cricErr(r) { return r && r.status && r.status !== 'success' ? String(r.reason || r.status).slice(0, 200) : ''; }

// open bets on the match that are now decided: won, lost or void; winners (and voids) are paid
export async function settle(db, inc, ts, id, decide) {
  const sn = await db.collection('bets').where('matchId', '==', id).get();
  let n = 0, paid = 0;
  for (const d of sn.docs) {
    const b = d.data(); if (b.status !== 'open') continue;
    const st = typeof decide === 'function' ? decide(b) : ((r => r === 'void' ? 'void' : r === b.pick ? 'won' : 'lost')(decide[b.market] || 'void'));
    if (!st) continue;
    const pay = st === 'won' ? payout(b.stake, b.odds) : st === 'void' ? b.stake : 0;
    const batch = db.batch();
    batch.update(db.doc('bets/' + d.id), { status: st, payout: pay, settledAt: ts() });
    if (pay > 0) batch.update(db.doc('users/' + b.uid), { chips: inc(pay), lastPayout: d.id, updatedAt: ts() });
    try { await batch.commit(); n++; paid += pay; } catch (e) { console.warn('could not settle bet ' + d.id + ' (' + e.message + ')'); }
  }
  return { n, paid };
}

/* ---- started by GitHub Actions: stay on, updating at the interval the admin picked ---- */
async function main() {
  const { default: admin } = await import('firebase-admin');
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
  if (!sa.project_id) throw new Error('The secret FIREBASE_SERVICE_ACCOUNT is missing or is not the service account JSON.');
  admin.initializeApp({ credential: admin.credential.cert(sa) });
  const fs = admin.firestore(), FieldValue = admin.firestore.FieldValue;
  const fetchJson = async (url, headers) => { const r = await fetch(url, { headers }); const t = await r.text(); if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + t.slice(0, 120));
    const hd = {}; r.headers.forEach((v, k) => { hd[k.toLowerCase()] = v; }); return { json: JSON.parse(t), headers: hd }; };
  // every match, kept up to date by a listener (far fewer reads than loading them all every update)
  const existing = {}; let ready = false;
  fs.collection('sports').onSnapshot(q => { q.docChanges().forEach(c => { if (c.type === 'removed') delete existing[c.doc.id]; else existing[c.doc.id] = c.doc.data(); }); ready = true; }, e => console.error('listener', e.message));
  while (!ready) await sleep(500);
  const runFor = (Number(process.env.RUN_FOR_MIN) || 340) * 60000, end = Date.now() + runFor;
  let last = 0, lastNow = 0;
  while (Date.now() < end) {
    const cfg = (await fs.doc('sportsMeta/config').get()).data() || {};
    const every = clamp(Number(cfg.interval) || 15, 1, 60) * 60000, asked = Number(cfg.runNow) || 0;
    if (Date.now() - last >= every || asked > lastNow) {
      lastNow = Math.max(lastNow, asked); last = Date.now();
      try { await run({ db: fs, inc: n => FieldValue.increment(n), ts: () => FieldValue.serverTimestamp(), fetchJson, env: process.env, existing, config: cfg }); }
      catch (e) { console.error('update failed', e); }
    }
    await sleep(Math.min(20000, Math.max(1000, end - Date.now())));
  }
  process.exit(0);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
if (process.argv[1] && process.argv[1].endsWith('sports-feed.mjs')) main().catch(e => { console.error(e); process.exit(1); });

// api/predict.js  —  V1.5.0
// UEFA/Cup/National mode detection + Referee & Team tempo multipliers + robust provider predictions

const API_BASE = "https://v3.football.api-sports.io";
const KEY = process.env.APIFOOTBALL_KEY;

/* --------------------------- HTTP utils --------------------------- */
async function afGet(path, params = {}) {
  const qs = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null)
  ).toString();
  const url = `${API_BASE}${path}?${qs}`;
  const res = await fetch(url, { headers: { "x-apisports-key": KEY } });
  if (!res.ok) throw new Error(`API error ${res.status} on ${path}`);
  return await res.json();
}
async function afGetAll(path, params = {}) {
  let page = 1;
  const all = [];
  for (;;) {
    const js = await afGet(path, { ...params, page });
    const resp = js?.response || [];
    all.push(...resp);
    const cur = js?.paging?.current ?? page;
    const tot = js?.paging?.total ?? page;
    if (cur >= tot || resp.length === 0) break;
    page++;
  }
  return all;
}

/* --------------------------- math helpers --------------------------- */
function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
function factorial(n){ let f=1; for(let i=2;i<=n;i++) f*=i; return f; }
function poissonP(k, lambda){ return Math.exp(-lambda) * Math.pow(lambda, k) / factorial(k); }
function scoreMatrix(lambdaH, lambdaA) {
  const SIZE=7; const m=Array.from({length:SIZE},()=>Array(SIZE).fill(0));
  for (let h=0; h<SIZE; h++) for (let a=0; a<SIZE; a++) m[h][a]=poissonP(h,lambdaH)*poissonP(a,lambdaA);
  // hafif DC:
  const dc=1.06; m[0][0]*=dc; m[1][0]*=dc; m[0][1]*=dc; m[1][1]*=dc;
  const s=m.flat().reduce((x,y)=>x+y,0); for (let h=0; h<SIZE; h++) for (let a=0; a<SIZE; a++) m[h][a]/=s;
  return m;
}
function sum1X2(m){
  let H=0,D=0,A=0;
  for(let h=0;h<m.length;h++) for(let a=0;a<m[h].length;a++){
    if(h>a) H+=m[h][a]; else if(h===a) D+=m[h][a]; else A+=m[h][a];
  }
  return { home:H, draw:D, away:A };
}
function bttsYes(m){ let p=0; for(let h=1;h<m.length;h++) for(let a=1;a<m[h].length;a++) p+=m[h][a]; return p; }
function over25(m){ let p=0; for(let h=0;h<m.length;h++) for(let a=0;a<m[h].length;a++) if(h+a>=3) p+=m[h][a]; return p; }
function topScores(m, k=5) {
  const list = [];
  for(let h=0;h<m.length;h++) for(let a=0;a<m[h].length;a++) list.push({score:`${h}-${a}`, prob:m[h][a]});
  list.sort((x,y)=>y.prob-x.prob);
  return list.slice(0,k).map(s=>({ score:s.score, prob:Number(s.prob.toFixed(3)) }));
}

/* --------------------------- domain helpers --------------------------- */
const toNum = (x)=> x==null ? 0 : Number(x) || 0;
const per90 = (val, minutes)=> minutes>0 ? (toNum(val)*90)/minutes : 0;
const posGroup = (p)=> {
  const s = (p||"").toUpperCase();
  if (s.startsWith("G")) return "GK";
  if (s.startsWith("D")) return "DEF";
  if (s.startsWith("M")) return "MID";
  if (s.startsWith("F") || s.includes("W")) return "FWD";
  return "MID";
};

// oyuncu rating
function ratePlayer(stat) {
  const g = stat?.games || {};
  const min = toNum(g.minutes);
  const pos = posGroup(g.position);
  const shots = stat?.shots || {};
  const goals = stat?.goals || {};
  const passes = stat?.passes || {};
  const drib = stat?.dribbles || {};
  const tack = stat?.tackles || {};
  const duels = stat?.duels || {};
  const cards = stat?.cards || {};

  const conceded = toNum(goals.conceded);
  const saves = toNum(goals.saves);
  const sotFaced = saves + conceded;
  const savePct = sotFaced>0 ? saves/sotFaced : 0;

  const g90 = per90(goals.total, min);
  const a90 = per90(goals.assists, min);
  const sot90 = per90(shots.on, min);
  const kp90 = per90(passes.key, min);
  const drSucc90 = per90(drib.success, min);
  const tk90 = per90(tack.total, min);
  const int90 = per90(tack.interceptions, min);
  const blk90 = per90(tack.blocks, min);
  const duTot90 = per90(duels.total, min);
  const duWon = toNum(duels.won);
  const duWinRate = (toNum(duels.total)>0) ? duWon/toNum(duels.total) : 0;
  const y = toNum(cards.yellow);
  const r = toNum(cards.red);

  let off, def;
  if (pos==="GK") {
    const gc90 = per90(conceded, min);
    const penSave90 = per90(stat?.penalty?.saved, min);
    const sScore = 0.7*savePct + 0.2*(1 - clamp(gc90/2.0,0,1)) + 0.1*clamp(penSave90/0.2,0,1);
    def = 50 + 50*sScore;
    off = 20;
  } else if (pos==="FWD") {
    const o = 0.45*g90 + 0.2*a90 + 0.15*sot90 + 0.12*kp90 + 0.08*drSucc90;
    const d = 0.35*tk90 + 0.25*int90 + 0.15*blk90 + 0.25*(duTot90*duWinRate);
    off = 100*clamp(o/1.2, 0, 1);
    def = 100*clamp(d/1.0, 0, 1);
  } else if (pos==="MID") {
    const o = 0.25*g90 + 0.25*a90 + 0.2*kp90 + 0.15*drSucc90 + 0.15*sot90;
    const d = 0.3*tk90 + 0.3*int90 + 0.15*blk90 + 0.25*(duTot90*duWinRate);
    off = 100*clamp(o/0.9, 0, 1);
    def = 100*clamp(d/1.2, 0, 1);
  } else { // DEF
    const o = 0.15*a90 + 0.15*kp90 + 0.2*drSucc90 + 0.1*sot90;
    const d = 0.35*tk90 + 0.35*int90 + 0.15*blk90 + 0.15*(duTot90*duWinRate);
    off = 100*clamp(o/0.6, 0, 1);
    def = 100*clamp(d/1.4, 0, 1);
  }

  const discPenalty = clamp(1 - (0.02*y + 0.08*r), 0.85, 1);
  off *= discPenalty; def *= discPenalty;

  const shrink = clamp((min/540), 0.35, 1);
  off = 50 + (off-50)*shrink;
  def = 50 + (def-50)*shrink;

  return { off, def, pos, minutes:min };
}
function weightForTeam(pos) {
  if (pos==="GK") return { off:0.00, def:1.00 };
  if (pos==="FWD") return { off:1.00, def:0.40 };
  if (pos==="MID") return { off:0.60, def:0.60 };
  if (pos==="DEF") return { off:0.30, def:0.90 };
  return { off:0.50, def:0.50 };
}
function lineupIds(lineupObj) {
  const arr = lineupObj?.startXI || [];
  return arr.map(x => x?.player?.id).filter(Boolean);
}
function teamFromXI(playerRatingsById, xiIds) {
  let offSum=0, offW=0, defSum=0, defW=0;
  const used = [];
  for (const pid of xiIds) {
    const pr = playerRatingsById.get(pid);
    if (!pr) continue;
    const w = weightForTeam(pr.pos);
    offSum += pr.off * w.off;
    defSum += pr.def * w.def;
    offW += w.off;
    defW += w.def;
    used.push({ id: pid, off: pr.off, def: pr.def, pos: pr.pos, minutes: pr.minutes });
  }
  const OffTeam = offW>0 ? offSum/offW : 80;
  const DefTeam = defW>0 ? defSum/defW : 80;
  return {
    OffTeam: clamp(OffTeam, 20, 180),
    DefTeam: clamp(DefTeam, 20, 180),
    xi_detail: used
  };
}

/* --------- odds -> implied 1X2 --------- */
function oddsImplied(oddsResp) {
  const rs = oddsResp?.response || [];
  const triplets = [];
  for (const fx of rs) {
    for (const bm of (fx.bookmakers||[])) {
      for (const bet of (bm.bets||[])) {
        const name = (bet.name||"").toLowerCase();
        if (name.includes("match") || name.includes("1x2") || name.includes("winner")) {
          let h=null,d=null,a=null;
          for (const v of (bet.values||[])) {
            const nm=(v.value||"").toLowerCase();
            const odd=Number(v.odd);
            if (!odd || odd<=1.01) continue;
            if (nm.includes("home") || nm==="1") h = 1/odd;
            else if (nm.includes("draw") || nm==="x") d = 1/odd;
            else if (nm.includes("away") || nm==="2") a = 1/odd;
          }
          if (h && d && a) {
            const s=h+d+a; triplets.push({home:h/s, draw:d/s, away:a/s});
          }
        }
      }
    }
  }
  if (!triplets.length) return null;
  const avg = triplets.reduce((acc,t)=>({home:acc.home+t.home, draw:acc.draw+t.draw, away:acc.away+t.away}),
                              {home:0,draw:0,away:0});
  const n = triplets.length;
  return { home:avg.home/n, draw:avg.draw/n, away:avg.away/n };
}

/* --------- H2H düşük skor paterni --------- */
function applyLowScoreBoost(m, h2hResp) {
  const rows = h2hResp?.response || [];
  const recent = rows.slice(0,6).filter(x => (x?.fixture?.status?.short||"").toUpperCase()==="FT");
  if (recent.length<3) return { matrix:m, applied:false };
  let totalGoals=0, lowCount=0;
  for (const r of recent) {
    const gh = r?.goals?.home ?? r?.score?.fulltime?.home ?? 0;
    const ga = r?.goals?.away ?? r?.score?.fulltime?.away ?? 0;
    const tg = toNum(gh)+toNum(ga);
    totalGoals += tg;
    if (tg<=1) lowCount++;
  }
  const avg = totalGoals / recent.length;
  const strongLow = avg < 1.8 || lowCount >= 3;
  if (!strongLow) return { matrix:m, applied:false };

  const SIZE = m.length;
  const clone = m.map(r=>r.slice());
  const add = 0.015;
  clone[0][0] += add;
  clone[1][0] += add;
  clone[0][1] += add;
  let s = clone.flat().reduce((x,y)=>x+y,0);
  for (let h=0; h<SIZE; h++) for (let a=0; a<SIZE; a++) clone[h][a] /= s;
  return { matrix: clone, applied:true };
}

/* --------- Mode detection (UEFA / Cup / National / League) --------- */
function detectModeFromFixture(fx) {
  const l = fx?.league || {};
  const name = (l.name || "").toLowerCase();
  const type = (l.type || "").toLowerCase(); // "League" | "Cup"
  const isUEFA = /uefa|champions league|europa league|conference league/.test(name);
  const isNational = /(world cup|wc qualification|euro|nations league|africa cup|copa america|gold cup|asian cup)/.test(name);
  if (isUEFA) return "uefa";
  if (isNational) return "national";
  if (type === "cup" && !isUEFA) return "cup";
  return "league";
}

/* --------- Referee & tempo factors --------- */
async function refereeFactors(fixture) {
  const refName = fixture?.fixture?.referee;
  if (!refName) return { has:false, name:null, matches:0, yc:0, rc:0, fouls:0, tempo_mult:1.0 };
  // Not: API-FOOTBALL 'referee' filtresi bazı liglerde sınırlı olabilir; boş dönerse nötr.
  const refGames = await afGetAll("/fixtures", { referee: refName, last: 20 });
  let n=0, yc=0, rc=0, fouls=0;

  for (const g of refGames) {
    const st = (g?.fixture?.status?.short || "").toUpperCase();
    if (st !== "FT") continue;
    n++;

    const fid = g?.fixture?.id;
    if (!fid) continue;

    // events -> kartlar
    try {
      const evJs = await afGet("/fixtures/events", { fixture: fid });
      const events = evJs?.response || [];
      for (const e of events) {
        const t = (e?.type || "").toLowerCase();
        const d = (e?.detail || "").toLowerCase();
        if (t === "card" && d.includes("yellow")) yc++;
        if (t === "card" && d.includes("red")) rc++;
      }
    } catch(_) {}

    // statistics -> fouls
    try {
      const stxJs = await afGet("/fixtures/statistics", { fixture: fid });
      const teamsStats = stxJs?.response || [];
      for (const ts of teamsStats) {
        const arr = ts?.statistics || [];
        const foulsRow = arr.find(r => (r?.type || "").toLowerCase() === "fouls");
        fouls += Number(foulsRow?.value || 0);
      }
    } catch(_) {}
  }

  if (n === 0) return { has:false, name:refName, matches:0, yc:0, rc:0, fouls:0, tempo_mult:1.0 };

  const ycPer = yc / n, rcPer = rc / n, foulsPer = fouls / n;

  // Basit tempo modeli (kart/foul yüksek => tempo azıcık düşer)
  let tempo = 1.0;
  if (ycPer > 4.5) tempo -= 0.02;
  if (ycPer > 5.5) tempo -= 0.01;
  if (foulsPer > 26) tempo -= 0.02;
  tempo = clamp(tempo, 0.92, 1.02);

  return { has:true, name:refName, matches:n, yc:Number(ycPer.toFixed(2)), rc:Number(rcPer.toFixed(2)), fouls:Number(foulsPer.toFixed(1)), tempo_mult:Number(tempo.toFixed(3)) };
}

async function teamTempoIndex(teamId, season) {
  const last = await afGetAll("/fixtures", { team: teamId, season, last: 6 });
  let n=0, shots=0, poss=0, dang=0;

  for (const g of last) {
    const st = (g?.fixture?.status?.short || "").toUpperCase();
    if (st !== "FT") continue;
    const fxId = g?.fixture?.id;
    if (!fxId) continue;
    try {
      const stx = await afGet("/fixtures/statistics", { fixture: fxId });
      const rows = stx?.response || [];
      for (const r of rows) {
        const arr = r?.statistics || [];
        const getVal = (key) => {
          const row = arr.find(z => (z?.type || "").toLowerCase() === key);
          let v = row?.value;
          if (typeof v === "string" && v.endsWith("%")) v = Number(v.replace("%",""));
          return Number(v || 0);
        };
        shots += getVal("total shots");
        poss  += getVal("ball possession");
        dang  += getVal("dangerous attacks");
        n++;
      }
    } catch(_) {}
  }
  if (n===0) return { has:false, tempo_mult:1.0, meta:null };

  const shotsAvg = shots / n;
  const possAvg  = poss / n;
  const dangAvg  = dang / n;

  // Basit lig-agnostik referanslar
  let tempo = 1.0;
  if (shotsAvg > 26) tempo += 0.03;
  if (shotsAvg < 18) tempo -= 0.02;
  if (possAvg > 56)  tempo += 0.01;
  if (possAvg < 44)  tempo -= 0.01;
  if (dangAvg > 120) tempo += 0.02;

  tempo = clamp(tempo, 0.94, 1.06);
  return { has:true, tempo_mult:Number(tempo.toFixed(3)), meta:{ shotsAvg:Number(shotsAvg.toFixed(1)), possAvg:Number(possAvg.toFixed(1)), dangAvg:Number(dangAvg.toFixed(0)), n } };
}

/* --------- League μ (wider seasonal window) --------- */
async function computeLeagueMu(leagueId, season) {
  const from = `${season-1}-07-01`;
  const to = `${season+1}-06-30`;
  const nowISO = new Date().toISOString();
  const fixtures = await afGetAll("/fixtures", { league: leagueId, season, from, to });
  let n=0, homeGoals=0, awayGoals=0;
  for (const f of fixtures) {
    const st = (f?.fixture?.status?.short||"").toUpperCase();
    const dISO = f?.fixture?.date;
    if (!dISO || new Date(dISO).toISOString() >= nowISO) continue; // as-of
    if (st!=="FT") continue;
    const gh = f?.goals?.home ?? f?.score?.fulltime?.home ?? 0;
    const ga = f?.goals?.away ?? f?.score?.fulltime?.away ?? 0;
    homeGoals += toNum(gh); awayGoals += toNum(ga); n++;
  }
  if (n===0) return { mu_home:1.60, mu_away:1.20 };
  const muH = homeGoals/n;
  const muA = awayGoals/n;
  return { mu_home: Number(muH.toFixed(2)), mu_away: Number(muA.toFixed(2)) };
}

/* --------- Players (ratings) --------- */
async function teamPlayersRatings(teamId, leagueId, season) {
  const all = await afGetAll("/players", { team: teamId, league: leagueId, season });
  const byId = new Map();
  for (const row of all) {
    const pid = row?.player?.id;
    const stat = row?.statistics?.[0];
    if (!pid || !stat) continue;
    byId.set(pid, ratePlayer(stat));
  }
  return byId;
}
function idealXIFromRatings(ratingsMap) {
  const arr = Array.from(ratingsMap.entries()).map(([id,v])=>({id, ...v}));
  arr.sort((a,b)=> (b.minutes||0) - (a.minutes||0));
  return arr.slice(0,11).map(x=>x.id);
}

/* ------------------------------ MAIN ------------------------------ */
export default async function handler(req, res){
  try{
    if (!KEY) return res.status(500).json({ error: "Missing APIFOOTBALL_KEY env var" });
    const fixtureId = req.query.fixture ? String(req.query.fixture) : undefined;
    const debug = String(req.query.debug||"") === "1";
    if (!fixtureId) return res.status(400).json({ error: "Pass ?fixture={id}" });

    const asof = new Date().toISOString();
    const fxJs = await afGet("/fixtures", { id: fixtureId });
    const fixture = fxJs?.response?.[0];
    if(!fixture) return res.status(404).json({ error: "Fixture not found" });

    const homeId = fixture.teams?.home?.id;
    const awayId = fixture.teams?.away?.id;
    const leagueId = fixture.league?.id;
    const seasonYr = fixture.league?.season;
    const kickoffISO = fixture.fixture?.date;
    if(!kickoffISO) throw new Error("Kickoff time missing");
    const now = Date.now();
    const kickoff = new Date(kickoffISO).getTime();

    const mode = detectModeFromFixture(fixture);

    // bulk fetch
    const [
      homeStatsJs, awayStatsJs,
      injHomeJs, injAwayJs,
      h2hJs, lineupsJs,
      oddsJs, providerPredJs,
      homePR, awayPR
    ] = await Promise.all([
      afGet("/teams/statistics", { team: homeId, league: leagueId, season: seasonYr }),
      afGet("/teams/statistics", { team: awayId, league: leagueId, season: seasonYr }),
      afGet("/injuries", { team: homeId, season: seasonYr }),
      afGet("/injuries", { team: awayId, season: seasonYr }),
      afGet("/fixtures/headtohead", { h2h: `${homeId}-${awayId}`, last: 10 }),
      afGet("/fixtures/lineups", { fixture: fixtureId }),
      afGet("/odds", { fixture: fixtureId }),
      afGet("/predictions", { fixture: fixtureId }),
      teamPlayersRatings(homeId, leagueId, seasonYr),
      teamPlayersRatings(awayId, leagueId, seasonYr)
    ]);

    // μ (lig tabanı as-of)
    const { mu_home, mu_away } = await computeLeagueMu(leagueId, seasonYr);
    const mu_team = (mu_home+mu_away)/2;

    // takım üstü avg (fallback)
    const hs = homeStatsJs?.response || {};
    const as = awayStatsJs?.response || {};
    const gfH = Number(hs?.goals?.for?.average?.total ?? 1.3);
    const gaH = Number(hs?.goals?.against?.average?.total ?? 1.3);
    const gfA = Number(as?.goals?.for?.average?.total ?? 1.3);
    const gaA = Number(as?.goals?.against?.average?.total ?? 1.3);

    // XI ve ideal XI
    const lineups = lineupsJs?.response || [];
    const xiHomeIds = lineupIds(lineups.find(x=>x?.team?.id===homeId)) || [];
    const xiAwayIds = lineupIds(lineups.find(x=>x?.team?.id===awayId)) || [];
    const xiAvailable = (xiHomeIds.length>0 && xiAwayIds.length>0 && kickoff>now);
    const xiConfidence = xiAvailable ? "high" : (kickoff - now < 90*60*1000 ? "medium" : "low");

    const idealHome = idealXIFromRatings(homePR);
    const idealAway = idealXIFromRatings(awayPR);
    const currentHome = xiHomeIds.length ? xiHomeIds : idealHome;
    const currentAway = xiAwayIds.length ? xiAwayIds : idealAway;

    const teamH = teamFromXI(homePR, currentHome);
    const teamA = teamFromXI(awayPR, currentAway);
    const idealH = teamFromXI(homePR, idealHome);
    const idealA = teamFromXI(awayPR, idealAway);

    // sakat/ceza (list)
    const injHome = injHomeJs?.response || [];
    const injAway = injAwayJs?.response || [];
    const injIdsHome = new Set(injHome.map(x=>x?.player?.id).filter(Boolean));
    const injIdsAway = new Set(injAway.map(x=>x?.player?.id).filter(Boolean));
    const keyOutHome = idealHome.filter(id => !currentHome.includes(id) && injIdsHome.has(id));
    const keyOutAway = idealAway.filter(id => !currentAway.includes(id) && injIdsAway.has(id));

    // takım-üstü + XI harmanı
    const clampOD = (x)=> clamp(x, 20, 180);
    const offH_stats = clampOD((gfH/mu_team)*100);
    const defH_stats = clampOD((mu_team/gaH)*100);
    const offA_stats = clampOD((gfA/mu_team)*100);
    const defA_stats = clampOD((mu_team/gaA)*100);

    const offH_xi = clampOD(teamH.OffTeam);
    const defH_xi = clampOD(teamH.DefTeam);
    const offA_xi = clampOD(teamA.OffTeam);
    const defA_xi = clampOD(teamA.DefTeam);

    const OffH = 0.6*offH_xi + 0.4*offH_stats;
    const DefH = 0.6*defH_xi + 0.4*defH_stats;
    const OffA = 0.6*offA_xi + 0.4*offA_stats;
    const DefA = 0.6*defA_xi + 0.4*defA_stats;

    // SoS (hafif, endpoint'te form alanı sınırlı olabilir -> nötrlenir)
    const sosHomeOff = clamp((toNum(hs?.form?.att?.value)||1), 0.8, 1.2);
    const sosHomeDef = clamp((toNum(hs?.form?.def?.value)||1), 0.8, 1.2);
    const sosAwayOff = clamp((toNum(as?.form?.att?.value)||1), 0.8, 1.2);
    const sosAwayDef = clamp((toNum(as?.form?.def?.value)||1), 0.8, 1.2);

    // başlangıç λ
    let lambda_home = mu_home * (OffH/100) * (100/DefA) * sosHomeOff * (1/sosAwayDef);
    let lambda_away = mu_away * (OffA/100) * (100/DefH) * sosAwayOff * (1/sosHomeDef);

    // XI belirsizliği
    if (xiConfidence === "medium") { lambda_home*=0.97; lambda_away*=0.97; }
    if (xiConfidence === "low")    { lambda_home*=0.94; lambda_away*=0.94; }

    // --- Referee & Team tempo multipliers ---
    const [refFx, tempoH, tempoA] = await Promise.all([
      refereeFactors(fixture),
      teamTempoIndex(homeId, seasonYr),
      teamTempoIndex(awayId, seasonYr),
    ]);
    const M_ref = refFx?.tempo_mult ?? 1.0;
    const M_tempo_home = tempoH?.tempo_mult ?? 1.0;
    const M_tempo_away = tempoA?.tempo_mult ?? 1.0;

    // --- Mode multipliers (şimdilik nötr; odds harmanı zaten rekabet gücünü taşır) ---
    let M_mode_home = 1.0, M_mode_away = 1.0;
    // if (mode === "cup") { /* ileride cross-tier/rotasyon için küçük düzeltme */ }

    lambda_home *= M_ref * M_tempo_home * M_mode_home;
    lambda_away *= M_ref * M_tempo_away * M_mode_away;

    // güvenli sınırlar
    lambda_home = clamp(lambda_home, 0.2, 3.8);
    lambda_away = clamp(lambda_away, 0.2, 3.8);

    // skor ızgarası + H2H düşük skor düzeltmesi
    let grid = scoreMatrix(lambda_home, lambda_away);
    const h2hBoost = applyLowScoreBoost(grid, h2hJs);
    grid = h2hBoost.matrix;

    const win = sum1X2(grid);
    const btts = bttsYes(grid);
    const over = over25(grid);
    const under = 1 - over;

    // piyasa harmanı (1X2)
    const market = oddsImplied(oddsJs);
    const blend = (m,b,alpha=0.75)=> {
      if (!b) return m;
      return {
        home: clamp(alpha*m.home + (1-alpha)*b.home, 0, 1),
        draw: clamp(alpha*m.draw + (1-alpha)*b.draw, 0, 1),
        away: clamp(alpha*m.away + (1-alpha)*b.away, 0, 1)
      };
    };
    const win_blended = blend(win, market);

    // provider predictions (sağlam ayrıştırıcı)
    let provider = null;
    const r = providerPredJs?.response;
    if (Array.isArray(r) && r.length) {
      const item = r[0] || {};
      let p = null;
      if (Array.isArray(item.predictions) && item.predictions.length) p = item.predictions[0];
      else if (item.predictions && typeof item.predictions === "object") p = item.predictions;
      else if (item.prediction && typeof item.prediction === "object") p = item.prediction;
      else if (item.data?.predictions) p = Array.isArray(item.data.predictions) ? item.data.predictions[0] : item.data.predictions;

      const percent = p?.percent || item?.percent || null;
      const toP = s => (typeof s==="string" ? Number(s.replace("%",""))/100
                        : (typeof s==="number" ? s : null));
      let probs_1x2 = null;
      if (percent && (percent.home ?? percent.Home) != null) {
        probs_1x2 = {
          home: toP(percent.home ?? percent.Home),
          draw: toP(percent.draw ?? percent.Draw),
          away: toP(percent.away ?? percent.Away)
        };
      }

      provider = {
        winner: p?.winner || item?.winner || null,
        win_or_draw: p?.win_or_draw ?? null,
        under_over: p?.under_over ?? null,
        goals: p?.goals ?? null,
        advice: p?.advice ?? null,
        probs_1x2,
        comparison: item?.comparison || null
      };
    }

    // injuries counts
    const injHomeCount = (injHomeJs?.response||[]).length;
    const injAwayCount = (injAwayJs?.response||[]).length;

    const pickLite = (ids, map) => ids.map(id => {
      const r = map.get(id);
      return r ? { id, grp: r.pos, off: Math.round(r.off), def: Math.round(r.def) } : { id };
    });

    const out = {
      version: "fa-api v1.5.0",
      asof_utc: asof,
      input: { fixture_id: fixtureId, league_id: leagueId, season: seasonYr, mode },
      mu: { mu_home, mu_away },
      prediction: {
        lambda_home: Number(lambda_home.toFixed(3)),
        lambda_away: Number(lambda_away.toFixed(3)),
        win_probs_model: {
          home: Number(win.home.toFixed(3)),
          draw: Number(win.draw.toFixed(3)),
          away: Number(win.away.toFixed(3))
        },
        win_probs_blended: {
          home: Number(win_blended.home.toFixed(3)),
          draw: Number(win_blended.draw.toFixed(3)),
          away: Number(win_blended.away.toFixed(3))
        },
        btts_yes: Number(btts.toFixed(3)),
        over25: Number(over.toFixed(3)),
        under25: Number(under.toFixed(3)),
        top_scores: topScores(grid, 5),
        score_matrix: grid.map(r=>r.map(x=>Number(x.toFixed(6)))),
        offdef: {
          home_off: Number((0.6*teamH.OffTeam + 0.4*clamp((gfH/((mu_home+mu_away)/2))*100,20,180)).toFixed(1)),
          home_def: Number((0.6*teamH.DefTeam + 0.4*clamp((((mu_home+mu_away)/2)/gaH)*100,20,180)).toFixed(1)),
          away_off: Number((0.6*teamA.OffTeam + 0.4*clamp((gfA/((mu_home+mu_away)/2))*100,20,180)).toFixed(1)),
          away_def: Number((0.6*teamA.DefTeam + 0.4*clamp((((mu_home+mu_away)/2)/gaA)*100,20,180)).toFixed(1))
        }
      },
      modifiers: {
        xi_factors: {
          home: {
            off: idealH.OffTeam>0 ? Number((teamH.OffTeam/idealH.OffTeam).toFixed(3)) : 1,
            def: idealH.DefTeam>0 ? Number((teamH.DefTeam/idealH.DefTeam).toFixed(3)) : 1
          },
          away: {
            off: idealA.OffTeam>0 ? Number((teamA.OffTeam/idealA.OffTeam).toFixed(3)) : 1,
            def: idealA.DefTeam>0 ? Number((teamA.DefTeam/idealA.DefTeam).toFixed(3)) : 1
          }
        },
        xi_players: {
          home: { idealXI: pickLite(idealHome, homePR), currentXI: pickLite(currentHome, homePR), key_out: keyOutHome },
          away: { idealXI: pickLite(idealAway, awayPR), currentXI: pickLite(currentAway, awayPR), key_out: keyOutAway }
        },
        injuries: { home_count: injHomeCount, away_count: injAwayCount },
        referee: refFx,
        tempo: { home: tempoH, away: tempoA },
        mode_factors: { mode, M_ref, M_tempo_home, M_tempo_away },
        h2h_low_boost_applied: h2hBoost.applied,
        market_implied: oddsImplied(oddsJs)
      },
      explanation: {
        notes: "V1.5.0 – UEFA/Kupa/Milli mod tespiti, hakem & tempo çarpanları, robust provider parser; lig μ geniş pencere; oyuncu-bazlı Off/Def + H2H düşük-skor boost; odds harmanı; λ cap.",
        flags: { low_lineup_confidence: xiConfidence!=="high", old_snapshot:false, missing_sources:false }
      },
      xi_confidence: xiConfidence,
      provider_predictions: provider,
      sources: [
        `${API_BASE}/fixtures?id=${fixtureId}`,
        `${API_BASE}/teams/statistics?team=${homeId}&league=${leagueId}&season=${seasonYr}`,
        `${API_BASE}/teams/statistics?team=${awayId}&league=${leagueId}&season=${seasonYr}`,
        `${API_BASE}/fixtures?league=${leagueId}&season=${seasonYr}`,
        `${API_BASE}/fixtures/lineups?fixture=${fixtureId}`,
        `${API_BASE}/injuries?team=${homeId}&season=${seasonYr}`,
        `${API_BASE}/injuries?team=${awayId}&season=${seasonYr}`,
        `${API_BASE}/fixtures/headtohead?h2h=${homeId}-${awayId}`,
        `${API_BASE}/fixtures/events?fixture=${fixtureId}`,
        `${API_BASE}/fixtures/statistics?fixture=${fixtureId}`,
        `${API_BASE}/odds?fixture=${fixtureId}`,
        `${API_BASE}/predictions?fixture=${fixtureId}`,
        `${API_BASE}/players?team=${homeId}&league=${leagueId}&season=${seasonYr}`,
        `${API_BASE}/players?team=${awayId}&league=${leagueId}&season=${seasonYr}`
      ]
    };

    if (debug) {
      out.modifiers.provider_raw_excerpt = JSON.stringify(
        (providerPredJs?.response||[])[0] ?? null
      ).slice(0, 1200);
    }

    return res.status(200).json(out);

  } catch (err){
    return res.status(500).json({ error: err?.message || "Internal error" });
  }
}

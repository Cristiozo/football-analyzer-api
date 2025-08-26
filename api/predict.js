const API_BASE = "https://v3.football.api-sports.io";
const KEY = process.env.APIFOOTBALL_KEY;

// ---------- Core HTTP ----------
async function afGet(path, params) {
  const qs = new URLSearchParams(
    Object.entries(params || {}).filter(([, v]) => v !== undefined && v !== null)
  ).toString();
  const url = `${API_BASE}${path}?${qs}`;
  const res = await fetch(url, { headers: { "x-apisports-key": KEY } });
  if (!res.ok) throw new Error(`API error ${res.status} on ${path}`);
  const json = await res.json();
  return json?.response ?? [];
}

// ---------- Math helpers ----------
function factorial(n){ let f=1; for(let i=2;i<=n;i++) f*=i; return f; }
function poissonP(k, lambda){ return Math.exp(-lambda) * Math.pow(lambda, k) / factorial(k); }

function scoreMatrix(lambdaH, lambdaA){
  const SIZE=7; const m=Array.from({length:SIZE},()=>Array(SIZE).fill(0));
  for(let h=0;h<SIZE;h++) for(let a=0;a<SIZE;a++) m[h][a]=poissonP(h,lambdaH)*poissonP(a,lambdaA);
  // hafif Dixon–Coles: düşük skor hücrelerine minik artış
  const dc=1.06; m[0][0]*=dc; m[1][0]*=dc; m[0][1]*=dc; m[1][1]*=dc;
  // normalize
  const s=m.flat().reduce((x,y)=>x+y,0); for(let h=0;h<SIZE;h++) for(let a=0;a<SIZE;a++) m[h][a]/=s; 
  return m;
}
function sum1X2(m){ let H=0,D=0,A=0;
  for(let h=0;h<m.length;h++) for(let a=0;a<m[h].length;a++){ if(h>a) H+=m[h][a]; else if(h===a) D+=m[h][a]; else A+=m[h][a]; }
  return { home:H, draw:D, away:A };
}
function bttsYes(m){ let p=0; for(let h=1;h<m.length;h++) for(let a=1;a<m[h].length;a++) p+=m[h][a]; return p; }
function over25(m){ let p=0; for(let h=0;h<m.length;h++) for(let a=0;a<m[h].length;a++) if(h+a>=3) p+=m[h][a]; return p; }

const clampPct = (x)=>Math.max(20, Math.min(180, x));     // Off/Def 20–180 banda
const squash   = (v)=>100*Math.sqrt(v/100);                // aşırıları bastır
const cap      = (x,lo,hi)=>Math.max(lo, Math.min(hi,x));  // λ cap

// ---------- Utils ----------
const toISODate = (d)=>new Date(d).toISOString().slice(0,10); // YYYY-MM-DD

// Lig μ’sünü “takım istatistiklerinden” üret (pagination gerektirmez)
async function getLeagueMuFromTeams(leagueId, seasonYr, cache){
  if(cache.mu && cache.mu.key===`${leagueId}-${seasonYr}`) return cache.mu.val;
  const teams = await afGet("/teams", { league: leagueId, season: seasonYr });
  const ids = (teams||[]).map(t=>t.team?.id).filter(Boolean);
  let sumHome=0, sumAway=0, nHome=0, nAway=0;
  // Her takım için team statistics çek
  for(const id of ids){
    const st = await afGet("/teams/statistics", { team:id, league:leagueId, season:seasonYr });
    const sh = Number(st?.goals?.for?.average?.home ?? NaN);
    const sa = Number(st?.goals?.for?.average?.away ?? NaN);
    if(Number.isFinite(sh)) { sumHome+=sh; nHome++; }
    if(Number.isFinite(sa)) { sumAway+=sa; nAway++; }
  }
  // Güvenlik: eksikse varsayılanlara dön
  const mu_home = nHome>0 ? (sumHome/nHome) : 1.60;
  const mu_away = nAway>0 ? (sumAway/nAway) : 1.20;
  cache.mu = { key:`${leagueId}-${seasonYr}`, val:{ mu_home, mu_away } };
  return cache.mu.val;
}

// Son N (FT) maçı, kickoff öncesi
async function getTeamLastN(teamId, leagueId, seasonYr, kickoffISO, N){
  const to = toISODate(new Date(new Date(kickoffISO).getTime() - 24*3600*1000)); // bir gün öncesine kadar
  const from = toISODate(new Date(new Date(kickoffISO).getTime() - 200*24*3600*1000)); // ~200 gün geriye
  const all = await afGet("/fixtures", { team: teamId, league: leagueId, season: seasonYr, from, to });
  // bitenler
  const done = (all||[]).filter(f=>{
    const s = f?.fixture?.status?.short;
    const t = new Date(f?.fixture?.date).getTime();
    return ["FT","PEN","AET"].includes(s) && t < new Date(kickoffISO).getTime();
  }).sort((a,b)=>new Date(b.fixture.date)-new Date(a.fixture.date));
  return done.slice(0,N);
}

// Odds → medyan 1X2 olasılığı
function oddsToImplied1x2(oddsResp){
  try{
    const books = Array.isArray(oddsResp) ? oddsResp : [];
    const triplets = [];
    for(const bm of books){
      for(const bet of (bm?.bookmakers?.[0]?.bets || bm?.bets || [])){
        const name = (bet?.name || "").toLowerCase();
        if(name.includes("match winner") || name==="1x2" || name.includes("3way")){
          const vals = bet.values || [];
          let oH,oD,oA;
          for(const v of vals){
            const label = (v?.value || v?.label || "").toLowerCase();
            const odd = Number(v?.odd);
            if(!Number.isFinite(odd)) continue;
            if(label.includes("home") || label==="1") oH=odd;
            if(label.includes("draw") || label==="x") oD=odd;
            if(label.includes("away") || label==="2") oA=odd;
          }
          if(oH && oD && oA){
            const ih=1/oH, id=1/oD, ia=1/oA; 
            const s=ih+id+ia; triplets.push({h:ih/s, d:id/s, a:ia/s});
          }
        }
      }
      // bazı sağlayıcılarda yapı farklı olabilir — üstteki kaçarsa diğer bookmakers’ları da tara
      for(const bk of (bm?.bookmakers || [])){
        for(const bet of (bk?.bets || [])){
          const name = (bet?.name || "").toLowerCase();
          if(name.includes("match winner") || name==="1x2" || name.includes("3way")){
            const vals = bet.values || [];
            let oH,oD,oA;
            for(const v of vals){
              const label = (v?.value || v?.label || "").toLowerCase();
              const odd = Number(v?.odd);
              if(!Number.isFinite(odd)) continue;
              if(label.includes("home") || label==="1") oH=odd;
              if(label.includes("draw") || label==="x") oD=odd;
              if(label.includes("away") || label==="2") oA=odd;
            }
            if(oH && oD && oA){
              const ih=1/oH, id=1/oD, ia=1/oA; 
              const s=ih+id+ia; triplets.push({h:ih/s, d:id/s, a:ia/s});
            }
          }
        }
      }
    }
    if(!triplets.length) return null;
    // medyan
    const med = (arr, key) => {
      const xs = arr.map(o=>o[key]).sort((a,b)=>a-b);
      const mid = Math.floor(xs.length/2);
      return xs.length%2? xs[mid] : 0.5*(xs[mid-1]+xs[mid]);
    };
    const home = med(triplets,"h"), draw = med(triplets,"d"), away = med(triplets,"a");
    const s = home+draw+away; 
    return { home:home/s, draw:draw/s, away:away/s };
  }catch{ return null; }
}

// H2H düşük skor boost
function applyH2HLows(matrix, h2hList){
  try{
    const last = Array.isArray(h2hList) ? h2hList : [];
    if(!last.length) return matrix;
    let low=0, n=0;
    for(const f of last){
      const hs = Number(f?.goals?.home ?? 0);
      const as = Number(f?.goals?.away ?? 0);
      const s = (f?.fixture?.status?.short);
      if(["FT","AET","PEN"].includes(s)){ n++; if((hs+as)<=1) low++; }
    }
    if(!n) return matrix;
    const pLow = low/n; // 0..1
    const baseline = 0.22; // tipik düşük skor payı
    const boost = cap(1 + 0.25*(pLow - baseline), 0.95, 1.08); // max %8
    // hücreleri çarp ve normalize et
    const M = matrix.map(r=>r.slice());
    M[0][0]*=boost; M[1][0]*=boost; M[0][1]*=boost; M[1][1]*=boost;
    const s = M.flat().reduce((x,y)=>x+y,0);
    for(let h=0;h<M.length;h++) for(let a=0;a<M[h].length;a++) M[h][a]/=s;
    return M;
  }catch{ return matrix; }
}

// Ortalama rakip gücü (son N maç) → SoS faktörü
function computeSoSModifier(lastN, teamId, oppDefGetter, oppOffGetter, gfSeason, gaSeason){
  // lastN: takımın son N FT maçı (kickoff öncesi)
  if(!lastN || !lastN.length) return { off:1.0, def:1.0, meta:{n:0} };
  let gf=0, ga=0, defSum=0, offSum=0, n=0;
  for(const f of lastN){
    const hId = f?.teams?.home?.id, aId = f?.teams?.away?.id;
    const isHome = hId === teamId;
    const myGoals = Number(isHome ? f?.goals?.home : f?.goals?.away);
    const opGoals = Number(isHome ? f?.goals?.away : f?.goals?.home);
    const oppId = isHome ? aId : hId;
    const defR = oppDefGetter(oppId); // 0–100
    const offR = oppOffGetter(oppId);
    if(defR) defSum += defR;
    if(offR) offSum += offR;
    gf += myGoals; ga += opGoals; n++;
  }
  if(!n) return { off:1.0, def:1.0, meta:{n:0} };
  const gfAvg = gf/n, gaAvg = ga/n;
  const avgOppDef = defSum/n || 100;
  const avgOppOff = offSum/n || 100;
  const eps = 1e-6;
  const gfSeasonAvg = Math.max(eps, gfSeason || gfAvg);
  const gaSeasonAvg = Math.max(eps, gaSeason || gaAvg);

  // trend^0.5 ve SoS^0.5 çarpımları, 0.85–1.15 arasında kelepçele
  const off = cap( Math.pow(gfAvg/gfSeasonAvg, 0.5) * Math.pow(avgOppDef/100, 0.5), 0.85, 1.15 );
  const def = cap( Math.pow(gaSeasonAvg/gaAvg, 0.5) * Math.pow(avgOppOff/100, 0.5), 0.85, 1.15 );

  return { off, def, meta:{ n, gfAvg, gaAvg, avgOppDef, avgOppOff } };
}

export default async function handler(req, res){
  try{
    if(!KEY) return res.status(500).json({ error: "Missing APIFOOTBALL_KEY env var" });

    const fixtureId = req.query.fixture ? String(req.query.fixture) : undefined;
    const mode = String(req.query.mode || "league"); // league | uefa | cup | intl (ilerisi için)
    if(!fixtureId) return res.status(400).json({ error: "Pass ?fixture={id}" });

    const asof = new Date().toISOString();
    const fx = await afGet("/fixtures", { id: fixtureId });
    const fixture = fx[0];
    if(!fixture) return res.status(404).json({ error: "Fixture not found" });

    const homeId = fixture.teams?.home?.id;
    const awayId = fixture.teams?.away?.id;
    const leagueId = fixture.league?.id;
    const seasonYr = fixture.league?.season;
    const kickoffISO = fixture.fixture?.date;
    if(!kickoffISO) throw new Error("Kickoff time missing");
    const now = Date.now();
    const kickoff = new Date(kickoffISO).getTime();

    // Team stats (season aggregates)
    const [homeStats, awayStats] = await Promise.all([
      afGet("/teams/statistics", { team: homeId, league: leagueId, season: seasonYr }),
      afGet("/teams/statistics", { team: awayId, league: leagueId, season: seasonYr })
    ]);

    // Injuries / H2H / Lineups / Odds / Provider
    const [injHome, injAway, h2h, lineups, odds, providerPred] = await Promise.all([
      afGet("/injuries", { team: homeId, season: seasonYr }),
      afGet("/injuries", { team: awayId, season: seasonYr }),
      afGet("/fixtures/headtohead", { h2h: `${homeId}-${awayId}`, last: 10 }),
      afGet("/fixtures/lineups", { fixture: fixtureId }),
      afGet("/odds", { fixture: fixtureId }),
      afGet("/predictions", { fixture: fixtureId })
    ]);

    // --------- Dinamik lig μ (tüm takımlardan)
    const cache = {};
    const { mu_home, mu_away } = await getLeagueMuFromTeams(leagueId, seasonYr, cache);
    const mu_team = (mu_home + mu_away) / 2; // referans

    // --------- Sezon ortalamaları → Off/Def (squash öncesi)
    const gfH = Number(homeStats?.goals?.for?.average?.total ?? 1.4);
    const gaH = Number(homeStats?.goals?.against?.average?.total ?? 1.4);
    const gfA = Number(awayStats?.goals?.for?.average?.total ?? 1.4);
    const gaA = Number(awayStats?.goals?.against?.average?.total ?? 1.4);

    const OffH_raw = (gfH/mu_team)*100;
    const DefH_raw = (mu_team/gaH)*100;
    const OffA_raw = (gfA/mu_team)*100;
    const DefA_raw = (mu_team/gaA)*100;

    const OffH = clampPct(OffH_raw);
    const DefH = clampPct(DefH_raw);
    const OffA = clampPct(OffA_raw);
    const DefA = clampPct(DefA_raw);

    const OffH2 = squash(OffH), DefH2 = squash(DefH);
    const OffA2 = squash(OffA), DefA2 = squash(DefA);

    // --------- SoS + form (son 6)
    const last6H = await getTeamLastN(homeId, leagueId, seasonYr, kickoffISO, 6);
    const last6A = await getTeamLastN(awayId, leagueId, seasonYr, kickoffISO, 6);

    // Opponent rating getter'ları (aynı ligden, sezon istatistikleri)
    const statCache = new Map();
    async function teamStat(id){
      if(statCache.has(id)) return statCache.get(id);
      const st = await afGet("/teams/statistics", { team:id, league:leagueId, season:seasonYr });
      statCache.set(id, st);
      return st;
    }
    // Opponent Def/Off ratingleri (squash uygulanmış)
    const oppDef = async(id)=>{
      const st = await teamStat(id);
      const ga = Number(st?.goals?.against?.average?.total ?? 1.4);
      return squash(clampPct((mu_team/ga)*100));
    };
    const oppOff = async(id)=>{
      const st = await teamStat(id);
      const gf = Number(st?.goals?.for?.average?.total ?? 1.4);
      return squash(clampPct((gf/mu_team)*100));
    };

    // map-async helper (sıralı değil ama basit)
    async function avgOppRating(last, getter){
      if(!last || !last.length) return 100;
      const vals=[];
      for(const f of last){
        const hId=f?.teams?.home?.id, aId=f?.teams?.away?.id;
        const opp=(hId===homeId||hId===awayId)? aId : hId;
        vals.push(await getter(opp));
      }
      return vals.length? vals.reduce((a,b)=>a+b,0)/vals.length : 100;
    }

    const [avgOppDefH, avgOppOffH, avgOppDefA, avgOppOffA] = await Promise.all([
      avgOppRating(last6H, oppDef), avgOppRating(last6H, oppOff),
      avgOppRating(last6A, oppDef), avgOppRating(last6A, oppOff)
    ]);

    const sosHome = computeSoSModifier(last6H, homeId, (id)=>avgOppDefH, (id)=>avgOppOffH, gfH, gaH);
    const sosAway = computeSoSModifier(last6A, awayId, (id)=>avgOppDefA, (id)=>avgOppOffA, gfA, gaA);

    // --------- XI güveni
    const xiAvailable = Array.isArray(lineups) && lineups.length>0 && kickoff>now && lineups[0]?.startXI?.length;
    const xiConfidence = xiAvailable ? "high" : (kickoff - now < 90*60*1000 ? "medium" : "low");

    // --------- Lambda’lar (squash + SoS + XI)
    let lambda_home = mu_home * (OffH2/100) * (100/DefA2) * sosHome.off;
    let lambda_away = mu_away * (OffA2/100) * (100/DefH2) * sosAway.off;

    if (xiConfidence === "medium") { lambda_home*=0.97; lambda_away*=0.97; }
    if (xiConfidence === "low")    { lambda_home*=0.94; lambda_away*=0.94; }

    // güvenli bant
    lambda_home = cap(lambda_home, 0.20, 3.00);
    lambda_away = cap(lambda_away, 0.20, 3.00);

    // --------- Skor matrisi + H2H düşük skor mini-boost
    let grid = scoreMatrix(lambda_home, lambda_away);
    grid = applyH2HLows(grid, h2h);

    const win = sum1X2(grid);
    const btts = bttsYes(grid);
    const over = over25(grid);
    const under = 1 - over;

    // en olası skorlar
    const scores=[]; for(let h=0; h<7; h++) for(let a=0; a<7; a++) scores.push({score:`${h}-${a}`, prob:grid[h][a]});
    scores.sort((x,y)=>y.prob-x.prob);
    const top5 = scores.slice(0,5).map(s=>({ score:s.score, prob:Number(s.prob.toFixed(3)) }));

    // --------- Odds (piyasa) → harmanlanmış 1X2
    const market = oddsToImplied1x2(odds);
    const blendW = 0.20;
    const win_blended = market ? {
      home: Number(( (1-blendW)*win.home + blendW*market.home ).toFixed(3)),
      draw: Number(( (1-blendW)*win.draw + blendW*market.draw ).toFixed(3)),
      away: Number(( (1-blendW)*win.away + blendW*market.away ).toFixed(3))
    } : null;

    const providerPredictions = Array.isArray(providerPred) && providerPred[0]?.predictions ? providerPred[0].predictions : null;

    return res.status(200).json({
      version: "fa-api v1.2.0",
      asof_utc: asof,
      input: { fixture_id: fixtureId, league_id: leagueId, season: seasonYr, mode },
      mu: { mu_home: Number(mu_home.toFixed(3)), mu_away: Number(mu_away.toFixed(3)) },
      prediction: {
        lambda_home: Number(lambda_home.toFixed(3)),
        lambda_away: Number(lambda_away.toFixed(3)),
        win_probs_model: {
          home: Number(win.home.toFixed(3)),
          draw: Number(win.draw.toFixed(3)),
          away: Number(win.away.toFixed(3))
        },
        win_probs_blended: win_blended,
        btts_yes: Number(btts.toFixed(3)),
        over25: Number(over.toFixed(3)),
        under25: Number(under.toFixed(3)),
        top_scores: top5,
        score_matrix: grid.map(r=>r.map(x=>Number(x.toFixed(6)))),
        offdef: {
          home_off: Number(OffH2.toFixed(1)),
          home_def: Number(DefH2.toFixed(1)),
          away_off: Number(OffA2.toFixed(1)),
          away_def: Number(DefA2.toFixed(1))
        }
      },
      modifiers: {
        sos_home: { off: Number(sosHome.off.toFixed(3)), def: Number(sosHome.def.toFixed(3)), meta: sosHome.meta },
        sos_away: { off: Number(sosAway.off.toFixed(3)), def: Number(sosAway.def.toFixed(3)), meta: sosAway.meta },
        h2h_low_boost_applied: Array.isArray(h2h) && h2h.length>0,
        market_implied: market
      },
      explanation: {
        notes: "V1.2 – dinamik lig μ (takım istatistiklerinden), SoS+form, H2H düşük skor mini-boost, odds harmanlı 1X2. Squash+cap sürüyor.",
        flags: { low_lineup_confidence: xiConfidence !== "high", old_snapshot: false, missing_sources: false }
      },
      xi_confidence: xiConfidence,
      provider_predictions: providerPredictions,
      sources: [
        `${API_BASE}/fixtures?id=${fixtureId}`,
        `${API_BASE}/teams?league=${leagueId}&season=${seasonYr}`,
        `${API_BASE}/teams/statistics?team=${homeId}&league=${leagueId}&season=${seasonYr}`,
        `${API_BASE}/teams/statistics?team=${awayId}&league=${leagueId}&season=${seasonYr}`,
        `${API_BASE}/fixtures?team=${homeId}&league=${leagueId}&season=${seasonYr}`,
        `${API_BASE}/fixtures?team=${awayId}&league=${leagueId}&season=${seasonYr}`,
        `${API_BASE}/fixtures/lineups?fixture=${fixtureId}`,
        `${API_BASE}/injuries?team=${homeId}&season=${seasonYr}`,
        `${API_BASE}/injuries?team=${awayId}&season=${seasonYr}`,
        `${API_BASE}/fixtures/headtohead?h2h=${homeId}-${awayId}`,
        `${API_BASE}/odds?fixture=${fixtureId}`,
        `${API_BASE}/predictions?fixture=${fixtureId}`
      ]
    });
  } catch (err){
    return res.status(500).json({ error: err?.message || "Internal error" });
  }
}

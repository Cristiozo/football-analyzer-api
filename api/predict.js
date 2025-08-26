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
const clamp    = (x,lo,hi)=>Math.max(lo, Math.min(hi,x));

const ROLE_W = {
  GK:  { off: 0.2, def: 1.6 },
  DEF: { off: 0.6, def: 1.2 },
  MID: { off: 1.0, def: 0.8 },
  ATT: { off: 1.3, def: 0.5 }
};

// ---------- Utils ----------
const toISODate = (d)=>new Date(d).toISOString().slice(0,10); // YYYY-MM-DD

function posGroup(pos){
  const p = String(pos || "").toUpperCase();
  if (p.startsWith("G")) return "GK";
  if (p.startsWith("D")) return "DEF";
  if (p.startsWith("M")) return "MID";
  if (p.startsWith("F") || p.startsWith("A")) return "ATT"; // Forward/Attacker
  return "MID";
}

// ---- League μ from team statistics (no heavy pagination)
async function getLeagueMuFromTeams(leagueId, seasonYr, cache){
  if(cache.mu && cache.mu.key===`${leagueId}-${seasonYr}`) return cache.mu.val;
  const teams = await afGet("/teams", { league: leagueId, season: seasonYr });
  const ids = (teams||[]).map(t=>t.team?.id).filter(Boolean);
  let sumHome=0, sumAway=0, nHome=0, nAway=0;
  for(const id of ids){
    const st = await afGet("/teams/statistics", { team:id, league:leagueId, season:seasonYr });
    const sh = Number(st?.goals?.for?.average?.home ?? NaN);
    const sa = Number(st?.goals?.for?.average?.away ?? NaN);
    if(Number.isFinite(sh)) { sumHome+=sh; nHome++; }
    if(Number.isFinite(sa)) { sumAway+=sa; nAway++; }
  }
  const mu_home = nHome>0 ? (sumHome/nHome) : 1.60;
  const mu_away = nAway>0 ? (sumAway/nAway) : 1.20;
  cache.mu = { key:`${leagueId}-${seasonYr}`, val:{ mu_home, mu_away } };
  return cache.mu.val;
}

// ---- Team last-N finished fixtures before kickoff
async function getTeamLastN(teamId, leagueId, seasonYr, kickoffISO, N){
  const to = toISODate(new Date(new Date(kickoffISO).getTime() - 24*3600*1000)); // bir gün öncesine kadar
  const from = toISODate(new Date(new Date(kickoffISO).getTime() - 200*24*3600*1000)); // ~200 gün
  const all = await afGet("/fixtures", { team: teamId, league: leagueId, season: seasonYr, from, to });
  const done = (all||[]).filter(f=>{
    const s = f?.fixture?.status?.short;
    const t = new Date(f?.fixture?.date).getTime();
    return ["FT","PEN","AET"].includes(s) && t < new Date(kickoffISO).getTime();
  }).sort((a,b)=>new Date(b.fixture.date)-new Date(a.fixture.date));
  return done.slice(0,N);
}

// ---- Odds → median implied 1X2
function oddsToImplied1x2(oddsResp){
  try{
    const books = Array.isArray(oddsResp) ? oddsResp : [];
    const triplets = [];
    const pushTriplet = (oH,oD,oA)=>{
      if(oH && oD && oA){
        const ih=1/oH, id=1/oD, ia=1/oA; const s=ih+id+ia;
        triplets.push({h:ih/s, d:id/s, a:ia/s});
      }
    };
    for(const bm of books){
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
            pushTriplet(oH,oD,oA);
          }
        }
      }
    }
    if(!triplets.length) return null;
    const med = (arr, key) => {
      const xs = arr.map(o=>o[key]).sort((a,b)=>a-b);
      const mid = Math.floor(xs.length/2);
      return xs.length%2? xs[mid] : 0.5*(xs[mid-1]+xs[mid]);
    };
    let home = med(triplets,"h"), draw = med(triplets,"d"), away = med(triplets,"a");
    const s = home+draw+away; 
    return { home:home/s, draw:draw/s, away:away/s };
  }catch{ return null; }
}

// ---- H2H: düşük skor hücrelerine micro-boost
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
    const baseline = 0.22;
    const boost = cap(1 + 0.25*(pLow - baseline), 0.95, 1.08);
    const M = matrix.map(r=>r.slice());
    M[0][0]*=boost; M[1][0]*=boost; M[0][1]*=boost; M[1][1]*=boost;
    const s = M.flat().reduce((x,y)=>x+y,0);
    for(let h=0;h<M.length;h++) for(let a=0;a<M[h].length;a++) M[h][a]/=s;
    return M;
  }catch{ return matrix; }
}

// ---------- Players: fetch & rate ----------
async function getPlayersStats(teamId, leagueId, seasonYr){
  const MAX_PAGES = 6;
  const all = [];
  for(let page=1; page<=MAX_PAGES; page++){
    const resp = await afGet("/players", { team: teamId, league: leagueId, season: seasonYr, page });
    if(!resp || resp.length===0) break;
    all.push(...resp);
  }
  return all;
}

function per90(val, minutes, apps){
  const m = Number(minutes||0);
  if(m>0) return Number(val||0) * (90/m);
  const a = Number(apps||0);
  if(a>0) return Number(val||0) / a;
  return 0;
}

function buildPlayerRatings(playersRaw){
  // playersRaw item: { player:{id,name,position}, statistics:[{games,shots,goals,passes,tackles,duels,dribbles,blocks,goalkeeper?...}] }
  const rows = [];
  for(const p of (playersRaw||[])){
    const pid = p?.player?.id; const name = p?.player?.name || "Unknown";
    const st = Array.isArray(p?.statistics) && p.statistics[0] ? p.statistics[0] : {};
    const minutes = Number(st?.games?.minutes || 0);
    const apps = Number(st?.games?.appearences || st?.games?.appearances || 0);
    const grp = posGroup(st?.games?.position || p?.player?.position);

    // attacking
    const goals = Number(st?.goals?.total || 0);
    const assists = Number(st?.goals?.assists || st?.passes?.assists || 0);
    const sot = Number(st?.shots?.on || 0);
    const keyP = Number(st?.passes?.key || 0);
    const drbSucc = Number(st?.dribbles?.success || 0);

    const G90 = per90(goals, minutes, apps);
    const A90 = per90(assists, minutes, apps);
    const SOT90 = per90(sot, minutes, apps);
    const KP90 = per90(keyP, minutes, apps);
    const DRB90 = per90(drbSucc, minutes, apps);

    // defending
    const tackles = Number(st?.tackles?.total || 0);
    const inter = Number(st?.tackles?.interceptions || 0);
    const blocks = Number(st?.blocks?.total || 0);
    const duelsTot = Number(st?.duels?.total || 0);
    const duelsWon = Number(st?.duels?.won || 0);
    const duelWin = duelsTot>0 ? duelsWon/duelsTot : 0;

    const T90 = per90(tackles, minutes, apps);
    const I90 = per90(inter, minutes, apps);
    const B90 = per90(blocks, minutes, apps);

    // GK
    const conceded = Number(st?.goals?.conceded || 0);
    const saves = Number(st?.goalkeeper?.saves || st?.saves?.total || 0);
    const penSaved = Number(st?.penalty?.saved || 0);
    const C90 = per90(conceded, minutes, apps);
    const SV90 = per90(saves, minutes, apps);
    const attGK = 0; // GK hücum katkısını nötr kabul
    const savePct = (saves + conceded) > 0 ? saves / (saves + conceded) : 0;

    // composite raw (pozisyona göre formül)
    let offRaw=0, defRaw=0;
    if(grp==="ATT"){
      offRaw = 4*G90 + 3*A90 + 1*SOT90 + 1*KP90 + 0.5*DRB90;
      defRaw = 0.6*(T90+I90) + 0.4*duelWin;
    } else if(grp==="MID"){
      offRaw = 2*A90 + 1*KP90 + 0.3*SOT90 + 0.3*DRB90 + 0.5*G90;
      defRaw = 1.0*(T90+I90) + 0.4*duelWin + 0.2*B90;
    } else if(grp==="DEF"){
      offRaw = 0.6*KP90 + 0.3*A90 + 0.2*SOT90;
      defRaw = 1.2*(T90+I90) + 0.6*duelWin + 0.4*B90;
    } else { // GK
      offRaw = attGK;
      defRaw = 1.5*savePct + 0.5*SV90 - 0.8*C90 + 0.3*penSaved;
    }

    rows.push({
      id: pid, name, grp, minutes,
      offRaw, defRaw,
      apps, G90, A90, SOT90, KP90, DRB90, T90, I90, B90, duelWin, savePct
    });
  }

  // group-wise min–max → 0–100 (gürültülü takımlarda bile göreli ölçek)
  const byGrp = { GK:[], DEF:[], MID:[], ATT:[] };
  rows.forEach(r=>byGrp[r.grp].push(r));

  function normalize(groupRows){
    if(!groupRows.length) return;
    const filt = groupRows.filter(r=>r.minutes>=270); // 3x90 dakika eşiği
    const base = filt.length ? filt : groupRows;
    const minOff = Math.min(...base.map(r=>r.offRaw));
    const maxOff = Math.max(...base.map(r=>r.offRaw));
    const minDef = Math.min(...base.map(r=>r.defRaw));
    const maxDef = Math.max(...base.map(r=>r.defRaw));
    for(const r of groupRows){
      const off = (maxOff-minOff)>1e-9 ? (r.offRaw-minOff)/(maxOff-minOff) : 0.5;
      const def = (maxDef-minDef)>1e-9 ? (r.defRaw-minDef)/(maxDef-minDef) : 0.5;
      r.off = clamp(20 + 80*off, 20, 98); // 20–98 bandı
      r.def = clamp(20 + 80*def, 20, 98);
    }
  }
  normalize(byGrp.GK); normalize(byGrp.DEF); normalize(byGrp.MID); normalize(byGrp.ATT);
  return rows;
}

// ---- Build XI: from lineup or from ratings
function buildXIFromLineup(lineupObj, rated, injuredSet){
  if(!lineupObj || !Array.isArray(lineupObj.startXI)) return null;
  const ids = lineupObj.startXI.map(x=>x?.player?.id).filter(Boolean);
  if(ids.length<7) return null; // yetersiz
  const byId = new Map(rated.map(r=>[r.id, r]));
  const xi = [];
  for(const id of ids){
    if(injuredSet && injuredSet.has(id)) continue; // güvenlik: sakat görünen varsa at
    const r = byId.get(id);
    if(r) xi.push(r);
    else xi.push({ id, name:`#${id}`, grp:"MID", minutes:0, off:60, def:60 }); // fallback
  }
  // tam 11’e tamamla
  const need = 11 - xi.length;
  if(need>0){
    const pool = rated.filter(r=>!ids.includes(r.id) && (!injuredSet || !injuredSet.has(r.id)))
                      .sort((a,b)=> (b.off+b.def) - (a.off+a.def));
    xi.push(...pool.slice(0,need));
  }
  return xi.slice(0,11);
}

function buildXIByRatings(rated, injuredSet){
  const pool = rated.filter(r=>!injuredSet || !injuredSet.has(r.id));
  const byGrp = { GK:[], DEF:[], MID:[], ATT:[] };
  pool.forEach(p=>byGrp[p.grp].push(p));
  byGrp.GK.sort((a,b)=> b.def-a.def);
  byGrp.DEF.sort((a,b)=> (b.def) - (a.def));
  byGrp.MID.sort((a,b)=> (b.off+b.def) - (a.off+a.def));
  byGrp.ATT.sort((a,b)=> b.off-a.off);

  const xi = [];
  if(byGrp.GK.length) xi.push(byGrp.GK[0]);
  xi.push(...byGrp.DEF.slice(0,4));
  xi.push(...byGrp.MID.slice(0,4));
  xi.push(...byGrp.ATT.slice(0,2));
  // doldur
  if(xi.length<11){
    const rest = pool
      .filter(p=>!xi.find(x=>x.id===p.id))
      .sort((a,b)=> (b.off+b.def) - (a.off+a.def));
    xi.push(...rest.slice(0, 11-xi.length));
  }
  return xi.slice(0,11);
}

function xiSums(xi){
  let offSum=0, defSum=0;
  for(const p of xi){
    const w = ROLE_W[p.grp] || ROLE_W.MID;
    offSum += p.off * w.off;
    defSum += p.def * w.def;
  }
  return { offSum, defSum };
}

function computeXIFactors({ lineupObj, rated, injuredSet }){
  // ideal XI (tam kadro) – sadece sakat/ceza filtresi YOK
  const idealXI = buildXIByRatings(rated, null);
  const ideal = xiSums(idealXI);

  // mevcut XI: lineup varsa ondan, yoksa “dakika+rating”
  const currentXI = buildXIFromLineup(lineupObj, rated, injuredSet) || buildXIByRatings(rated, injuredSet);
  const current = xiSums(currentXI);

  const offFactor = ideal.offSum>0 ? clamp(current.offSum/ideal.offSum, 0.85, 1.15) : 1.0;
  const defFactor = ideal.defSum>0 ? clamp(current.defSum/ideal.defSum, 0.85, 1.15) : 1.0;

  // kritik eksikler: ideal XI’de olup current XI’de olmayan ilk 5 (rating toplamına göre)
  const currentIds = new Set(currentXI.map(p=>p.id));
  const keyOut = idealXI.filter(p=>!currentIds.has(p.id)).slice(0,5).map(p=>({ id:p.id, name:p.name, grp:p.grp, off:p.off, def:p.def }));

  return { offFactor, defFactor, idealXI, currentXI, keyOut };
}

// --------------------------------------------

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
    const mu_team = (mu_home + mu_away) / 2;

    // --------- Sezon ortalamaları → Off/Def (squash öncesi)
    const gfH = Number(homeStats?.goals?.for?.average?.total ?? 1.4);
    const gaH = Number(homeStats?.goals?.against?.average?.total ?? 1.4);
    const gfA = Number(awayStats?.goals?.for?.average?.total ?? 1.4);
    const gaA = Number(awayStats?.goals?.against?.average?.total ?? 1.4);

    const OffH_raw = (gfH/mu_team)*100;
    const DefH_raw = (mu_team/gaH)*100;
    const OffA_raw = (gfA/mu_team)*100;
    const DefA_raw = (mu_team/gaA)*100;

    let OffH2 = squash(clampPct(OffH_raw));
    let DefH2 = squash(clampPct(DefH_raw));
    let OffA2 = squash(clampPct(OffA_raw));
    let DefA2 = squash(clampPct(DefA_raw));

    // --------- SoS + form (son 6)
    const last6H = await getTeamLastN(homeId, leagueId, seasonYr, kickoffISO, 6);
    const last6A = await getTeamLastN(awayId, leagueId, seasonYr, kickoffISO, 6);

    // opp rating ortalamaları (basit; hızlı)
    const statCache = new Map();
    async function teamStat(id){
      if(statCache.has(id)) return statCache.get(id);
      const st = await afGet("/teams/statistics", { team:id, league:leagueId, season:seasonYr });
      statCache.set(id, st); return st;
    }
    async function oppDefAvg(last, myId){
      if(!last || !last.length) return 100;
      let sum=0,n=0;
      for(const f of last){
        const h=f?.teams?.home?.id, a=f?.teams?.away?.id;
        const opp = (h===myId)? a : h;
        const st = await teamStat(opp);
        const ga = Number(st?.goals?.against?.average?.total ?? 1.4);
        const def = squash(clampPct((mu_team/ga)*100));
        sum+=def; n++;
      }
      return n? sum/n : 100;
    }
    async function oppOffAvg(last, myId){
      if(!last || !last.length) return 100;
      let sum=0,n=0;
      for(const f of last){
        const h=f?.teams?.home?.id, a=f?.teams?.away?.id;
        const opp = (h===myId)? a : h;
        const st = await teamStat(opp);
        const gf = Number(st?.goals?.for?.average?.total ?? 1.4);
        const off = squash(clampPct((gf/mu_team)*100));
        sum+=off; n++;
      }
      return n? sum/n : 100;
    }

    const [avgOppDefH, avgOppOffH, avgOppDefA, avgOppOffA] = await Promise.all([
      oppDefAvg(last6H, homeId), oppOffAvg(last6H, homeId),
      oppDefAvg(last6A, awayId), oppOffAvg(last6A, awayId)
    ]);

    function computeSoSModifier(lastN, teamId, avgOppDef, avgOppOff, gfSeason, gaSeason){
      if(!lastN || !lastN.length) return { off:1.0, def:1.0, meta:{n:0} };
      let gf=0, ga=0, n=0;
      for(const f of lastN){
        const hId=f?.teams?.home?.id, aId=f?.teams?.away?.id;
        const isHome = hId===teamId;
        gf += Number(isHome? f?.goals?.home : f?.goals?.away);
        ga += Number(isHome? f?.goals?.away : f?.goals?.home);
        n++;
      }
      const gfAvg = gf/n, gaAvg = ga/n;
      const eps = 1e-6;
      const gfSeasonAvg = Math.max(eps, gfSeason || gfAvg);
      const gaSeasonAvg = Math.max(eps, gaSeason || gaAvg);
      const off = cap( Math.pow(gfAvg/gfSeasonAvg, 0.5) * Math.pow((avgOppDef||100)/100, 0.5), 0.85, 1.15 );
      const def = cap( Math.pow(gaSeasonAvg/gaAvg, 0.5) * Math.pow((avgOppOff||100)/100, 0.5), 0.85, 1.15 );
      return { off, def, meta:{ n, gfAvg, gaAvg, avgOppDef, avgOppOff } };
    }

    const sosHome = computeSoSModifier(last6H, homeId, avgOppDefH, avgOppOffH, gfH, gaH);
    const sosAway = computeSoSModifier(last6A, awayId, avgOppDefA, avgOppOffA, gfA, gaA);

    // --------- XI güveni (fixture lineup varsa)
    const lineupHome = Array.isArray(lineups) ? lineups.find(x=>x?.team?.id===homeId) : null;
    const lineupAway = Array.isArray(lineups) ? lineups.find(x=>x?.team?.id===awayId) : null;
    const xiAvailable = lineupHome?.startXI?.length || lineupAway?.startXI?.length;
    const nowMs = Date.now();
    const xiConfidence = xiAvailable ? "high" : (new Date(kickoffISO).getTime() - nowMs < 90*60*1000 ? "medium" : "low");

    // --------- Injuries → unavailable set
    const injSetHome = new Set((injHome||[]).map(i=>i?.player?.id).filter(Boolean));
    const injSetAway = new Set((injAway||[]).map(i=>i?.player?.id).filter(Boolean));

    // --------- Players (stats) → ratings
    const [playersH_raw, playersA_raw] = await Promise.all([
      getPlayersStats(homeId, leagueId, seasonYr),
      getPlayersStats(awayId, leagueId, seasonYr)
    ]);
    const ratedH = buildPlayerRatings(playersH_raw);
    const ratedA = buildPlayerRatings(playersA_raw);

    // --------- XI factors (injuries yedirilmiş)
    const xiH = computeXIFactors({ lineupObj: lineupHome, rated: ratedH, injuredSet: injSetHome });
    const xiA = computeXIFactors({ lineupObj: lineupAway, rated: ratedA, injuredSet: injSetAway });

    // Off/Def’e XI çarpanlarını uygula
    OffH2 *= xiH.offFactor;  DefH2 *= xiH.defFactor;
    OffA2 *= xiA.offFactor;  DefA2 *= xiA.defFactor;

    // --------- Lambda’lar (squash + SoS + XI) + XI belirsizliği zayıflatma
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
      home: Number(((1-blendW)*win.home + blendW*market.home).toFixed(3)),
      draw: Number(((1-blendW)*win.draw + blendW*market.draw).toFixed(3)),
      away: Number(((1-blendW)*win.away + blendW*market.away).toFixed(3))
    } : null;

    const providerPredictions = Array.isArray(providerPred) && providerPred[0]?.predictions ? providerPred[0].predictions : null;

    return res.status(200).json({
      version: "fa-api v1.3.0",
      asof_utc: asof,
      input: { fixture_id: fixtureId, league_id: leagueId, season: seasonYr, mode },
      mu: { mu_home: Number(mu_home.toFixed(2)), mu_away: Number(mu_away.toFixed(2)) },
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
        xi_factors: {
          home: { off: Number(xiH.offFactor.toFixed(3)), def: Number(xiH.defFactor.toFixed(3)) },
          away: { off: Number(xiA.offFactor.toFixed(3)), def: Number(xiA.defFactor.toFixed(3)) }
        },
        xi_players: {
          home: {
            idealXI: xiH.idealXI.map(p=>({id:p.id,name:p.name,grp:p.grp,off:p.off,def:p.def})),
            currentXI: xiH.currentXI.map(p=>({id:p.id,name:p.name,grp:p.grp,off:p.off,def:p.def})),
            key_out: xiH.keyOut
          },
          away: {
            idealXI: xiA.idealXI.map(p=>({id:p.id,name:p.name,grp:p.grp,off:p.off,def:p.def})),
            currentXI: xiA.currentXI.map(p=>({id:p.id,name:p.name,grp:p.grp,off:p.off,def:p.def})),
            key_out: xiA.keyOut
          }
        },
        injuries: {
          home_count: injHome?.length || 0,
          away_count: injAway?.length || 0
        },
        h2h_low_boost_applied: Array.isArray(h2h) && h2h.length>0,
        market_implied: market
      },
      explanation: {
        notes: "V1.3 – oyuncu-bazlı rating (league/season), lineup/injury etkisi Off/Def’e çarpan; V1.2’nin μ/SoS/H2H/odds/squash+cap yapısı korunur.",
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
        `${API_BASE}/predictions?fixture=${fixtureId}`,
        `${API_BASE}/players?team=${homeId}&league=${leagueId}&season=${seasonYr}`,
        `${API_BASE}/players?team=${awayId}&league=${leagueId}&season=${seasonYr}`
      ]
    });
  } catch (err){
    return res.status(500).json({ error: err?.message || "Internal error" });
  }
}

// api/predict.js  —  V1.6.0 (merged on canvas)
// Additions vs v1.5.7:
//  - Dynamic alphaByTtk (time-to-kickoff aware market/model blend)
//  - League-aware DC bias (from μ)
//  - In-memory caching for μ, referee and tempo lookups (TTL)
//  - Congestion/Rest factor (days since last match) → mild Off/Def effect
//  - Set-piece proxy (corners last N) → mild Off boost when edge exists
//  - Formation multipliers (from lineup formations)
//  - Keep: Two-leg detection + 2nd-leg context, O/U2.5 calibration, XI Off/Def, referee & tempo, injuries, bench-aware lineup.

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
function scoreMatrix(lambdaH, lambdaA, dcLow=1.0) {
  const SIZE=7; const m=Array.from({length:SIZE},()=>Array(SIZE).fill(0));
  for (let h=0; h<SIZE; h++) for (let a=0; a<SIZE; a++) m[h][a]=poissonP(h,lambdaH)*poissonP(a,lambdaA);
  const tot = lambdaH + lambdaA;
  const dc = tot <= 2.2 ? dcLow : 1.00; // league-aware external param
  m[0][0]*=dc; m[1][0]*=dc; m[0][1]*=dc; m[1][1]*=dc;
  const s=m.flat().reduce((x,y)=>x+y,0); for (let h=0; h<SIZE; h++) for (let a=0; a<SIZE; a++) m[h][a]/=s;
  return m;
}
function sum1X2(m){ let H=0,D=0,A=0; for(let h=0;h<m.length;h++) for(let a=0;a<m[h].length;a++){ if(h>a) H+=m[h][a]; else if(h===a) D+=m[h][a]; else A+=m[h][a]; } return { home:H, draw:D, away:A }; }
function bttsYes(m){ let p=0; for(let h=1;h<m.length;h++) for(let a=1;a<m[h].length;a++) p+=m[h][a]; return p; }
function over25(m){ let p=0; for(let h=0;h<m.length;h++) for(let a=0;a<m[h].length;a++) if(h+a>=3) p+=m[h][a]; return p; }
function topScores(m, k=5) { const list = []; for(let h=0;h<m.length;h++) for(let a=0;a<m[h].length;a++) list.push({score:`${h}-${a}`, prob:m[h][a]}); list.sort((x,y)=>y.prob-x.prob); return list.slice(0,k).map(s=>({ score:s.score, prob:Number(s.prob.toFixed(3)) })); }

/* ------------------------------ v1.6 additions ------------------------------ */
/* Simple in-memory caches */
const _cache = { mu: new Map(), tempo: new Map(), referee: new Map() };
const TTL = {
  mu: Number(process.env.CACHE_TTL_MU_MS || 6*3600*1000),
  tempo: Number(process.env.CACHE_TTL_TEMPO_MS || 6*3600*1000),
  referee: Number(process.env.CACHE_TTL_REF_MS || 24*3600*1000),
};
function __cacheGet(bucket, key){ const rec = _cache[bucket]?.get(key); if (!rec) return null; if (Date.now()>rec.expires){ _cache[bucket].delete(key); return null; } return rec.value; }
function __cacheSet(bucket, key, value, ttl){ _cache[bucket].set(key, { value, expires: Date.now() + (ttl||3600000) }); }

/* Formation profile multipliers */
function formationMultipliers(form){
  const s = String(form||"").trim();
  let M_off = 1.00, M_def = 1.00, profile = "balanced";
  if (/^(5-4-1|5-3-2|4-5-1)$/i.test(s)) { M_off = 0.985; M_def = 1.02; profile = "defensive"; }
  else if (/^(4-3-3|3-4-3|4-2-3-1)$/i.test(s)) { M_off = 1.02; M_def = 0.995; profile = "attacking"; }
  else if (/^(3-5-2)$/i.test(s)) { M_off = 1.015; M_def = 0.995; profile = "attacking"; }
  else if (/^(4-4-2)$/i.test(s)) { M_off = 1.00; M_def = 1.00; profile = "balanced"; }
  return { formation:s||null, profile, M_off:Number(M_off.toFixed(3)), M_def:Number(M_def.toFixed(3)) };
}

/* Rest/congestion factor */
async function restFactor(teamId, kickoffISO){
  try{
    const fx = await afGetAll('/fixtures', { team: teamId, last: 3 });
    let lastFT=null;
    for (const g of fx){ const st=(g?.fixture?.status?.short||'').toUpperCase(); if (st==='FT'){ const d=g?.fixture?.date; if (d) lastFT = Math.max(lastFT||0, Date.parse(d)); } }
    if (!lastFT) return { days:null, mult:1.0 };
    const days = (Date.parse(kickoffISO) - lastFT) / (24*3600*1000);
    let mult = 1.0;
    if (days <= 2) mult = 0.96;
    else if (days <= 3) mult = 0.98;
    else if (days >= 7 && days <= 10) mult = 1.01;
    return { days:Number(days.toFixed(1)), mult:Number(mult.toFixed(3)) };
  } catch { return { days:null, mult:1.0 }; }
}

/* Set-piece proxy via corners */
async function teamSetPieceIndex(teamId){
  try{
    const last = await afGetAll('/fixtures', { team: teamId, last: 10 });
    let m=0, corners=0;
    for (const g of last){
      const st=(g?.fixture?.status?.short||'').toUpperCase(); if (st!=='FT') continue;
      const fid=g?.fixture?.id; if(!fid) continue;
      try{
        const stx = await afGet('/fixtures/statistics', { fixture: fid });
        for (const row of (stx?.response||[])){
          if (row?.team?.id !== teamId) continue;
          const arr=row?.statistics||[];
          const c = getStatValue(arr, ['corners']);
          corners += c; m++;
        }
      } catch(_){})
    }
    if (m===0) return { has:false, corners_avg:0 };
    return { has:true, corners_avg: Number((corners/m).toFixed(2)) };
  } catch { return { has:false, corners_avg:0 }; }
}
function setPieceMultipliers(idxHome, idxAway){
  if (!idxHome?.has || !idxAway?.has) return { M_sp_home:1.0, M_sp_away:1.0 };
  const diff = (idxHome.corners_avg - idxAway.corners_avg);
  const mag  = Math.abs(diff);
  const boost = clamp(1 + mag*0.015, 0.96, 1.04);
  return {
    M_sp_home: Number((diff > 0 ? boost : 1.0).toFixed(3)),
    M_sp_away: Number((diff < 0 ? boost : 1.0).toFixed(3))
  };
}

/* Market blend alpha by minutes-to-kickoff */
function alphaByTtk(mins){
  if (!(mins>=0)) return 0.75;
  if (mins <= 20) return 0.55;
  if (mins <= 60) return 0.65;
  if (mins <= 180) return 0.70;
  if (mins <= 720) return 0.73;
  return 0.75;
}

/* League-aware DC low-total factor from μ */
function dcFactorFromMu(muH, muA){
  const tot = (Number(muH)||1.5) + (Number(muA)||1.3);
  if (tot < 2.5) return 1.03;
  if (tot < 2.8) return 1.02;
  if (tot > 3.2) return 0.995;
  return 1.00;
}
/* ---------------------------- end v1.6 add ---------------------------- */

/* --------------------------- domain helpers --------------------------- */
const toNum = (x)=> x==null ? 0 : Number(x) || 0;
const per90 = (val, minutes)=> minutes>0 ? (toNum(val)*90)/minutes : 0;
const posGroup = (p)=> { const s = (p||"").toUpperCase(); if (s.startsWith("G")) return "GK"; if (s.startsWith("D")) return "DEF"; if (s.startsWith("M")) return "MID"; if (s.startsWith("F") || s.includes("W")) return "FWD"; return "MID"; };

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

/* --------- lineup helpers (bench-aware) --------- */
function lineupIds(lineupObj) {
  const starters = lineupObj?.startXI || [];
  const bench = lineupObj?.substitutes || [];
  const all = [...starters, ...bench];
  return all.map(x => x?.player?.id).filter(Boolean);
}
function namesFromLineup(lineupObj){
  const map = new Map();
  const starters = lineupObj?.startXI || [];
  const bench = lineupObj?.substitutes || [];
  for (const row of [...starters, ...bench]){
    const id = row?.player?.id;
    const nm = row?.player?.name;
    if (id && nm) map.set(id, nm);
  }
  return map;
}
function mergeNameMaps(a, b){
  const out = new Map(a ? Array.from(a.entries()) : []);
  if (b) for (const [k,v] of b.entries()) if (!out.has(k) && v) out.set(k,v);
  return out;
}
function weightForTeam(pos) {
  if (pos==="GK") return { off:0.00, def:1.00 };
  if (pos==="FWD") return { off:1.00, def:0.40 };
  if (pos==="MID") return { off:0.60, def:0.60 };
  if (pos==="DEF") return { off:0.30, def:0.90 };
  return { off:0.50, def:0.50 };
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
    used.push({ id: pid, off: pr.off, def: pr.def, pos: pr.pos, minutes: pr.minutes, name: pr.name });
  }
  const OffTeam = offW>0 ? offSum/offW : 80;
  const DefTeam = defW>0 ? defSum/defW : 80;
  return {
    OffTeam: clamp(OffTeam, 20, 180),
    DefTeam: clamp(DefTeam, 20, 180),
    xi_detail: used
  };
}

/* --------- injuries: dedupe + "active" filter --------- */
const INJ_ACTIVE_WINDOW_DAYS = Number(process.env.INJ_ACTIVE_WINDOW_DAYS || 35);
const INJ_INCLUDE_DOUBTFUL = String(process.env.INJ_INCLUDE_DOUBTFUL || "0") === "1";

function dedupeInjuriesByPlayer(arr){
  const seen = new Set(); const out = [];
  for (const r of (arr||[])) {
    const pid = r?.player?.id || r?.id;
    if (!pid || seen.has(pid)) continue;
    seen.add(pid); out.push(r);
  }
  return out;
}
function isDoubtfulOrMinor(reason){
  if (!reason) return false;
  const s = String(reason).toLowerCase();
  return /(doubt|minor|knock|rest|rotation|fatigue|cold|illness\?)/.test(s) || /doubtful/.test(s);
}
function looksRecovered(reason){
  if (!reason) return false;
  const s = String(reason).toLowerCase();
  return /(return|returned|back in training|fit|recovered)/.test(s);
}
function injuryIsActive(rec, nowMs=Date.now()){
  const reason = rec?.reason || rec?.type || rec?.player?.reason || "";
  if (!INJ_INCLUDE_DOUBTFUL && isDoubtfulOrMinor(reason)) return false;
  if (looksRecovered(reason)) return false;
  let ts = rec?.fixture?.timestamp ? rec.fixture.timestamp*1000 : null;
  ts = ts ?? (rec?.timestamp ? rec.timestamp*1000 : null);
  if (!ts) {
    const d = rec?.date || rec?.start || rec?.update;
    const t = d ? Date.parse(d) : NaN;
    ts = Number.isFinite(t) ? t : Date.now();
  }
  const maxAge = INJ_ACTIVE_WINDOW_DAYS*24*3600*1000;
  return (nowMs - ts) <= maxAge;
}

/* --------- odds -> implied 1X2 (strict) --------- */
function oddsImplied(oddsResp) {
  const rs = oddsResp?.response || [];
  const triplets = [];
  const ALLOW = /(^|\s)(full\s*time\s*result|match\s*winner|1x2)(\s|$)/i;
  const BLOCK = /(to\s*qualify|double\s*chance|draw\s*no\s*bet|handicap|asian|1st|2nd|first\s*half|second\s*half|overtime|extra\s*time|penalt)/i;

  for (const fx of rs) {
    for (const bm of (fx.bookmakers||[])) {
      for (const bet of (bm.bets||[])) {
        const name = (bet.name||"").toLowerCase();
        if (!ALLOW.test(name) || BLOCK.test(name)) continue;
        let h=null,d=null,a=null;
        for (const v of (bet.values||[])) {
          const nm=(v.value||"").toLowerCase().trim();
          const odd=Number(v.odd);
          if (!odd || odd<=1.01) continue;
          if (nm==="1" || nm.includes("home")) h = 1/odd;
          else if (nm==="x" || nm.includes("draw")) d = 1/odd;
          else if (nm==="2" || nm.includes("away")) a = 1/odd;
        }
        if (h && d && a) {
          const s=h+d+a; triplets.push({home:h/s, draw:d/s, away:a/s});
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

/* --------- odds -> implied Over/Under 2.5 --------- */
function oddsImpliedTotals(oddsResp) {
  const rs = oddsResp?.response || [];
  const samples = [];
  const ALLOW = /(over\/under|totals|total\s+goals)/i;

  for (const fx of rs) {
    for (const bm of (fx.bookmakers || [])) {
      for (const bet of (bm.bets || [])) {
        const nm = (bet.name || "").toLowerCase();
        if (!ALLOW.test(nm)) continue;
        let overOdd = null, underOdd = null;
        for (const v of (bet.values || [])) {
          const odd = Number(v.odd);
          if (!odd || odd <= 1.01) continue;
          const val = String(v.value || "").toLowerCase();
          const hand = String(v.handicap || "").trim();
          const label = hand || (val.match(/(\d+(\.\d+)?)/)?.[1] || "");
          const is25 = label === "2.5";
          const isOver = /^over/.test(val) || (String(v.value||"").toLowerCase() === "over");
          const isUnder = /^under/.test(val) || (String(v.value||"").toLowerCase() === "under");
          if (!is25) continue;
          if (isOver) overOdd = odd;
          if (isUnder) underOdd = odd;
        }
        if (overOdd && underOdd) {
          const io = 1/overOdd, iu = 1/underOdd;
          const den = io + iu;
          if (den > 0) samples.push({ over25: io/den, under25: iu/den });
        }
      }
    }
  }
  if (!samples.length) return null;
  const avg = samples.reduce((a,b)=>({over25:a.over25+b.over25, under25:a.under25+b.under25}), {over25:0, under25:0});
  const n = samples.length;
  return { over25: avg.over25/n, under25: avg.under25/n };
}

// Over/Under 2.5 hedeflenerek λ'ları ortak ölçekle (bisection)
function calibrateTotals(lambdaH, lambdaA, targetOver25) {
  if (!(targetOver25 > 0 && targetOver25 < 1)) return { lambdaH, lambdaA, applied: false };
  let lo = 0.6, hi = 1.6;
  for (let i = 0; i < 16; i++) {
    const mid = (lo + hi) / 2;
    const m = scoreMatrix(lambdaH * mid, lambdaA * mid);
    const over = over25(m);
    if (over < targetOver25) lo = mid; else hi = mid;
  }
  const s = (lo + hi) / 2;
  return { lambdaH: lambdaH * s, lambdaA: lambdaA * s, scale: s, applied: true };
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
  const type = (l.type || "").toLowerCase();

  const isUEFA = /(uefa|champions league|europa league|conference league)/i.test(name);
  const isNational = /(world cup|wc qualification|euro|nations league|africa cup|copa america|gold cup|asian cup)/i.test(name);
  if (isUEFA) return "uefa";
  if (isNational) return "national";

  // Geniş "cup" adı yakalama
  const cupName = /\b(fa cup|efl cup|carabao|league cup|dfb pokal|copa del rey|coppa italia|coupe de france|knvb beker|dutch cup|taca|taça|pokal|beker|scottish cup|copa do brasil|turkish cup|türkiye kupas[ıi])\b/i;
  if (type === "cup" || cupName.test(name)) return "cup";

  return "league";
}

/* --------- Stat helpers (tempo) --------- */
function asNumber(v){
  if (v == null) return 0;
  if (typeof v === "string" && v.trim().endsWith("%")) return Number(v.replace("%","")) || 0;
  return Number(v) || 0;
}
function getStatValue(rows, keys, fallbackPairs=[]){
  const find = (k) => rows.find(r => (r?.type || "").toLowerCase() === k);
  for (const k of keys){
    const hit = find(k);
    if (hit) return asNumber(hit.value);
  }
  for (const pair of fallbackPairs){
    const a = find(pair[0]); const b = find(pair[1]);
    if (a || b) return asNumber(a?.value) + asNumber(b?.value);
  }
  return 0;
}

/* --------- Referee & tempo factors --------- */
function sanitizeRefName(ref) {
  if (!ref) return null;
  let s = String(ref);
  s = s.replace(/\(.*?\)/g, "");
  s = s.split(",")[0];
  s = s.replace(/\s+/g, " ").trim();
  return s || null;
}
function nameVariants(full){
  if (!full) return [];
  const parts = full.trim().split(/\s+/);
  const ln = parts[parts.length-1];
  const fn = parts[0];
  const variants = new Set([
    full, ln,
    `${fn} ${ln}`,
    `${(fn?.[0]||"")}. ${ln}`,
    `${(fn?.[0]||"")} ${ln}`,
  ].filter(Boolean));
  return Array.from(variants);
}
const REF_FALLBACK_SCAN_DAYS   = Number(process.env.REF_FALLBACK_SCAN_DAYS || 365);
const REF_FALLBACK_MAX_MATCHES = Number(process.env.REF_FALLBACK_MAX_MATCHES || 60);
const REF_FALLBACK_MAX_PAGES   = Number(process.env.REF_FALLBACK_MAX_PAGES || 12);

async function scanRefGloballyByLastname(lastname){
  if (!lastname) return [];
  const toD = new Date();
  const fromD = new Date(toD.getTime() - REF_FALLBACK_SCAN_DAYS*24*3600*1000);
  const from = fromD.toISOString().slice(0,10);
  const to   = toD.toISOString().slice(0,10);

  const hits = [];
  let page = 1;
  while (page <= REF_FALLBACK_MAX_PAGES && hits.length < REF_FALLBACK_MAX_MATCHES){
    const js = await afGet("/fixtures", { from, to, page });
    const resp = js?.response || [];
    if (!resp.length) break;
    for (const g of resp){
      const rf = (g?.fixture?.referee || "").toLowerCase();
      if (rf && rf.includes(String(lastname).toLowerCase())) {
        hits.push(g);
        if (hits.length >= REF_FALLBACK_MAX_MATCHES) break;
      }
    }
    const cur = js?.paging?.current ?? page;
    const tot = js?.paging?.total ?? page;
    if (cur >= tot) break;
    page++;
  }
  return hits;
}

async function refereeFactors(fixture) {
  const __ck = String(fixture?.fixture?.referee||""); const hit = __cacheGet('referee', __ck); if (hit) return hit;
  const refRaw = fixture?.fixture?.referee;
  const clean = sanitizeRefName(refRaw);
  const variants = nameVariants(clean);

  let collected = [];
  for (const q of variants) {
    try {
      const got = await afGetAll("/fixtures", { referee: q, last: 40 });
      collected.push(...got);
    } catch(_) {}
  }
  const seen = new Set();
  collected = collected.filter(x => { const id = x?.fixture?.id; if (!id || seen.has(id)) return false; seen.add(id); return true; });

  if (!collected.length && variants.length){
    try {
      const ln = variants.find(v => v.split(/\s+/).length === 1) || variants[0];
      const glb = await scanRefGloballyByLastname(ln);
      collected.push(...glb);
    } catch(_) {}
  }

  let n=0, yc=0, rc=0, fouls=0;
  for (const g of collected) {
    const st = (g?.fixture?.status?.short || "").toUpperCase();
    if (st !== "FT") continue;
    const fid = g?.fixture?.id;
    if (!fid) continue;
    n++;
    try {
      const evJs = await afGet("/fixtures/events", { fixture: fid });
      for (const e of (evJs?.response||[])) {
        const t = (e?.type || "").toLowerCase();
        const d = (e?.detail || "").toLowerCase();
        if (t === "card" && d.includes("yellow")) yc++;
        if (t === "card" && d.includes("red")) rc++;
      }
    } catch(_) {}
    try {
      const stxJs = await afGet("/fixtures/statistics", { fixture: fid });
      for (const ts of (stxJs?.response||[])) {
        const arr = ts?.statistics || [];
        const foulsRow = arr.find(r => (r?.type || "").toLowerCase() === "fouls");
        fouls += Number(foulsRow?.value || 0);
      }
    } catch(_) {}
  }

  let val;
  if (n === 0) val = { has:false, name:refRaw || null, matches:0, yc:0, rc:0, fouls:0, tempo_mult:1.0 };
  else {
    const ycPer = yc / n, rcPer = rc / n, foulsPer = fouls / n;
    let tempo = 1.0;
    if (ycPer > 4.5) tempo -= 0.02;
    if (ycPer > 5.5) tempo -= 0.01;
    if (foulsPer > 26) tempo -= 0.02;
    tempo = clamp(tempo, 0.92, 1.02);

    val = {
      has:true,
      name:refRaw || null,
      matches:n,
      yc:Number(ycPer.toFixed(2)),
      rc:Number(rcPer.toFixed(2)),
      fouls:Number(foulsPer.toFixed(1)),
      tempo_mult:Number(tempo.toFixed(3))
    };
  }
  __cacheSet('referee', __ck, val, TTL.referee);
  return val;
}

async function teamTempoIndex(teamId) {
  const __ck = String(teamId); const hit = __cacheGet('tempo', __ck); if (hit) return hit;
  const last = await afGetAll("/fixtures", { team: teamId, last: 10 });
  let m=0;
  let shotsSum=0, attacksSum=0, dangSum=0, possSum=0;

  for (const g of last) {
    const st = (g?.fixture?.status?.short || "").toUpperCase();
    if (st !== "FT") continue;
    const fxId = g?.fixture?.id;
    if (!fxId) continue;

    try {
      const stx = await afGet("/fixtures/statistics", { fixture: fxId });
      if (!Array.isArray(stx?.response) || !stx.response.length) continue;

      let shotsBoth=0, attacksBoth=0, dangBoth=0, possBoth=0, teams=0;
      for (const tRow of stx.response) {
        const arr = tRow?.statistics || [];
        const shots = getStatValue(
          arr,
          ["total shots","shots total"],
          [["shots on target","shots off target"], ["shots on goal","shots off goal"]]
        );
        const attacks = getStatValue(arr, ["attacks"]);
        const dang    = getStatValue(arr, ["dangerous attacks"]);
        const poss    = getStatValue(arr, ["ball possession"]);

        shotsBoth   += shots;
        attacksBoth += attacks;
        dangBoth    += dang;
        possBoth    += poss;
        teams++;
      }
      if (teams > 0){
        m++;
        shotsSum   += shotsBoth;
        attacksSum += attacksBoth;
        dangSum    += dangBoth;
        possSum    += (possBoth/teams);
      }
    } catch(_) {}
  }

  let val;
  if (m===0) val = { has:false, tempo_mult:1.0, meta:null };
  else {
    const shotsAvg   = shotsSum / m;
    const attacksAvg = attacksSum / m;
    const dangAvg    = dangSum / m;
    const possAvg    = possSum / m;

    let tempo = 1.0;
    if (shotsAvg > 28) tempo += 0.03;
    if (shotsAvg < 18) tempo -= 0.02;
    if (attacksAvg > 200) tempo += 0.02;
    if (attacksAvg < 140) tempo -= 0.01;
    if (dangAvg > 120) tempo += 0.02;
    if (dangAvg < 75)  tempo -= 0.01;
    if (possAvg > 56) tempo += 0.005;
    if (possAvg < 44) tempo -= 0.005;

    tempo = clamp(tempo, 0.94, 1.06);

    val = {
      has:true,
      tempo_mult:Number(tempo.toFixed(3)),
      meta:{
        matches:m,
        shotsAvg:Number(shotsAvg.toFixed(1)),
        attacksAvg:Number(attacksAvg.toFixed(0)),
        dangAvg:Number(dangAvg.toFixed(0)),
        possAvg:Number(possAvg.toFixed(1))
      }
    };
  }
  __cacheSet('tempo', __ck, val, TTL.tempo);
  return val;
}

/* --------- League μ (wider seasonal window) --------- */
async function computeLeagueMu(leagueId, season) {
  const __ck = `${leagueId}:${season}`; const hit = __cacheGet('mu', __ck); if (hit) return hit;
  const from = `${season-1}-07-01`;
  const to = `${season+1}-06-30`;
  const nowISO = new Date().toISOString();
  const fixtures = await afGetAll("/fixtures", { league: leagueId, season, from, to });
  let n=0, homeGoals=0, awayGoals=0;
  for (const f of fixtures) {
    const st = (f?.fixture?.status?.short||"").toUpperCase();
    const dISO = f?.fixture?.date;
    if (!dISO || new Date(dISO).toISOString() >= nowISO) continue;
    if (st!=="FT") continue;
    const gh = f?.goals?.home ?? f?.score?.fulltime?.home ?? 0;
    const ga = f?.goals?.away ?? f?.score?.fulltime?.away ?? 0;
    homeGoals += toNum(gh); awayGoals += toNum(ga); n++;
  }
  let val;
  if (n===0) val = { mu_home:1.60, mu_away:1.20 };
  else {
    const muH = homeGoals/n;
    const muA = awayGoals/n;
    val = { mu_home: Number(muH.toFixed(2)), mu_away: Number(muA.toFixed(2)) };
  }
  __cacheSet('mu', __ck, val, TTL.mu);
  return val;
}

/* --------- Players (ratings + names) --------- */
async function teamPlayersData(teamId, leagueId, season) {
  // 1) primary: league-filtered
  const primary = await afGetAll("/players", { team: teamId, league: leagueId, season });
  // 2) fallback: cross-competition (league param olmadan)
  let merged = primary;
  if (primary.length < 8) {
    try {
      const cross = await afGetAll("/players", { team: teamId, season });
      const seen = new Set(primary.map(r => r?.player?.id));
      merged = primary.concat(cross.filter(r => !seen.has(r?.player?.id)));
    } catch(_) {}
  }
  const ratings = new Map();
  const names   = new Map();
  for (const row of merged) {
    const pid = row?.player?.id;
    const name = row?.player?.name;
    const stat = row?.statistics?.[0];
    if (pid && name) names.set(pid, name);
    if (pid && stat) ratings.set(pid, { ...ratePlayer(stat), name });
  }
  return { ratings, names };
}
function idealXIFromRatings(ratingsMap) {
  const arr = Array.from(ratingsMap.entries()).map(([id,v])=>({id, ...v}));
  arr.sort((a,b)=> (b.minutes||0) - (a.minutes||0));
  return arr.slice(0,11).map(x=>x.id);
}
function pickLite(ids, ratingsMap, namesMap) {
  return ids.map(id => {
    const r = ratingsMap.get(id);
    const name = namesMap?.get(id);
    if (r) return { id, name: r.name || name || null, grp: r.pos, off: Math.round(r.off), def: Math.round(r.def) };
    return { id, name: name || null };
  });
}

/* --------- Two-leg helper --------- */
function findTwoLegInfo(currentFx, h2hResp){
  try{
    const leagueId = currentFx?.league?.id;
    const season   = currentFx?.league?.season;
    const homeId   = currentFx?.teams?.home?.id;
    const awayId   = currentFx?.teams?.away?.id;
    const nowTs    = Date.parse(currentFx?.fixture?.date || "") || 0;
    const rows = (h2hResp?.response || []).filter(x =>
      x?.league?.id === leagueId &&
      x?.league?.season === season &&
      Date.parse(x?.fixture?.date || "") < nowTs
    );
    if (!rows.length) return { is_two_legged:false };

    let best=null, bestRank=-1;
    for (const g of rows){
      const ts = Date.parse(g?.fixture?.date || "") || 0;
      const days = (nowTs - ts) / (24*3600*1000);
      if (days > 30) continue; // iki ayak için makul pencere
      const rev = (g?.teams?.home?.id === awayId && g?.teams?.away?.id === homeId) ? 1 : 0;
      const st  = String(g?.fixture?.status?.short || "").toUpperCase();
      const ftOK = st === "FT";
      const rank = (rev ? 100 : 0) + (ftOK ? 10 : 0) - Math.abs(days);
      if (rank > bestRank) { best = g; bestRank = rank; }
    }
    if (!best) return { is_two_legged:false };

    const fl = best;
    const flHomeId = fl?.teams?.home?.id;
    const flAwayId = fl?.teams?.away?.id;
    const flGh = toNum(fl?.goals?.home ?? fl?.score?.fulltime?.home);
    const flGa = toNum(fl?.goals?.away ?? fl?.score?.fulltime?.away);

    // aggregate BEFORE second leg, mapped to current home/away
    let aggHomeBefore = 0, aggAwayBefore = 0;
    if (flHomeId === awayId && flAwayId === homeId) {
      // first leg at current away's home
      aggHomeBefore = flGa; // current home was away in 1st leg
      aggAwayBefore = flGh; // current away was home in 1st leg
    } else if (flHomeId === homeId && flAwayId === awayId) {
      // (nadir) same orientation; map directly
      aggHomeBefore = flGh;
      aggAwayBefore = flGa;
    } else {
      // farklı turnuva/yanlış eşleşme
      return { is_two_legged:false };
    }

    const diff = aggHomeBefore - aggAwayBefore; // + => home leads
    const which_leg = 2;

    return {
      is_two_legged: true,
      which_leg,
      first_leg: {
        fixture_id: fl?.fixture?.id || null,
        date: fl?.fixture?.date || null,
        home_id: flHomeId, away_id: flAwayId,
        score_home: flGh, score_away: flGa
      },
      aggregate_before: { home: aggHomeBefore, away: aggAwayBefore },
      diff
    };
  } catch {
    return { is_two_legged:false };
  }
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
    const minsToKick = Math.max(0, Math.round((kickoff - now)/60000));

    const mode = detectModeFromFixture(fixture);

    const [
      homeStatsJs, awayStatsJs,
      injHomeJs, injAwayJs,
      h2hJs, lineupsJs,
      oddsJs, providerPredJs,
      homePD, awayPD
    ] = await Promise.all([
      afGet("/teams/statistics", { team: homeId, league: leagueId, season: seasonYr }),
      afGet("/teams/statistics", { team: awayId, league: leagueId, season: seasonYr }),
      afGet("/injuries", { team: homeId, season: seasonYr }),
      afGet("/injuries", { team: awayId, season: seasonYr }),
      afGet("/fixtures/headtohead", { h2h: `${homeId}-${awayId}`, last: 10 }),
      afGet("/fixtures/lineups", { fixture: fixtureId }),
      afGet("/odds", { fixture: fixtureId }),
      afGet("/predictions", { fixture: fixtureId }),
      teamPlayersData(homeId, leagueId, seasonYr),
      teamPlayersData(awayId, leagueId, seasonYr)
    ]);

    const homePR = homePD.ratings, awayPR = awayPD.ratings;

    const { mu_home, mu_away } = await computeLeagueMu(leagueId, seasonYr);
    const mu_team = (mu_home+mu_away)/2;

    const hs = homeStatsJs?.response || {};
    const as = awayStatsJs?.response || {};
    const gfH = Number(hs?.goals?.for?.average?.total ?? 1.3);
    const gaH = Number(hs?.goals?.against?.average?.total ?? 1.3);
    const gfA = Number(as?.goals?.for?.average?.total ?? 1.3);
    const gaA = Number(as?.goals?.against?.average?.total ?? 1.3);

    // lineups (bench-aware) + names from lineup
    const lineups = lineupsJs?.response || [];
    const luHome = lineups.find(x=>x?.team?.id===homeId) || {};
    const luAway = lineups.find(x=>x?.team?.id===awayId) || {};
    const xiHomeIds = lineupIds(luHome) || [];
    const xiAwayIds = lineupIds(luAway) || [];
    const namesHome = mergeNameMaps(homePD.names, namesFromLineup(luHome));
    const namesAway = mergeNameMaps(awayPD.names, namesFromLineup(luAway));

    const xiAvailable = (xiHomeIds.length>0 && xiAwayIds.length>0 && kickoff>now);
    const xiConfidence = xiAvailable ? "high" : (kickoff - now < 90*60*1000 ? "medium" : "low");

    // ideal vs current
    const idealHome = idealXIFromRatings(homePR);
    const idealAway = idealXIFromRatings(awayPR);
    const currentHome = xiHomeIds.length ? xiHomeIds : idealHome;
    const currentAway = xiAwayIds.length ? xiAwayIds : idealAway;

    const teamH = teamFromXI(homePR, currentHome);
    const teamA = teamFromXI(awayPR, currentAway);
    const idealH = teamFromXI(homePR, idealHome);
    const idealA = teamFromXI(awayPR, idealAway);

    // injuries -> dedupe + active window
    const injHomeAll = dedupeInjuriesByPlayer(injHomeJs?.response || []);
    const injAwayAll = dedupeInjuriesByPlayer(injAwayJs?.response || []);
    const injHomeActive = injHomeAll.filter(r => injuryIsActive(r));
    const injAwayActive = injAwayAll.filter(r => injuryIsActive(r));

    const injIdsHome = new Set(injHomeActive.map(x=>x?.player?.id).filter(Boolean));
    const injIdsAway = new Set(injAwayActive.map(x=>x?.player?.id).filter(Boolean));

    const squadSetHome = new Set(currentHome);
    const squadSetAway = new Set(currentAway);
    const keyOutHome = idealHome.filter(id => !squadSetHome.has(id) && injIdsHome.has(id));
    const keyOutAway = idealAway.filter(id => !squadSetAway.has(id) && injIdsAway.has(id));

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

    const sosHomeOff = clamp((toNum(hs?.form?.att?.value)||1), 0.8, 1.2);
    const sosHomeDef = clamp((toNum(hs?.form?.def?.value)||1), 0.8, 1.2);
    const sosAwayOff = clamp((toNum(as?.form?.att?.value)||1), 0.8, 1.2);
    const sosAwayDef = clamp((toNum(as?.form?.def?.value)||1), 0.8, 1.2);

    let lambda_home = mu_home * (OffH/100) * (100/DefA) * sosHomeOff * (1/sosAwayDef);
    let lambda_away = mu_away * (OffA/100) * (100/DefH) * sosAwayOff * (1/sosHomeDef);

    if (xiConfidence === "medium") { lambda_home*=0.97; lambda_away*=0.97; }
    if (xiConfidence === "low")    { lambda_home*=0.94; lambda_away*=0.94; }

    // Formation/tactical multipliers
    const formHome = (luHome?.formation || "").trim();
    const formAway = (luAway?.formation || "").trim();
    const fHome = formationMultipliers(formHome);
    const fAway = formationMultipliers(formAway);
    lambda_home *= (fHome.M_off / (fAway.M_def || 1.0));
    lambda_away *= (fAway.M_off / (fHome.M_def || 1.0));

    // Two-leg context (2nd leg chase multipliers)
    const tie = findTwoLegInfo(fixture, h2hJs);
    let M_leg_home = 1.0, M_leg_away = 1.0;
    if (tie.is_two_legged && tie.which_leg === 2) {
      const d = tie.diff; // + => home leads
      if (d > 0) { // away trails
        const boost = d >= 2 ? 1.08 : 1.05;
        M_leg_away *= boost;
        M_leg_home *= (d >= 1 ? 0.98 : 1.0);
      } else if (d < 0) { // home trails
        const boost = Math.abs(d) >= 2 ? 1.08 : 1.05;
        M_leg_home *= boost;
        M_leg_away *= (Math.abs(d) >= 1 ? 0.98 : 1.0);
      } else { // aggregate level
        M_leg_home *= 1.01; M_leg_away *= 1.01;
      }
    }

    // Referee & tempo
    const [refFx, tempoH, tempoA] = await Promise.all([
      refereeFactors(fixture),
      teamTempoIndex(homeId),
      teamTempoIndex(awayId),
    ]);

    // Rest & Set-piece
    const [restH, restA] = await Promise.all([
      restFactor(homeId, kickoffISO),
      restFactor(awayId, kickoffISO)
    ]);
    const [spH, spA] = await Promise.all([
      teamSetPieceIndex(homeId),
      teamSetPieceIndex(awayId)
    ]);

    const spMult = setPieceMultipliers(spH, spA);

    const M_ref = refFx?.tempo_mult ?? 1.0;
    const M_tempo_home = tempoH?.tempo_mult ?? 1.0;
    const M_tempo_away = tempoA?.tempo_mult ?? 1.0;
    const M_rest_home = restH?.mult ?? 1.0;
    const M_rest_away = restA?.mult ?? 1.0;
    const M_sp_home = spMult.M_sp_home;
    const M_sp_away = spMult.M_sp_away;

    let M_mode_home = 1.0, M_mode_away = 1.0; // hooks for future specifics
    lambda_home *= M_ref * M_tempo_home * M_mode_home * M_leg_home * M_rest_home * M_sp_home;
    lambda_away *= M_ref * M_tempo_away * M_mode_away * M_leg_away * M_rest_away * M_sp_away;

    // Totals market calibration (Over/Under 2.5)
    const totalsMarket = oddsImpliedTotals(oddsJs);
    if (totalsMarket?.over25) {
      const cal = calibrateTotals(lambda_home, lambda_away, totalsMarket.over25);
      lambda_home = clamp(cal.lambdaH, 0.2, 3.8);
      lambda_away = clamp(cal.lambdaA, 0.2, 3.8);
    } else {
      lambda_home = clamp(lambda_home, 0.2, 3.8);
      lambda_away = clamp(lambda_away, 0.2, 3.8);
    }

    const dcLow = dcFactorFromMu(mu_home, mu_away);
    let grid = scoreMatrix(lambda_home, lambda_away, dcLow);
    const h2hBoost = applyLowScoreBoost(grid, h2hJs);
    grid = h2hBoost.matrix;

    const win = sum1X2(grid);
    const btts = bttsYes(grid);
    const over = over25(grid);
    const under = 1 - over;

    const market = oddsImplied(oddsJs);
    const alpha = alphaByTtk(minsToKick);
    const blend = (m,b,alpha=0.75)=> {
      if (!b) return m;
      return {
        home: clamp(alpha*m.home + (1-alpha)*b.home, 0, 1),
        draw: clamp(alpha*m.draw + (1-alpha)*b.draw, 0, 1),
        away: clamp(alpha*m.away + (1-alpha)*b.away, 0, 1)
      };
    };
    const win_blended = blend(win, market, alpha);

    // Provider predictions (robust + UI-compatible fields)
    const fmtPct = (x) => `${Math.round((Number(x)||0)*100)}%`;
    let provider = null;
    const r = providerPredJs?.response;
    if (Array.isArray(r) && r.length) {
      const item = r[0] || {};
      let p = null;
      if (Array.isArray(item.predictions) && item.predictions.length) p = item.predictions[0];
      else if (item.predictions && typeof item.predictions === "object") p = item.predictions;
      else if (item.prediction && typeof item.prediction === "object") p = item.prediction;
      else if (item.data?.predictions) p = Array.isArray(item.data.predictions) ? item.data.predictions[0] : item.data.predictions;

      const rawPercent = p?.percent || item?.percent || null;
      const toP = s => {
        if (s == null) return null;
        if (typeof s === "number") return (s > 1 ? s/100 : s);
        const num = Number(String(s).replace("%",""));
        return Number.isFinite(num) ? (num > 1 ? num/100 : num) : null;
      };
      const pn = {
        home: toP(rawPercent?.home ?? rawPercent?.Home),
        draw: toP(rawPercent?.draw ?? rawPercent?.Draw),
        away: toP(rawPercent?.away ?? rawPercent?.Away)
      };
      const probs_1x2 = (pn.home!=null && pn.draw!=null && pn.away!=null) ? pn : null;

      const percent_num = probs_1x2 ? {
        home: Number(probs_1x2.home.toFixed(3)),
        draw: Number(probs_1x2.draw.toFixed(3)),
        away: Number(probs_1x2.away.toFixed(3)),
      } : null;
      const percent = probs_1x2 ? {
        home: fmtPct(probs_1x2.home),
        draw: fmtPct(probs_1x2.draw),
        away: fmtPct(probs_1x2.away),
      } : null;

      provider = {
        winner: p?.winner || item?.winner || null,
        win_or_draw: p?.win_or_draw ?? item?.win_or_draw ?? null,
        under_over: p?.under_over ?? item?.under_over ?? null,
        goals: p?.goals ?? item?.goals ?? null,
        advice: p?.advice ?? item?.advice ?? null,
        probs_1x2, percent_num, percent,
        comparison: item?.comparison || null
      };
    }

    const out = {
      version: "fa-api v1.6.0",
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
          home: {
            idealXI: pickLite(idealHome, homePR, namesHome),
            currentXI: pickLite(currentHome, homePR, namesHome),
            key_out: pickLite(keyOutHome, homePR, namesHome)
          },
          away: {
            idealXI: pickLite(idealAway, awayPR, namesAway),
            currentXI: pickLite(currentAway, awayPR, namesAway),
            key_out: pickLite(keyOutAway, awayPR, namesAway)
          }
        },
        absences: {
          home: {
            confirmed_out: keyOutHome.length,
            active_injuries: injHomeActive.length,
            listed_injuries_total: injHomeAll.length
          },
          away: {
            confirmed_out: keyOutAway.length,
            active_injuries: injAwayActive.length,
            listed_injuries_total: injAwayAll.length
          }
        },
        referee: refFx,
        tempo: { home: tempoH, away: tempoA },
        mode_factors: { mode, M_ref, M_tempo_home, M_tempo_away, M_leg_home, M_leg_away, M_rest_home, M_rest_away, M_sp_home, M_sp_away },
        tie: tie,
        h2h_low_boost_applied: h2hBoost.applied,
        market_implied: oddsImplied(oddsJs)
      },
      explanation: {
        notes: "V1.6.0 – TTK’ye göre market blend, μ’ye göre DC low tweak, μ/tempo/referee caching, dinlenme ve duran top proxy’leri, formation çarpanları. O/U2.5 pazar kalibrasyonu ve iki maçlı eşleşme bağlamı korunur.",
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
        `${API_BASE}/players?team=${awayId}&league=${leagueId}&season=${seasonYr}`,
        `${API_BASE}/players?team=${homeId}&season=${seasonYr}`,
        `${API_BASE}/players?team=${awayId}&season=${seasonYr}`,
        ...(tie?.first_leg?.fixture_id ? [`${API_BASE}/fixtures?id=${tie.first_leg.fixture_id}`] : [])
      ]
    };

    if (debug) {
      out.modifiers._debug = {
        INJ_ACTIVE_WINDOW_DAYS,
        INJ_INCLUDE_DOUBTFUL,
        alphaByTtk: alpha,
        provider_raw_excerpt: JSON.stringify((providerPredJs?.response||[])[0] ?? null).slice(0,1200)
      };
    }

    return res.status(200).json(out);

  } catch (err){
    return res.status(500).json({ error: err?.message || "Internal error" });
  }
}

// api/screen.js  —  v0.9 (Screener)
// Amaç: Belirli bir tarihte (date) fikstürleri tarayıp odds'tan türetilmiş olasılıklarla
// "ilk 10 Over 2.5", "ilk 10 ev sahibi kazanır" vb. hızlı seçim döndürmek.
//
// Kullanım örnekleri:
//   /api/screen?date=2025-08-27&criterion=over25&k=10
//   /api/screen?date=2025-08-27&criterion=home&k=10&league=39      (Premier League)
//   /api/screen?date=2025-08-27&criterion=btts&k=15&only_pre=1
//
// Notlar:
// - Yüksek performans için "piyasa ima" (implied) olasılıklar kullanılır.
// - Over/Under 2.5 ve BTTS için uygun bahis pazarlarını yakalar.
// - 1X2 için "full time result / match winner / 1x2" harici pazarları dışlar.
// - İsteğe bağlı: refine=1 verilirse, seçilen top N aday için hafif bir ek bilgi sağlar (maç başlığı vb.),
//   TAM model çağrısı yapmaz (kotaları korumak için). İstersen ileride predict.js çağrısıyla derinleştiririz.

const API_BASE = "https://v3.football.api-sports.io";
const KEY = process.env.APIFOOTBALL_KEY;

// Basit concurrency
async function mapLimit(list, limit, mapper){
  const ret = [];
  let i = 0, active = 0;
  return await new Promise((resolve, reject)=>{
    const next = ()=>{
      if (i >= list.length && active === 0) return resolve(ret);
      while (active < limit && i < list.length){
        const idx = i++, item = list[idx];
        active++;
        Promise.resolve()
          .then(()=>mapper(item, idx))
          .then(v=>{ ret[idx]=v; active--; next(); })
          .catch(err=>reject(err));
      }
    };
    next();
  });
}

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

/* --------------------------- Odds parsers --------------------------- */
function avgTriplets(triplets){
  if (!triplets.length) return null;
  const s = triplets.reduce((a,t)=>({home:a.home+t.home, draw:a.draw+t.draw, away:a.away+t.away}),
                            {home:0,draw:0,away:0});
  const n = triplets.length;
  return { home:s.home/n, draw:s.draw/n, away:s.away/n, samples:n };
}

function parse1X2_fromOdds(bookmakers){
  const ALLOW = /(^|\s)(full\s*time\s*result|match\s*winner|1x2)(\s|$)/i;
  const BLOCK = /(to\s*qualify|double\s*chance|draw\s*no\s*bet|handicap|asian|1st|2nd|first\s*half|second\s*half|overtime|extra\s*time|penalt)/i;
  const trips = [];
  for (const bm of (bookmakers||[])){
    for (const bet of (bm.bets||[])){
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
      if (h && d && a){
        const s=h+d+a; trips.push({home:h/s, draw:d/s, away:a/s});
      }
    }
  }
  return avgTriplets(trips);
}

function parseOverUnder25_fromOdds(bookmakers){
  const ALLOW = /(over\/under|totals?|total goals)/i;
  const BLOCK  = /(1st|2nd|first\s*half|second\s*half|asian|handicap|overtime|extra\s*time)/i;
  const overs = [], unders = [];
  for (const bm of (bookmakers||[])){
    for (const bet of (bm.bets||[])){
      const name = (bet.name||"").toLowerCase();
      if (!ALLOW.test(name) || BLOCK.test(name)) continue;
      let over=null, under=null;
      for (const v of (bet.values||[])) {
        const lab=(v.value||"").toLowerCase().replace(/\s+/g,"");
        const odd=Number(v.odd);
        if (!odd || odd<=1.01) continue;
        if (/^over?2\.?5$/.test(lab) || /over2\.5/.test(lab)) over = 1/odd;
        if (/^under?2\.?5$/.test(lab) || /under2\.5/.test(lab)) under = 1/odd;
      }
      if (over || under){
        const s = ((over||0)+(under||0));
        if (over && under && s>0){
          overs.push(over/s); unders.push(under/s);
        } else if (over && !under){
          // normalize approx with small overround assumption
          overs.push(Math.min(0.95, over)); // best-effort
        } else if (under && !over){
          unders.push(Math.min(0.95, under));
        }
      }
    }
  }
  const mean = (arr)=> arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : null;
  const o = mean(overs), u = mean(unders);
  if (o==null && u==null) return null;
  // renormalize if both exist
  if (o!=null && u!=null){
    const s=o+u; return { over25:o/s, under25:u/s, samples: Math.max(overs.length, unders.length) };
  }
  return { over25: o ?? (1-(u??0)), under25: u ?? (1-(o??0)), samples: (overs.length||unders.length) };
}

function parseBTTS_fromOdds(bookmakers){
  const ALLOW = /(both\s*teams\s*to\s*score|btts)/i;
  const BLOCK = /(1st|2nd|first\s*half|second\s*half|overtime|extra\s*time)/i;
  const yeses=[], nos=[];
  for (const bm of (bookmakers||[])){
    for (const bet of (bm.bets||[])){
      const name = (bet.name||"").toLowerCase();
      if (!ALLOW.test(name) || BLOCK.test(name)) continue;
      let y=null, n=null;
      for (const v of (bet.values||[])) {
        const lab=(v.value||"").toLowerCase().trim();
        const odd=Number(v.odd);
        if (!odd || odd<=1.01) continue;
        if (lab==="yes") y = 1/odd;
        if (lab==="no")  n = 1/odd;
      }
      if (y || n){
        const s = ((y||0)+(n||0));
        if (y && n && s>0){
          yeses.push(y/s); nos.push(n/s);
        } else if (y && !n){
          yeses.push(Math.min(0.95, y));
        } else if (n && !y){
          nos.push(Math.min(0.95, n));
        }
      }
    }
  }
  const mean = (arr)=> arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : null;
  const y = mean(yeses), n = mean(nos);
  if (y==null && n==null) return null;
  if (y!=null && n!=null){
    const s=y+n; return { btts_yes:y/s, btts_no:n/s, samples: Math.max(yeses.length, nos.length) };
  }
  return { btts_yes: y ?? (1-(n??0)), btts_no: n ?? (1-(y??0)), samples: (yeses.length||nos.length) };
}

/* --------------------------- Screener core --------------------------- */
function statusShort(f){ return (f?.fixture?.status?.short || "").toUpperCase(); }

function criterionValue(crit, parsed){
  if (!parsed) return null;
  switch(String(crit).toLowerCase()){
    case "home":    return parsed.win1x2?.home ?? null;
    case "draw":    return parsed.win1x2?.draw ?? null;
    case "away":    return parsed.win1x2?.away ?? null;
    case "over25":  return parsed.ou25?.over25 ?? null;
    case "under25": return parsed.ou25?.under25 ?? null;
    case "btts":    return parsed.btts?.btts_yes ?? null;
    default:        return null;
  }
}

export default async function handler(req, res){
  try{
    if (!KEY) return res.status(500).json({ error: "Missing APIFOOTBALL_KEY env var" });

    const date      = String(req.query.date || "").trim(); // YYYY-MM-DD
    const league    = req.query.league ? Number(req.query.league) : undefined;
    const season    = req.query.season ? Number(req.query.season) : undefined;
    const crit      = String(req.query.criterion || "over25").toLowerCase(); // over25|under25|btts|home|draw|away
    const k         = Math.max(1, Math.min(50, Number(req.query.k || 10)));
    const onlyPre   = String(req.query.only_pre ?? "1") === "1"; // sadece başlamamış
    const refine    = String(req.query.refine ?? "0") === "1";
    const conc      = Math.max(2, Math.min(12, Number(process.env.SCREENER_CONCURRENCY || 6)));

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: "Pass ?date=YYYY-MM-DD" });
    }

    // 1) Fikstürler (tarih + opsiyonel lig)
    const fxParams = league ? { date, league } : { date };
    const fixtures = await afGetAll("/fixtures", fxParams);
    const list = fixtures.filter(f => {
      if (season && f?.league?.season !== season) return false;
      if (onlyPre) {
        const st = statusShort(f);
        if (!(st==="NS" || st==="TBD")) return false;
      }
      return true;
    });

    // Map by fixture id
    const byId = new Map(list.map(f => [f?.fixture?.id, f]).filter(([id])=>id));

    // 2) Odds toplama (önce toplu dene, olmazsa tek tek)
    const oddsMap = new Map(); // fixtureId -> bookmakers[]
    try {
      // bazı planlarda /odds?date destekli; yoksa boş dönebilir.
      const bulk = await afGet("/odds", { date });
      for (const r of (bulk?.response || [])){
        const fid = r?.fixture?.id;
        const bms = r?.bookmakers || [];
        if (fid && bms.length) oddsMap.set(fid, bms);
      }
    } catch(_) {}

    // eksik kalan fikstürlere tek tek
    const need = list.filter(f => !oddsMap.has(f?.fixture?.id));
    await mapLimit(need, conc, async (f)=>{
      const fid = f?.fixture?.id;
      if (!fid) return;
      try {
        const js = await afGet("/odds", { fixture: fid });
        const bms = js?.response?.[0]?.bookmakers || [];
        if (bms.length) oddsMap.set(fid, bms);
      } catch(_) {}
    });

    // 3) Parse + skorla
    const rows = [];
    for (const [fid, f] of byId.entries()){
      const bms = oddsMap.get(fid) || [];
      if (!bms.length) continue;

      const win1x2 = parse1X2_fromOdds(bms);
      const ou25   = parseOverUnder25_fromOdds(bms);
      const btts   = parseBTTS_fromOdds(bms);
      const parsed = { win1x2, ou25, btts };
      const val    = criterionValue(crit, parsed);
      if (val == null) continue;

      rows.push({
        fixture_id: fid,
        kickoff_utc: f?.fixture?.date || null,
        league: { id: f?.league?.id, name: f?.league?.name, country: f?.league?.country, season: f?.league?.season },
        home:   { id: f?.teams?.home?.id, name: f?.teams?.home?.name },
        away:   { id: f?.teams?.away?.id, name: f?.teams?.away?.name },
        market: {
          implied_1x2: win1x2 ? { ...win1x2 } : null,
          implied_ou25: ou25 ? { ...ou25 } : null,
          implied_btts: btts ? { ...btts } : null,
        },
        criterion: crit,
        criterion_value: Number(val.toFixed(4))
      });
    }

    // 4) Sırala + ilk k
    rows.sort((a,b)=> b.criterion_value - a.criterion_value);
    let picks = rows.slice(0, k);

    // 5) (opsiyonel) refine: sadece görsel rahatlık için minik ekler (tam model yok)
    if (refine) {
      picks = picks.map((r, i)=>({
        rank: i+1,
        ...r,
        notes: "screen=odds; refine=light (model çağrısı yapılmadı)"
      }));
    } else {
      picks = picks.map((r, i)=>({ rank: i+1, ...r }));
    }

    return res.status(200).json({
      asof_utc: new Date().toISOString(),
      date,
      criterion: crit,
      count_total: rows.length,
      count_returned: picks.length,
      items: picks
    });

  } catch(err){
    return res.status(500).json({ error: err?.message || "Internal error" });
  }
}

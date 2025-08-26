// api/screen.js — Odds-based daily scanner (no hard thresholds)
// Finds the top-K fixtures for a given criterion using market-implied probabilities.
// criterion: over25 | under25 | btts | home | draw | away

const API_BASE = "https://v3.football.api-sports.io";
const KEY = process.env.APIFOOTBALL_KEY;

// ---------- HTTP utils ----------
async function afGet(path, params = {}) {
  const qs = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null)
  ).toString();
  const url = `${API_BASE}${path}?${qs}`;
  const res = await fetch(url, { headers: { "x-apisports-key": KEY } });
  if (!res.ok) throw new Error(`API error ${res.status} on ${path}`);
  return await res.json();
}

function clamp01(x) { return Math.max(0, Math.min(1, x)); }

// ---------- Odds parsers ----------
function norm3(h, d, a) {
  const s = h + d + a;
  if (s <= 0) return null;
  return { home: h / s, draw: d / s, away: a / s };
}
function norm2(x, y) {
  const s = x + y;
  if (s <= 0) return null;
  return [x / s, y / s];
}

function parse1x2FromOdds(oddsResp) {
  const rs = oddsResp?.response || [];
  const ALLOW = /(^|\s)(full\s*time\s*result|match\s*winner|1x2)(\s|$)/i;
  const BLOCK = /(to\s*qualify|double\s*chance|draw\s*no\s*bet|handicap|asian|1st|2nd|half|overtime|extra|penalt)/i;

  const triplets = [];
  for (const fx of rs) {
    for (const bm of fx.bookmakers || []) {
      for (const bet of bm.bets || []) {
        const nm = (bet.name || "").toLowerCase();
        if (!ALLOW.test(nm) || BLOCK.test(nm)) continue;
        let H = null, D = null, A = null;
        for (const v of bet.values || []) {
          const label = (v.value || "").toLowerCase().trim();
          const odd = Number(v.odd);
          if (!odd || odd <= 1.01) continue;
          if (label === "1" || label.includes("home")) H = 1 / odd;
          else if (label === "x" || label.includes("draw")) D = 1 / odd;
          else if (label === "2" || label.includes("away")) A = 1 / odd;
        }
        if (H && D && A) {
          const n = norm3(H, D, A);
          if (n) triplets.push(n);
        }
      }
    }
  }
  if (!triplets.length) return null;
  const avg = triplets.reduce((acc, t) => ({
    home: acc.home + t.home,
    draw: acc.draw + t.draw,
    away: acc.away + t.away,
  }), { home: 0, draw: 0, away: 0 });
  const n = triplets.length;
  return { home: avg.home / n, draw: avg.draw / n, away: avg.away / n, samples: n };
}

function parseOU25FromOdds(oddsResp) {
  const rs = oddsResp?.response || [];
  const OU_ALLOW = /(over\/under|total goals|goals over\/under|o\/u)/i;

  const pairs = [];
  for (const fx of rs) {
    for (const bm of fx.bookmakers || []) {
      for (const bet of bm.bets || []) {
        const nm = (bet.name || "").toLowerCase();
        if (!OU_ALLOW.test(nm)) continue;
        let over = null, under = null;
        for (const v of bet.values || []) {
          const label = (v.value || "").toLowerCase();
          const odd = Number(v.odd);
          if (!odd || odd <= 1.01) continue;
          const isOver = label.includes("over") && (label.includes("2.5") || label.includes("2,5"));
          const isUnder = label.includes("under") && (label.includes("2.5") || label.includes("2,5"));
          if (isOver) over = 1 / odd;
          if (isUnder) under = 1 / odd;
        }
        if (over && under) {
          const [pOver, pUnder] = norm2(over, under);
          pairs.push({ over25: pOver, under25: pUnder });
        }
      }
    }
  }
  if (!pairs.length) return null;
  const avg = pairs.reduce((acc, t) => ({
    over25: acc.over25 + t.over25,
    under25: acc.under25 + t.under25,
  }), { over25: 0, under25: 0 });
  const n = pairs.length;
  return { over25: avg.over25 / n, under25: avg.under25 / n, samples: n };
}

function parseBTTSFromOdds(oddsResp) {
  const rs = oddsResp?.response || [];
  const BTTS_ALLOW = /(both teams to score|btts|gg\/ng|gg-ng)/i;

  const pairs = [];
  for (const fx of rs) {
    for (const bm of fx.bookmakers || []) {
      for (const bet of bm.bets || []) {
        const nm = (bet.name || "").toLowerCase();
        if (!BTTS_ALLOW.test(nm)) continue;
        let yes = null, no = null;
        for (const v of bet.values || []) {
          const label = (v.value || "").toLowerCase().trim();
          const odd = Number(v.odd);
          if (!odd || odd <= 1.01) continue;
          if (label === "yes" || label === "gg" || label.includes("both teams score: yes")) yes = 1 / odd;
          if (label === "no" || label === "ng"  || label.includes("both teams score: no"))  no  = 1 / odd;
        }
        if (yes && no) {
          const [pYes, pNo] = norm2(yes, no);
          pairs.push({ btts_yes: pYes, btts_no: pNo });
        }
      }
    }
  }
  if (!pairs.length) return null;
  const avg = pairs.reduce((acc, t) => ({
    btts_yes: acc.btts_yes + t.btts_yes,
    btts_no: acc.btts_no + t.btts_no,
  }), { btts_yes: 0, btts_no: 0 });
  const n = pairs.length;
  return { btts_yes: avg.btts_yes / n, btts_no: avg.btts_no / n, samples: n };
}

// ---------- Helpers ----------
function statusIsPre(short) {
  const s = String(short || "").toUpperCase();
  return s === "NS" || s === "TBD";
}

function pickCriterionValue(criterion, market) {
  if (!market) return null;
  switch (criterion) {
    case "home":    return market.implied_1x2?.home  ?? null;
    case "draw":    return market.implied_1x2?.draw  ?? null;
    case "away":    return market.implied_1x2?.away  ?? null;
    case "over25":  return market.implied_ou25?.over25 ?? null;
    case "under25": return market.implied_ou25?.under25 ?? null; // not used typically, but exposed
    case "btts":    return market.implied_btts?.btts_yes ?? null;
    default: return null;
  }
}

async function mapLimit(list, limit, worker) {
  const ret = [];
  let i = 0;
  const run = async () => {
    while (i < list.length) {
      const idx = i++;
      try {
        ret[idx] = await worker(list[idx], idx);
      } catch (e) {
        ret[idx] = null;
      }
    }
  };
  const runners = Array.from({ length: Math.min(limit, list.length) }, run);
  await Promise.all(runners);
  return ret;
}

// ---------- MAIN ----------
export default async function handler(req, res) {
  try {
    if (!KEY) return res.status(500).json({ error: "Missing APIFOOTBALL_KEY env var" });

    const date = String(req.query.date || "").trim() || new Date().toISOString().slice(0, 10);
    const criterion = String(req.query.criterion || "over25").toLowerCase();
    const k = Math.max(1, Math.min(50, Number(req.query.k || 10)));
    const league = req.query.league ? Number(req.query.league) : undefined;
    const season = req.query.season ? Number(req.query.season) : undefined;
    const only_pre = String(req.query.only_pre ?? "1") === "1";
    const refine = String(req.query.refine ?? "0") === "1";

    // 1) Fetch fixtures of the day
    const fx = await afGet("/fixtures", { date, league, season });
    const fixtures = (fx?.response || []).filter(g => {
      if (!only_pre) return true;
      return statusIsPre(g?.fixture?.status?.short);
    });

    // 2) For each fixture, fetch odds & compute implied markets
    const itemsRaw = await mapLimit(fixtures, 8, async (g) => {
      const fid = g?.fixture?.id;
      if (!fid) return null;

      let oddsJs = null;
      try {
        oddsJs = await afGet("/odds", { fixture: fid });
      } catch (_) {}

      const implied_1x2  = parse1x2FromOdds(oddsJs);
      const implied_ou25 = parseOU25FromOdds(oddsJs);
      const implied_btts = parseBTTSFromOdds(oddsJs);

      const market = {
        implied_1x2:  implied_1x2  ? { home: implied_1x2.home, draw: implied_1x2.draw, away: implied_1x2.away, samples: implied_1x2.samples } : null,
        implied_ou25: implied_ou25 ? { over25: implied_ou25.over25, under25: implied_ou25.under25, samples: implied_ou25.samples } : null,
        implied_btts: implied_btts ? { btts_yes: implied_btts.btts_yes, btts_no: implied_btts.btts_no, samples: implied_btts.samples } : null,
      };

      let criterion_value = pickCriterionValue(criterion, market);

      return {
        fixture_id: fid,
        kickoff_utc: g?.fixture?.date || null,
        league: {
          id: g?.league?.id ?? null,
          name: g?.league?.name ?? null,
          country: g?.league?.country ?? null,
          season: g?.league?.season ?? null,
        },
        home: { id: g?.teams?.home?.id ?? null, name: g?.teams?.home?.name ?? null },
        away: { id: g?.teams?.away?.id ?? null, name: g?.teams?.away?.name ?? null },
        market,
        criterion,
        criterion_value,
        _status: g?.fixture?.status?.short || null
      };
    });

    // Remove nulls & those with no market for the requested criterion
    let pool = (itemsRaw || []).filter(x => x && x.criterion_value != null);

    // 3) Optional refine: blend with our model for top N
    if (refine && pool.length) {
      const ORIGIN = `https://${req.headers.host}`;
      const topN = pool
        .slice()
        .sort((a, b) => (b.criterion_value - a.criterion_value))
        .slice(0, Math.min(25, Math.max(k, 10)));

      await Promise.all(topN.map(async (it) => {
        try {
          const r = await fetch(`${ORIGIN}/api/predict?fixture=${it.fixture_id}`);
          if (!r.ok) return;
          const js = await r.json();
          if (!js?.prediction) return;

          // pick model metric to blend with market
          let modelVal = null;
          if (criterion === "home" || criterion === "draw" || criterion === "away") {
            modelVal = js?.prediction?.win_probs_blended?.[criterion] ?? null;
          } else if (criterion === "over25")  modelVal = js?.prediction?.over25 ?? null;
          else if (criterion === "under25")   modelVal = js?.prediction?.under25 ?? null;
          else if (criterion === "btts")      modelVal = js?.prediction?.btts_yes ?? null;

          if (modelVal != null) {
            // Soft blend toward model (market ↑ 60% / model ↑ 40%)
            const blended = clamp01(0.6 * it.criterion_value + 0.4 * modelVal);
            it.criterion_value = blended;
            it.notes = (it.notes || "") + "refine:blend(0.6Mkt/0.4Model)";
          }
        } catch (_) {}
      }));
    }

    // 4) Rank & slice
    pool.sort((a, b) => (b.criterion_value - a.criterion_value));
    const topK = pool.slice(0, k).map((x, idx) => ({
      rank: idx + 1,
      ...x
    }));

    const out = {
      asof_utc: new Date().toISOString(),
      date,
      criterion,
      count_total: fixtures.length,
      count_returned: topK.length,
      items: topK
    };

    return res.status(200).json(out);

  } catch (err) {
    return res.status(500).json({ error: err?.message || "Internal error" });
  }
}

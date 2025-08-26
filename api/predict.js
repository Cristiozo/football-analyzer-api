const API_BASE = "https://v3.football.api-sports.io";
const KEY = process.env.APIFOOTBALL_KEY;

async function afGet(path, params) {
  const qs = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null)
  ).toString();
  const url = `${API_BASE}${path}?${qs}`;
  const res = await fetch(url, { headers: { "x-apisports-key": KEY } });
  if (!res.ok) throw new Error(`API error ${res.status} on ${path}`);
  const json = await res.json();
  return json?.response ?? [];
}

// ---- math helpers
function factorial(n) { let f = 1; for (let i = 2; i <= n; i++) f *= i; return f; }
function poissonP(k, lambda) { return Math.exp(-lambda) * Math.pow(lambda, k) / factorial(k); }

// Poisson grid + hafif Dixon–Coles düzeltmesi (0–1, 1–0, 1–1 hücrelerine küçük artış)
function scoreMatrix(lambdaH, lambdaA) {
  const SIZE = 7;
  const m = Array.from({ length: SIZE }, () => Array(SIZE).fill(0));
  for (let h = 0; h < SIZE; h++) {
    for (let a = 0; a < SIZE; a++) {
      m[h][a] = poissonP(h, lambdaH) * poissonP(a, lambdaA);
    }
  }
  const dc = 1.06;
  m[0][0] *= dc; m[1][0] *= dc; m[0][1] *= dc; m[1][1] *= dc;
  const s = m.flat().reduce((x, y) => x + y, 0);
  for (let h = 0; h < SIZE; h++) for (let a = 0; a < SIZE; a++) m[h][a] /= s;
  return m;
}
function sum1X2(m) {
  let H = 0, D = 0, A = 0;
  for (let h = 0; h < m.length; h++) {
    for (let a = 0; a < m[h].length; a++) {
      if (h > a) H += m[h][a];
      else if (h === a) D += m[h][a];
      else A += m[h][a];
    }
  }
  return { home: H, draw: D, away: A };
}
function bttsYes(m) { let p = 0; for (let h = 1; h < m.length; h++) for (let a = 1; a < m[h].length; a++) p += m[h][a]; return p; }
function over25(m) { let p = 0; for (let h = 0; h < m.length; h++) for (let a = 0; a < m[h].length; a++) if (h + a >= 3) p += m[h][a]; return p; }

// ---- NEW: helper'lar (kalibrasyon frenleri)
const clampPct = (x) => Math.max(20, Math.min(180, x));        // Off/Def için 20–180 bandı
const squash = (v) => 100 * Math.sqrt(v / 100);                 // 100→100, 160→126, 40→63 gibi
const cap = (x, lo, hi) => Math.max(lo, Math.min(hi, x));       // λ için yumuşak sınır

export default async function handler(req, res) {
  try {
    if (!KEY) return res.status(500).json({ error: "Missing APIFOOTBALL_KEY env var" });

    const fixtureId = req.query.fixture ? String(req.query.fixture) : undefined;
    if (!fixtureId) return res.status(400).json({ error: "Pass ?fixture={id}" });

    const asof = new Date().toISOString();

    const fx = await afGet("/fixtures", { id: fixtureId });
    const fixture = fx[0];
    if (!fixture) return res.status(404).json({ error: "Fixture not found" });

    const homeId = fixture.teams?.home?.id;
    const awayId = fixture.teams?.away?.id;
    const leagueId = fixture.league?.id;
    const seasonYr = fixture.league?.season;

    const kickoffISO = fixture.fixture?.date;
    if (!kickoffISO) throw new Error("Kickoff time missing");
    const now = Date.now();
    const kickoff = new Date(kickoffISO).getTime();

    // Takım istatistikleri + destek uçları
    const [homeStats, awayStats] = await Promise.all([
      afGet("/teams/statistics", { team: homeId, league: leagueId, season: seasonYr }),
      afGet("/teams/statistics", { team: awayId, league: leagueId, season: seasonYr })
    ]);
    const [injHome, injAway, h2h, lineups, odds, providerPred] = await Promise.all([
      afGet("/injuries", { team: homeId, season: seasonYr }),
      afGet("/injuries", { team: awayId, season: seasonYr }),
      afGet("/fixtures/headtohead", { h2h: `${homeId}-${awayId}`, last: 10 }),
      afGet("/fixtures/lineups", { fixture: fixtureId }),
      afGet("/odds", { fixture: fixtureId }),
      afGet("/predictions", { fixture: fixtureId })
    ]);

    // Basit sezon ortalamaları (toplam)
    const gfH = Number(homeStats?.goals?.for?.average?.total ?? 1.4);
    const gaH = Number(homeStats?.goals?.against?.average?.total ?? 1.4);
    const gfA = Number(awayStats?.goals?.for?.average?.total ?? 1.4);
    const gaA = Number(awayStats?.goals?.against?.average?.total ?? 1.4);

    // Lig tabanı (ileride dinamik yapacağız)
    const mu_home = 1.60, mu_away = 1.20;
    const mu_team = (mu_home + mu_away) / 2; // 1.40

    // ---- Off/Def (normalize → clamp → squash)
    const OffH_raw = (gfH / mu_team) * 100;
    const DefH_raw = (mu_team / gaH) * 100;
    const OffA_raw = (gfA / mu_team) * 100;
    const DefA_raw = (mu_team / gaA) * 100;

    const OffH = clampPct(OffH_raw);
    const DefH = clampPct(DefH_raw);
    const OffA = clampPct(OffA_raw);
    const DefA = clampPct(DefA_raw);

    const OffH2 = squash(OffH);
    const DefH2 = squash(DefH);
    const OffA2 = squash(OffA);
    const DefA2 = squash(DefA);

    // XI güveni
    const xiAvailable = Array.isArray(lineups) && lineups.length > 0 && kickoff > now && lineups[0]?.startXI?.length;
    const xiConfidence = xiAvailable ? "high" : (kickoff - now < 90 * 60 * 1000 ? "medium" : "low");

    // ---- λ hesapları (squash'lı Off/Def ile) + XI güvenine küçük zayıflatma + CAP
    let lambda_home = mu_home * (OffH2 / 100) * (100 / DefA2);
    let lambda_away = mu_away * (OffA2 / 100) * (100 / DefH2);

    if (xiConfidence === "medium") { lambda_home *= 0.97; lambda_away *= 0.97; }
    if (xiConfidence === "low")    { lambda_home *= 0.94; lambda_away *= 0.94; }

    // ---- NEW: uç değer frenleri (lig-agnostik güvenli bant)
    lambda_home = cap(lambda_home, 0.20, 3.00);
    lambda_away = cap(lambda_away, 0.20, 3.00);

    // Skor matrisi ve özetler
    const grid = scoreMatrix(lambda_home, lambda_away);
    const win = sum1X2(grid);
    const btts = bttsYes(grid);
    const over = over25(grid);
    const under = 1 - over;

    const scores = [];
    for (let h = 0; h < 7; h++) for (let a = 0; a < 7; a++) scores.push({ score: `${h}-${a}`, prob: grid[h][a] });
    scores.sort((x, y) => y.prob - x.prob);
    const top5 = scores.slice(0, 5).map(s => ({ score: s.score, prob: Number(s.prob.toFixed(3)) }));

    const providerPredictions =
      Array.isArray(providerPred) && providerPred[0]?.predictions
        ? providerPred[0].predictions
        : null;

    return res.status(200).json({
      asof_utc: asof,
      input: { fixture_id: fixtureId, league_id: leagueId, season: seasonYr },
      prediction: {
        lambda_home: Number(lambda_home.toFixed(3)),
        lambda_away: Number(lambda_away.toFixed(3)),
        win_probs: {
          home: Number(win.home.toFixed(3)),
          draw: Number(win.draw.toFixed(3)),
          away: Number(win.away.toFixed(3))
        },
        btts_yes: Number(btts.toFixed(3)),
        over25: Number(over.toFixed(3)),
        under25: Number(under.toFixed(3)),
        top_scores: top5,
        score_matrix: grid.map(r => r.map(x => Number(x.toFixed(6)))),
        // ---- NEW: şeffaflık için Off/Def (squash sonrası) döndürüyoruz
        offdef: {
          home_off: Number(OffH2.toFixed(1)),
          home_def: Number(DefH2.toFixed(1)),
          away_off: Number(OffA2.toFixed(1)),
          away_def: Number(DefA2.toFixed(1))
        }
      },
      explanation: {
        notes: "V1.1 – squash + lambda cap. μ sabit; taktik/SoS ileride eklenecek.",
        flags: { low_lineup_confidence: xiConfidence !== "high", old_snapshot: false, missing_sources: false }
      },
      xi_confidence: xiConfidence,
      provider_predictions: providerPredictions,
      sources: [
        `${API_BASE}/fixtures?id=${fixtureId}`,
        `${API_BASE}/teams/statistics?team=${homeId}&league=${leagueId}&season=${seasonYr}`,
        `${API_BASE}/teams/statistics?team=${awayId}&league=${leagueId}&season=${seasonYr}`,
        `${API_BASE}/fixtures/lineups?fixture=${fixtureId}`,
        `${API_BASE}/injuries?team=${homeId}&season=${seasonYr}`,
        `${API_BASE}/injuries?team=${awayId}&season=${seasonYr}`,
        `${API_BASE}/fixtures/headtohead?h2h=${homeId}-${awayId}`,
        `${API_BASE}/odds?fixture=${fixtureId}`,
        `${API_BASE}/predictions?fixture=${fixtureId}`
      ]
    });
  } catch (err) {
    return res.status(500).json({ error: err?.message || "Internal error" });
  }
}

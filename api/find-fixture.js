const API_BASE = "https://v3.football.api-sports.io";
const KEY = process.env.APIFOOTBALL_KEY;

// simple GET wrapper
async function afGet(path, params) {
  const qs = new URLSearchParams(Object.entries(params).filter(([,v]) => v!==undefined && v!==null)).toString();
  const url = `${API_BASE}${path}?${qs}`;
  const res = await fetch(url, { headers: { "x-apisports-key": KEY } });
  if (!res.ok) throw new Error(`API error ${res.status} on ${path}`);
  const json = await res.json();
  return json?.response ?? [];
}

// find first team id by name search
async function findTeamId(name) {
  const r = await afGet("/teams", { search: name });
  return Array.isArray(r) && r[0]?.team?.id ? r[0].team.id : null;
}

export default async function handler(req, res) {
  try {
    if (!KEY) return res.status(500).json({ error: "Missing APIFOOTBALL_KEY env var" });

    const date = req.query.date;           // "YYYY-MM-DD" (zorunlu)
    const homeName = req.query.home;       // "Benfica"   (opsiyonel)
    const awayName = req.query.away;       // "Fenerbahce"(opsiyonel)
    const league = req.query.league;       // league id   (opsiyonel)
    const season = req.query.season;       // season year (opsiyonel)

    if (!date) return res.status(400).json({ error: "Pass ?date=YYYY-MM-DD (and optionally &home=...&away=...)" });

    let homeId = null, awayId = null;
    if (homeName) homeId = await findTeamId(String(homeName));
    if (awayName) awayId = await findTeamId(String(awayName));

    // Get fixtures by date (+ optional league/season + one team filter)
    const baseParams = { date, league, season };
    const r1 = await afGet("/fixtures", { ...baseParams, team: homeId || awayId || undefined });

    // If both teams provided, filter locally to those two
    const list = (Array.isArray(r1) ? r1 : []).filter(fx => {
      if (homeId && fx.teams?.home?.id !== homeId && fx.teams?.away?.id !== homeId) return false;
      if (awayId && fx.teams?.home?.id !== awayId && fx.teams?.away?.id !== awayId) return false;
      return true;
    });

    const out = list.map(fx => ({
      fixture_id: fx.fixture?.id,
      date_utc: fx.fixture?.date,
      status: fx.fixture?.status?.short,
      league: { id: fx.league?.id, name: fx.league?.name, country: fx.league?.country, season: fx.league?.season },
      home: { id: fx.teams?.home?.id, name: fx.teams?.home?.name },
      away: { id: fx.teams?.away?.id, name: fx.teams?.away?.name }
    }));

    return res.status(200).json({ count: out.length, items: out });
  } catch (err) {
    return res.status(500).json({ error: err?.message || "Internal error" });
  }
}

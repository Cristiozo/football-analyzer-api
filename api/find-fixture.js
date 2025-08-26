const API_BASE = "https://v3.football.api-sports.io";
const KEY = process.env.APIFOOTBALL_KEY;

async function afGet(path, params) {
  const qs = new URLSearchParams(Object.entries(params)
    .filter(([,v]) => v !== undefined && v !== null)).toString();
  const url = `${API_BASE}${path}?${qs}`;
  const res = await fetch(url, { headers: { "x-apisports-key": KEY } });
  if (!res.ok) throw new Error(`API error ${res.status} on ${path}`);
  const json = await res.json();
  return json?.response ?? [];
}

// ---- name matching helpers (accent / punctuation insensitive)
const norm = s => (s || "")
  .toLowerCase()
  .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .replace(/[^a-z0-9]/g, "");
const matchName = (apiName, q) => norm(apiName).includes(norm(q));

async function findTeamIdBySearch(name) {
  const r = await afGet("/teams", { search: name });
  if (!Array.isArray(r) || !r.length) return null;
  // prefer best textual match
  const exact = r.find(x => norm(x.team?.name) === norm(name));
  return (exact || r[0])?.team?.id || null;
}

export default async function handler(req, res) {
  try {
    if (!KEY) return res.status(500).json({ error: "Missing APIFOOTBALL_KEY env var" });

    const date   = req.query.date;       // "YYYY-MM-DD" (required)
    const homeQ  = req.query.home || ""; // optional text
    const awayQ  = req.query.away || ""; // optional text
    const league = req.query.league;     // optional league id
    const season = req.query.season;     // optional season year
    const debug  = req.query.debug === "1";

    if (!date) return res.status(400).json({ error: "Pass ?date=YYYY-MM-DD (and optionally &home=...&away=...)" });

    // A) Strong path: pull all fixtures on date (+league/season), filter by names
    const baseParams = { date, league, season };
    const allDay = await afGet("/fixtures", baseParams);

    let byName = allDay.filter(fx => {
      const h = fx.teams?.home?.name || "", a = fx.teams?.away?.name || "";
      if (homeQ && !matchName(h, homeQ) && !matchName(a, homeQ)) return false;
      if (awayQ && !matchName(h, awayQ) && !matchName(a, awayQ)) return false;
      // if both provided, enforce they appear on opposite sides when possible
      if (homeQ && awayQ) {
        const cond1 = matchName(h, homeQ) && matchName(a, awayQ);
        const cond2 = matchName(h, awayQ) && matchName(a, homeQ);
        return cond1 || cond2;
      }
      return true;
    });

    // B) Fallback: team-id search then intersect
    let fallbackTried = false, byId = [];
    if ((!byName || byName.length === 0) && (homeQ || awayQ)) {
      fallbackTried = true;
      const hId = homeQ ? await findTeamIdBySearch(homeQ) : null;
      const aId = awayQ ? await findTeamIdBySearch(awayQ) : null;
      // query once with whichever id exists to reduce volume
      const r1 = await afGet("/fixtures", { ...baseParams, team: hId || aId || undefined });
      byId = (Array.isArray(r1) ? r1 : []).filter(fx => {
        const hid = fx.teams?.home?.id, aid = fx.teams?.away?.id;
        if (hId && hid !== hId && aid !== hId) return false;
        if (aId && hid !== aId && aid !== aId) return false;
        return true;
      });
    }

    const list = (byName && byName.length ? byName : byId).map(fx => ({
      fixture_id: fx.fixture?.id,
      date_utc:   fx.fixture?.date,
      status:     fx.fixture?.status?.short,
      league: { id: fx.league?.id, name: fx.league?.name, country: fx.league?.country, season: fx.league?.season },
      home:   { id: fx.teams?.home?.id, name: fx.teams?.home?.name },
      away:   { id: fx.teams?.away?.id, name: fx.teams?.away?.name }
    }));

    const dbg = debug ? {
      total_on_date: allDay.length,
      name_filter_results: byName?.length || 0,
      fallback_used: fallbackTried,
      fallback_results: byId?.length || 0,
      sample_on_date: allDay.slice(0, 10).map(fx => ({
        id: fx.fixture?.id, h: fx.teams?.home?.name, a: fx.teams?.away?.name
      }))
    } : undefined;

    return res.status(200).json({ count: list.length, items: list, debug: dbg });
  } catch (err) {
    return res.status(500).json({ error: err?.message || "Internal error" });
  }
}

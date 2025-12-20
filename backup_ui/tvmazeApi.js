const TVMAZE_BASE_URL = "https://api.tvmaze.com";
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export async function searchShows(query) {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const res = await fetch(
    `${TVMAZE_BASE_URL}/search/shows?q=${encodeURIComponent(trimmed)}`
  );

  if (!res.ok) {
    console.error("TVmaze search failed", res.status);
    return [];
  }

  const data = await res.json();
  return data
    .filter((item) => item.show)
    .slice(0, 8)
    .map((item) => {
      const show = item.show;
      return {
        id: show.id,
        name: show.name,
        genres: Array.isArray(show.genres) ? show.genres : [],
        premiered: show.premiered || null,
        status: show.status || null,
        image:
          (show.image && (show.image.medium || show.image.original)) || null
      };
    });
}

export async function fetchEpisodes(showId) {
  const res = await fetch(`${TVMAZE_BASE_URL}/shows/${showId}/episodes`);
  if (!res.ok) {
    console.error("TVmaze episodes failed", res.status);
    return [];
  }
  return res.json();
}

export function computeNextEpisode(episodes) {
  const now = Date.now();
  let next = null;

  for (const ep of episodes) {
    if (!ep.airstamp) continue;
    const airTime = Date.parse(ep.airstamp);
    if (Number.isNaN(airTime)) continue;
    if (airTime > now && (!next || airTime < Date.parse(next.airstamp))) {
      next = {
        season: ep.season,
        number: ep.number,
        airstamp: ep.airstamp
      };
    }
  }

  return next;
}

export function isFetchStale(lastFetchedAtIso) {
  if (!lastFetchedAtIso) return true;
  const last = Date.parse(lastFetchedAtIso);
  if (Number.isNaN(last)) return true;
  return Date.now() - last > ONE_DAY_MS;
}






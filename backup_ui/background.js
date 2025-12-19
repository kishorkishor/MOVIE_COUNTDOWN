import {
  fetchEpisodes,
  computeNextEpisode,
  isFetchStale
} from "../tvmazeApi.js";

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("refreshShowsDaily", {
    periodInMinutes: 60 * 24
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "refreshShowsDaily") {
    refreshAllShows();
  }
});

async function refreshAllShows() {
  const stored = await chrome.storage.local.get("shows");
  const shows = Array.isArray(stored.shows) ? stored.shows : [];
  if (!shows.length) return;

  const updated = [];

  for (const show of shows) {
    // Preserve watched fields always.
    let updatedShow = { ...show };

    try {
      if (!isFetchStale(show.allEpisodesLastFetchedAt)) {
        updated.push(updatedShow);
        continue;
      }

      const episodes = await fetchEpisodes(show.id);
      const nextEpisode = computeNextEpisode(episodes);
      updatedShow = {
        ...updatedShow,
        nextEpisode,
        allEpisodesLastFetchedAt: new Date().toISOString()
      };
    } catch (err) {
      console.error("Failed to refresh show", show.id, err);
    }

    // Reattach watched / watchedAt in case of any future changes.
    updatedShow.watched = show.watched;
    updatedShow.watchedAt = show.watchedAt;

    updated.push(updatedShow);
  }

  await chrome.storage.local.set({ shows: updated });
}




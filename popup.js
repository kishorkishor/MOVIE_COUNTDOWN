import {
  searchShows,
  fetchEpisodes,
  computeNextEpisode,
  isFetchStale
} from "./tvmazeApi.js";

const SAMPLE_SHOWS = [
  {
    id: "sample-1",
    name: "Strange Things in the Mountains",
    image:
      "https://static.tvmaze.com/uploads/images/medium_landscape/1/4388.jpg",
    nextEpisode: {
      season: 2,
      number: 5,
      airstamp: new Date(Date.now() + 6 * 24 * 60 * 60 * 1000).toISOString()
    },
    watched: false,
    watchedAt: null
  }
];

let currentSortMode = "soonest";

document.addEventListener("DOMContentLoaded", () => {
  const searchInput = document.getElementById("search-input");
  const searchBtn = document.getElementById("search-btn");
  const searchResultsEl = document.getElementById("search-results");
  const showsContainer = document.getElementById("shows-container");
  const sortSelect = document.getElementById("sort-select");

  if (!showsContainer) return;

  if (sortSelect) {
    chrome.storage.sync.get("sortMode", (res) => {
      if (res.sortMode) {
        currentSortMode = res.sortMode;
        sortSelect.value = currentSortMode;
      }
      loadAndRenderShows(showsContainer);
    });

    sortSelect.addEventListener("change", async (e) => {
      currentSortMode = e.target.value;
      await chrome.storage.sync.set({ sortMode: currentSortMode });
      loadAndRenderShows(showsContainer);
    });
  } else {
    loadAndRenderShows(showsContainer);
  }

  if (searchBtn && searchInput && searchResultsEl) {
    const debouncedSearch = debounce(() => {
      runSearch(searchInput, searchResultsEl);
    }, 300);

    searchBtn.addEventListener("click", () => {
      runSearch(searchInput, searchResultsEl);
    });

    searchInput.addEventListener("input", () => {
      debouncedSearch();
    });

    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        runSearch(searchInput, searchResultsEl);
      }
    });
  }

});

async function loadAndRenderShows(container) {
  const stored = await chrome.storage.local.get("shows");
  const shows = Array.isArray(stored.shows) ? stored.shows : [];

  if (!shows.length) {
    renderShows(container, SAMPLE_SHOWS, { interactive: false });
  } else {
    renderShows(container, shows, { interactive: true });
  }
}

function renderShows(container, shows, options = { interactive: true }) {
  container.innerHTML = "";
  if (!shows.length) {
    const empty = document.createElement("div");
    empty.className = "card show-card";
    empty.textContent = "No shows tracked yet. Click “Add Show” to begin.";
    container.appendChild(empty);
    return;
  }

  const ordered = sortShows(shows, currentSortMode);

  for (const show of ordered) {
    const card = createShowCard(show, options.interactive);
    container.appendChild(card);
  }

  startCountdownLoop();
}

let countdownIntervalId = null;

function createShowCard(show, interactive) {
  const card = document.createElement("div");
  card.className = "card show-card";

  if (show.image) {
    card.classList.add("has-image");
    card.style.setProperty("--show-image-url", `url("${show.image}")`);
  }

  const content = document.createElement("div");
  content.className = "show-card-content";

  const header = document.createElement("div");
  header.className = "show-header";

  const main = document.createElement("div");
  main.className = "show-main";

  if (show.image) {
    const art = document.createElement("img");
    art.className = "show-art";
    art.src = show.image;
    art.alt = `${show.name} poster`;
    main.appendChild(art);
  }

  const title = document.createElement("div");
  title.className = "show-title";
  title.textContent = show.name;

  const sub = document.createElement("div");
  sub.className = "show-countdown";
  const primaryGenre =
    Array.isArray(show.genres) && show.genres.length ? show.genres[0] : "";
  sub.textContent = primaryGenre || "";

  const textWrap = document.createElement("div");
  textWrap.className = "show-text";
  textWrap.appendChild(title);
  textWrap.appendChild(sub);

  main.appendChild(textWrap);

  header.appendChild(main);

  if (interactive) {
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "show-remove";
    removeBtn.title = "Remove from list";
    removeBtn.textContent = "✕";
    removeBtn.addEventListener("click", () => onRemoveShow(show.id));
    header.appendChild(removeBtn);
  }

  const countdownInfo = getCountdownInfo(show.nextEpisode?.airstamp);
  const meta = document.createElement("div");
  meta.className = "show-countdown";
  meta.textContent = countdownInfo.label;

  const timer = document.createElement("div");
  timer.className = "show-timer";
  if (show.nextEpisode?.airstamp) {
    timer.dataset.airstamp = show.nextEpisode.airstamp;
  }
  updateTimerElement(timer, countdownInfo);

  content.appendChild(header);
  content.appendChild(timer);
  card.appendChild(content);

  return card;
}

function sortShows(shows, mode) {
  const copy = [...shows];
  if (mode === "alpha") {
    copy.sort((a, b) => a.name.localeCompare(b.name));
  } else {
    // default: soonest next episode first
    copy.sort((a, b) => {
      const ta = a.nextEpisode?.airstamp ? Date.parse(a.nextEpisode.airstamp) : Infinity;
      const tb = b.nextEpisode?.airstamp ? Date.parse(b.nextEpisode.airstamp) : Infinity;
      return ta - tb;
    });
  }
  return copy;
}

function getCountdownInfo(airstamp) {
  if (!airstamp) {
    return { mode: "none", label: "No upcoming episodes", progress: 100 };
  }
  const now = Date.now();
  const airTime = Date.parse(airstamp);
  if (Number.isNaN(airTime)) {
    return { mode: "none", label: "Unknown date", progress: 50 };
  }

  const diffMs = airTime - now;
  if (diffMs <= 0) {
    return {
      mode: "past",
      label: "Released",
      progress: 100,
      days: 0,
      hours: 0,
      minutes: 0,
      seconds: 0
    };
  }

  const totalSeconds = Math.floor(diffMs / 1000);
  const days = Math.floor(totalSeconds / (60 * 60 * 24));
  const hours = Math.floor((totalSeconds % (60 * 60 * 24)) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  let progress = 100 - Math.min(1, diffMs / sevenDaysMs) * 100;
  progress = Math.max(5, Math.min(100, Math.round(progress)));

  return {
    mode: "upcoming",
    label: "Time until release",
    progress,
    days,
    hours,
    minutes,
    seconds
  };
}

function updateTimerElement(timerEl, info) {
  timerEl.innerHTML = "";

  if (info.mode === "upcoming") {
    const grid = document.createElement("div");
    grid.className = "countdown-grid";

    const units = [
      { key: "days", label: "D" },
      { key: "hours", label: "H" },
      { key: "minutes", label: "M" },
      { key: "seconds", label: "S" }
    ];

    units.forEach((u) => {
      const block = document.createElement("div");
      block.className = "countdown-unit";

      const num = document.createElement("div");
      num.className = "count-number";
      num.textContent = String(info[u.key] ?? 0);

      const lab = document.createElement("div");
      lab.className = "count-label";
      lab.textContent = u.label;

      block.appendChild(num);
      block.appendChild(lab);
      grid.appendChild(block);
    });

    timerEl.appendChild(grid);
  } else {
    const label = document.createElement("div");
    label.className = "timer-label";
    label.textContent = info.label;
    timerEl.appendChild(label);
  }
}

function startCountdownLoop() {
  if (countdownIntervalId != null) return;
  countdownIntervalId = setInterval(() => {
    const timers = document.querySelectorAll(".show-timer");
    timers.forEach((timerEl) => {
      const airstamp = timerEl.dataset.airstamp;
      if (!airstamp) return;
      const info = getCountdownInfo(airstamp);
      updateTimerElement(timerEl, info);
    });
  }, 1000);
}

function debounce(fn, delay) {
  let timeoutId;
  return (...args) => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    timeoutId = setTimeout(() => fn(...args), delay);
  };
}

async function runSearch(inputEl, resultsEl) {
  const query = inputEl.value;
  resultsEl.textContent = "Searching…";

  try {
    const results = await searchShows(query);
    if (!results.length) {
      resultsEl.textContent = "No results.";
      return;
    }

    resultsEl.innerHTML = "";
    results.forEach((show, index) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "search-result-item anim-in";
      item.style.animationDelay = `${index * 30}ms`;

      const main = document.createElement("div");
      main.className = "search-result-main";

      if (show.image) {
        const art = document.createElement("img");
        art.className = "search-result-art";
        art.src = show.image;
        art.alt = `${show.name} poster`;
        main.appendChild(art);
      }

      const textWrap = document.createElement("div");

      const title = document.createElement("span");
      title.className = "search-result-title";
      title.textContent = show.name;
      textWrap.appendChild(title);

      if (show.premiered || show.status) {
        const meta = document.createElement("span");
        meta.className = "search-result-meta";
        const year = show.premiered ? show.premiered.slice(0, 4) : "";
        const status = show.status || "";
        meta.textContent = [year, status].filter(Boolean).join(" • ");
        textWrap.appendChild(meta);
      }

      main.appendChild(textWrap);

      const right = document.createElement("span");
      right.className = "search-result-year";
      right.textContent = "Add";

      item.appendChild(main);
      item.appendChild(right);

      item.addEventListener("click", () => {
        addShowFromSearch(show);
      });

      resultsEl.appendChild(item);
    });
  } catch (err) {
    console.error(err);
    resultsEl.textContent = "Offline or TVmaze unavailable.";
  }
}

async function addShowFromSearch(showSummary) {
  const stored = await chrome.storage.local.get("shows");
  const shows = Array.isArray(stored.shows) ? stored.shows : [];
  if (shows.some((s) => s.id === showSummary.id)) {
    const container = document.getElementById("shows-container");
    if (container) {
      renderShows(container, shows, { interactive: true });
    }
    return;
  }

  let nextEpisode = null;
  let fetchedAt = null;
  try {
    const episodes = await fetchEpisodes(showSummary.id);
    nextEpisode = computeNextEpisode(episodes);
    fetchedAt = new Date().toISOString();
  } catch (err) {
    console.error("Failed to fetch episodes for new show", err);
  }

  const newShow = {
    id: showSummary.id,
    name: showSummary.name,
    image: showSummary.image || null,
    nextEpisode,
    allEpisodesLastFetchedAt: fetchedAt,
    watched: false,
    watchedAt: null
  };

  const updated = [...shows, newShow];
  await chrome.storage.local.set({ shows: updated });

  const container = document.getElementById("shows-container");
  if (container) {
    renderShows(container, updated, { interactive: true });
  }
}

async function onRemoveShow(showId) {
  const stored = await chrome.storage.local.get("shows");
  const shows = Array.isArray(stored.shows) ? stored.shows : [];
  const updated = shows.filter((s) => s.id !== showId);
  await chrome.storage.local.set({ shows: updated });

  const container = document.getElementById("shows-container");
  if (container) {
    renderShows(container, updated, { interactive: true });
  }
}

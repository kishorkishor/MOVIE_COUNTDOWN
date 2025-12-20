import {
  searchShows,
  searchShowsByGenre,
  searchShowsByGenreWithPopularity,
  fetchShow,
  fetchEpisodes,
  computeNextEpisode,
  isFetchStale,
  fetchScheduleToday,
  fetchPopularShows,
  lookupByImdb,
  searchByTitle
} from "./tvmazeApi.js";
import {
  fetchAiringAnime,
  fetchPopularAnime,
  fetchAnimeDetails
} from "./jikanApi.js";
import {
  queryByGenre
} from "./wikidataApi.js";
import {
  normalizeGenre,
  getCanonicalGenres,
  getApiGenre
} from "./genreMapping.js";

const SAMPLE_SHOWS = [
  {
    id: "sample-1",
    name: "Strange Things in the Mountains",
    image:
      "https://static.tvmaze.com/uploads/images/medium_landscape/1/4388.jpg",
    genres: ["Drama", "Mystery"],
    status: "Running",
    summary: "A sample show to demonstrate the card and details layout.",
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
let currentUser = null;
let pendingImportData = null;
let currentView = "my-shows"; // "my-shows", "airing", "popular"
let currentContentType = "tv"; // "tv", "anime", "movies"
let currentGenreFilter = null; // Selected genre filter in Popular view

// Quick Wins - New state variables
let currentStatusFilter = "all"; // "all", "Running", "Ended"
let currentPage = 1;
const ITEMS_PER_PAGE = 15;
let pendingLinkShowId = null; // Show ID for link modal

// Simple login functions - no OAuth2 required!
async function getCurrentUser() {
  try {
    const result = await chrome.storage.sync.get("currentUser");
    return result.currentUser || null;
  } catch (err) {
    console.error("Error getting current user:", err);
    return null;
  }
}

async function setCurrentUser(user) {
  try {
    await chrome.storage.sync.set({ currentUser: user });
    currentUser = user;
  } catch (err) {
    console.error("Error setting current user:", err);
  }
}

async function clearCurrentUser() {
  try {
    await chrome.storage.sync.remove("currentUser");
    currentUser = null;
  } catch (err) {
    console.error("Error clearing current user:", err);
  }
}

function updateUserButtonUI(user) {
  const userBtn = document.getElementById("user-btn");
  if (!userBtn) return;

  if (user) {
    const initial = user.name ? user.name.charAt(0).toUpperCase() : "👤";
    userBtn.textContent = initial;
    userBtn.title = user.email ? `Signed in as ${user.name} (${user.email})` : `Signed in as ${user.name}`;
    userBtn.classList.add("signed-in");
  } else {
    userBtn.textContent = "👤";
    userBtn.title = "Profile";
    userBtn.classList.remove("signed-in");
  }

  // Update profile menu
  const profileMenuName = document.getElementById("profile-menu-name");
  const profileSigninText = document.getElementById("profile-signin-text");
  if (profileMenuName) {
    profileMenuName.textContent = user ? user.name : "Profile";
  }
  if (profileSigninText) {
    profileSigninText.textContent = user ? "Sign Out" : "Sign In";
  }
}

function showProfileMenu() {
  const menu = document.getElementById("profile-menu");
  if (menu) {
    menu.style.display = "block";
  }
}

function hideProfileMenu() {
  const menu = document.getElementById("profile-menu");
  if (menu) {
    menu.style.display = "none";
  }
}

async function exportShows() {
  try {
    const stored = await chrome.storage.sync.get("shows");
    const shows = Array.isArray(stored.shows) ? stored.shows : [];

    if (!shows.length) {
      showToast("No shows to export. Add some shows first!", "error");
      return;
    }

    const exportData = {
      version: "1.0",
      exportedAt: new Date().toISOString(),
      shows: shows
    };

    const dataStr = JSON.stringify(exportData, null, 2);
    const dataBlob = new Blob([dataStr], { type: "application/json" });
    const url = URL.createObjectURL(dataBlob);

    const link = document.createElement("a");
    link.href = url;
    link.download = `tv-shows-backup-${new Date().toISOString().split("T")[0]}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    hideProfileMenu();
    showToast(`Exported ${shows.length} show(s) successfully!`);
  } catch (err) {
    console.error("Export error:", err);
    showToast("Failed to export shows. Please try again.", "error");
  }
}

async function importShows() {
  const fileInput = document.getElementById("profile-import-file");
  if (!fileInput) return;

  fileInput.click();
}

function showImportModal(importData) {
  const modal = document.getElementById("import-modal");
  const message = document.getElementById("import-modal-message");

  if (!modal || !message) return;

  const showCount = importData.shows.length;
  message.textContent = `This will import ${showCount} show(s). How would you like to proceed?`;

  pendingImportData = importData;
  modal.style.display = "flex";
}

function hideImportModal() {
  const modal = document.getElementById("import-modal");
  if (modal) {
    modal.style.display = "none";
  }
  pendingImportData = null;
}

async function processImport(merge = false) {
  if (!pendingImportData) return;

  try {
    const stored = await chrome.storage.sync.get("shows");
    const existingShows = Array.isArray(stored.shows) ? stored.shows : [];
    const showCount = pendingImportData.shows.length;

    let finalShows;
    if (merge) {
      // Merge: combine existing and imported, avoiding duplicates
      const existingIds = new Set(existingShows.map(s => s.id));
      const newShows = pendingImportData.shows.filter(s => !existingIds.has(s.id));
      finalShows = [...existingShows, ...newShows];
      showToast(`Merged ${newShows.length} new show(s) with ${existingShows.length} existing show(s).`);
    } else {
      // Replace
      finalShows = pendingImportData.shows;
      showToast(`Replaced all shows with ${showCount} imported show(s).`);
    }

    await chrome.storage.sync.set({ shows: finalShows });

    // Refresh the UI
    const container = document.getElementById("shows-container");
    if (container) {
      loadAndRenderShows(container);
    }

    hideImportModal();
    hideProfileMenu();
  } catch (err) {
    console.error("Import error:", err);
    showToast("Failed to import shows. Please try again.", "error");
    hideImportModal();
  }
}

async function handleFileImport(event) {
  const file = event.target.files[0];
  if (!file) return;

  try {
    const text = await file.text();
    const importData = JSON.parse(text);

    // Validate the import data
    if (!importData.shows || !Array.isArray(importData.shows)) {
      showToast("Invalid file format. Please export a valid backup file first.", "error");
      event.target.value = "";
      return;
    }

    const showCount = importData.shows.length;
    if (showCount === 0) {
      showToast("The file contains no shows.", "error");
      event.target.value = "";
      return;
    }

    // Show custom modal instead of confirm dialog
    showImportModal(importData);

    // Reset file input
    event.target.value = "";
  } catch (err) {
    console.error("Import error:", err);
    if (err instanceof SyntaxError) {
      showToast("Invalid JSON file. Please check the file and try again.", "error");
    } else {
      showToast("Failed to import shows. Please try again.", "error");
    }
    event.target.value = "";
  }
}

function showLoginModal() {
  const modal = document.getElementById("login-modal");
  if (modal) {
    modal.style.display = "flex";
    const nameInput = document.getElementById("login-name-input");
    if (nameInput) {
      nameInput.focus();
      nameInput.value = "";
    }
    const emailInput = document.getElementById("login-email-input");
    if (emailInput) {
      emailInput.value = "";
    }
  }
}

function hideLoginModal() {
  const modal = document.getElementById("login-modal");
  if (modal) {
    modal.style.display = "none";
  }
}

async function handleLogin() {
  const nameInput = document.getElementById("login-name-input");
  const emailInput = document.getElementById("login-email-input");

  if (!nameInput) return;

  const name = nameInput.value.trim();
  const email = emailInput ? emailInput.value.trim() : "";

  if (!name) {
    showToast("Please enter your name", "error");
    return;
  }

  const user = {
    name: name,
    email: email || null
  };

  await setCurrentUser(user);
  updateUserButtonUI(user);
  hideLoginModal();
  showToast(`Signed in as ${user.name}`);
}

// Toast notification system
function showToast(message, type = "success") {
  const toast = document.getElementById("toast");
  const toastMessage = document.getElementById("toast-message");

  if (!toast || !toastMessage) return;

  toastMessage.textContent = message;
  toast.className = `toast toast-${type}`;
  toast.style.display = "block";

  // Auto-hide after 3 seconds
  setTimeout(() => {
    toast.style.display = "none";
  }, 3000);
}

// ========================================
// LINK MODAL FUNCTIONS
// ========================================

function showLinkModal(showId, showName, currentLink = "") {
  const modal = document.getElementById("link-modal");
  const showNameEl = document.getElementById("link-modal-show-name");
  const linkInput = document.getElementById("link-input");
  const removeBtn = document.getElementById("link-remove-btn");

  if (!modal) return;

  pendingLinkShowId = showId;

  if (showNameEl) showNameEl.textContent = showName;
  if (linkInput) linkInput.value = currentLink || "";
  if (removeBtn) {
    removeBtn.style.display = currentLink ? "block" : "none";
  }

  modal.style.display = "flex";
  if (linkInput) linkInput.focus();
}

function hideLinkModal() {
  const modal = document.getElementById("link-modal");
  if (modal) {
    modal.style.display = "none";
  }
  pendingLinkShowId = null;
}

async function saveLinkForShow() {
  const linkInput = document.getElementById("link-input");
  if (!linkInput || !pendingLinkShowId) return;

  const link = linkInput.value.trim();

  // Validate URL
  if (link && !isValidUrl(link)) {
    showToast("Please enter a valid URL", "error");
    return;
  }

  try {
    const stored = await chrome.storage.sync.get("shows");
    const shows = Array.isArray(stored.shows) ? stored.shows : [];

    const showIndex = shows.findIndex(s => s.id === pendingLinkShowId);
    if (showIndex !== -1) {
      shows[showIndex].watchLink = link || null;
      await chrome.storage.sync.set({ shows });

      // Refresh the UI
      const container = document.getElementById("shows-container");
      if (container && currentView === "my-shows") {
        loadAndRenderShows(container);
      }

      showToast(link ? "Watch link saved!" : "Watch link removed");
    }

    hideLinkModal();
  } catch (err) {
    console.error("Error saving watch link:", err);
    showToast("Failed to save link", "error");
  }
}

async function removeLinkForShow() {
  const linkInput = document.getElementById("link-input");
  if (linkInput) linkInput.value = "";
  await saveLinkForShow();
}

function isValidUrl(string) {
  try {
    new URL(string);
    return true;
  } catch (_) {
    return false;
  }
}

// ========================================
// PRIORITY/PIN FUNCTIONS
// ========================================

async function togglePriority(showId) {
  try {
    const stored = await chrome.storage.sync.get("shows");
    const shows = Array.isArray(stored.shows) ? stored.shows : [];

    const showIndex = shows.findIndex(s => s.id === showId);
    if (showIndex !== -1) {
      shows[showIndex].priority = !shows[showIndex].priority;
      await chrome.storage.sync.set({ shows });

      // Refresh the UI
      const container = document.getElementById("shows-container");
      if (container && currentView === "my-shows") {
        loadAndRenderShows(container);
      }

      const isPriority = shows[showIndex].priority;
      showToast(isPriority ? "Pinned to top ⭐" : "Unpinned");
    }
  } catch (err) {
    console.error("Error toggling priority:", err);
  }
}

function openWatchLink(url) {
  if (url && isValidUrl(url)) {
    window.open(url, "_blank");
  } else {
    showToast("Invalid or missing watch link", "error");
  }
}

function showLogoutModal() {
  const modal = document.getElementById("logout-modal");
  if (modal) {
    modal.style.display = "flex";
  }
}

function hideLogoutModal() {
  const modal = document.getElementById("logout-modal");
  if (modal) {
    modal.style.display = "none";
  }
}

async function handleLogout() {
  await clearCurrentUser();
  updateUserButtonUI(null);
  hideLogoutModal();
  showToast("Signed out");
}

document.addEventListener("DOMContentLoaded", async () => {
  // Initialize user
  currentUser = await getCurrentUser();
  updateUserButtonUI(currentUser);
  const searchInput = document.getElementById("search-input");
  const searchBtn = document.getElementById("search-btn");
  const searchResultsEl = document.getElementById("search-results");
  const clearSearchBtn = document.getElementById("clear-search-btn");
  const searchShell = document.querySelector(".search-shell");
  const showsContainer = document.getElementById("shows-container");
  const sortSelect = document.getElementById("sort-select");
  const userBtn = document.getElementById("user-btn");

  // Handle user button click - show profile menu
  if (userBtn) {
    userBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const menu = document.getElementById("profile-menu");
      if (menu && menu.style.display === "block") {
        hideProfileMenu();
      } else {
        showProfileMenu();
      }
    });
  }

  // Close profile menu when clicking outside
  document.addEventListener("click", (e) => {
    const menu = document.getElementById("profile-menu");
    const userBtn = document.getElementById("user-btn");
    if (menu && userBtn && !menu.contains(e.target) && !userBtn.contains(e.target)) {
      hideProfileMenu();
    }
  });

  // Profile menu buttons
  const profileExportBtn = document.getElementById("profile-export-btn");
  const profileImportBtn = document.getElementById("profile-import-btn");
  const profileImportFile = document.getElementById("profile-import-file");
  const profileSigninBtn = document.getElementById("profile-signin-btn");

  if (profileExportBtn) {
    profileExportBtn.addEventListener("click", exportShows);
  }

  if (profileImportBtn) {
    profileImportBtn.addEventListener("click", importShows);
  }

  if (profileImportFile) {
    profileImportFile.addEventListener("change", handleFileImport);
  }

  if (profileSigninBtn) {
    profileSigninBtn.addEventListener("click", () => {
      hideProfileMenu();
      if (currentUser) {
        showLogoutModal();
      } else {
        showLoginModal();
      }
    });
  }

  // Logout modal buttons
  const logoutConfirmBtn = document.getElementById("logout-confirm-btn");
  const logoutCancelBtn = document.getElementById("logout-cancel-btn");

  if (logoutConfirmBtn) {
    logoutConfirmBtn.addEventListener("click", handleLogout);
  }

  if (logoutCancelBtn) {
    logoutCancelBtn.addEventListener("click", hideLogoutModal);
  }

  // Close logout modal when clicking outside
  const logoutModal = document.getElementById("logout-modal");
  if (logoutModal) {
    logoutModal.addEventListener("click", (e) => {
      if (e.target === logoutModal) {
        hideLogoutModal();
      }
    });
  }

  // Import modal buttons
  const importMergeBtn = document.getElementById("import-merge-btn");
  const importReplaceBtn = document.getElementById("import-replace-btn");
  const importCancelBtn = document.getElementById("import-cancel-btn");

  if (importMergeBtn) {
    importMergeBtn.addEventListener("click", () => {
      processImport(true);
    });
  }

  if (importReplaceBtn) {
    importReplaceBtn.addEventListener("click", () => {
      processImport(false);
    });
  }

  if (importCancelBtn) {
    importCancelBtn.addEventListener("click", () => {
      hideImportModal();
    });
  }

  // Close import modal when clicking outside
  const importModal = document.getElementById("import-modal");
  if (importModal) {
    importModal.addEventListener("click", (e) => {
      if (e.target === importModal) {
        hideImportModal();
      }
    });
  }

  // Handle login modal
  const loginSubmitBtn = document.getElementById("login-submit-btn");
  const loginCancelBtn = document.getElementById("login-cancel-btn");
  const loginNameInput = document.getElementById("login-name-input");
  const loginEmailInput = document.getElementById("login-email-input");

  if (loginSubmitBtn) {
    loginSubmitBtn.addEventListener("click", handleLogin);
  }

  if (loginCancelBtn) {
    loginCancelBtn.addEventListener("click", hideLoginModal);
  }

  if (loginNameInput) {
    loginNameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleLogin();
      }
    });
  }

  if (loginEmailInput) {
    loginEmailInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleLogin();
      }
    });
  }

  // Close modal when clicking outside
  const loginModal = document.getElementById("login-modal");
  if (loginModal) {
    loginModal.addEventListener("click", (e) => {
      if (e.target === loginModal) {
        hideLoginModal();
      }
    });
  }

  if (!showsContainer) return;

  // Navigation tabs
  const navTabs = document.querySelectorAll(".nav-tab");
  navTabs.forEach(tab => {
    tab.addEventListener("click", () => {
      const view = tab.dataset.view;
      switchView(view);
    });
  });

  // Content type toggles
  const contentTypeButtons = document.querySelectorAll(".content-type-btn");
  contentTypeButtons.forEach(btn => {
    btn.addEventListener("click", () => {
      const type = btn.dataset.type;
      setContentType(type);
    });
  });

  // Load saved view preference
  chrome.storage.sync.get(["sortMode", "currentView"], (res) => {
    if (res.sortMode) {
      currentSortMode = res.sortMode;
      if (sortSelect) sortSelect.value = currentSortMode;
    }
    if (res.currentView) {
      currentView = res.currentView;
      switchView(currentView, false);
    } else {
      loadAndRenderShows(showsContainer);
    }
  });

  if (sortSelect) {
    sortSelect.addEventListener("change", async (e) => {
      currentSortMode = e.target.value;
      await chrome.storage.sync.set({ sortMode: currentSortMode });
      if (currentView === "my-shows") {
        loadAndRenderShows(showsContainer);
      }
    });
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
      if (searchShell) {
        if (searchInput.value.trim().length) {
          searchShell.classList.add("has-text");
        } else {
          searchShell.classList.remove("has-text");
        }
      }
    });

    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        runSearch(searchInput, searchResultsEl);
      }
    });
  }

  if (clearSearchBtn && searchInput && searchResultsEl && searchShell) {
    clearSearchBtn.addEventListener("click", () => {
      searchInput.value = "";
      searchShell.classList.remove("has-text");
      searchInput.focus();
      searchResultsEl.innerHTML = "";
    });
  }

  // Status filter handler
  const statusFilter = document.getElementById("status-filter");
  if (statusFilter) {
    // Load saved status filter
    chrome.storage.sync.get(["statusFilter"], (res) => {
      if (res.statusFilter) {
        currentStatusFilter = res.statusFilter;
        statusFilter.value = currentStatusFilter;
      }
    });

    statusFilter.addEventListener("change", async (e) => {
      currentStatusFilter = e.target.value;
      currentPage = 1; // Reset pagination
      await chrome.storage.sync.set({ statusFilter: currentStatusFilter });
      if (currentView === "my-shows") {
        loadAndRenderShows(showsContainer);
      }
    });
  }

  // Link modal handlers
  const linkModal = document.getElementById("link-modal");
  const linkInput = document.getElementById("link-input");
  const linkSaveBtn = document.getElementById("link-save-btn");
  const linkRemoveBtn = document.getElementById("link-remove-btn");
  const linkCancelBtn = document.getElementById("link-cancel-btn");

  if (linkSaveBtn) {
    linkSaveBtn.addEventListener("click", () => saveLinkForShow());
  }

  if (linkRemoveBtn) {
    linkRemoveBtn.addEventListener("click", () => removeLinkForShow());
  }

  if (linkCancelBtn) {
    linkCancelBtn.addEventListener("click", () => hideLinkModal());
  }

  if (linkInput) {
    linkInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        saveLinkForShow();
      }
    });
  }

  // Close link modal when clicking outside
  if (linkModal) {
    linkModal.addEventListener("click", (e) => {
      if (e.target === linkModal) {
        hideLinkModal();
      }
    });
  }

});

async function switchView(view, savePreference = true) {
  currentView = view;
  const showsContainer = document.getElementById("shows-container");
  const sectionTitle = document.querySelector(".section-title");
  const sortSelect = document.getElementById("sort-select");
  const sortSelectContainer = document.querySelector(".shows-header");

  if (!showsContainer) return;

  // Update active tab
  document.querySelectorAll(".nav-tab").forEach(tab => {
    if (tab.dataset.view === view) {
      tab.classList.add("active");
    } else {
      tab.classList.remove("active");
    }
  });

  // Show/hide content type toggles
  const contentTypeToggles = document.getElementById("content-type-toggles");
  if (contentTypeToggles) {
    if (view === "popular" || view === "airing") {
      contentTypeToggles.style.display = "flex";
    } else {
      contentTypeToggles.style.display = "none";
    }
  }

  // Show/hide genre filters (only in Popular view)
  const genreFilters = document.getElementById("genre-filters");
  if (genreFilters) {
    if (view === "popular") {
      genreFilters.style.display = "block";
      initializeGenreFilters();
    } else {
      genreFilters.style.display = "none";
      currentGenreFilter = null;
    }
  }

  // Show/hide sort select based on view
  if (sortSelectContainer) {
    if (view === "my-shows") {
      sortSelectContainer.style.display = "flex";
    } else {
      sortSelectContainer.style.display = "none";
    }
  }

  // Update section title
  if (sectionTitle) {
    if (view === "my-shows") {
      sectionTitle.textContent = "Your shows";
    } else if (view === "airing") {
      sectionTitle.textContent = "Airing today";
    } else if (view === "popular") {
      sectionTitle.textContent = "Popular shows";
    }
  }

  // Load appropriate content
  if (view === "my-shows") {
    loadAndRenderShows(showsContainer);
  } else if (view === "airing") {
    loadAndRenderAiringShows(showsContainer);
  } else if (view === "popular") {
    loadAndRenderPopularShows(showsContainer);
  }

  // Save preference
  if (savePreference) {
    await chrome.storage.sync.set({ currentView: view });
  }
}

async function loadAndRenderAiringShows(container) {
  container.innerHTML = "<div class='card show-card'>Loading shows airing today...</div>";

  try {
    let shows = [];

    if (currentContentType === "tv") {
      const tvShows = await fetchScheduleToday();
      shows = await Promise.all(
        tvShows.map(async (show) => {
          try {
            const episodes = await fetchEpisodes(show.id);
            const nextEpisode = computeNextEpisode(episodes);
            return {
              ...show,
              nextEpisode,
              watched: false,
              watchedAt: null,
              contentType: "tv"
            };
          } catch (err) {
            console.error(`Failed to fetch episodes for ${show.name}:`, err);
            return {
              ...show,
              nextEpisode: null,
              watched: false,
              watchedAt: null,
              contentType: "tv"
            };
          }
        })
      );
    } else if (currentContentType === "anime") {
      // Use Jikan to get airing anime, then cross-match with TVmaze
      const jikanAnime = await fetchAiringAnime();

      // Cross-match each anime with TVmaze - only keep if found in TVmaze
      const matchedAnime = await Promise.all(
        jikanAnime.map(async (anime) => {
          // Try searching TVmaze by title (try English name first, then original)
          let tvmazeShow = await searchByTitle(anime.nameEnglish || anime.name);

          // If not found, try original name
          if (!tvmazeShow && anime.name !== anime.nameEnglish) {
            tvmazeShow = await searchByTitle(anime.name);
          }

          // Only return if found in TVmaze
          if (tvmazeShow) {
            // Prioritize images: TVmaze first, then Jikan, ensure it's a valid URL
            let finalImage = null;
            // Handle TVmaze image format (could be string or object with medium/original)
            if (tvmazeShow.image) {
              if (typeof tvmazeShow.image === 'string' && tvmazeShow.image.trim()) {
                finalImage = tvmazeShow.image;
              } else if (typeof tvmazeShow.image === 'object') {
                finalImage = tvmazeShow.image.medium || tvmazeShow.image.original || null;
              }
            }
            // Fallback to Jikan image if TVmaze doesn't have one
            if (!finalImage && anime.image && typeof anime.image === 'string' && anime.image.trim()) {
              finalImage = anime.image;
            }

            try {
              const episodes = await fetchEpisodes(tvmazeShow.id);
              const nextEpisode = computeNextEpisode(episodes);
              return {
                id: tvmazeShow.id,
                name: tvmazeShow.name,
                genres: tvmazeShow.genres || anime.genres,
                status: tvmazeShow.status || anime.status,
                summary: tvmazeShow.summary || anime.summary,
                image: finalImage,
                nextEpisode,
                watched: false,
                watchedAt: null,
                contentType: "anime",
                malId: anime.malId
              };
            } catch (err) {
              console.error(`Failed to fetch episodes for ${tvmazeShow.name}:`, err);
              return {
                id: tvmazeShow.id,
                name: tvmazeShow.name,
                genres: tvmazeShow.genres || anime.genres,
                status: tvmazeShow.status || anime.status,
                summary: tvmazeShow.summary || anime.summary,
                image: finalImage,
                nextEpisode: null,
                watched: false,
                watchedAt: null,
                contentType: "anime",
                malId: anime.malId
              };
            }
          }
          return null; // Not found in TVmaze, skip
        })
      );

      // Filter out nulls (anime not found in TVmaze)
      shows = matchedAnime.filter(show => show !== null);
    } else if (currentContentType === "movies") {
      // Movies don't have "airing" episodes, but show them with "Not episodic" label
      // Try to get some popular movies from Wikidata
      const wikidataResults = await queryByGenre("Action", ["movies"], 10);
      shows = await Promise.all(
        wikidataResults.map(async (item) => {
          // Try to cross-check with TVmaze for images
          let tvmazeData = null;
          if (item.imdbId) {
            tvmazeData = await lookupByImdb(item.imdbId);
          }
          if (!tvmazeData) {
            tvmazeData = await searchByTitle(item.name);
          }

          return {
            id: `wd-${item.wikidataId}`,
            name: item.name,
            genres: tvmazeData?.genres || [],
            status: tvmazeData?.status || null,
            summary: tvmazeData?.summary || "",
            image: tvmazeData?.image || null,
            nextEpisode: null, // Movies are not episodic
            watched: false,
            watchedAt: null,
            contentType: "movies",
            imdbId: item.imdbId,
            tvmazeId: tvmazeData?.id || null
          };
        })
      );
    }

    if (!shows.length) {
      container.innerHTML = `<div class='card show-card'>No ${currentContentType === "tv" ? "TV shows" : "anime"} airing today.</div>`;
      return;
    }

    renderShows(container, shows, { interactive: false, clickable: true });
  } catch (err) {
    console.error("Failed to load airing shows:", err);
    container.innerHTML = "<div class='card show-card'>Failed to load shows airing today.</div>";
  }
}

async function loadAndRenderPopularShows(container) {
  container.innerHTML = "<div class='card show-card'>Loading popular shows...</div>";

  try {
    let shows = [];

    if (currentGenreFilter) {
      // Load by genre
      shows = await loadAndRenderByGenre(currentGenreFilter, currentContentType);
    } else {
      // Load popular by content type
      if (currentContentType === "tv") {
        const tvShows = await fetchPopularShows();
        shows = await Promise.all(
          tvShows.map(async (show) => {
            try {
              const episodes = await fetchEpisodes(show.id);
              const nextEpisode = computeNextEpisode(episodes);
              return {
                ...show,
                nextEpisode,
                watched: false,
                watchedAt: null,
                contentType: "tv"
              };
            } catch (err) {
              console.error(`Failed to fetch episodes for ${show.name}:`, err);
              return {
                ...show,
                nextEpisode: null,
                watched: false,
                watchedAt: null,
                contentType: "tv"
              };
            }
          })
        );
      } else if (currentContentType === "anime") {
        // Use Jikan to get popular anime, then cross-match with TVmaze
        let jikanAnime = [];
        if (currentGenreFilter) {
          const genre = getApiGenre(normalizeGenre(currentGenreFilter), "jikan");
          jikanAnime = await fetchPopularAnime(genre);
        } else {
          jikanAnime = await fetchPopularAnime();
        }

        // Cross-match each anime with TVmaze - only keep if found in TVmaze
        const matchedAnime = await Promise.all(
          jikanAnime.map(async (anime) => {
            // Try searching TVmaze by title (try English name first, then original)
            let tvmazeShow = await searchByTitle(anime.nameEnglish || anime.name);

            // If not found, try original name
            if (!tvmazeShow && anime.name !== anime.nameEnglish) {
              tvmazeShow = await searchByTitle(anime.name);
            }

            // Only return if found in TVmaze
            if (tvmazeShow) {
              // Prioritize images: TVmaze first, then Jikan, ensure it's a valid URL
              let finalImage = null;
              if (tvmazeShow.image && typeof tvmazeShow.image === 'string' && tvmazeShow.image.trim()) {
                finalImage = tvmazeShow.image;
              } else if (anime.image && typeof anime.image === 'string' && anime.image.trim()) {
                finalImage = anime.image;
              }

              try {
                const episodes = await fetchEpisodes(tvmazeShow.id);
                const nextEpisode = computeNextEpisode(episodes);
                return {
                  id: tvmazeShow.id,
                  name: tvmazeShow.name,
                  genres: tvmazeShow.genres || anime.genres,
                  status: tvmazeShow.status || anime.status,
                  summary: tvmazeShow.summary || anime.summary,
                  image: finalImage,
                  nextEpisode,
                  watched: false,
                  watchedAt: null,
                  contentType: "anime",
                  malId: anime.malId
                };
              } catch (err) {
                console.error(`Failed to fetch episodes for ${tvmazeShow.name}:`, err);
                return {
                  id: tvmazeShow.id,
                  name: tvmazeShow.name,
                  genres: tvmazeShow.genres || anime.genres,
                  status: tvmazeShow.status || anime.status,
                  summary: tvmazeShow.summary || anime.summary,
                  image: finalImage,
                  nextEpisode: null,
                  watched: false,
                  watchedAt: null,
                  contentType: "anime",
                  malId: anime.malId
                };
              }
            }
            return null; // Not found in TVmaze, skip
          })
        );

        // Filter out nulls (anime not found in TVmaze)
        shows = matchedAnime.filter(show => show !== null);
      } else if (currentContentType === "movies") {
        // For movies, fetch from a common genre like "Drama" or "Action"
        const wikidataResults = await queryByGenre("Drama", ["movies"], 20);
        // Cross-check with TVmaze for images and metadata
        shows = await Promise.all(
          wikidataResults.map(async (item) => {
            let tvmazeData = null;

            // Try IMDb lookup first, then title search
            if (item.imdbId) {
              tvmazeData = await lookupByImdb(item.imdbId);
            }
            if (!tvmazeData) {
              tvmazeData = await searchByTitle(item.name);
            }

            return {
              id: `wd-${item.wikidataId}`,
              name: item.name,
              genres: tvmazeData?.genres || [],
              status: tvmazeData?.status || null,
              summary: tvmazeData?.summary || "",
              image: tvmazeData?.image || null,
              nextEpisode: null, // Movies are not episodic
              watched: false,
              watchedAt: null,
              contentType: "movies",
              imdbId: item.imdbId,
              tvmazeId: tvmazeData?.id || null
            };
          })
        );
      }
    }

    if (!shows.length) {
      container.innerHTML = `<div class='card show-card'>No popular ${currentContentType} found.</div>`;
      return;
    }

    renderShows(container, shows, { interactive: false, clickable: true });
  } catch (err) {
    console.error("Failed to load popular shows:", err);
    container.innerHTML = "<div class='card show-card'>Failed to load popular shows.</div>";
  }
}

async function loadAndRenderByGenre(genre, contentType) {
  try {
    const normalizedGenre = normalizeGenre(genre);
    let shows = [];

    if (contentType === "tv") {
      // Use TVmaze with popularity scoring
      shows = await searchShowsByGenreWithPopularity(getApiGenre(normalizedGenre, "tvmaze"));
      shows = await Promise.all(
        shows.map(async (show) => {
          try {
            const episodes = await fetchEpisodes(show.id);
            const nextEpisode = computeNextEpisode(episodes);
            return {
              ...show,
              nextEpisode,
              watched: false,
              watchedAt: null,
              contentType: "tv"
            };
          } catch (err) {
            return {
              ...show,
              nextEpisode: null,
              watched: false,
              watchedAt: null,
              contentType: "tv"
            };
          }
        })
      );
    } else if (contentType === "anime") {
      // Use Jikan to get anime by genre, then cross-match with TVmaze
      const genre = getApiGenre(normalizedGenre, "jikan");
      const jikanAnime = await fetchPopularAnime(genre);

      // Cross-match each anime with TVmaze - only keep if found in TVmaze
      const matchedAnime = await Promise.all(
        jikanAnime.map(async (anime) => {
          // Try searching TVmaze by title (try English name first, then original)
          let tvmazeShow = await searchByTitle(anime.nameEnglish || anime.name);

          // If not found, try original name
          if (!tvmazeShow && anime.name !== anime.nameEnglish) {
            tvmazeShow = await searchByTitle(anime.name);
          }

          // Only return if found in TVmaze
          if (tvmazeShow) {
            // Prioritize images: TVmaze first, then Jikan, ensure it's a valid URL
            let finalImage = null;
            // Handle TVmaze image format (could be string or object with medium/original)
            if (tvmazeShow.image) {
              if (typeof tvmazeShow.image === 'string' && tvmazeShow.image.trim()) {
                finalImage = tvmazeShow.image;
              } else if (typeof tvmazeShow.image === 'object') {
                finalImage = tvmazeShow.image.medium || tvmazeShow.image.original || null;
              }
            }
            // Fallback to Jikan image if TVmaze doesn't have one
            if (!finalImage && anime.image && typeof anime.image === 'string' && anime.image.trim()) {
              finalImage = anime.image;
            }

            try {
              const episodes = await fetchEpisodes(tvmazeShow.id);
              const nextEpisode = computeNextEpisode(episodes);
              return {
                id: tvmazeShow.id,
                name: tvmazeShow.name,
                genres: tvmazeShow.genres || anime.genres,
                status: tvmazeShow.status || anime.status,
                summary: tvmazeShow.summary || anime.summary,
                image: finalImage,
                nextEpisode,
                watched: false,
                watchedAt: null,
                contentType: "anime",
                malId: anime.malId
              };
            } catch (err) {
              return {
                id: tvmazeShow.id,
                name: tvmazeShow.name,
                genres: tvmazeShow.genres || anime.genres,
                status: tvmazeShow.status || anime.status,
                summary: tvmazeShow.summary || anime.summary,
                image: finalImage,
                nextEpisode: null,
                watched: false,
                watchedAt: null,
                contentType: "anime",
                malId: anime.malId
              };
            }
          }
          return null; // Not found in TVmaze, skip
        })
      );

      // Filter out nulls (anime not found in TVmaze)
      shows = matchedAnime.filter(show => show !== null);
    } else if (contentType === "movies") {
      // Use Wikidata
      const wikidataResults = await queryByGenre(normalizedGenre, ["movies"], 20);
      // Cross-check with TVmaze for images and metadata
      shows = await Promise.all(
        wikidataResults.map(async (item) => {
          let tvmazeData = null;

          // Try IMDb lookup first, then title search
          if (item.imdbId) {
            tvmazeData = await lookupByImdb(item.imdbId);
          }
          if (!tvmazeData) {
            tvmazeData = await searchByTitle(item.name);
          }

          return {
            id: `wd-${item.wikidataId}`,
            name: item.name,
            genres: tvmazeData?.genres || [],
            status: tvmazeData?.status || null,
            summary: tvmazeData?.summary || "",
            image: tvmazeData?.image || null,
            nextEpisode: null, // Movies are not episodic
            watched: false,
            watchedAt: null,
            contentType: "movies",
            imdbId: item.imdbId,
            tvmazeId: tvmazeData?.id || null
          };
        })
      );
    }

    return shows;
  } catch (err) {
    console.error("Failed to load by genre:", err);
    return [];
  }
}

function initializeGenreFilters() {
  const genreFiltersList = document.getElementById("genre-filters-list");
  if (!genreFiltersList) return;

  const genres = getCanonicalGenres();
  genreFiltersList.innerHTML = "";

  // Add "All" button
  const allBtn = document.createElement("button");
  allBtn.className = "genre-filter-chip";
  allBtn.textContent = "All";
  allBtn.dataset.genre = "";
  if (!currentGenreFilter) {
    allBtn.classList.add("active");
  }
  allBtn.addEventListener("click", () => {
    currentGenreFilter = null;
    updateGenreFilterButtons();
    const container = document.getElementById("shows-container");
    if (container && currentView === "popular") {
      loadAndRenderPopularShows(container);
    }
  });
  genreFiltersList.appendChild(allBtn);

  // Add genre buttons
  genres.forEach(genre => {
    const chip = document.createElement("button");
    chip.className = "genre-filter-chip";
    chip.textContent = genre;
    chip.dataset.genre = genre;
    if (currentGenreFilter === genre) {
      chip.classList.add("active");
    }
    chip.addEventListener("click", () => {
      currentGenreFilter = genre;
      updateGenreFilterButtons();
      const container = document.getElementById("shows-container");
      if (container && currentView === "popular") {
        loadAndRenderPopularShows(container);
      }
    });
    genreFiltersList.appendChild(chip);
  });
}

function updateGenreFilterButtons() {
  document.querySelectorAll(".genre-filter-chip").forEach(btn => {
    if (btn.dataset.genre === (currentGenreFilter || "")) {
      btn.classList.add("active");
    } else {
      btn.classList.remove("active");
    }
  });
}

async function setContentType(type) {
  currentContentType = type;

  // Update active button
  document.querySelectorAll(".content-type-btn").forEach(btn => {
    if (btn.dataset.type === type) {
      btn.classList.add("active");
    } else {
      btn.classList.remove("active");
    }
  });

  // Reload current view
  const container = document.getElementById("shows-container");
  if (!container) return;

  if (currentView === "airing") {
    loadAndRenderAiringShows(container);
  } else if (currentView === "popular") {
    loadAndRenderPopularShows(container);
  }
}

async function loadAndRenderShows(container) {
  // chrome.storage.sync automatically syncs per Chrome account - no auth needed!
  const stored = await chrome.storage.sync.get("shows");
  let shows = Array.isArray(stored.shows) ? stored.shows : [];

  // Apply status filter
  if (currentStatusFilter !== "all") {
    shows = shows.filter(show => show.status === currentStatusFilter);
  }

  if (!shows.length && currentStatusFilter === "all") {
    renderShows(container, SAMPLE_SHOWS, { interactive: false });
  } else if (!shows.length) {
    container.innerHTML = "";
    const empty = document.createElement("div");
    empty.className = "card show-card";
    empty.textContent = `No ${currentStatusFilter.toLowerCase()} shows found.`;
    container.appendChild(empty);
  } else {
    renderShows(container, shows, { interactive: true });
  }
}

function renderShows(container, shows, options = { interactive: true, clickable: false }) {
  container.innerHTML = "";
  if (!shows.length) {
    const empty = document.createElement("div");
    empty.className = "card show-card";
    empty.textContent = "No shows tracked yet. Search to add shows!";
    container.appendChild(empty);
    return;
  }

  const ordered = currentView === "my-shows" ? sortShows(shows, currentSortMode) : shows;

  // Pagination: show only items for current page
  const startIndex = 0;
  const endIndex = currentPage * ITEMS_PER_PAGE;
  const paginatedShows = ordered.slice(startIndex, endIndex);
  const hasMore = ordered.length > endIndex;

  for (const show of paginatedShows) {
    const card = createShowCard(show, options.interactive, options.clickable);
    container.appendChild(card);
  }

  // Add "Load More" button if there are more shows
  if (hasMore && currentView === "my-shows") {
    const loadMoreBtn = document.createElement("button");
    loadMoreBtn.className = "load-more-btn";
    loadMoreBtn.textContent = `Load More (${ordered.length - endIndex} remaining)`;
    loadMoreBtn.addEventListener("click", () => {
      currentPage++;
      loadAndRenderShows(container);
    });
    container.appendChild(loadMoreBtn);
  }

  startCountdownLoop();
}

let countdownIntervalId = null;

function createShowCard(show, interactive, clickable = false) {
  const card = document.createElement("div");
  card.className = "card show-card";

  // Add priority styling
  if (show.priority) {
    card.classList.add("priority-card");
  }

  if (clickable) {
    card.style.cursor = "pointer";
    card.title = "Click to add to your shows";
  }

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

  // Add content type badge
  const contentType = show.contentType || "tv";
  const typeBadge = document.createElement("span");
  typeBadge.className = "content-type-badge";
  typeBadge.textContent = contentType === "anime" ? "🎌" : contentType === "movies" ? "🎬" : "📺";
  typeBadge.title = contentType === "anime" ? "Anime" : contentType === "movies" ? "Movie" : "TV Show";
  title.appendChild(typeBadge);

  const sub = document.createElement("div");
  sub.className = "show-countdown";
  const genreList = Array.isArray(show.genres) ? show.genres : [];
  const subLabel =
    genreList.length > 0 ? genreList.join(", ") : show.status || "";
  sub.textContent = subLabel || "";

  const textWrap = document.createElement("div");
  textWrap.className = "show-text";
  textWrap.appendChild(title);
  textWrap.appendChild(sub);

  main.appendChild(textWrap);

  header.appendChild(main);

  // Action buttons container (for interactive cards only)
  if (interactive) {
    const actionsContainer = document.createElement("div");
    actionsContainer.className = "show-actions";

    // Priority/Pin button (star)
    const priorityBtn = document.createElement("button");
    priorityBtn.type = "button";
    priorityBtn.className = "show-priority-btn" + (show.priority ? " active" : "");
    priorityBtn.title = show.priority ? "Unpin from top" : "Pin to top";
    priorityBtn.textContent = "⭐";
    priorityBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      togglePriority(show.id);
    });
    actionsContainer.appendChild(priorityBtn);

    // Watch link button - show + or Play based on whether link exists
    if (show.watchLink) {
      // Play button (has link)
      const playBtn = document.createElement("button");
      playBtn.type = "button";
      playBtn.className = "show-play-btn";
      playBtn.title = "Watch now";
      playBtn.innerHTML = "▶ Watch";
      playBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        openWatchLink(show.watchLink);
      });
      actionsContainer.appendChild(playBtn);

      // Small edit button
      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "show-add-link-btn";
      editBtn.title = "Edit watch link";
      editBtn.textContent = "✎";
      editBtn.style.fontSize = "12px";
      editBtn.style.padding = "4px 6px";
      editBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        showLinkModal(show.id, show.name, show.watchLink);
      });
      actionsContainer.appendChild(editBtn);
    } else {
      // Add link button (+)
      const addLinkBtn = document.createElement("button");
      addLinkBtn.type = "button";
      addLinkBtn.className = "show-add-link-btn";
      addLinkBtn.title = "Add watch link";
      addLinkBtn.textContent = "+";
      addLinkBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        showLinkModal(show.id, show.name, "");
      });
      actionsContainer.appendChild(addLinkBtn);
    }

    // Remove button
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "show-remove";
    removeBtn.title = "Remove from list";
    removeBtn.textContent = "✕";
    removeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      onRemoveShow(show.id);
    });
    actionsContainer.appendChild(removeBtn);

    header.appendChild(actionsContainer);
  }

  // Handle movies differently - show "Not episodic" instead of countdown
  const isMovie = contentType === "movies";
  const meta = document.createElement("div");
  meta.className = "show-countdown";

  const timer = document.createElement("div");
  timer.className = "show-timer";

  if (isMovie) {
    meta.textContent = "Not episodic";
    timer.textContent = "Movies are not episodic content";
    timer.className = "show-timer movie-timer";
  } else {
    const countdownInfo = getCountdownInfo(show.nextEpisode?.airstamp);
    meta.textContent = countdownInfo.label;
    if (show.nextEpisode?.airstamp) {
      timer.dataset.airstamp = show.nextEpisode.airstamp;

      // Add "countdown-soon" class if airing within 24 hours
      if (countdownInfo.mode === "upcoming" && countdownInfo.days === 0) {
        timer.classList.add("countdown-soon");
      }
    }
    updateTimerElement(timer, countdownInfo);
  }

  content.appendChild(header);
  content.appendChild(timer);
  card.appendChild(content);

  if (interactive || clickable) {
    attachDetailsToggle(card, show);
  }

  return card;
}

// Toggle details drawer when clicking the card (ignore action button clicks)
function attachDetailsToggle(card, show) {
  card.addEventListener("click", (e) => {
    const target = e.target;
    // Ignore clicks on action buttons
    if (target instanceof HTMLElement && target.closest(".show-actions")) {
      return;
    }

    // If not in "my-shows" view, add the show instead of showing details
    if (currentView !== "my-shows") {
      addShowFromSearch(show);
      return;
    }

    toggleShowDetails(card, show);
  });
}

function toggleShowDetails(card, show) {
  const existing = card.querySelector(".show-details");
  if (existing) {
    existing.remove();
    return;
  }

  const details = document.createElement("div");
  details.className = "show-details";
  details.textContent = "Loading details…";
  card.appendChild(details);

  populateShowDetails(details, show);
}

async function populateShowDetails(detailsEl, show) {
  const cleanText = (htmlString) => {
    if (typeof htmlString !== "string") return "";
    return htmlString.replace(/<[^>]+>/g, "").trim();
  };

  const fallbackSummary = cleanText(show.summary || "");
  const fallbackGenres = Array.isArray(show.genres) ? show.genres : [];
  const fallbackStatus = show.status || "Unknown";

  // Build a details shell immediately so something shows even if network fails.
  detailsEl.innerHTML = "";

  const summaryLine = document.createElement("div");
  summaryLine.className = "show-details-line";
  const summaryLabel = document.createElement("span");
  summaryLabel.className = "show-details-label";
  summaryLabel.textContent = "Summary";
  const summaryValue = document.createElement("span");
  summaryValue.textContent =
    fallbackSummary.length > 0 ? fallbackSummary : "No summary available.";
  summaryLine.appendChild(summaryLabel);
  summaryLine.appendChild(summaryValue);

  const genresLine = document.createElement("div");
  genresLine.className = "show-details-line";
  const genresLabel = document.createElement("span");
  genresLabel.className = "show-details-label";
  genresLabel.textContent = "Genres";
  const genresValue = document.createElement("span");
  genresValue.textContent =
    fallbackGenres.length > 0 ? fallbackGenres.join(", ") : "Unknown genre";
  genresLine.appendChild(genresLabel);
  genresLine.appendChild(genresValue);

  const statusLine = document.createElement("div");
  statusLine.className = "show-details-line";
  const statusLabel = document.createElement("span");
  statusLabel.className = "show-details-label";
  statusLabel.textContent = "Status";
  const statusValue = document.createElement("span");
  statusValue.textContent = fallbackStatus;
  statusLine.appendChild(statusLabel);
  statusLine.appendChild(statusValue);

  const episodesLine = document.createElement("div");
  episodesLine.className = "show-details-line";
  const episodesLineLabel = document.createElement("span");
  episodesLineLabel.className = "show-details-label";
  episodesLineLabel.textContent = "Episodes";
  const episodesLineValue = document.createElement("span");
  episodesLineValue.textContent = "Loading…";
  episodesLine.appendChild(episodesLineLabel);
  episodesLine.appendChild(episodesLineValue);

  const nextLine = document.createElement("div");
  nextLine.className = "show-details-line";

  const episodesList = document.createElement("div");
  episodesList.className = "episode-list";

  detailsEl.appendChild(summaryLine);
  detailsEl.appendChild(genresLine);
  detailsEl.appendChild(statusLine);
  detailsEl.appendChild(episodesLine);
  detailsEl.appendChild(nextLine);
  detailsEl.appendChild(episodesList);

  try {
    const [showInfo, episodes] = await Promise.all([
      fetchShow(show.id),
      fetchEpisodes(show.id)
    ]);

    const rawSummary =
      (showInfo && typeof showInfo.summary === "string"
        ? showInfo.summary
        : show.summary) || "";
    const cleanSummary = cleanText(rawSummary);
    summaryValue.textContent =
      cleanSummary.length > 0 ? cleanSummary : "No summary available.";

    const genresSource =
      showInfo && Array.isArray(showInfo.genres) && showInfo.genres.length
        ? showInfo.genres
        : Array.isArray(show.genres)
          ? show.genres
          : [];
    genresValue.textContent =
      genresSource && genresSource.length ? genresSource.join(", ") : "Unknown genre";

    statusValue.textContent = showInfo?.status || show.status || "Unknown";

    if (episodes.length) {
      const seasonsSet = new Set();
      episodes.forEach((ep) => {
        if (typeof ep.season === "number") {
          seasonsSet.add(ep.season);
        }
      });
      episodesLineValue.textContent = `${episodes.length} in ${seasonsSet.size} season${seasonsSet.size === 1 ? "" : "s"
        }`;
    } else {
      episodesLineValue.textContent = "Unknown";
    }

    if (show.nextEpisode?.airstamp) {
      const dt = new Date(show.nextEpisode.airstamp);
      const when = dt.toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short"
      });
      nextLine.innerHTML =
        '<span class="show-details-label">Next</span>' +
        `S${show.nextEpisode.season}E${show.nextEpisode.number} \u2022 ${when}`;
    } else {
      nextLine.innerHTML =
        '<span class="show-details-label">Next</span>No upcoming episode';
    }

    episodesList.innerHTML = "";
    const sortedEpisodes = [...episodes].sort((a, b) => {
      const ta = Date.parse(a.airstamp || a.airdate || 0);
      const tb = Date.parse(b.airstamp || b.airdate || 0);
      return tb - ta;
    });
    const episodesToShow = sortedEpisodes.slice(0, 5);
    if (episodesToShow.length) {
      episodesToShow.forEach((ep) => {
        const row = document.createElement("div");
        row.className = "episode-row";
        const code =
          typeof ep.season === "number" && typeof ep.number === "number"
            ? `S${ep.season}E${ep.number}`
            : "";
        const airDate = ep.airdate
          ? ep.airdate
          : ep.airstamp
            ? new Date(ep.airstamp).toLocaleDateString()
            : "";
        const rowTop = document.createElement("div");
        rowTop.className = "episode-meta";
        rowTop.textContent = [code, ep.name, airDate].filter(Boolean).join(" • ");
        const rowSummary = cleanText(ep.summary);
        if (rowSummary) {
          const summaryEl = document.createElement("div");
          summaryEl.className = "episode-summary";
          summaryEl.textContent =
            rowSummary.length > 140 ? `${rowSummary.slice(0, 137)}...` : rowSummary;
          row.appendChild(summaryEl);
        }
        row.prepend(rowTop);
        episodesList.appendChild(row);
      });
    } else {
      const noEpisodes = document.createElement("span");
      noEpisodes.textContent = "No episode list available.";
      episodesList.appendChild(noEpisodes);
    }
  } catch (err) {
    console.error("Failed to load show details", err);
    episodesLineValue.textContent = "Unable to load episodes.";
    episodesList.innerHTML = "";
    const errorMsg = document.createElement("span");
    errorMsg.textContent = "Unable to load details right now.";
    episodesList.appendChild(errorMsg);
  }
}

function sortShows(shows, mode) {
  const copy = [...shows];

  // Always put priority shows first
  copy.sort((a, b) => {
    // Priority shows come first
    if (a.priority && !b.priority) return -1;
    if (!a.priority && b.priority) return 1;

    // Then apply the selected sort mode
    if (mode === "alpha") {
      return a.name.localeCompare(b.name);
    } else {
      // default: soonest next episode first
      const ta = a.nextEpisode?.airstamp ? Date.parse(a.nextEpisode.airstamp) : Infinity;
      const tb = b.nextEpisode?.airstamp ? Date.parse(b.nextEpisode.airstamp) : Infinity;
      return ta - tb;
    }
  });

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
      { key: "days", label: "Days" },
      { key: "hours", label: "Hours" },
      { key: "minutes", label: "Min" },
      { key: "seconds", label: "Sec" }
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

async function searchByGenre(genre, inputEl, resultsEl) {
  inputEl.value = genre;
  resultsEl.textContent = "Searching…";

  try {
    const results = await searchShowsByGenre(genre);
    if (!results.length) {
      resultsEl.textContent = `No ${genre} shows found.`;
      return;
    }

    resultsEl.innerHTML = "";
    results.forEach((show, index) => {
      const item = createSearchResultItem(show, index, inputEl, resultsEl);
      resultsEl.appendChild(item);
    });
  } catch (err) {
    console.error(err);
    resultsEl.textContent = "Offline or TVmaze unavailable.";
  }
}

function createSearchResultItem(show, index, inputEl, resultsEl) {
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

  // Add clickable genres
  if (show.genres && show.genres.length > 0) {
    const genresContainer = document.createElement("div");
    genresContainer.className = "search-result-genres";
    show.genres.forEach((genre) => {
      const genreTag = document.createElement("span");
      genreTag.className = "search-genre-tag";
      genreTag.textContent = genre;
      genreTag.title = `Search for ${genre} shows`;
      genreTag.addEventListener("click", (e) => {
        e.stopPropagation(); // Prevent adding the show when clicking genre
        searchByGenre(genre, inputEl, resultsEl);
      });
      genresContainer.appendChild(genreTag);
    });
    textWrap.appendChild(genresContainer);
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

  return item;
}

async function runSearch(inputEl, resultsEl) {
  const query = inputEl.value;
  resultsEl.textContent = "Searching…";

  try {
    const results = await searchShows(query);
    if (!results.length) {
      resultsEl.textContent = "No results. Try a different search term.";
      return;
    }

    resultsEl.innerHTML = "";
    results.forEach((show, index) => {
      const item = createSearchResultItem(show, index, inputEl, resultsEl);
      resultsEl.appendChild(item);
    });
  } catch (err) {
    console.error(err);
    resultsEl.textContent = "Offline or TVmaze unavailable.";
  }
}

async function addShowFromSearch(showSummary) {
  const stored = await chrome.storage.sync.get("shows");
  const shows = Array.isArray(stored.shows) ? stored.shows : [];
  if (shows.some((s) => s.id === showSummary.id)) {
    const container = document.getElementById("shows-container");
    if (container) {
      renderShows(container, shows, { interactive: true });
    }
    return;
  }

  const contentType = showSummary.contentType || "tv";
  // Preserve nextEpisode from showSummary if it exists (from Airing/Popular views)
  let nextEpisode = showSummary.nextEpisode || null;
  let fetchedAt = null;
  let showInfo = null;
  let genres = Array.isArray(showSummary.genres) ? showSummary.genres : [];
  let status = showSummary.status || null;
  let summary = showSummary.summary || "";
  let image = showSummary.image || null;

  try {
    if (contentType === "anime" && showSummary.malId) {
      // For anime, fetch from Jikan first, then get TVmaze data
      const jikanData = await fetchAnimeDetails(showSummary.malId);
      if (jikanData) {
        genres = jikanData.genres || genres;
        status = jikanData.status || status;
        summary = jikanData.synopsis || summary;
        image = jikanData.image || image;
      }

      // Then get TVmaze data for episodes and countdown
      if (showSummary.id && !showSummary.id.startsWith("wd-") && !showSummary.id.startsWith("jikan-")) {
        const [info, episodes] = await Promise.all([
          fetchShow(showSummary.id),
          fetchEpisodes(showSummary.id)
        ]);
        showInfo = info;
        nextEpisode = computeNextEpisode(episodes);
        fetchedAt = new Date().toISOString();

        if (showInfo) {
          genres = Array.isArray(showInfo.genres) && showInfo.genres.length
            ? showInfo.genres
            : genres;
          status = showInfo.status || status;
          summary = typeof showInfo.summary === "string"
            ? showInfo.summary.replace(/<[^>]+>/g, "")
            : summary;
          const imageFromInfo = showInfo.image && (showInfo.image.medium || showInfo.image.original);
          image = imageFromInfo || image;
        }
      } else {
        fetchedAt = new Date().toISOString();
      }
    } else if (contentType === "tv" && !showSummary.id.startsWith("wd-")) {
      // Fetch TV show details from TVmaze
      const [info, episodes] = await Promise.all([
        fetchShow(showSummary.id),
        fetchEpisodes(showSummary.id)
      ]);
      showInfo = info;
      nextEpisode = computeNextEpisode(episodes);
      fetchedAt = new Date().toISOString();

      if (showInfo) {
        genres = Array.isArray(showInfo.genres) && showInfo.genres.length
          ? showInfo.genres
          : genres;
        status = showInfo.status || status;
        summary = typeof showInfo.summary === "string"
          ? showInfo.summary.replace(/<[^>]+>/g, "")
          : summary;
        const imageFromInfo = showInfo.image && (showInfo.image.medium || showInfo.image.original);
        image = imageFromInfo || image;
      }
    } else if (contentType === "movies") {
      // Movies don't have episodes, just use the summary data
      fetchedAt = new Date().toISOString();
    }
  } catch (err) {
    console.error("Failed to fetch details for new show", err);
  }

  const newShow = {
    id: showSummary.id,
    name: showSummary.name,
    image,
    genres,
    status,
    summary,
    nextEpisode,
    allEpisodesLastFetchedAt: fetchedAt,
    watched: false,
    watchedAt: null,
    contentType: contentType
  };

  const updated = [...shows, newShow];
  await chrome.storage.sync.set({ shows: updated });

  showToast(`Added ${newShow.name} to your shows!`);

  // If we're in my-shows view, refresh it
  if (currentView === "my-shows") {
    const container = document.getElementById("shows-container");
    if (container) {
      renderShows(container, updated, { interactive: true });
    }
  }
}

async function onRemoveShow(showId) {
  const stored = await chrome.storage.sync.get("shows");
  const shows = Array.isArray(stored.shows) ? stored.shows : [];
  const updated = shows.filter((s) => s.id !== showId);
  await chrome.storage.sync.set({ shows: updated });

  const container = document.getElementById("shows-container");
  if (container) {
    renderShows(container, updated, { interactive: true });
  }
}

const JIKAN_BASE_URL = "https://api.jikan.moe/v4";

// Simple rate limiter (3 requests per second)
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 1000 / 3; // ~333ms between requests

async function rateLimitedFetch(url) {
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;
  
  if (timeSinceLastRequest < MIN_REQUEST_INTERVAL) {
    await new Promise(resolve => 
      setTimeout(resolve, MIN_REQUEST_INTERVAL - timeSinceLastRequest)
    );
  }
  
  lastRequestTime = Date.now();
  
  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.error("Jikan API error", response.status);
      return null;
    }
    return await response.json();
  } catch (err) {
    console.error("Jikan fetch error:", err);
    return null;
  }
}

/**
 * Fetch currently airing anime
 * @returns {Promise<Array>} - Array of airing anime
 */
export async function fetchAiringAnime() {
  const data = await rateLimitedFetch(`${JIKAN_BASE_URL}/top/anime?filter=airing&limit=25`);
  if (!data || !data.data) return [];
  
  return data.data.map(anime => ({
    id: `mal-${anime.mal_id}`,
    malId: anime.mal_id,
    name: anime.title,
    nameEnglish: anime.title_english || anime.title,
    genres: anime.genres ? anime.genres.map(g => g.name) : [],
    image: anime.images?.jpg?.large_image_url || anime.images?.jpg?.image_url || null,
    rating: anime.score || null,
    members: anime.members || 0,
    status: anime.status || null,
    synopsis: anime.synopsis ? anime.synopsis.replace(/<[^>]+>/g, "") : "",
    contentType: "anime",
    airing: true
  }));
}

/**
 * Fetch popular anime by genre
 * @param {string} genre - Genre name (will be normalized)
 * @returns {Promise<Array>} - Array of popular anime
 */
export async function fetchPopularAnime(genre) {
  // First, get genre ID from Jikan
  const genreId = await getGenreId(genre);
  if (!genreId) {
    // Fallback: search by query
    return searchAnimeByGenre(genre);
  }
  
  const data = await rateLimitedFetch(
    `${JIKAN_BASE_URL}/anime?genres=${genreId}&order_by=score&sort=desc&limit=20`
  );
  
  if (!data || !data.data) return [];
  
  return data.data.map(anime => ({
    id: `mal-${anime.mal_id}`,
    malId: anime.mal_id,
    name: anime.title,
    nameEnglish: anime.title_english || anime.title,
    genres: anime.genres ? anime.genres.map(g => g.name) : [],
    image: anime.images?.jpg?.large_image_url || anime.images?.jpg?.image_url || null,
    rating: anime.score || null,
    members: anime.members || 0,
    status: anime.status || null,
    synopsis: anime.synopsis ? anime.synopsis.replace(/<[^>]+>/g, "") : "",
    contentType: "anime",
    airing: anime.status === "Currently Airing"
  }));
}

/**
 * Search anime by genre
 * @param {string} genre - Genre name
 * @returns {Promise<Array>} - Search results
 */
export async function searchAnimeByGenre(genre) {
  // Search and filter by genre
  const data = await rateLimitedFetch(
    `${JIKAN_BASE_URL}/anime?q=${encodeURIComponent(genre)}&order_by=score&sort=desc&limit=20`
  );
  
  if (!data || !data.data) return [];
  
  const genreLower = genre.toLowerCase();
  
  return data.data
    .filter(anime => {
      const genres = anime.genres ? anime.genres.map(g => g.name.toLowerCase()) : [];
      return genres.some(g => g.includes(genreLower) || genreLower.includes(g));
    })
    .map(anime => ({
      id: `mal-${anime.mal_id}`,
      malId: anime.mal_id,
      name: anime.title,
      nameEnglish: anime.title_english || anime.title,
      genres: anime.genres ? anime.genres.map(g => g.name) : [],
      image: anime.images?.jpg?.large_image_url || anime.images?.jpg?.image_url || null,
      rating: anime.score || null,
      members: anime.members || 0,
      status: anime.status || null,
      synopsis: anime.synopsis ? anime.synopsis.replace(/<[^>]+>/g, "") : "",
      contentType: "anime",
      airing: anime.status === "Currently Airing"
    }));
}

/**
 * Get anime details by MAL ID
 * @param {number} malId - MyAnimeList ID
 * @returns {Promise<Object|null>} - Anime details
 */
export async function fetchAnimeDetails(malId) {
  const data = await rateLimitedFetch(`${JIKAN_BASE_URL}/anime/${malId}`);
  if (!data || !data.data) return null;
  
  const anime = data.data;
  return {
    id: `mal-${anime.mal_id}`,
    malId: anime.mal_id,
    name: anime.title,
    nameEnglish: anime.title_english || anime.title,
    genres: anime.genres ? anime.genres.map(g => g.name) : [],
    image: anime.images?.jpg?.large_image_url || anime.images?.jpg?.image_url || null,
    rating: anime.score || null,
    members: anime.members || 0,
    status: anime.status || null,
    synopsis: anime.synopsis ? anime.synopsis.replace(/<[^>]+>/g, "") : "",
    contentType: "anime",
    airing: anime.status === "Currently Airing",
    episodes: anime.episodes || null,
    aired: anime.aired?.string || null
  };
}

/**
 * Get genre ID from Jikan (cached)
 */
let genreCache = null;

async function getGenreId(genre) {
  if (!genreCache) {
    const data = await rateLimitedFetch(`${JIKAN_BASE_URL}/genres/anime`);
    if (data && data.data) {
      genreCache = {};
      data.data.forEach(g => {
        genreCache[g.name.toLowerCase()] = g.mal_id;
      });
    }
  }
  
  if (!genreCache) return null;
  
  const genreLower = genre.toLowerCase();
  return genreCache[genreLower] || null;
}

/**
 * Get all anime genres from Jikan
 * @returns {Promise<Array>} - Array of genre names
 */
export async function getAnimeGenres() {
  const data = await rateLimitedFetch(`${JIKAN_BASE_URL}/genres/anime`);
  if (!data || !data.data) return [];
  
  return data.data.map(g => g.name);
}


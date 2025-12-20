const JIKAN_BASE_URL = "https://api.jikan.moe/v4";

// Simple rate limiting for Jikan API (3 requests/second)
let lastRequestTime = 0;
const REQUEST_INTERVAL = 350; // ms

async function rateLimitedFetch(url) {
  const now = Date.now();
  if (now - lastRequestTime < REQUEST_INTERVAL) {
    await new Promise(resolve => setTimeout(resolve, REQUEST_INTERVAL - (now - lastRequestTime)));
  }
  lastRequestTime = Date.now();

  const res = await fetch(url);
  if (!res.ok) {
    console.error(`Jikan API error for ${url}: ${res.status} ${res.statusText}`);
    throw new Error(`Jikan API error: ${res.statusText}`);
  }
  return res.json();
}

/**
 * Fetch currently airing anime
 * @returns {Promise<Array>} - Array of airing anime
 */
export async function fetchAiringAnime() {
  try {
    const data = await rateLimitedFetch(`${JIKAN_BASE_URL}/top/anime?filter=airing&limit=20`);
    if (!data || !data.data) return [];
    
    return data.data.map(anime => ({
      id: `jikan-${anime.mal_id}`,
      name: anime.title,
      nameEnglish: anime.title_english || anime.title,
      genres: anime.genres ? anime.genres.map(g => g.name) : [],
      status: anime.status,
      summary: anime.synopsis ? anime.synopsis.replace(/<[^>]+>/g, "") : "",
      image: anime.images?.webp?.image_url || anime.images?.jpg?.image_url || null,
      rating: anime.score || null,
      malId: anime.mal_id,
      contentType: "anime",
      airing: anime.status === "Currently Airing"
    }));
  } catch (err) {
    console.error("Error fetching airing anime:", err);
    return [];
  }
}

/**
 * Fetch popular anime
 * @param {string} genre - Optional genre filter
 * @returns {Promise<Array>} - Array of popular anime
 */
export async function fetchPopularAnime(genre = null) {
  try {
    let url = `${JIKAN_BASE_URL}/top/anime?filter=bypopularity&limit=20`;
    if (genre) {
      // Search by genre name
      url = `${JIKAN_BASE_URL}/anime?q=${encodeURIComponent(genre)}&order_by=members&sort=desc&limit=20`;
    }
    
    const data = await rateLimitedFetch(url);
    if (!data || !data.data) return [];
    
    let animeResults = data.data.map(anime => ({
      id: `jikan-${anime.mal_id}`,
      name: anime.title,
      nameEnglish: anime.title_english || anime.title,
      genres: anime.genres ? anime.genres.map(g => g.name) : [],
      status: anime.status,
      summary: anime.synopsis ? anime.synopsis.replace(/<[^>]+>/g, "") : "",
      image: anime.images?.webp?.image_url || anime.images?.jpg?.image_url || null,
      rating: anime.score || null,
      malId: anime.mal_id,
      contentType: "anime",
      members: anime.members || 0
    }));

    if (genre) {
      const genreLower = genre.toLowerCase();
      animeResults = animeResults.filter(anime => 
        anime.genres.some(g => g.toLowerCase().includes(genreLower))
      );
    }

    return animeResults.slice(0, 20);
  } catch (err) {
    console.error("Error fetching popular anime:", err);
    return [];
  }
}

/**
 * Get anime details by MAL ID
 * @param {number} malId - MyAnimeList ID
 * @returns {Promise<Object|null>} - Anime details
 */
export async function fetchAnimeDetails(malId) {
  try {
    const data = await rateLimitedFetch(`${JIKAN_BASE_URL}/anime/${malId}`);
    if (!data || !data.data) return null;
    
    const anime = data.data;
    return {
      id: `jikan-${anime.mal_id}`,
      malId: anime.mal_id,
      name: anime.title,
      nameEnglish: anime.title_english || anime.title,
      genres: anime.genres ? anime.genres.map(g => g.name) : [],
      image: anime.images?.webp?.image_url || anime.images?.jpg?.image_url || null,
      rating: anime.score || null,
      members: anime.members || 0,
      status: anime.status || null,
      synopsis: anime.synopsis ? anime.synopsis.replace(/<[^>]+>/g, "") : "",
      contentType: "anime",
      airing: anime.status === "Currently Airing",
      episodes: anime.episodes || null,
      aired: anime.aired?.string || null
    };
  } catch (err) {
    console.error(`Error fetching anime details for MAL ID ${malId}:`, err);
    return null;
  }
}





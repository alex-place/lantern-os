// Reply post-processing for stream-chat: strip local-model artifacts, extract the
// hidden [DOORS: …] marker (Three Doors RP surface), and produce the final
// cleanText + suggestions. Also the web-search suggestion link generator.
const { saveDoorChoice } = require("../csf-memory");

// Fallback doors when the model omits the marker or the provider fails.
const FALLBACK_DOORS = ["Tell me more about that", "What happened next?", "How are you feeling about it?"];

// Parse [DOORS: A | B | C] out of the full reply and return cleaned text + doors.
// Local models sometimes use commas instead of pipes — fall back gracefully.
function extractDoors(text) {
  const match = text.match(/\[DOORS:\s*([^\]]+)\]?/i);
  if (!match) return { cleanText: text.trim(), doors: [] };
  let doors = match[1].split("|").map((d) => d.trim()).filter(Boolean).slice(0, 3);
  // Fallback: if pipe-split didn't produce 3 doors, try comma-before-capital split
  if (doors.length < 3) {
    const commaSplit = match[1].split(/,\s*(?=[A-Z])/).map((d) => d.trim()).filter(Boolean).slice(0, 3);
    if (commaSplit.length > doors.length) doors = commaSplit;
  }
  const cleanText = text.replace(/\[DOORS:[^\]]*\]?/i, "").replace(/\n{3,}/g, "\n\n").trim();
  return { cleanText, doors };
}

// Cut a local model's output at the first instruction-template echo or new-turn
// marker it appends AFTER answering (### Response:, <|im_end|>, "\n\nUser:", …).
// These are turn/template boundaries, never legitimate content; cloud models don't
// emit them, so this is a no-op for Claude/Gemini/GPT.
function stripModelArtifacts(text) {
  if (!text || typeof text !== "string") return text;
  const m = text.match(/\n*#{2,}\s*(?:response|instruction)\b|<\|(?:im_end|im_start|endoftext|eot_id)\|>|\n\n+\s*(?:user|human|assistant|question|system)\s*:/i);
  return (m && m.index > 0) ? text.slice(0, m.index).trimEnd() : text;
}

function doorsOrFallback(text, skipDoors = false) {
  text = stripModelArtifacts(text);
  if (skipDoors) return { cleanText: text.trim(), suggestions: [] };
  const { cleanText, doors } = extractDoors(text);
  // Always return exactly 3 suggestions. Pad with fallbacks if model gave fewer.
  let finalDoors;
  if (doors.length >= 3) {
    finalDoors = doors.slice(0, 3);
  } else if (doors.length > 0) {
    finalDoors = [...doors, ...FALLBACK_DOORS].slice(0, 3);
  } else {
    finalDoors = FALLBACK_DOORS;
  }
  if (doors.length > 0) {
    try { saveDoorChoice(null, finalDoors); } catch {}
  }
  return { cleanText, suggestions: finalDoors };
}

// Extract key topics from a user message → 3 web-search suggestion links.
function generateWebSuggestions(userMessage) {
  const topicPatterns = {
    sports: /\b(basketball|football|baseball|soccer|hockey|tennis|golf|cricket|boxing)s?\b/i,
    trains: /\b(trains?|railways?|locomotives?|stations?|transit|rails?)\b/i,
    recipes: /\b(recipes?|cooking|cook|meals?|dishes?|foods?|ingredients?)\b/i,
    movies: /\b(movies?|films?|cinemas?|watch|actors?|actresses?|directors?)\b/i,
    music: /\b(musics?|songs?|albums?|artists?|concerts?|bands?|genres?)\b/i,
    tech: /\b(technology|software|hardware|ai|code|programming|apps?)\b/i,
    travel: /\b(travels?|trips?|destinations?|vacations?|hotels?|flights?|tours?)\b/i,
    science: /\b(science|research|studies?|discoveries?|experiments?|biology|physics)\b/i,
    news: /\b(news|current|todays?|today's|latest|breaking)\b/i,
    health: /\b(health|fitness|diets?|exercises?|wellness|nutrition)\b/i,
  };

  let matchedTopics = [];
  for (const [topic, pattern] of Object.entries(topicPatterns)) {
    if (pattern.test(userMessage)) matchedTopics.push(topic);
  }

  // If no patterns match, extract first meaningful word
  if (matchedTopics.length === 0) {
    const words = userMessage.split(/\s+/).filter((w) => w.length > 4 && !/^(what|when|where|which|how|about)$/i.test(w));
    if (words.length > 0) matchedTopics.push(words[0].toLowerCase());
  }

  const topicLabel = matchedTopics[0] || "interesting topics";

  return [
    { label: "Explore on Google", url: `https://www.google.com/search?q=${encodeURIComponent(topicLabel)}`, icon: "🔍" },
    { label: "Latest on Wikipedia", url: `https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(topicLabel)}&title=Special:Search`, icon: "📖" },
    { label: "News & Articles", url: `https://news.google.com/search?q=${encodeURIComponent(topicLabel)}`, icon: "📰" },
  ];
}

module.exports = { FALLBACK_DOORS, extractDoors, stripModelArtifacts, doorsOrFallback, generateWebSuggestions };

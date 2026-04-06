#!/usr/bin/env node
/**
 * FlashParty AI Party Generator
 * ─────────────────────────────
 * Automatically creates a themed party on FlashParty.co every night with
 * 25 AI-generated photos — SFW and NSFW — uploaded as guests arrive.
 *
 * Stack:
 *   - Claude (Anthropic) — theme + caption generation
 *   - PartyLab (xAI / Grok) — AI image generation
 *   - FlashParty API — party creation and photo upload
 *
 * Setup: see README.md
 * License: MIT
 */

require('dotenv').config();

const https  = require('https');
const http   = require('http');
const fs     = require('fs');
const path   = require('path');

// ─── Validate required environment variables ──────────────────────────────────
const REQUIRED_ENV = ['FLASHPARTY_API_KEY', 'PARTYLAB_API_KEY', 'ANTHROPIC_API_KEY'];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) {
  console.error(`Missing required environment variables: ${missing.join(', ')}`);
  console.error('Copy .env.example to .env and fill in your API keys.');
  process.exit(1);
}

// ─── Configuration ────────────────────────────────────────────────────────────
// Everything you'd want to tweak lives here.
const CONFIG = {
  partylab: {
    apiKey:  process.env.PARTYLAB_API_KEY,
    baseUrl: 'https://api.partylab.dev'
  },
  flashparty: {
    apiKey:     process.env.FLASHPARTY_API_KEY,
    baseUrl:    'https://api.flashparty.co/v1',
    webBaseUrl: 'https://flashparty.co'
  },
  claude: {
    apiKey:  process.env.ANTHROPIC_API_KEY,
    baseUrl: 'https://api.anthropic.com',
    model:   'claude-haiku-4-5-20251001'   // Haiku is fast and cheap — perfect for this
  },
  party: {
    totalImages:     25,    // Images per party (NSFW count is determined by theme level)
    durationHours:   5,     // How long each party runs
    premiumPassPrice: 5,    // USD price to unlock NSFW content
    pollIntervalMs:  8000,  // How often to check PartyLab for completed images
    pollTimeoutMs:   600000 // 10 minutes max wait for image generation
  },
  uploader: {
    // Change this to your brand name — shows up as the photo uploader
    nickname: process.env.UPLOADER_NICKNAME || 'Party Bot'
  },
  retry: {
    maxAttempts: 3,
    delayMs:     5000
  }
};

// ─── Theme History ────────────────────────────────────────────────────────────
// Tracks previously generated themes so the AI doesn't repeat itself.
const USED_THEMES_FILE = path.join(__dirname, 'logs', 'used-themes.json');

function readUsedThemes(limit = 30) {
  try {
    const raw = fs.readFileSync(USED_THEMES_FILE, 'utf8');
    const all = JSON.parse(raw);
    return Array.isArray(all) ? all.slice(-limit) : [];
  } catch {
    return [];
  }
}

function saveUsedTheme(themeName) {
  try {
    const all = readUsedThemes(90);
    all.push(themeName);
    fs.mkdirSync(path.dirname(USED_THEMES_FILE), { recursive: true });
    fs.writeFileSync(USED_THEMES_FILE, JSON.stringify(all, null, 2));
  } catch (err) {
    console.warn(`  Could not save theme history: ${err.message}`);
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────
async function makeRequest(url, options = {}, retryCount = 0) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const req = client.request(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', async (err) => {
      if (retryCount < CONFIG.retry.maxAttempts) {
        console.log(`  Retry ${retryCount + 1}/${CONFIG.retry.maxAttempts}...`);
        await sleep(CONFIG.retry.delayMs);
        try { resolve(await makeRequest(url, options, retryCount + 1)); }
        catch (e) { reject(e); }
      } else { reject(err); }
    });
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function downloadImage(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const req = client.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Download failed: ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const mimeType = url.endsWith('.png') ? 'image/png' : 'image/jpeg';
        resolve(`data:${mimeType};base64,${buffer.toString('base64')}`);
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Image download timeout')); });
  });
}

// ─── AI Theme Generation ──────────────────────────────────────────────────────
/**
 * Calls Claude to generate a fresh party theme based on today's date,
 * season, upcoming holidays, and a list of recently used themes to avoid.
 *
 * Returns: { name, promptPrefix, nsfwLevel (0–3), tags }
 */
async function generateThemeWithAI() {
  const now     = new Date();
  const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const month   = now.getMonth() + 1;

  const holidays = [
    { month: 1,  day: 1,  name: "New Year's Day" },
    { month: 2,  day: 14, name: "Valentine's Day" },
    { month: 3,  day: 17, name: "St. Patrick's Day" },
    { month: 4,  day: 1,  name: "April Fools' Day" },
    { month: 5,  day: 5,  name: "Cinco de Mayo" },
    { month: 7,  day: 4,  name: "Fourth of July" },
    { month: 10, day: 31, name: "Halloween" },
    { month: 11, day: 27, name: "Thanksgiving" },
    { month: 12, day: 24, name: "Christmas Eve" },
    { month: 12, day: 31, name: "New Year's Eve" }
  ];

  const upcoming = holidays
    .map(h => {
      const hDate = new Date(now.getFullYear(), h.month - 1, h.day);
      if (hDate < now) hDate.setFullYear(now.getFullYear() + 1);
      const daysAway = Math.ceil((hDate - now) / 86400000);
      return { ...h, daysAway };
    })
    .filter(h => h.daysAway <= 14)
    .map(h => `${h.name} (${h.daysAway} day${h.daysAway === 1 ? '' : 's'} away)`);

  const seasons = ['winter','winter','spring','spring','spring','summer','summer','summer','fall','fall','fall','winter'];
  const season  = seasons[month - 1];

  const recentThemes = readUsedThemes(30);
  const exclusionLine = recentThemes.length > 0
    ? `\nDo NOT use any of these recently used themes:\n${recentThemes.map(t => `- ${t}`).join('\n')}\n`
    : '';

  const prompt = `You generate creative party themes for an AI social platform that hosts themed party content.

Today is ${dateStr}. Season: ${season}.${upcoming.length ? `\nUpcoming holidays/events: ${upcoming.join(', ')}.` : ''}
${exclusionLine}
Generate ONE party theme for tonight. Be creative and specific — tie to the season or holidays when relevant. Mix in adult-oriented themes occasionally.

Respond with ONLY valid JSON in this exact format:
{
  "name": "Theme Name",
  "promptPrefix": "vivid scene-setting description for AI image generation, 15-25 words",
  "nsfwLevel": 0,
  "tags": ["Tag1", "Tag2"]
}

nsfwLevel guide:
0 = no nudity (daytime, outdoor, casual)
1 = mildly suggestive (cocktail parties, speakeasies)
2 = moderately NSFW (nightclubs, pool parties, masquerades)
3 = explicitly adult (lingerie parties, nudity-themed events)

Only output the JSON object, nothing else.`;

  const res = await makeRequest(
    `${CONFIG.claude.baseUrl}/v1/messages`,
    {
      method: 'POST',
      headers: {
        'x-api-key': CONFIG.claude.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: CONFIG.claude.model,
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }]
      })
    }
  );

  if (res.status !== 200) throw new Error(`Claude API error (${res.status}): ${JSON.stringify(res.data)}`);

  const raw   = res.data.content[0].text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const theme = JSON.parse(raw);

  if (!theme.name || !theme.promptPrefix || theme.nsfwLevel === undefined) {
    throw new Error(`Invalid theme response: ${raw}`);
  }

  theme.tags = theme.tags || ['Party', theme.name];
  return theme;
}

// Hardcoded fallback themes used if the Claude API call fails
function generateThemeFallback() {
  const themes = [
    { name: 'Friday Night Lights',  promptPrefix: 'glamorous nightclub, dramatic spotlights, upscale crowd in evening wear',                    nsfwLevel: 2 },
    { name: 'Saturday Night Fever', promptPrefix: 'retro disco dance party, glitter ball spinning, funky fashion and big hair',                  nsfwLevel: 2 },
    { name: 'Rooftop Sunset Soirée',promptPrefix: 'chic rooftop gathering, city skyline at golden hour, cocktails and conversation',             nsfwLevel: 1 },
    { name: 'Neon Nights',          promptPrefix: 'glow-in-the-dark rave, electric neon colors, UV light, EDM energy',                          nsfwLevel: 2 },
    { name: 'Masquerade Ball',      promptPrefix: 'mysterious masquerade ball, opulent ballroom, ornate masks and silk gowns',                   nsfwLevel: 2 },
    { name: 'Tropical Luau',        promptPrefix: 'Hawaiian luau on the beach, tiki torches, tropical flowers, ocean backdrop',                  nsfwLevel: 0 },
    { name: 'Roaring 20s Speakeasy',promptPrefix: 'vintage 1920s speakeasy, live jazz, art deco interiors, flapper fashion',                    nsfwLevel: 1 },
    { name: 'Pool Party Paradise',  promptPrefix: 'luxury rooftop pool party, sunny summer vibes, cabanas, tropical cocktails, swimwear',       nsfwLevel: 2 },
    { name: 'Lingerie Party',       promptPrefix: 'upscale lingerie party, guests in silk and lace, boudoir lighting, intimate atmosphere',      nsfwLevel: 3 },
    { name: 'After Dark Club',      promptPrefix: 'exclusive members-only after-dark club, velvet ropes, dark corners, charged energy',          nsfwLevel: 3 }
  ];
  const theme = pick(themes);
  return { ...theme, tags: ['Party', theme.name] };
}

// ─── Character Generation ─────────────────────────────────────────────────────
// Characters give the AI image generator named subjects to feature consistently.
const CHARACTER_NAMES = [
  'Alex', 'Jordan', 'Morgan', 'Taylor', 'Casey', 'Riley',
  'Quinn', 'Avery', 'Blake', 'Cameron', 'Dakota', 'Emery'
];

const CHARACTER_TYPES = [
  'confident party host', 'mysterious stranger', 'life of the party',
  'flirtatious socialite', 'artsy creative type', 'charming bartender',
  'carefree dancer', 'cool DJ spinning tracks'
];

function generateCharacters(theme, count) {
  const names = [...CHARACTER_NAMES].sort(() => Math.random() - 0.5);
  return Array.from({ length: count }, (_, i) => ({
    name: names[i],
    description: `${pick(CHARACTER_TYPES)} at a ${theme.name} party`
  }));
}

// ─── Scene Building ───────────────────────────────────────────────────────────

// Eight photographic styles assigned per-scene — gives the party a "multiple
// photographers on different devices" feel instead of one uniform look.
const CAMERA_STYLES = [
  { name: 'DSLR Candid',           descriptors: 'shot on Sony Alpha A7R V with 85mm f/1.4 lens, shallow depth of field, creamy bokeh, natural ambient lighting, candid documentary photography' },
  { name: 'Film Photography',       descriptors: 'shot on 35mm Kodak Portra 400 film, warm golden tones, organic film grain, slight halation, soft contrast, nostalgic analog texture' },
  { name: 'Editorial Night',        descriptors: 'shot on Canon EOS R5 with 35mm f/1.2 lens, dramatic neon and practical light, vivid color contrast, intentional grain, moody shadows, editorial quality' },
  { name: 'Flash Party Cam',        descriptors: 'disposable camera aesthetic, direct on-camera flash, overexposed highlights, red-eye effect, gritty raw party energy, Fujifilm disposable lo-fi' },
  { name: 'Cinematic Telephoto',    descriptors: 'shot on Leica SL2 with 90mm Summicron APO lens, cinematic teal and orange color grade, extreme subject isolation, buttery bokeh, Hollywood quality' },
  { name: 'iPhone Snap',            descriptors: 'casual iPhone 15 Pro photo, Portrait mode, vivid saturation, natural party lighting, authentic spontaneous feel, high dynamic range' },
  { name: 'Android Night Mode',     descriptors: 'Google Pixel 8 night mode, computational photography, excellent low-light brightness, vivid colors, warm skin tones, authentic smartphone shot' },
  { name: 'Vintage Point-and-Shoot',descriptors: 'Y2K-era Canon PowerShot point-and-shoot, washed-out colors, lens distortion at edges, direct flash, early-2000s party photo aesthetic' }
];

// Framing and angle variety — one assigned per image
const SHOT_TYPES = [
  'wide establishing shot of the full venue and crowd',
  'tight close-up portrait, face filling the frame',
  'medium shot from the waist up',
  'over-the-shoulder candid, subject unaware of camera',
  'low angle looking up at the subjects',
  'high angle bird\'s-eye view looking down at the crowd',
  'shot from behind, looking over shoulder into the party',
  'mid-distance candid with blurred background',
  'extreme wide shot, tiny figures against the venue',
  'close-up on hands, glasses, or faces in animated conversation'
];

// Subject count — explicit count stops the AI defaulting to 2–3 every time
const SUBJECT_COUNTS = [
  'just one person alone in the frame',
  'two people together',
  'three friends',
  'a small group of four or five people',
  'a large group of seven or more',
  'a packed crowd filling the entire frame'
];

// Shot types biased toward intimacy for NSFW images
const NSFW_SHOT_TYPES = [
  'intimate close-up, faces and torsos filling the frame',
  'tight medium shot from the waist up',
  'low angle candid, caught in the moment',
  'shallow depth-of-field close-up, background blurred away',
  'voyeuristic mid-distance candid, slightly zoomed in'
];

// ── NSFW prompts ──────────────────────────────────────────────────────────────
// All prompts clearly contain adult content so premium unlocks feel worth it.
// Adjust or replace these to match your platform's content policy.
const NSFW_PROMPTS = [
  'woman confidently topless at the party, bare breasts fully visible, surrounded by partygoers, glamorous party lighting, unapologetic and sensual, R-rated nudity',
  'topless woman, bare breasts on full display, laughing and carefree, candid party moment, artistic nudity',
  'couple making out, her shirt removed, bare breasts pressed against his chest, hands roaming, breathless and urgent, explicit R-rated intimacy',
  'woman playfully flashing, lifting her top to reveal bare breasts, laughing and uninhibited, crowd reacting, spontaneous party nudity',
  'two people in foreplay, both partially undressed, bare breasts visible, hands exploring skin, suggestive and erotic, steamy R-rated scene',
  'topless woman straddling her partner on a couch, bare breasts exposed, both disheveled and breathless, R-rated party romance',
  'woman dancing topless, arms raised, bare breasts on full show, uninhibited and joyful, crowd around her, electric party energy',
  'two women kissing passionately, both topless, bare breasts touching, tender and sensual, intimate R-rated moment'
];

// Returns a random NSFW image count for the given level
function nsfwCountForLevel(level) {
  const ranges = { 0: [0,0], 1: [2,4], 2: [5,9], 3: [10,17] };
  const [min, max] = ranges[level] || [0, 0];
  return min + Math.floor(Math.random() * (max - min + 1));
}

// NSFW scene name prefix — used when uploading to flag images as premium
const NSFW_SCENE_PREFIX = 'After Dark';

// Scene templates with weights — higher weight = more images allocated
const SFW_TEMPLATES = [
  { name: 'Dance Floor',    prompt: 'dancing freely and having the time of their lives',         weight: 4,   useCharacters: true  },
  { name: 'Candid Moments', prompt: 'candid moments, genuine laughter and real connection',       weight: 3,   useCharacters: true  },
  { name: 'At the Bar',     prompt: 'mingling at the bar, raising glasses in a toast, laughing', weight: 2,   useCharacters: true  },
  { name: 'Arrivals',       prompt: 'arriving and greeting each other with excitement',            weight: 1,   useCharacters: true  },
  {
    name: 'Selfie',
    prompt: 'selfie, front-facing camera, smiling and laughing directly into the lens, arm extended',
    weight: 1,
    useCharacters: true,
    cameraOverride: 'iPhone 15 Pro selfie camera, wide-angle front-facing lens, faces close to camera, authentic smartphone selfie'
  },
  {
    name: 'Atmosphere',
    prompt: 'close-up detail shot — cocktails, neon lights, DJ equipment, confetti — no people, purely atmospheric',
    weight: 0.5,
    useCharacters: false
  }
];

/**
 * Builds the scene list for a party.
 * Each image gets its own scene entry (count: 1) with independently randomised
 * shot type, subject count, and camera style — so no two images look the same.
 * NSFW scenes are interleaved throughout rather than clustered at the end.
 */
function generateScenes(theme, characters, sfwCount, nsfwCount) {
  const totalWeight = SFW_TEMPLATES.reduce((sum, t) => sum + t.weight, 0);
  const pool = [];
  SFW_TEMPLATES.forEach((t, i) => {
    const slots = Math.max(1, Math.round((t.weight / totalWeight) * sfwCount));
    for (let j = 0; j < slots; j++) pool.push(i);
  });
  while (pool.length < sfwCount) pool.push(0);
  pool.splice(sfwCount);
  pool.sort(() => Math.random() - 0.5);

  const sfwScenes = pool.map(idx => {
    const template   = SFW_TEMPLATES[idx];
    const cam        = template.cameraOverride ? { descriptors: template.cameraOverride } : pick(CAMERA_STYLES);
    const shotType   = pick(SHOT_TYPES);
    const subjectLine = template.useCharacters ? `, ${pick(SUBJECT_COUNTS)}` : '';
    return {
      name:       template.name,
      prompt:     `${template.prompt}${subjectLine}, ${shotType}, ${cam.descriptors}`,
      characters: template.useCharacters ? characters.map(c => c.name) : [],
      count:      1
    };
  });

  const nsfwScenes = [];
  if (nsfwCount > 0) {
    const shuffled = [...NSFW_PROMPTS].sort(() => Math.random() - 0.5);
    for (let i = 0; i < nsfwCount; i++) {
      nsfwScenes.push({
        name:       `${NSFW_SCENE_PREFIX} ${i + 1}`,
        prompt:     `${shuffled[i % shuffled.length]}, ${pick(NSFW_SHOT_TYPES)}, ${pick(CAMERA_STYLES).descriptors}`,
        characters: characters.map(c => c.name),
        count:      1
      });
    }
  }

  // Interleave NSFW scenes at evenly-spaced positions
  const scenes = [...sfwScenes];
  if (nsfwScenes.length > 0) {
    const step = scenes.length / (nsfwScenes.length + 1);
    nsfwScenes.forEach((scene, idx) => {
      scenes.splice(Math.round(step * (idx + 1)) + idx, 0, scene);
    });
  }

  return scenes;
}

// ─── Caption Generation ───────────────────────────────────────────────────────

// Static fallback pool — used if the AI caption call fails
function generateCaption(isNsfw, sceneName) {
  if (isNsfw) {
    return pick(['After hours, different rules', 'Not for everyone\'s feed', 'Things got interesting',
      'The night went somewhere good', 'Premium content, for a reason', 'You had to be there',
      'Some things stay between us', 'The real party started late']);
  }
  const byScene = {
    'Dance Floor':    ['Lost in the music right now', 'This is why we came out', 'The floor is ours tonight',
                       'Nobody leaves until this song ends', 'Moving like nobody\'s watching', 'Can\'t stop, won\'t stop'],
    'At the Bar':     ['Round two, obviously', 'One more never hurt anyone', 'Cheers to a night like this',
                       'The bartender knows our names now', 'Another round, another memory'],
    'Arrivals':       ['We have arrived', 'The night officially starts now', 'Fashionably late, obviously',
                       'The party can start now', 'Made our entrance'],
    'Candid Moments': ['Caught in the middle of everything', 'Not posed, just real', 'These are my people',
                       'Some nights you just feel it', 'Right place, right time', 'This moment found us'],
    'Selfie':         ['Had to document this one', 'We look too good not to', 'For the memories, obviously',
                       'Proof we were here', 'This night deserved a photo'],
    'Atmosphere':     ['The vibe was already set', 'Every detail, perfect', 'Before the chaos, the calm',
                       'Set the scene', 'The room did all the work']
  };
  return pick(byScene[sceneName] || ['Caught in the moment', 'Right place, right time', 'One of those nights']);
}

/**
 * Generates all captions in a single Claude API call.
 * Haiku sees the full scene list and produces unique, contextual captions
 * for every image in one shot — cost is negligible (<$0.01 per party).
 */
async function generateCaptionsWithAI(scenes, themeName) {
  const sceneList = scenes.map((s, i) =>
    `${i + 1}. [${s.name}] ${s.prompt.split(',')[0].trim()}`
  ).join('\n');

  const prompt = `You write short, punchy captions for AI-generated party photos posted to a social platform.

Party theme: "${themeName}"
Number of images: ${scenes.length}

Scenes in order:
${sceneList}

Write exactly ${scenes.length} captions — one per scene, in the same order.
Rules:
- Under 10 words each
- No hashtags, no emojis
- Casual and authentic, like a real partygoer posted it
- Vary the tone: some playful, some dry, some heartfelt
- Reference the scene or theme where it feels natural
- No two captions should be the same or feel similar
- NSFW scenes ("After Dark") should feel teasing and exclusive, not explicit

Respond with ONLY a valid JSON array of strings. No explanation, no markdown.
Example: ["caption one", "caption two"]`;

  const res = await makeRequest(
    `${CONFIG.claude.baseUrl}/v1/messages`,
    {
      method: 'POST',
      headers: {
        'x-api-key': CONFIG.claude.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({ model: CONFIG.claude.model, max_tokens: 800, messages: [{ role: 'user', content: prompt }] })
    }
  );

  if (res.status !== 200) throw new Error(`Claude API error (${res.status})`);

  const raw      = res.data.content[0].text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const captions = JSON.parse(raw);

  if (!Array.isArray(captions) || captions.length < scenes.length) {
    throw new Error(`Expected ${scenes.length} captions, got ${captions.length}`);
  }

  return captions.slice(0, scenes.length);
}

// ─── FlashParty API ───────────────────────────────────────────────────────────
function generateDescription(themeName) {
  return pick([
    `The ${themeName} you didn't know you needed. Come for the vibes, stay for the memories.`,
    `Tonight's forecast: 100% chance of good times. Dress to impress and prepare for a night you won't forget.`,
    `Where strangers become friends and friends become closer. The music's loud, the drinks are cold, and the night is yours.`
  ]);
}

async function createFlashParty(theme) {
  const startTime = new Date();
  const endTime   = new Date(startTime.getTime() + CONFIG.party.durationHours * 3600000);

  const res = await makeRequest(
    `${CONFIG.flashparty.baseUrl}/parties`,
    {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${CONFIG.flashparty.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        party_name:        theme.name,
        unique_party_slug: `${slugify(theme.name)}-${Date.now().toString(36)}`.slice(0, 64),
        description:       generateDescription(theme.name),
        start_time:        startTime.toISOString(),
        end_time:          endTime.toISOString(),
        visibility:        'public',
        allow_ai_guests:   true,
        allow_nsfw:        true,
        premium_pass_price: CONFIG.party.premiumPassPrice
      })
    }
  );

  if (res.status === 200 || res.status === 201) {
    return { id: res.data.id || res.data.party_id, slug: res.data.unique_party_slug };
  }
  throw new Error(`Failed to create FlashParty: ${JSON.stringify(res.data)}`);
}

async function uploadToFlashParty(partyId, base64Data, isNsfw, sceneName, caption) {
  const res = await makeRequest(
    `${CONFIG.flashparty.baseUrl}/parties/${partyId}/uploads/media`,
    {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${CONFIG.flashparty.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        file_base64:      base64Data,
        file_name:        `party-${Date.now()}.jpg`,
        uploader_nickname: CONFIG.uploader.nickname,
        media_type:       'image',
        caption:          caption || generateCaption(isNsfw, sceneName),
        is_premium:       isNsfw,
        is_nsfw:          isNsfw
      })
    }
  );

  if (res.status === 200 || res.status === 201) return res.data;
  throw new Error(`Upload failed: ${JSON.stringify(res.data)}`);
}

async function updatePartyCover(partyId, imageUrl) {
  try {
    await makeRequest(
      `${CONFIG.flashparty.baseUrl}/parties/${partyId}`,
      {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${CONFIG.flashparty.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ cover_url: imageUrl })
      }
    );
    console.log('  ✓ Cover image set');
  } catch (err) {
    console.error(`  ✗ Cover update failed: ${err.message}`);
  }
}

// ─── PartyLab Batch Generation ────────────────────────────────────────────────
async function startPartyLabGeneration(theme, characters, scenes, totalImages) {
  const res = await makeRequest(
    `${CONFIG.partylab.baseUrl}/party`,
    {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${CONFIG.partylab.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        theme:        { name: theme.name, prompt_prefix: theme.promptPrefix, tags: theme.tags, model_id: 'grok-imagine-image' },
        characters,
        style:        { name: theme.name, style_descriptors: theme.promptPrefix },
        scenes,
        folder:       `${theme.name} ${new Date().toLocaleDateString()}`,
        total_images: totalImages
      })
    }
  );

  if (res.status === 200 || res.status === 202) return res.data.job_id;
  throw new Error(`PartyLab /party failed (${res.status}): ${JSON.stringify(res.data)}`);
}

async function pollAndUpload(jobId, flashPartyId, totalImages, captions) {
  const deadline         = Date.now() + CONFIG.party.pollTimeoutMs;
  const uploadedImageIds = new Set();
  let uploadCount  = 0;
  let failCount    = 0;
  let coverSet     = false;
  let captionIndex = 0;

  console.log(`\nPolling job ${jobId} — uploading images as they complete...`);

  while (Date.now() < deadline) {
    await sleep(CONFIG.party.pollIntervalMs);

    const res = await makeRequest(
      `${CONFIG.partylab.baseUrl}/party/${jobId}/status`,
      { method: 'GET', headers: { 'Authorization': `Bearer ${CONFIG.partylab.apiKey}` } }
    );

    const { status, images_completed, images_total, result, error } = res.data;
    process.stdout.write(`\r  PartyLab: ${images_completed || 0}/${images_total || totalImages} generated (${status})   `);

    if (error) throw new Error(`PartyLab job failed: ${error}`);

    if (result && result.images) {
      for (const img of result.images) {
        if (uploadedImageIds.has(img.id)) continue;
        uploadedImageIds.add(img.id);

        const isNsfw = img.scene && img.scene.startsWith(NSFW_SCENE_PREFIX);
        const num    = uploadCount + failCount + 1;

        try {
          console.log(`\n  [${num}/${totalImages}] Uploading (scene: ${img.scene || 'unknown'}${isNsfw ? ', NSFW' : ''})`);
          const base64  = await downloadImage(img.url);
          const caption = captions ? captions[captionIndex++ % captions.length] : null;
          const uploaded = await uploadToFlashParty(flashPartyId, base64, isNsfw, img.scene, caption);
          uploadCount++;
          console.log(`  ✓ Uploaded${isNsfw ? ' [premium]' : ''} — "${caption || ''}"`);

          if (!coverSet && !isNsfw && uploaded.media_url) {
            await updatePartyCover(flashPartyId, uploaded.media_url);
            coverSet = true;
          }
        } catch (err) {
          failCount++;
          console.error(`\n  ✗ Upload failed: ${err.message}`);
        }
      }
    }

    if (status === 'completed') { console.log(`\n  ✓ All images generated`); break; }
    if (status === 'failed')    { throw new Error(`PartyLab job failed: ${error || 'unknown'}`); }
  }

  return { uploaded: uploadCount, failed: failCount };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const startTime = Date.now();
  console.log('='.repeat(60));
  console.log('FlashParty AI Generator');
  console.log(`Started: ${new Date().toLocaleString()}`);
  console.log('='.repeat(60));

  // 1. Health check
  console.log('\nChecking PartyLab API health...');
  const health = await makeRequest(`${CONFIG.partylab.baseUrl}/health`, { method: 'GET' });
  if (health.data.status !== 'ok') throw new Error(`PartyLab unhealthy: ${health.data.message}`);
  console.log(`  ✓ PartyLab OK`);

  // 2. Generate theme
  let theme;
  try {
    theme = await generateThemeWithAI();
    console.log(`\nTheme (AI): ${theme.name} (NSFW level ${theme.nsfwLevel})`);
  } catch (err) {
    console.warn(`  AI theme failed (${err.message}), using fallback`);
    theme = generateThemeFallback();
    console.log(`\nTheme (fallback): ${theme.name} (NSFW level ${theme.nsfwLevel})`);
  }
  saveUsedTheme(theme.name);

  // 3. Set up characters and counts
  const characterCount = 3 + Math.floor(Math.random() * 5);
  const characters     = generateCharacters(theme, characterCount);
  const nsfwCount      = nsfwCountForLevel(theme.nsfwLevel);
  const sfwCount       = CONFIG.party.totalImages - nsfwCount;
  const totalImages    = CONFIG.party.totalImages;

  console.log(`Characters: ${characters.map(c => c.name).join(', ')}`);
  console.log(`Images:     ${sfwCount} SFW + ${nsfwCount} NSFW = ${totalImages} total`);

  // 4. Create party on FlashParty
  const party    = await createFlashParty(theme);
  const partyUrl = `${CONFIG.flashparty.webBaseUrl}/party/${party.slug}`;
  console.log(`\nParty created: ${partyUrl}`);

  // 5. Build scene list and generate captions
  const scenes = generateScenes(theme, characters, sfwCount, nsfwCount);
  let captions = null;
  try {
    captions = await generateCaptionsWithAI(scenes, theme.name);
    console.log(`Captions: AI-generated (${captions.length})`);
  } catch (err) {
    console.warn(`  AI captions failed (${err.message}), using static pool`);
  }

  // 6. Kick off PartyLab batch image generation
  console.log(`\nStarting image generation on PartyLab...`);
  const jobId = await startPartyLabGeneration(theme, characters, scenes, totalImages);
  console.log(`Job ID: ${jobId}`);

  // 7. Poll and upload images as they complete
  const { uploaded, failed } = await pollAndUpload(jobId, party.id, totalImages, captions);

  const durationMins = Math.round((Date.now() - startTime) / 60000);
  console.log('\n' + '='.repeat(60));
  console.log('Done!');
  console.log(`Party URL:  ${partyUrl}`);
  console.log(`Uploaded:   ${uploaded}/${totalImages}`);
  console.log(`Failed:     ${failed}`);
  console.log(`Duration:   ${durationMins} minutes`);
  console.log('='.repeat(60));

  if (uploaded < 5) {
    console.error(`\n❌ Only ${uploaded} images uploaded — party may appear empty`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error(`\n✗ Fatal error: ${err.message}`);
  process.exit(1);
});

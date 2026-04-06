# FlashParty AI Party Generator

A Node.js script that automatically creates a new themed party on [FlashParty.co](https://flashparty.co) every night — complete with 25 AI-generated photos, unique captions, and a premium paywall for NSFW content.

**Stack:** Claude (Anthropic) · PartyLab (xAI/Grok) · FlashParty API

---

## What it does

Each run:

1. **Generates a unique party theme** via Claude — seasonal, holiday-aware, and aware of what it generated the last 30 nights so it never repeats
2. **Builds 25 scenes** with varied shot types (wide, close-up, selfie, over-the-shoulder, bird's-eye), subject counts (solo to packed crowd), and camera styles (DSLR, film, disposable, iPhone, etc.)
3. **Generates all 25 captions** in a single Claude API call — contextual, unique, under 10 words each
4. **Kicks off batch image generation** on PartyLab using xAI's Grok image model
5. **Uploads photos to FlashParty** as they complete — SFW images are free, NSFW images are gated behind a $5 Party Pass
6. **Interleaves NSFW content** naturally throughout the party rather than clustering it together

Run it nightly via cron and your FlashParty page stays fresh every day with zero manual effort.

---

## Requirements

- Node.js 18+
- A [FlashParty.co](https://flashparty.co/developers) API key
- A [PartyLab](https://partylab.dev) API key
- An [Anthropic](https://console.anthropic.com) API key

---

## Setup

```bash
# 1. Clone the repo
git clone https://github.com/your-org/flashparty-ai-generator
cd flashparty-ai-generator

# 2. Install dependencies (just dotenv)
npm install

# 3. Configure your API keys
cp .env.example .env
# Edit .env and fill in your three API keys

# 4. Run it
node party-generator.js
```

The first run takes 5–10 minutes. You'll see each image log as it uploads.

---

## Automate with cron

To run nightly at 6pm:

```bash
crontab -e
```

Add:

```
0 18 * * * /usr/local/bin/node /path/to/party-generator.js >> /path/to/logs/party.log 2>&1
```

---

## Customisation

Everything worth tweaking is near the top of `party-generator.js`:

| What | Where |
|---|---|
| Total images per party | `CONFIG.party.totalImages` |
| Party duration | `CONFIG.party.durationHours` |
| Premium pass price | `CONFIG.party.premiumPassPrice` |
| NSFW prompts | `NSFW_PROMPTS` array |
| Camera styles | `CAMERA_STYLES` array |
| Scene types and weights | `SFW_TEMPLATES` array |
| Shot type variety | `SHOT_TYPES` array |

### Adjusting NSFW level

The AI assigns a `nsfwLevel` (0–3) to each theme. The number of NSFW images scales with this:

| Level | Images | Description |
|---|---|---|
| 0 | 0 | No NSFW content |
| 1 | 2–4 | Mildly suggestive |
| 2 | 5–9 | Moderately NSFW |
| 3 | 10–17 | Explicitly adult |

---

## Cost estimate

Per nightly run, approximate API costs:

| Service | Usage | Cost |
|---|---|---|
| Anthropic (Claude Haiku) | ~3 API calls | ~$0.003 |
| PartyLab (xAI/Grok) | 25 images | ~$0.50–$1.00 |
| FlashParty | Hosting + uploads | Free tier available |
| **Total** | | **~$0.50–$1.00/night** |

Revenue from a single $5 Party Pass sale covers a week of nightly runs.

---

## License

MIT — fork it, modify it, build on it.

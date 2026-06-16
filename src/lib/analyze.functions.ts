import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { YoutubeTranscript } from "youtube-transcript";

const InputSchema = z.object({
  url: z.string().trim().min(5).max(500),
});

export type ReplicationKit = {
  source: {
    platform: "youtube" | "tiktok";
    title: string;
    author?: string;
    url: string;
    transcriptPreview: string;
    durationMinutes?: number;
    durationLabel?: string;
  };
  markdown: string;
};

/* ---------------- URL detection ---------------- */

type SourceKind =
  | { platform: "youtube"; kind: "video"; id: string }
  | { platform: "youtube"; kind: "channel"; handleOrId: string }
  | { platform: "tiktok"; kind: "video"; url: string }
  | { platform: "tiktok"; kind: "profile"; username: string };

function detectSource(raw: string): SourceKind {
  // Normalize: trim whitespace, drop surrounding quotes, and parse with URL when possible
  // so tracking params like ?si=..., ?feature=share, &t=10s never leak into IDs/handles.
  let url = raw.trim().replace(/^['"<]+|['">]+$/g, "");
  // Add protocol if missing so `new URL` works for things like "youtu.be/abc" or "youtube.com/@foo"
  const withProto = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  let host = "";
  let pathname = url;
  let searchV: string | null = null;
  try {
    const u = new URL(withProto);
    host = u.hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
    pathname = u.pathname; // already stripped of ?si=, &feature=, #t=, etc.
    searchV = u.searchParams.get("v");
  } catch {
    // fall back to raw string matching below
  }

  // ---------- YouTube video ----------
  if (host === "youtu.be") {
    const m = pathname.match(/^\/([A-Za-z0-9_-]{6,})/);
    if (m) return { platform: "youtube", kind: "video", id: m[1] };
  }
  if (host.endsWith("youtube.com")) {
    if (searchV && /^[A-Za-z0-9_-]{6,}$/.test(searchV)) {
      return { platform: "youtube", kind: "video", id: searchV };
    }
    const shorts = pathname.match(/^\/shorts\/([A-Za-z0-9_-]{6,})/);
    if (shorts) return { platform: "youtube", kind: "video", id: shorts[1] };
    const embed = pathname.match(/^\/(?:embed|live|v)\/([A-Za-z0-9_-]{6,})/);
    if (embed) return { platform: "youtube", kind: "video", id: embed[1] };

    // ---------- YouTube channel ----------
    const handle = pathname.match(/^\/(@[A-Za-z0-9_.-]+)/);
    if (handle) return { platform: "youtube", kind: "channel", handleOrId: handle[1] };
    const channelId = pathname.match(/^\/channel\/([A-Za-z0-9_-]+)/);
    if (channelId) return { platform: "youtube", kind: "channel", handleOrId: channelId[1] };
    const custom = pathname.match(/^\/(?:c|user)\/([A-Za-z0-9_.-]+)/);
    if (custom) return { platform: "youtube", kind: "channel", handleOrId: custom[1] };
  }

  // ---------- TikTok ----------
  if (host.endsWith("tiktok.com")) {
    if (/\/video\/\d+/.test(pathname) || host === "vm.tiktok.com") {
      return { platform: "tiktok", kind: "video", url: withProto };
    }
    const prof = pathname.match(/^\/(@[A-Za-z0-9_.-]+)/);
    if (prof) return { platform: "tiktok", kind: "profile", username: prof[1] };
  }

  // ---------- Fallback: bare handle or ID ----------
  if (/^@[A-Za-z0-9_.-]+$/.test(url)) {
    return { platform: "youtube", kind: "channel", handleOrId: url };
  }
  if (/^[A-Za-z0-9_-]{11}$/.test(url)) {
    return { platform: "youtube", kind: "video", id: url };
  }

  throw new Error(
    "Could not recognize this URL. Paste a YouTube video/channel link or a TikTok video/profile link.",
  );
}

/* ---------------- YouTube ---------------- */

async function fetchYouTubeVideo(videoId: string, apiKey: string) {
  const res = await fetch(
    `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,contentDetails&id=${videoId}&key=${apiKey}`,
  );
  if (!res.ok) throw new Error(`YouTube API error: ${res.status}`);
  const json = (await res.json()) as {
    items?: Array<{
      snippet: {
        title: string;
        description: string;
        channelTitle: string;
        tags?: string[];
      };
      statistics?: { viewCount?: string; likeCount?: string };
      contentDetails?: { duration?: string };
    }>;
  };
  const item = json.items?.[0];
  if (!item) throw new Error("Video not found.");
  return item;
}

async function fetchYouTubeTranscript(videoId: string): Promise<string> {
  // 1) Primary: youtube-transcript npm package (scrapes public captions, no OAuth).
  try {
    const segments = await YoutubeTranscript.fetchTranscript(videoId, {
      lang: "en",
    });
    const text = segments
      .map((s) => s.text)
      .join(" ")
      .replace(/&amp;#39;/g, "'")
      .replace(/&amp;quot;/g, '"')
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
      .trim();
    if (text) return text;
  } catch {
    /* fall through to language-agnostic fetch */
  }
  try {
    const segments = await YoutubeTranscript.fetchTranscript(videoId);
    const text = segments
      .map((s) => s.text)
      .join(" ")
      .replace(/&amp;#39;/g, "'")
      .replace(/&amp;quot;/g, '"')
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
      .trim();
    if (text) return text;
  } catch {
    /* fall through to watch-page scrape */
  }

  // 2) Fallback: scrape the watch page for captionTracks (auto-generated tracks etc.).
  try {
    const page = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=en`, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    const html = await page.text();
    const match = html.match(/"captionTracks":(\[.*?\])/);
    if (!match) return "";
    const tracks = JSON.parse(match[1]) as Array<{
      baseUrl: string;
      languageCode: string;
      kind?: string;
    }>;
    const track =
      tracks.find((t) => t.languageCode === "en" && !t.kind) ??
      tracks.find((t) => t.languageCode === "en") ??
      tracks[0];
    if (!track?.baseUrl) return "";
    const xmlRes = await fetch(track.baseUrl);
    const xml = await xmlRes.text();
    return xml
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/\s+/g, " ")
      .trim();
  } catch {
    return "";
  }
}

function readTextRenderer(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const renderer = value as { simpleText?: unknown; runs?: unknown };
  if (typeof renderer.simpleText === "string") return renderer.simpleText;
  if (!Array.isArray(renderer.runs)) return "";
  return renderer.runs
    .map((run) => {
      if (!run || typeof run !== "object") return "";
      const text = (run as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    })
    .join("")
    .trim();
}

function extractBalancedJson(html: string, marker: string): unknown | null {
  const markerIndex = html.indexOf(marker);
  if (markerIndex === -1) return null;
  const start = html.indexOf("{", markerIndex);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < html.length; i += 1) {
    const char = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

type YouTubeListVideo = {
  id: { videoId: string };
  snippet: { title: string; description: string; channelTitle: string };
};

function collectVideosFromInitialData(
  node: unknown,
  channelTitle: string,
  videos: YouTubeListVideo[],
  seen = new Set<string>(),
): void {
  if (videos.length >= 5 || node == null) return;
  if (Array.isArray(node)) {
    for (const item of node) collectVideosFromInitialData(item, channelTitle, videos, seen);
    return;
  }
  if (typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  const maybeVideo = record.videoRenderer;
  if (maybeVideo && typeof maybeVideo === "object") {
    const renderer = maybeVideo as Record<string, unknown>;
    const videoId = renderer.videoId;
    if (typeof videoId === "string" && !seen.has(videoId)) {
      const title = readTextRenderer(renderer.title) || "Untitled YouTube video";
      const description = readTextRenderer(renderer.descriptionSnippet);
      seen.add(videoId);
      videos.push({
        id: { videoId },
        snippet: { title, description, channelTitle },
      });
    }
  }
  for (const value of Object.values(record)) {
    collectVideosFromInitialData(value, channelTitle, videos, seen);
    if (videos.length >= 5) return;
  }
}

async function scrapeYouTubeChannelVideos(
  handleOrId: string,
  channelId: string,
  channelTitle: string,
): Promise<YouTubeListVideo[]> {
  const raw = handleOrId.replace(/^@/, "");
  const bases = channelId
    ? [`https://www.youtube.com/channel/${channelId}`]
    : [`https://www.youtube.com/@${raw}`, `https://www.youtube.com/c/${raw}`, `https://www.youtube.com/user/${raw}`];
  const paths = ["/videos?view=0&sort=dd&shelf_id=0", "/videos", "/shorts", "/streams"];
  const headers = {
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "accept-language": "en-US,en;q=0.9",
    cookie: "CONSENT=YES+1; SOCS=CAI",
  };

  for (const base of bases) {
    for (const path of paths) {
      try {
        const res = await fetch(`${base}${path}`, { headers });
        if (!res.ok) continue;
        const html = await res.text();
        const title =
          channelTitle ||
          html.match(/<meta property="og:title" content="([^"]+)"/)?.[1]?.replace(/ - YouTube$/, "") ||
          "YouTube channel";
        const initialData =
          extractBalancedJson(html, "var ytInitialData =") ??
          extractBalancedJson(html, "ytInitialData =");
        const scraped: YouTubeListVideo[] = [];
        collectVideosFromInitialData(initialData, title, scraped);
        if (scraped.length > 0) return scraped;
      } catch {
        /* try the next public page variant */
      }
    }
  }
  return [];
}

async function fetchYouTubeChannelRecent(handleOrId: string, apiKey: string) {
  // Resolve to channelId
  let channelId = handleOrId.startsWith("UC") ? handleOrId : "";
  const raw = handleOrId.replace(/^@/, "");

  let apiKeyIssue: string | null = null;
  const noteApiError = async (r: Response) => {
    try {
      const j = (await r.clone().json()) as {
        error?: { code?: number; message?: string; errors?: Array<{ reason?: string }> };
      };
      const reason = j.error?.errors?.[0]?.reason ?? "";
      const message = j.error?.message ?? "";
      if (
        (r.status === 403 || r.status === 400) &&
        /quotaExceeded|rateLimitExceeded|dailyLimitExceeded|keyInvalid|API key not valid|ipRefererBlocked|accessNotConfigured/i.test(
          reason + " " + message,
        )
      ) {
        apiKeyIssue = message || reason || `YouTube API error (${r.status})`;
      }
    } catch {
      /* ignore */
    }
  };
  if (!apiKey) apiKeyIssue = "YOUTUBE_API_KEY is not configured on the server.";

  const scrapeHeaders = {
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "accept-language": "en-US,en;q=0.9",
    cookie: "CONSENT=YES+1; SOCS=CAI",
  };

  // 1) Try the official channels endpoint with forHandle (works for @handles)
  if (!channelId && apiKey) {
    try {
      const r = await fetch(
        `https://www.googleapis.com/youtube/v3/channels?part=id&forHandle=${encodeURIComponent("@" + raw)}&key=${apiKey}`,
      );
      if (!r.ok) await noteApiError(r);
      const j = (await r.json()) as { items?: Array<{ id: string }> };
      channelId = j.items?.[0]?.id ?? "";
    } catch {
      /* ignore */
    }
  }

  // 2) Try forUsername (legacy /user/ URLs)
  if (!channelId && apiKey) {
    try {
      const r = await fetch(
        `https://www.googleapis.com/youtube/v3/channels?part=id&forUsername=${encodeURIComponent(raw)}&key=${apiKey}`,
      );
      if (!r.ok) await noteApiError(r);
      const j = (await r.json()) as { items?: Array<{ id: string }> };
      channelId = j.items?.[0]?.id ?? "";
    } catch {
      /* ignore */
    }
  }

  // 3) Scrape the public channel page for the canonical channelId
  if (!channelId) {
    let anyPageOk = false;
    try {
      const candidates = [
        `https://www.youtube.com/@${raw}`,
        `https://www.youtube.com/c/${raw}`,
        `https://www.youtube.com/user/${raw}`,
        `https://www.youtube.com/${raw}`,
      ];
      for (const url of candidates) {
        const r = await fetch(url, { headers: scrapeHeaders });
        if (!r.ok) continue;
        anyPageOk = true;
        const html = await r.text();
        const m =
          html.match(/"channelId":"(UC[0-9A-Za-z_-]{22})"/) ??
          html.match(/"externalId":"(UC[0-9A-Za-z_-]{22})"/) ??
          html.match(/<meta itemprop="channelId" content="(UC[0-9A-Za-z_-]{22})">/) ??
          html.match(/\/channel\/(UC[0-9A-Za-z_-]{22})/);
        if (m) {
          channelId = m[1];
          break;
        }
      }
      if (!channelId && !anyPageOk) {
        throw new Error(
          `Link issue: no public YouTube channel found for "${handleOrId}". YouTube returned 404 for @${raw}, /c/${raw}, and /user/${raw}. Double-check spelling (handles are case sensitive) or paste the full channel URL (https://www.youtube.com/channel/UC...).`,
        );
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("Link issue:")) throw e;
      /* ignore network errors, fall through */
    }
  }

  // 4) Last resort: search API
  if (!channelId && apiKey) {
    try {
      const search = await fetch(
        `https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&q=${encodeURIComponent(raw)}&maxResults=1&key=${apiKey}`,
      );
      if (!search.ok) await noteApiError(search);
      const sj = (await search.json()) as {
        items?: Array<{ snippet: { channelId: string; channelTitle: string } }>;
      };
      channelId = sj.items?.[0]?.snippet.channelId ?? "";
    } catch {
      /* ignore */
    }
  }

  if (!channelId) {
    if (apiKeyIssue) {
      throw new Error(
        `YouTube API key issue: ${apiKeyIssue} — update the YOUTUBE_API_KEY secret (YouTube Data API v3 must be enabled with quota remaining).`,
      );
    }
    throw new Error(
      `Link issue: could not resolve YouTube channel "${handleOrId}". Verify the handle is spelled correctly (case sensitive) or paste the full channel URL (https://www.youtube.com/channel/UC...).`,
    );
  }
  // Resolve the channel's uploads playlist (more reliable + cheaper than search.list)
  let uploadsPlaylistId = "";
  let channelTitle = "";
  try {
    const cRes = await fetch(
      `https://www.googleapis.com/youtube/v3/channels?part=snippet,contentDetails&id=${channelId}&key=${apiKey}`,
    );
    const cj = (await cRes.json()) as {
      items?: Array<{
        snippet?: { title?: string };
        contentDetails?: { relatedPlaylists?: { uploads?: string } };
      }>;
    };
    uploadsPlaylistId =
      cj.items?.[0]?.contentDetails?.relatedPlaylists?.uploads ?? "";
    channelTitle = cj.items?.[0]?.snippet?.title ?? "";
  } catch {
    /* ignore */
  }

  let videos: YouTubeListVideo[] = [];

  if (uploadsPlaylistId) {
    const pRes = await fetch(
      `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${uploadsPlaylistId}&maxResults=5&key=${apiKey}`,
    );
    const pj = (await pRes.json()) as {
      items?: Array<{
        snippet: {
          title: string;
          description: string;
          channelTitle: string;
          resourceId: { videoId: string };
        };
      }>;
    };
    videos = (pj.items ?? []).map((it) => ({
      id: { videoId: it.snippet.resourceId.videoId },
      snippet: {
        title: it.snippet.title,
        description: it.snippet.description,
        channelTitle: it.snippet.channelTitle,
      },
    }));
  }

  // Fallback: search.list (kept for edge cases)
  if (videos.length === 0) {
    const list = await fetch(
      `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channelId}&maxResults=5&order=date&type=video&key=${apiKey}`,
    );
    const lj = (await list.json()) as { items?: YouTubeListVideo[] };
    videos = lj.items ?? [];
  }

  // Final fallback: scrape public channel tabs. This avoids false "no videos" errors
  // when API quota/search/playlist endpoints return empty data for a valid channel.
  if (videos.length === 0) {
    videos = await scrapeYouTubeChannelVideos(handleOrId, channelId, channelTitle);
  }

  if (videos.length === 0) {
    throw new Error(
      "Channel has no recent public videos (or YouTube API quota exhausted).",
    );
  }
  if (!channelTitle) channelTitle = videos[0].snippet.channelTitle;
  // Pull transcript for top video, titles+descriptions for the rest.
  const top = videos[0];
  const transcript = await fetchYouTubeTranscript(top.id.videoId);
  // Also fetch duration for the top video
  let topDurationIso = "";
  try {
    const dRes = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=${top.id.videoId}&key=${apiKey}`,
    );
    const dj = (await dRes.json()) as {
      items?: Array<{ contentDetails?: { duration?: string } }>;
    };
    topDurationIso = dj.items?.[0]?.contentDetails?.duration ?? "";
  } catch {
    /* ignore */
  }
  const summary = videos
    .map(
      (v, i) =>
        `${i + 1}. ${v.snippet.title}\n   ${v.snippet.description.slice(0, 220)}`,
    )
    .join("\n\n");
  const body =
    `LATEST VIDEO TITLE: ${top.snippet.title}\n` +
    `LATEST VIDEO DESCRIPTION:\n${top.snippet.description}\n\n` +
    `LATEST VIDEO TRANSCRIPT:\n${transcript || "(transcript not available)"}\n\n` +
    `RECENT POSTS:\n${summary}`;
  return {
    title: `${channelTitle} — channel analysis`,
    author: channelTitle,
    transcriptText: body,
    durationIso: topDurationIso,
  };
}

/* ---------------- TikTok (Apify) ---------------- */

async function fetchApifyDataset(actorId: string, input: unknown, token: string) {
  const res = await fetch(
    `https://api.apify.com/v2/acts/${actorId}/run-sync-get-dataset-items?token=${token}&timeout=120`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Apify error ${res.status}: ${txt.slice(0, 200)}`);
  }
  return (await res.json()) as Array<Record<string, unknown>>;
}

async function fetchTikTokVideo(url: string, token: string) {
  const items = await fetchApifyDataset(
    "clockworks~tiktok-scraper",
    { postURLs: [url], resultsPerPage: 1, shouldDownloadVideos: false },
    token,
  );
  const it = items[0] as
    | {
        text?: string;
        authorMeta?: { name?: string; nickName?: string };
        hashtags?: Array<{ name: string }>;
        playCount?: number;
        diggCount?: number;
        videoMeta?: { duration?: number };
      }
    | undefined;
  if (!it) throw new Error("TikTok post not found.");
  const author = it.authorMeta?.nickName ?? it.authorMeta?.name ?? "TikTok creator";
  const tags = (it.hashtags ?? []).map((h) => `#${h.name}`).join(" ");
  const body =
    `CAPTION/TEXT:\n${it.text ?? ""}\n\n` +
    `HASHTAGS: ${tags}\n` +
    `METRICS: ${it.playCount ?? "?"} views, ${it.diggCount ?? "?"} likes`;
  return {
    title: `TikTok post by @${author}`,
    author,
    transcriptText: body,
    durationSeconds: it.videoMeta?.duration ?? 0,
  };
}

async function fetchTikTokProfile(username: string, token: string) {
  const handle = username.replace(/^@/, "");
  const items = await fetchApifyDataset(
    "clockworks~tiktok-scraper",
    { profiles: [handle], resultsPerPage: 8, shouldDownloadVideos: false },
    token,
  );
  if (items.length === 0) throw new Error("No TikTok posts found for that profile.");
  const summary = items
    .map((raw, i) => {
      const it = raw as {
        text?: string;
        playCount?: number;
        diggCount?: number;
      };
      return `${i + 1}. (${it.playCount ?? "?"} views) ${it.text ?? ""}`.slice(
        0,
        500,
      );
    })
    .join("\n\n");
  return {
    title: `@${handle} — TikTok profile analysis`,
    author: `@${handle}`,
    transcriptText: `RECENT TIKTOK POSTS:\n\n${summary}`,
  };
}

/* ---------------- Claude ---------------- */

const SYSTEM_PROMPT = `You are ContentForge AI, an elite Content Strategist and Master Copywriter. Analyze the provided video transcript and metadata. Output a deeply detailed 'Content Replication Kit' covering:
- Channel DNA (Tone, Vibe, Target Audience, and Hook Strategy).
- Reusable Master Prompt (A custom prompt the user can copy-paste later to generate similar scripts).
- Title Generation (5 highly click-worthy titles in the exact same style).
- Comprehensive Script Re-writing: Generate a complete, full-length script that matches the exact duration and depth of the analyzed video. FIRST, analyze the total length / word count of the fetched transcript and the provided VIDEO DURATION metadata, then dynamically match the output script's duration to the original video's duration. If the original video is 15 minutes, 30 minutes, or 1 hour long, the generated script MUST be a full, comprehensive, scene-by-scene breakdown of that exact length — do NOT truncate or summarize it into a short version. Use the industry rule of ~150 spoken words per minute to size the script (e.g. a 30-minute video → ~4,500 words of narration). Divide the script into clear chronological scenes or chapters with explicit timestamps spanning from 00:00 to the full runtime. For EVERY single scene/timestamp, provide:
  * The spoken narration/voiceover text in full (no placeholders, no "continue in this style" shortcuts).
  * Detailed visual prompts for AI video generation (Midjourney / Leonardo AI) specifically tailored for that exact scene.
  * Specific editing instructions (transitions, overlays, sound effects, b-roll cues) for that exact moment.
- Visuals & Editing Guide (Global Midjourney/Leonardo AI style guide, color grade, and video clip sourcing ideas like Pexels/Wikipedia that apply across the whole video).
- Voiceover Character (Recommend specific ElevenLabs voice models like 'Adam - deep documentary' or 'Marcus - energetic' with stability/clarity setting recommendations).

Format your output as clean Markdown. Use these exact H2 section headers in this order:
## Channel DNA
## Reusable Master Prompt
## Title Generation
## Script Writing
## Visuals & Editing Guide
## Voiceover Character

Inside ## Script Writing, begin with a one-line "Target runtime: X minutes (~Y words)" header, then output every scene in order until the full runtime is covered. Be specific, opinionated, and avoid generic advice. Mirror the source creator's voice precisely.`;

async function callClaude(payload: string, apiKey: string): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: payload }],
    }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Claude error ${res.status}: ${txt.slice(0, 300)}`);
  }
  const json = (await res.json()) as {
    content?: Array<{ type: string; text?: string }>;
  };
  const text = (json.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
  if (!text.trim()) throw new Error("Claude returned empty content.");
  return text;
}

/* ---------------- Server function ---------------- */

function parseIsoDurationToMinutes(iso: string): number {
  if (!iso) return 0;
  const m = iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return 0;
  const h = parseInt(m[1] ?? "0", 10);
  const mm = parseInt(m[2] ?? "0", 10);
  const s = parseInt(m[3] ?? "0", 10);
  return Math.max(1, Math.round((h * 3600 + mm * 60 + s) / 60));
}

function formatDurationLabel(totalMinutes: number): string {
  if (totalMinutes < 1) return "under 1 minute";
  if (totalMinutes < 60) return `${totalMinutes} minute${totalMinutes === 1 ? "" : "s"}`;
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export const analyzeContent = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => InputSchema.parse(input))
  .handler(async ({ data }): Promise<ReplicationKit> => {
    const claudeKey = process.env.CLAUDE_API_KEY;
    const ytKey = process.env.YOUTUBE_API_KEY;
    const apifyKey = process.env.APIFY_API_KEY;
    if (!claudeKey) throw new Error("Missing CLAUDE_API_KEY.");

    const source = detectSource(data.url);
    let title = "";
    let author: string | undefined;
    let transcriptText = "";
    let durationMinutes = 0;

    if (source.platform === "youtube") {
      if (!ytKey) throw new Error("Missing YOUTUBE_API_KEY.");
      if (source.kind === "video") {
        const meta = await fetchYouTubeVideo(source.id, ytKey);
        const transcript = await fetchYouTubeTranscript(source.id);
        title = meta.snippet.title;
        author = meta.snippet.channelTitle;
        durationMinutes = parseIsoDurationToMinutes(
          meta.contentDetails?.duration ?? "",
        );
        transcriptText =
          `TITLE: ${title}\n` +
          `CHANNEL: ${author}\n` +
          (durationMinutes
            ? `VIDEO DURATION: ${durationMinutes} minutes (~${durationMinutes * 150} spoken words target)\n`
            : "") +
          `DESCRIPTION:\n${meta.snippet.description}\n\n` +
          `TRANSCRIPT:\n${transcript || "(transcript not available — analyze from title + description)"}`;
      } else {
        const ch = await fetchYouTubeChannelRecent(source.handleOrId, ytKey);
        title = ch.title;
        author = ch.author;
        durationMinutes = parseIsoDurationToMinutes(ch.durationIso ?? "");
        transcriptText = ch.transcriptText;
        if (durationMinutes) {
          transcriptText =
            `LATEST VIDEO DURATION: ${durationMinutes} minutes (~${durationMinutes * 150} spoken words target)\n\n` +
            transcriptText;
        }
      }
    } else {
      if (!apifyKey) throw new Error("Missing APIFY_API_KEY.");
      if (source.kind === "video") {
        const tt = await fetchTikTokVideo(source.url, apifyKey);
        title = tt.title;
        author = tt.author;
        transcriptText = tt.transcriptText;
        durationMinutes = tt.durationSeconds
          ? Math.max(1, Math.round(tt.durationSeconds / 60))
          : 0;
      } else {
        const tt = await fetchTikTokProfile(source.username, apifyKey);
        title = tt.title;
        author = tt.author;
        transcriptText = tt.transcriptText;
      }
    }

    // Cap payload to keep token usage sane.
    const trimmed = transcriptText.slice(0, 16000);
    const durationLine = durationMinutes
      ? `ORIGINAL VIDEO DURATION: ${formatDurationLabel(durationMinutes)} (${durationMinutes} minutes total). Your Script Writing section MUST match this runtime — target ~${durationMinutes * 150} spoken words, broken into chronological scenes with timestamps from 00:00 to ${formatDurationLabel(durationMinutes)}.\n\n`
      : `ORIGINAL VIDEO DURATION: unknown — infer the target runtime from the transcript length and produce a full, scene-by-scene script of matching depth.\n\n`;
    const userPayload =
      `SOURCE: ${source.platform.toUpperCase()} (${source.kind})\n` +
      `URL: ${data.url}\n\n` +
      durationLine +
      `--- CONTENT START ---\n${trimmed}\n--- CONTENT END ---\n\n` +
      `Now produce the Content Replication Kit exactly as instructed.`;

    const markdown = await callClaude(userPayload, claudeKey);

    return {
      source: {
        platform: source.platform,
        title,
        author,
        url: data.url,
        transcriptPreview: trimmed.slice(0, 600),
        durationMinutes: durationMinutes || undefined,
        durationLabel: durationMinutes ? formatDurationLabel(durationMinutes) : undefined,
      },
      markdown,
    };
  });
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

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
  const url = raw.trim();
  // YouTube video
  const ytShort = url.match(/youtu\.be\/([A-Za-z0-9_-]{6,})/);
  const ytWatch = url.match(/[?&]v=([A-Za-z0-9_-]{6,})/);
  const ytShorts = url.match(/youtube\.com\/shorts\/([A-Za-z0-9_-]{6,})/);
  if (ytShort || ytWatch || ytShorts) {
    const id = (ytShort?.[1] ?? ytWatch?.[1] ?? ytShorts?.[1]) as string;
    return { platform: "youtube", kind: "video", id };
  }
  // YouTube channel
  const ytHandle = url.match(/youtube\.com\/(@[A-Za-z0-9_.-]+)/);
  const ytChannelId = url.match(/youtube\.com\/channel\/([A-Za-z0-9_-]+)/);
  const ytCustom = url.match(/youtube\.com\/(?:c|user)\/([A-Za-z0-9_.-]+)/);
  if (ytHandle || ytChannelId || ytCustom) {
    return {
      platform: "youtube",
      kind: "channel",
      handleOrId: (ytHandle?.[1] ?? ytChannelId?.[1] ?? ytCustom?.[1]) as string,
    };
  }
  // TikTok video
  if (/tiktok\.com\/.+\/video\/\d+/.test(url) || /vm\.tiktok\.com\//.test(url)) {
    return { platform: "tiktok", kind: "video", url };
  }
  // TikTok profile
  const ttProfile = url.match(/tiktok\.com\/(@[A-Za-z0-9_.-]+)/);
  if (ttProfile) {
    return { platform: "tiktok", kind: "profile", username: ttProfile[1] };
  }
  throw new Error(
    "Could not recognize this URL. Paste a YouTube video/channel link or a TikTok video/profile link.",
  );
}

/* ---------------- YouTube ---------------- */

async function fetchYouTubeVideo(videoId: string, apiKey: string) {
  const res = await fetch(
    `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&id=${videoId}&key=${apiKey}`,
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
    }>;
  };
  const item = json.items?.[0];
  if (!item) throw new Error("Video not found.");
  return item;
}

async function fetchYouTubeTranscript(videoId: string): Promise<string> {
  // Best-effort: scrape the watch page to find caption tracks.
  try {
    const page = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=en`, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ContentForge/1.0)" },
    });
    const html = await page.text();
    const match = html.match(/"captionTracks":(\[.*?\])/);
    if (!match) return "";
    const tracks = JSON.parse(match[1]) as Array<{
      baseUrl: string;
      languageCode: string;
    }>;
    const track =
      tracks.find((t) => t.languageCode === "en") ?? tracks[0];
    if (!track?.baseUrl) return "";
    const xmlRes = await fetch(track.baseUrl);
    const xml = await xmlRes.text();
    // Strip XML tags + decode basic entities.
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

async function fetchYouTubeChannelRecent(handleOrId: string, apiKey: string) {
  // Resolve to channelId
  let channelId = handleOrId.startsWith("UC") ? handleOrId : "";
  if (!channelId) {
    const q = handleOrId.replace(/^@/, "");
    const search = await fetch(
      `https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&q=${encodeURIComponent(q)}&maxResults=1&key=${apiKey}`,
    );
    const sj = (await search.json()) as {
      items?: Array<{ snippet: { channelId: string; channelTitle: string } }>;
    };
    channelId = sj.items?.[0]?.snippet.channelId ?? "";
  }
  if (!channelId) throw new Error("Could not resolve YouTube channel.");
  const list = await fetch(
    `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channelId}&maxResults=5&order=date&type=video&key=${apiKey}`,
  );
  const lj = (await list.json()) as {
    items?: Array<{
      id: { videoId: string };
      snippet: { title: string; description: string; channelTitle: string };
    }>;
  };
  const videos = lj.items ?? [];
  if (videos.length === 0) throw new Error("Channel has no recent videos.");
  const channelTitle = videos[0].snippet.channelTitle;
  // Pull transcript for top video, titles+descriptions for the rest.
  const top = videos[0];
  const transcript = await fetchYouTubeTranscript(top.id.videoId);
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
      }
    | undefined;
  if (!it) throw new Error("TikTok post not found.");
  const author = it.authorMeta?.nickName ?? it.authorMeta?.name ?? "TikTok creator";
  const tags = (it.hashtags ?? []).map((h) => `#${h.name}`).join(" ");
  const body =
    `CAPTION/TEXT:\n${it.text ?? ""}\n\n` +
    `HASHTAGS: ${tags}\n` +
    `METRICS: ${it.playCount ?? "?"} views, ${it.diggCount ?? "?"} likes`;
  return { title: `TikTok post by @${author}`, author, transcriptText: body };
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
- Script Writing (A complete, structured 60-second or 5-minute script with Hook, Body, and CTA timestamps).
- Visuals & Editing Guide (Specific Midjourney/Leonardo AI prompts for image generation, and video clip sourcing ideas like Pexels/Wikipedia).
- Voiceover Character (Recommend specific ElevenLabs voice models like 'Adam - deep documentary' or 'Marcus - energetic' with stability/clarity setting recommendations).

Format your output as clean Markdown. Use these exact H2 section headers in this order:
## Channel DNA
## Reusable Master Prompt
## Title Generation
## Script Writing
## Visuals & Editing Guide
## Voiceover Character

Be specific, opinionated, and avoid generic advice. Mirror the source creator's voice precisely.`;

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
      max_tokens: 4000,
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

    if (source.platform === "youtube") {
      if (!ytKey) throw new Error("Missing YOUTUBE_API_KEY.");
      if (source.kind === "video") {
        const meta = await fetchYouTubeVideo(source.id, ytKey);
        const transcript = await fetchYouTubeTranscript(source.id);
        title = meta.snippet.title;
        author = meta.snippet.channelTitle;
        transcriptText =
          `TITLE: ${title}\n` +
          `CHANNEL: ${author}\n` +
          `DESCRIPTION:\n${meta.snippet.description}\n\n` +
          `TRANSCRIPT:\n${transcript || "(transcript not available — analyze from title + description)"}`;
      } else {
        const ch = await fetchYouTubeChannelRecent(source.handleOrId, ytKey);
        title = ch.title;
        author = ch.author;
        transcriptText = ch.transcriptText;
      }
    } else {
      if (!apifyKey) throw new Error("Missing APIFY_API_KEY.");
      if (source.kind === "video") {
        const tt = await fetchTikTokVideo(source.url, apifyKey);
        title = tt.title;
        author = tt.author;
        transcriptText = tt.transcriptText;
      } else {
        const tt = await fetchTikTokProfile(source.username, apifyKey);
        title = tt.title;
        author = tt.author;
        transcriptText = tt.transcriptText;
      }
    }

    // Cap payload to keep token usage sane.
    const trimmed = transcriptText.slice(0, 16000);
    const userPayload =
      `SOURCE: ${source.platform.toUpperCase()} (${source.kind})\n` +
      `URL: ${data.url}\n\n` +
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
      },
      markdown,
    };
  });
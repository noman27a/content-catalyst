import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Toaster, toast } from "sonner";
import {
  Sparkles,
  Wand2,
  Loader2,
  Copy,
  Check,
  Youtube,
  Music2,
  Link as LinkIcon,
  Flame,
  Clock,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { analyzeContent, type ReplicationKit } from "@/lib/analyze.functions";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "ContentForge — Reverse-engineer viral content with AI" },
      {
        name: "description",
        content:
          "Paste any YouTube or TikTok link and get a 100% authentic Content Replication Kit: hooks, scripts, titles, visuals, and voiceover specs.",
      },
      { property: "og:title", content: "ContentForge — Viral Content Replication Kit" },
      {
        property: "og:description",
        content:
          "Reverse-engineer any viral YouTube or TikTok creator into a copy-ready content kit.",
      },
    ],
  }),
  component: Index,
});

const SECTION_ORDER = [
  "Channel DNA",
  "Reusable Master Prompt",
  "Title Generation",
  "Script Writing",
  "Visuals & Editing Guide",
  "Voiceover Character",
] as const;

type SectionKey = (typeof SECTION_ORDER)[number];

function splitMarkdownSections(md: string): Record<SectionKey, string> {
  const out = Object.fromEntries(
    SECTION_ORDER.map((s) => [s, ""]),
  ) as Record<SectionKey, string>;
  // Split on H2 headers
  const parts = md.split(/^##\s+/m);
  for (const p of parts) {
    if (!p.trim()) continue;
    const firstLine = p.split("\n", 1)[0].trim();
    const match = SECTION_ORDER.find(
      (s) => firstLine.toLowerCase() === s.toLowerCase(),
    );
    if (match) {
      out[match] = p.slice(firstLine.length).trim();
    }
  }
  return out;
}

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          toast.success("Copied to clipboard");
          setTimeout(() => setCopied(false), 1500);
        } catch {
          toast.error("Could not copy");
        }
      }}
      className="gap-1.5 border-border/60 bg-secondary/40 hover:bg-secondary"
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? "Copied" : label}
    </Button>
  );
}

function SectionMarkdown({ children }: { children: string }) {
  return (
    <div className="prose prose-invert max-w-none prose-headings:text-foreground prose-p:text-foreground/85 prose-li:text-foreground/85 prose-strong:text-foreground prose-code:rounded prose-code:bg-secondary/60 prose-code:px-1.5 prose-code:py-0.5 prose-code:text-[0.85em] prose-code:text-primary prose-code:before:content-none prose-code:after:content-none prose-pre:bg-secondary/60 prose-pre:border prose-pre:border-border/60 prose-a:text-primary">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children || "_No content for this section._"}</ReactMarkdown>
    </div>
  );
}

function Index() {
  const [url, setUrl] = useState("");
  const analyze = useServerFn(analyzeContent);
  const mutation = useMutation({
    mutationFn: (u: string) => analyze({ data: { url: u } }),
    onError: (err: Error) =>
      toast.error(err.message || "Something went wrong analyzing that link."),
  });

  const sections = useMemo<Record<SectionKey, string> | null>(
    () => (mutation.data ? splitMarkdownSections(mutation.data.markdown) : null),
    [mutation.data],
  );

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = url.trim();
    if (!trimmed) {
      toast.error("Paste a YouTube or TikTok link first.");
      return;
    }
    const lower = trimmed.toLowerCase();
    const looksValid =
      lower.includes("youtube.com") ||
      lower.includes("youtu.be") ||
      lower.includes("tiktok.com");
    if (!looksValid) {
      toast.error("Paste a YouTube or TikTok link first.");
      return;
    }
    mutation.mutate(trimmed);
  };

  return (
    <div className="relative min-h-screen overflow-hidden bg-background text-foreground">
      {/* Ambient gradient backdrop */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-60"
        style={{
          background:
            "radial-gradient(60% 50% at 20% 0%, oklch(0.72 0.19 305 / 0.18), transparent 60%), radial-gradient(50% 40% at 90% 10%, oklch(0.65 0.22 28 / 0.12), transparent 60%)",
        }}
      />
      <Toaster theme="dark" position="top-center" richColors />

      <header className="relative z-10 mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
        <div className="flex items-center gap-2">
          <div
            className="flex h-9 w-9 items-center justify-center rounded-lg"
            style={{ background: "var(--gradient-primary)", boxShadow: "var(--shadow-glow)" }}
          >
            <Flame className="h-5 w-5 text-primary-foreground" />
          </div>
          <span className="text-lg font-semibold tracking-tight">
            Content<span className="text-primary">Forge</span>
          </span>
        </div>
        <Badge variant="secondary" className="hidden gap-1.5 border border-border/60 bg-secondary/50 sm:flex">
          <Sparkles className="h-3 w-3" /> Powered by Claude
        </Badge>
      </header>

      <main className="relative z-10 mx-auto max-w-6xl px-6 pb-24">
        <section className="mx-auto max-w-3xl pt-10 text-center">
          <Badge className="mb-5 border border-border/60 bg-secondary/40 text-foreground/80 hover:bg-secondary/60">
            <Sparkles className="mr-1 h-3 w-3" /> AI Content Reverse-Engineering
          </Badge>
          <h1 className="text-balance text-4xl font-semibold tracking-tight sm:text-5xl">
            Reverse-engineer any viral video into a{" "}
            <span
              className="bg-clip-text text-transparent"
              style={{ backgroundImage: "var(--gradient-primary)" }}
            >
              Replication Kit
            </span>
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-pretty text-muted-foreground">
            Paste a YouTube video, YouTube channel, or TikTok link. ContentForge pulls the
            transcript and produces hooks, titles, full scripts, visual prompts, and
            voiceover specs — in the creator's exact style.
          </p>
        </section>

        <Card
          className="relative mx-auto mt-10 max-w-3xl border-border/60 p-2 backdrop-blur-sm"
          style={{ background: "var(--gradient-surface)" }}
        >
          <form onSubmit={submit} className="flex flex-col gap-2 sm:flex-row">
            <div className="relative flex-1">
              <LinkIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                disabled={mutation.isPending}
                placeholder="https://youtube.com/watch?v=…  or  https://tiktok.com/@creator"
                className="h-12 border-border/40 bg-background/40 pl-10 text-base focus-visible:ring-primary/40"
              />
            </div>
            <Button
              type="submit"
              disabled={mutation.isPending}
              size="lg"
              className="h-12 gap-2 px-5 font-medium text-primary-foreground"
              style={{ background: "var(--gradient-primary)", boxShadow: "var(--shadow-glow)" }}
            >
              {mutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Forging…
                </>
              ) : (
                <>
                  <Wand2 className="h-4 w-4" /> Analyze &amp; Replicate
                </>
              )}
            </Button>
          </form>
          <div className="flex flex-wrap items-center gap-2 px-2 pb-1 pt-3 text-xs text-muted-foreground">
            <span>Examples:</span>
            <button
              type="button"
              onClick={() => setUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")}
              className="inline-flex items-center gap-1 rounded-md border border-border/50 bg-secondary/40 px-2 py-1 hover:bg-secondary"
            >
              <Youtube className="h-3 w-3" /> YouTube video
            </button>
            <button
              type="button"
              onClick={() => setUrl("https://www.youtube.com/@MrBeast")}
              className="inline-flex items-center gap-1 rounded-md border border-border/50 bg-secondary/40 px-2 py-1 hover:bg-secondary"
            >
              <Youtube className="h-3 w-3" /> YouTube channel
            </button>
            <button
              type="button"
              onClick={() => setUrl("https://www.tiktok.com/@khaby.lame")}
              className="inline-flex items-center gap-1 rounded-md border border-border/50 bg-secondary/40 px-2 py-1 hover:bg-secondary"
            >
              <Music2 className="h-3 w-3" /> TikTok profile
            </button>
          </div>
        </Card>

        {mutation.isPending && <PendingState />}

        {sections && mutation.data && (
          <ResultView kit={mutation.data} sections={sections} />
        )}

        {!mutation.isPending && !mutation.data && <FeaturePreview />}
      </main>
    </div>
  );
}

function PendingState() {
  return (
    <Card
      className="mx-auto mt-10 max-w-3xl border-border/60 p-8"
      style={{ background: "var(--gradient-surface)" }}
    >
      <div className="flex flex-col items-center gap-3 text-center">
        <div className="relative">
          <div
            className="absolute inset-0 animate-ping rounded-full opacity-40"
            style={{ background: "var(--gradient-primary)" }}
          />
          <div
            className="relative flex h-12 w-12 items-center justify-center rounded-full"
            style={{ background: "var(--gradient-primary)" }}
          >
            <Loader2 className="h-6 w-6 animate-spin text-primary-foreground" />
          </div>
        </div>
        <p className="text-sm font-medium">Pulling transcript and forging your kit…</p>
        <p className="text-xs text-muted-foreground">
          Fetching content → cleaning transcript → Claude is writing your Replication Kit.
        </p>
      </div>
    </Card>
  );
}

function ResultView({
  kit,
  sections,
}: {
  kit: ReplicationKit;
  sections: Record<SectionKey, string>;
}) {
  return (
    <section className="mx-auto mt-10 max-w-5xl">
      <Card
        className="mb-6 border-border/60 p-5"
        style={{ background: "var(--gradient-surface)" }}
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">
              {kit.source.platform === "youtube" ? (
                <Youtube className="h-3.5 w-3.5" />
              ) : (
                <Music2 className="h-3.5 w-3.5" />
              )}
              {kit.source.platform}
              {kit.source.author && <span>· {kit.source.author}</span>}
            </div>
            <h2 className="mt-1 text-xl font-semibold tracking-tight">
              {kit.source.title}
            </h2>
          </div>
          <CopyButton text={kit.markdown} label="Copy full kit" />
        </div>
        {kit.source.durationLabel && (
          <div className="mt-3 flex items-center gap-2 rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-xs text-foreground/90">
            <Clock className="h-3.5 w-3.5 text-primary" />
            <span>
              Analyzed Video Duration:{" "}
              <span className="font-semibold">{kit.source.durationLabel}</span>.
              Generated Replication Kit matches the full duration.
            </span>
          </div>
        )}
      </Card>

      <Tabs defaultValue={SECTION_ORDER[0]} className="w-full">
        <TabsList className="flex h-auto w-full flex-wrap justify-start gap-1 bg-secondary/40 p-1">
          {SECTION_ORDER.map((s) => (
            <TabsTrigger
              key={s}
              value={s}
              className="data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
            >
              {s}
            </TabsTrigger>
          ))}
        </TabsList>

        {SECTION_ORDER.map((s) => (
          <TabsContent key={s} value={s} className="mt-4">
            <Card
              className="border-border/60 p-6"
              style={{ background: "var(--gradient-surface)" }}
            >
              <div className="mb-4 flex items-center justify-between">
                <h3 className="text-lg font-semibold tracking-tight">{s}</h3>
                <CopyButton text={sections[s]} label={`Copy ${s}`} />
              </div>
              <SectionMarkdown>{sections[s]}</SectionMarkdown>
            </Card>
          </TabsContent>
        ))}
      </Tabs>
    </section>
  );
}

function FeaturePreview() {
  const items = [
    {
      icon: Sparkles,
      title: "Channel DNA",
      body: "Tone, vibe, audience and hook strategy — pinpointed.",
    },
    {
      icon: Wand2,
      title: "Reusable Master Prompt",
      body: "A copy-paste prompt to generate more scripts in this exact style.",
    },
    {
      icon: Flame,
      title: "Scripts + Visuals + Voice",
      body: "Full script with timestamps, Midjourney prompts, ElevenLabs voice picks.",
    },
  ];
  return (
    <section className="mx-auto mt-14 grid max-w-5xl gap-4 sm:grid-cols-3">
      {items.map((f) => (
        <Card
          key={f.title}
          className="border-border/60 p-5"
          style={{ background: "var(--gradient-surface)" }}
        >
          <div
            className="mb-3 flex h-9 w-9 items-center justify-center rounded-md"
            style={{ background: "var(--gradient-primary)" }}
          >
            <f.icon className="h-4 w-4 text-primary-foreground" />
          </div>
          <h3 className="text-sm font-semibold">{f.title}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{f.body}</p>
        </Card>
      ))}
    </section>
  );
}

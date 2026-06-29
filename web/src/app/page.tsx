import Link from "next/link";
import {
  Sparkles,
  ArrowRight,
  Smartphone,
  MessageCircle,
  Mic,
  Paperclip,
  Search,
  FileText,
  GitBranch,
  Shield,
  Lock,
  Infinity as InfinityIcon,
} from "lucide-react";

export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center text-foreground">
      {/* ===== Top bar ===== */}
      <header className="sticky top-0 z-30 w-full border-b border-black/10 bg-white/70 backdrop-blur-md dark:border-white/10 dark:bg-black/40">
        <nav
          aria-label="Primary"
          className="mx-auto flex w-full max-w-5xl items-center justify-between px-5 py-3.5"
        >
          <Link
            href="/"
            className="group flex items-center gap-2.5 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            aria-label="EverVault home"
          >
            <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-linear-to-br from-blue-500 to-violet-500 shadow-sm">
              <Sparkles className="h-4 w-4 text-white" aria-hidden="true" />
            </span>
            <span className="text-[15px] font-semibold tracking-tight">EverVault</span>
          </Link>
          <Link
            href="/webapp"
            className="inline-flex items-center gap-1.5 rounded-full bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            Open the web app
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        </nav>
      </header>

      {/* ===== Hero ===== */}
      <section className="relative w-full overflow-hidden px-5">
        {/* soft blue->violet ambient glow, the page's single light source */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute left-1/2 top-[-6rem] -z-10 h-[34rem] w-[44rem] max-w-[120vw] -translate-x-1/2 rounded-full bg-linear-to-br from-blue-500/25 to-violet-500/25 blur-[120px] dark:from-blue-500/20 dark:to-violet-500/20"
        />

        <div className="mx-auto flex w-full max-w-3xl flex-col items-center pt-24 pb-20 text-center sm:pt-32 sm:pb-28">
          <span className="inline-flex items-center gap-2 rounded-full bg-blue-100 px-3.5 py-1.5 text-xs font-medium text-blue-700 dark:bg-blue-900/40 dark:text-blue-200">
            <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
            Your personal memory AI
          </span>

          <h1 className="mt-7 text-balance text-5xl font-semibold tracking-tight sm:text-6xl">
            Remember everything.
            <br />
            <span className="bg-linear-to-br from-blue-500 to-violet-500 bg-clip-text text-transparent">
              Carry nothing.
            </span>
          </h1>

          <p className="mt-6 max-w-xl text-pretty text-base leading-relaxed text-black/60 dark:text-white/60 sm:text-lg">
            EverVault is a private place that quietly remembers your conversations,
            ideas, and moments — and helps you find them again whenever you need.
            Talk to it like a friend who never forgets.
          </p>

          <div className="mt-9 flex flex-col items-center gap-3 sm:flex-row sm:gap-4">
            <Link
              href="/webapp"
              className="inline-flex items-center gap-2 rounded-full bg-blue-600 px-6 py-3 text-sm font-medium text-white shadow-md transition-colors hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              Open the web app
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Link>
            <span
              className="inline-flex cursor-default select-none items-center gap-2 rounded-full border border-black/10 bg-white/70 px-5 py-3 text-sm text-black/60 shadow-sm backdrop-blur dark:border-white/10 dark:bg-white/5 dark:text-white/60"
              aria-label="iPhone and Android apps coming soon"
            >
              <Smartphone className="h-4 w-4" aria-hidden="true" />
              iPhone &amp; Android — coming soon
            </span>
          </div>

          <p className="mt-5 text-xs text-black/50 dark:text-white/50">
            Private by design · Yours alone · Nothing forgotten
          </p>

          {/* ===== Floating product hint card (decorative) ===== */}
          <div aria-hidden="true" className="mt-16 w-full max-w-xl text-left">
            <div className="rounded-2xl border border-black/10 bg-white/80 p-5 shadow-sm backdrop-blur dark:border-white/10 dark:bg-white/5 sm:p-6">
              {/* memory timeline */}
              <div className="mb-5 flex items-start gap-3">
                <div className="flex flex-col items-center pt-1">
                  <span className="h-2 w-2 rounded-full bg-linear-to-br from-blue-500 to-violet-500" />
                  <span className="my-1 h-8 w-px bg-black/10 dark:bg-white/10" />
                  <span className="h-2 w-2 rounded-full bg-black/20 dark:bg-white/20" />
                  <span className="my-1 h-8 w-px bg-black/10 dark:bg-white/10" />
                  <span className="h-2 w-2 rounded-full bg-black/20 dark:bg-white/20" />
                </div>
                <div className="flex-1 space-y-3 text-sm">
                  <div>
                    <div className="font-mono text-[11px] uppercase tracking-wide text-black/50 dark:text-white/50">
                      Tue · 9:41
                    </div>
                    <div className="text-black/75 dark:text-white/75">
                      Idea for the spring trip — somewhere by the coast.
                    </div>
                  </div>
                  <div>
                    <div className="font-mono text-[11px] uppercase tracking-wide text-black/50 dark:text-white/50">
                      Fri · 18:20
                    </div>
                    <div className="text-black/75 dark:text-white/75">
                      Booked the cottage. Felt good to finally decide.
                    </div>
                  </div>
                </div>
              </div>

              <div className="h-px w-full bg-black/10 dark:bg-white/10" />

              {/* recall exchange */}
              <div className="mt-5 space-y-3">
                <div className="flex justify-end">
                  <div className="max-w-[80%] rounded-2xl rounded-br-md bg-blue-600 px-4 py-2.5 text-sm text-white">
                    What was that coast trip I was planning?
                  </div>
                </div>
                <div className="flex items-end gap-2">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-linear-to-br from-blue-500 to-violet-500 shadow-sm">
                    <Sparkles className="h-3.5 w-3.5 text-white" aria-hidden="true" />
                  </span>
                  <div className="max-w-[80%] rounded-2xl rounded-bl-md border border-black/10 bg-white/90 px-4 py-2.5 text-sm text-black/80 dark:border-white/10 dark:bg-white/10 dark:text-white/85">
                    The coastal cottage — you booked it last Friday. Want me to pull
                    up your notes?
                  </div>
                </div>
              </div>

              {/* slim composer */}
              <div className="mt-5 flex items-center gap-2 rounded-full border border-black/10 bg-black/[0.03] px-4 py-2.5 dark:border-white/10 dark:bg-white/5">
                <span className="flex-1 text-sm text-black/45 dark:text-white/45">
                  Say anything…
                </span>
                <Paperclip className="h-4 w-4 text-black/45 dark:text-white/45" aria-hidden="true" />
                <Mic className="h-4 w-4 text-black/45 dark:text-white/45" aria-hidden="true" />
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ===== How it feels ===== */}
      <section
        aria-labelledby="feel-heading"
        className="w-full border-t border-black/10 px-5 dark:border-white/10"
      >
        <div className="mx-auto w-full max-w-3xl py-24 text-center sm:py-28">
          <h2
            id="feel-heading"
            className="text-3xl font-semibold tracking-tight sm:text-4xl"
          >
            A calmer way to hold your own life
          </h2>
          <p className="mx-auto mt-6 max-w-2xl text-pretty text-base leading-relaxed text-black/60 dark:text-white/60 sm:text-lg">
            Most days move faster than we can keep up with. A thought here, a plan
            there, a moment you meant to come back to. EverVault catches all of it.
            You simply talk — and it listens, keeps, and gently connects the threads,
            so the things that matter to you are always within reach.
          </p>
        </div>
      </section>

      {/* ===== What it does ===== */}
      <section
        aria-labelledby="features-heading"
        className="w-full border-t border-black/10 px-5 dark:border-white/10"
      >
        <div className="mx-auto w-full max-w-5xl py-24 sm:py-28">
          <div className="mx-auto max-w-2xl text-center">
            <h2
              id="features-heading"
              className="text-3xl font-semibold tracking-tight sm:text-4xl"
            >
              Quietly capable, never in the way
            </h2>
            <p className="mt-5 text-base leading-relaxed text-black/60 dark:text-white/60">
              Everything you need to keep your life close — and nothing you don&apos;t.
            </p>
          </div>

          <div className="mt-14 grid grid-cols-1 gap-5 sm:grid-cols-2">
            {[
              {
                Icon: MessageCircle,
                title: "Talk naturally",
                body: "Have a real conversation by text or voice, and EverVault remembers it all.",
              },
              {
                Icon: Search,
                title: "Find any moment",
                body: "Ask about something you mentioned weeks ago and it surfaces in seconds.",
              },
              {
                Icon: FileText,
                title: "Everything in one place",
                body: "Bring in your notes and files; they live alongside your conversations.",
              },
              {
                Icon: GitBranch,
                title: "Reflect over time",
                body: "See how your thoughts, plans, and ideas grow and connect as the days go by.",
              },
            ].map(({ Icon, title, body }) => (
              <div
                key={title}
                className="rounded-2xl border border-black/10 bg-white/70 p-6 shadow-sm backdrop-blur transition-shadow hover:shadow-md dark:border-white/10 dark:bg-white/5"
              >
                <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-linear-to-br from-blue-500 to-violet-500 shadow-sm">
                  <Icon className="h-5 w-5 text-white" aria-hidden="true" />
                </span>
                <h3 className="mt-4 text-lg font-semibold tracking-tight">{title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-black/60 dark:text-white/60">
                  {body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ===== Not a social app ===== */}
      <section
        aria-labelledby="just-you-heading"
        className="w-full border-t border-black/10 px-5 dark:border-white/10"
      >
        <div className="mx-auto w-full max-w-3xl py-24 text-center sm:py-28">
          <h2
            id="just-you-heading"
            className="text-3xl font-semibold tracking-tight sm:text-4xl"
          >
            Just for you. Only for you.
          </h2>
          <p className="mx-auto mt-6 max-w-2xl text-pretty text-base leading-relaxed text-black/60 dark:text-white/60 sm:text-lg">
            EverVault isn&apos;t a social network and it isn&apos;t here to entertain
            you. There&apos;s no feed, no audience, no noise. It&apos;s a quiet,
            personal space built for one purpose: helping you understand your own
            life a little better, one conversation at a time.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-2.5">
            {["No feed", "No audience", "No noise"].map((t) => (
              <span
                key={t}
                className="rounded-full border border-black/10 bg-white/70 px-3.5 py-1.5 text-xs font-medium text-black/60 backdrop-blur dark:border-white/10 dark:bg-white/5 dark:text-white/60"
              >
                {t}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* ===== Privacy & safety ===== */}
      <section
        aria-labelledby="privacy-heading"
        className="w-full border-t border-black/10 px-5 dark:border-white/10"
      >
        <div className="mx-auto w-full max-w-3xl py-24 sm:py-28">
          <div className="rounded-2xl border border-black/10 bg-white/70 p-8 text-center shadow-sm backdrop-blur dark:border-white/10 dark:bg-white/5 sm:p-12">
            <span className="mx-auto inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-linear-to-br from-blue-500 to-violet-500 shadow-sm">
              <Shield className="h-6 w-6 text-white" aria-hidden="true" />
            </span>
            <h2
              id="privacy-heading"
              className="mt-6 text-3xl font-semibold tracking-tight sm:text-4xl"
            >
              A safe place for everything you share
            </h2>
            <p className="mx-auto mt-6 max-w-2xl text-pretty text-base leading-relaxed text-black/60 dark:text-white/60 sm:text-lg">
              Your thoughts, conversations, and memories are yours alone — kept
              private and protected, and never treated as something to sell.
              EverVault is built to be the one place where nothing you say is ever
              lost, and nothing you trust it with is ever shared.
            </p>
            <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
              {[
                { Icon: Lock, label: "Yours alone" },
                { Icon: Shield, label: "Always private" },
                { Icon: InfinityIcon, label: "Never forgotten" },
              ].map(({ Icon, label }) => (
                <span
                  key={label}
                  className="inline-flex items-center gap-2 rounded-full border border-black/10 bg-black/[0.02] px-4 py-2 text-sm text-black/70 dark:border-white/10 dark:bg-white/5 dark:text-white/70"
                >
                  <Icon className="h-4 w-4 text-blue-600 dark:text-blue-400" aria-hidden="true" />
                  {label}
                </span>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ===== Get started ===== */}
      <section
        aria-labelledby="cta-heading"
        className="relative w-full overflow-hidden border-t border-black/10 px-5 dark:border-white/10"
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute left-1/2 top-1/2 -z-10 h-80 w-[40rem] max-w-[120vw] -translate-x-1/2 -translate-y-1/2 rounded-full bg-linear-to-br from-blue-500/20 to-violet-500/20 blur-[120px]"
        />
        <div className="mx-auto w-full max-w-3xl py-28 text-center sm:py-32">
          <h2
            id="cta-heading"
            className="text-balance text-4xl font-semibold tracking-tight sm:text-5xl"
          >
            Your memory, ready when you are
          </h2>
          <p className="mx-auto mt-6 max-w-xl text-pretty text-base leading-relaxed text-black/60 dark:text-white/60 sm:text-lg">
            Start a conversation today, right from your browser — no setup, no
            clutter. The iPhone and Android apps are coming soon, so your memory
            will travel with you wherever you go.
          </p>
          <div className="mt-10 flex flex-col items-center gap-3 sm:flex-row sm:justify-center sm:gap-4">
            <Link
              href="/webapp"
              className="inline-flex items-center gap-2 rounded-full bg-blue-600 px-7 py-3.5 text-sm font-medium text-white shadow-md transition-colors hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              Open the web app
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Link>
            <span
              className="inline-flex cursor-default select-none items-center gap-2 rounded-full border border-black/10 bg-white/70 px-5 py-3.5 text-sm text-black/60 shadow-sm backdrop-blur dark:border-white/10 dark:bg-white/5 dark:text-white/60"
              aria-label="iPhone and Android apps coming soon"
            >
              <Smartphone className="h-4 w-4" aria-hidden="true" />
              iPhone &amp; Android — coming soon
            </span>
          </div>
        </div>
      </section>

      {/* ===== Footer ===== */}
      <footer className="w-full border-t border-black/10 px-5 dark:border-white/10">
        <div className="mx-auto flex w-full max-w-5xl flex-col items-center gap-6 py-12 text-center sm:flex-row sm:justify-between sm:text-left">
          <div className="flex items-center gap-2.5">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-linear-to-br from-blue-500 to-violet-500 shadow-sm">
              <Sparkles className="h-3.5 w-3.5 text-white" aria-hidden="true" />
            </span>
            <span className="text-sm font-semibold tracking-tight">EverVault</span>
          </div>
          <p className="max-w-md text-sm text-black/60 dark:text-white/60">
            A safe place where your thoughts, conversations, and memories are never
            lost.
          </p>
        </div>
      </footer>
    </main>
  );
}

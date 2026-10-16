import { PauseIcon, PlayIcon } from "@phosphor-icons/react";
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import harshil from "./avatars/harshil1712.jpg?w=96&format=webp";
import hieu from "./avatars/hieussr.jpg?w=96&format=webp";
import mehdi from "./avatars/hiimmehdi.jpg?w=96&format=webp";
import salina from "./avatars/inababi.jpg?w=96&format=webp";
import mihaly from "./avatars/mihaly_calycode.jpg?w=96&format=webp";
import phil from "./avatars/philhawksworth.jpg?w=96&format=webp";
import rose from "./avatars/rose__celestial.jpg?w=96&format=webp";
import theo from "./avatars/theozero.jpg?w=96&format=webp";
import yosef from "./avatars/yoseforschwartz.jpg?w=96&format=webp";

/**
 * Posts on X about Appflare, word for word less the leading @-mentions of a
 * reply and a trailing link. The avatars are copies kept here, so the page
 * loads nothing from X.
 */
interface Testimonial {
  name: string;
  handle: string;
  /** From their own profile, when it says what they do. */
  role?: string;
  text: string;
  date: string;
  url: string;
  avatar: string;
}

const testimonials: Testimonial[] = [
  {
    name: "Harshil",
    handle: "harshil1712",
    role: "Developer Relations, Cloudflare",
    text: "This is an incredible idea!",
    date: "Oct 14, 2026",
    url: "https://x.com/harshil1712/status/2110388367321886885",
    avatar: harshil,
  },
  {
    name: "Phil Hawksworth",
    handle: "philhawksworth",
    role: "Developer Adoption, Cloudflare",
    text: "Genius!",
    date: "Oct 14, 2026",
    url: "https://x.com/philhawksworth/status/2110430866518556801",
    avatar: phil,
  },
  {
    name: "Theo Ephraim",
    handle: "theozero",
    role: "Building varlock.dev",
    text: "This is pretty neat!",
    date: "Oct 14, 2026",
    url: "https://x.com/theozero/status/2110364251005304996",
    avatar: theo,
  },
  {
    name: "Yosef Schwartz",
    handle: "yoseforschwartz",
    role: "Co-founder, Jimmy",
    text: "That's really cool! I've been waiting for this! 😊",
    date: "Oct 9, 2026",
    url: "https://x.com/yoseforschwartz/status/2108454589980635499",
    avatar: yosef,
  },
  {
    name: "Mihály Tóth",
    handle: "mihaly_calycode",
    role: "Creator of calycode",
    text: "Must-have for orange people",
    date: "Oct 9, 2026",
    url: "https://x.com/mihaly_calycode/status/2108668132965662794",
    avatar: mihaly,
  },
  {
    name: "Mehdi",
    handle: "hiimmehdi",
    text: "super cool idea, go give it a look !",
    date: "Oct 9, 2026",
    url: "https://x.com/hiimmehdi/status/2108510692441784496",
    avatar: mehdi,
  },
  {
    name: "Celestial Rose",
    handle: "Rose__Celestial",
    text: "omg\nthis is serverless @coolifyio",
    date: "Oct 9, 2026",
    url: "https://x.com/Rose__Celestial/status/2108458486308962695",
    avatar: rose,
  },
  {
    name: "Salina Mendoza",
    handle: "inababi",
    role: "Product Engineer, Cloudflare",
    text: "OK Mendy ❤️‍🔥❤️‍🔥❤️‍🔥 love this",
    date: "Oct 15, 2026",
    url: "https://x.com/inababi/status/2110523824290853060",
    avatar: salina,
  },
  {
    name: "Hieu",
    handle: "hieuSSR",
    role: "Indie dev, Mailflare",
    text: "In case you're into cloudflare 👀",
    date: "Oct 9, 2026",
    url: "https://x.com/hieuSSR/status/2108442162719523049",
    avatar: hieu,
  },
];

/** How long the front post stays before the next one comes forward. */
const ADVANCE_MS = 2800;

/** How many posts show behind the front one. */
const BEHIND = 2;

/**
 * What people said on X, as a tilted stack of posts styled like X's own. The
 * stack goes through every post on its own, one every few seconds, while it is
 * on screen. A ring around the front post's face fills until the next one.
 * Picking a face, or clicking a post behind the front one, shows that post and
 * carries on from it; the button beside the faces pauses it, and so does
 * keyboard focus inside the section, so a post does not move away from it.
 */
export function Testimonials({ heading }: { heading: ReactNode }) {
  const count = testimonials.length;
  const [front, setFront] = useState(0);
  const [paused, setPaused] = useState(false);
  const [visible, setVisible] = useState(false);
  const [keyboardFocus, setKeyboardFocus] = useState(false);
  const section = useRef<HTMLElement>(null);
  const playing = visible && !paused && !keyboardFocus;

  useEffect(() => {
    const element = section.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      // The threshold only decides when this runs: a sliver on screen still "intersects".
      ([entry]) => setVisible((entry?.intersectionRatio ?? 0) >= 0.25),
      { threshold: 0.25 },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // A new timer for every post, so a picked post gets its whole turn.
  useEffect(() => {
    if (!playing) return;
    const timer = setTimeout(() => setFront((front + 1) % count), ADVANCE_MS);
    return () => clearTimeout(timer);
  }, [playing, front]);

  const current = testimonials[front];

  return (
    <section
      ref={section}
      aria-label="What people are saying"
      // A click focuses a face too, but only focus from the keyboard holds the stack.
      onFocus={(event) => setKeyboardFocus(event.target.matches(":focus-visible"))}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setKeyboardFocus(false);
      }}
      className="mx-auto grid w-full max-w-6xl items-center gap-12 overflow-x-clip px-4 pt-24 md:px-6 lg:grid-cols-[5fr_7fr] lg:gap-8"
    >
      <div className="grid gap-8">
        {heading}
        <div className="flex items-center">
          {testimonials.map((t, i) => (
            <button
              key={t.handle}
              type="button"
              aria-label={`Show ${t.name}'s post`}
              aria-pressed={i === front}
              onClick={() => setFront(i)}
              className={`relative grid size-11 shrink-0 place-items-center rounded-full first:ml-0 -ml-3.5 transition-transform duration-300 focus-visible:outline-2 focus-visible:outline-fd-ring focus-visible:outline-offset-2 motion-reduce:transition-none sm:-ml-2 ${i === front ? "z-10 -translate-y-1" : "hover:z-10 hover:-translate-y-0.5"}`}
            >
              <img
                src={t.avatar}
                alt=""
                width={40}
                height={40}
                loading="lazy"
                decoding="async"
                className="size-10 rounded-full border-2 border-fd-background bg-fd-muted"
              />
              {i === front && <ProgressRing key={`${front}-${playing}`} running={playing} />}
            </button>
          ))}
          <button
            type="button"
            aria-label={paused ? "Play the posts" : "Pause the posts"}
            onClick={() => setPaused(!paused)}
            className="ml-2 grid size-11 shrink-0 place-items-center rounded-full text-fd-muted-foreground transition-colors hover:bg-fd-accent hover:text-fd-foreground focus-visible:outline-2 focus-visible:outline-fd-ring focus-visible:outline-offset-2 sm:ml-3"
          >
            {paused ? (
              <PlayIcon weight="fill" className="size-4" />
            ) : (
              <PauseIcon weight="fill" className="size-4" />
            )}
          </button>
        </div>
      </div>

      <div className="[perspective:1800px]">
        <div className="grid pt-[2.75rem] pr-2 pl-[2.25rem] sm:pr-0 [--dx:-0.875rem] [--dy:-1.375rem] [transform:rotateX(6deg)_rotateZ(-2deg)] sm:pt-20 sm:pl-24 sm:[--dx:-3rem] sm:[--dy:-2.5rem] lg:[transform:rotateX(8deg)_rotateY(-7deg)_rotateZ(-2.5deg)] lg:pl-32 lg:[--dx:-4rem] lg:[--dy:-3rem]">
          {testimonials.map((t, i) => (
            <Post
              key={t.handle}
              t={t}
              depth={(i - front + count) % count}
              count={count}
              onBring={() => setFront(i)}
            />
          ))}
        </div>
      </div>

      {/* Read out only while paused: a screen reader would otherwise talk every few seconds. */}
      <p aria-live="polite" className="sr-only">
        {paused && current ? `${current.name}: ${current.text}` : ""}
      </p>
    </section>
  );
}

/**
 * The orange ring around the front post's face. While the stack plays it
 * draws itself in the time the post has left (the front page's arrow
 * animation, reused); held or paused, it is whole.
 */
function ProgressRing({ running }: { running: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 44 44"
      className="pointer-events-none absolute inset-0 size-11 -rotate-90"
    >
      <circle cx="22" cy="22" r="21" fill="none" strokeWidth="2" className="stroke-[#fb6b00]/25" />
      <circle
        cx="22"
        cy="22"
        r="21"
        fill="none"
        strokeWidth="2"
        strokeLinecap="round"
        pathLength={1}
        className="stroke-[#fb6b00]"
        style={running ? { animation: `click-here-draw ${ADVANCE_MS}ms linear both` } : undefined}
      />
    </svg>
  );
}

/**
 * Where a post sits in the stack. The front one is at depth 0; the one that
 * just left (the last depth) flies off toward the visitor, so stepping back
 * brings it in from there; those further back wait out of sight.
 */
function placement(depth: number, count: number): { style: CSSProperties; content: number } {
  const step = (d: number, scale: number) =>
    `translate3d(calc(var(--dx) * ${d}), calc(var(--dy) * ${d}), 0) scale(${scale})`;
  if (depth === count - 1) {
    return {
      style: { transform: `${step(-1.2, 1.04)}`, opacity: 0, zIndex: count + 1 },
      content: 1,
    };
  }
  if (depth > BEHIND) {
    return {
      style: { transform: step(BEHIND + 1, 1 - (BEHIND + 1) * 0.05), opacity: 0, zIndex: 0 },
      content: 0,
    };
  }
  return {
    style: { transform: step(depth, 1 - depth * 0.05), opacity: 1, zIndex: count - depth },
    content: depth === 0 ? 1 : depth === 1 ? 0.4 : 0.2,
  };
}

/**
 * One post, laid out as X lays out a post: face, name and handle, the X mark,
 * the words, then the date. The front post's date is the link to the post,
 * stretched over the whole card. A post showing behind it comes to the front
 * when clicked; keyboards and screen readers reach every post through the faces
 * instead.
 */
function Post({
  t,
  depth,
  count,
  onBring,
}: {
  t: Testimonial;
  depth: number;
  count: number;
  onBring: () => void;
}) {
  const { style, content } = placement(depth, count);
  const isFront = depth === 0;
  const isBehind = depth > 0 && depth <= BEHIND;
  return (
    <article
      inert={!isFront && !isBehind}
      aria-hidden={!isFront}
      style={style}
      className="group/post relative col-start-1 row-start-1 w-full max-w-[30rem] origin-bottom-left rounded-2xl border border-[#cfd9de] bg-white text-[#0f1419] shadow-[0_1px_2px_rgba(15,20,25,0.06),0_24px_48px_-24px_rgba(15,20,25,0.25)] transition-[transform,opacity] duration-700 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-opacity dark:border-[#2f3336] dark:bg-black dark:text-[#e7e9ea] dark:shadow-[0_24px_48px_-24px_rgba(0,0,0,0.8)]"
    >
      <div
        style={{ opacity: content }}
        className={`grid gap-3 p-5 transition-opacity duration-500 sm:p-6 ${isBehind ? "pointer-events-none group-hover/post:!opacity-70" : ""}`}
      >
        <div className="flex items-start gap-3">
          <img
            src={t.avatar}
            alt=""
            width={48}
            height={48}
            loading="lazy"
            decoding="async"
            className="size-12 shrink-0 rounded-full bg-[#eff3f4] dark:bg-[#16181c]"
          />
          <span className="grid min-w-0 grow leading-snug">
            <span className="truncate font-bold text-[15px] sm:text-base">{t.name}</span>
            <span className="truncate text-[#536471] text-[15px] dark:text-[#71767b]">
              @{t.handle}
            </span>
          </span>
          <XLogo className="size-5 shrink-0 sm:size-6" />
        </div>
        <blockquote
          cite={t.url}
          className="m-0 whitespace-pre-line text-[17px] leading-normal sm:text-xl"
        >
          {t.text}
        </blockquote>
        <div className="flex items-center justify-between gap-4 text-[#536471] text-sm dark:text-[#71767b]">
          <a
            href={t.url}
            target="_blank"
            rel="noopener noreferrer"
            tabIndex={isFront ? undefined : -1}
            className="shrink-0 hover:underline after:absolute after:inset-0 after:rounded-2xl focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-fd-ring focus-visible:after:outline-offset-2"
          >
            {t.date}
            <span className="sr-only">, the post on X</span>
          </a>
          {t.role && <span className="truncate text-right">{t.role}</span>}
        </div>
      </div>
      {isBehind && (
        <button
          type="button"
          tabIndex={-1}
          onClick={onBring}
          className="absolute inset-0 cursor-pointer rounded-2xl"
        >
          <span className="sr-only">Show {t.name}'s post</span>
        </button>
      )}
    </article>
  );
}

/** X's mark, drawn inline so it loads nothing. */
function XLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor" className={className}>
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

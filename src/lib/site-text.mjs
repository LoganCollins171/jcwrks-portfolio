// Site text Jacob can edit in /admin ("Site text"). One list, used by the site build
// (src/lib/copy.ts), the /admin backend and, through the API, the /admin page.
// Keep this file dependency-free.
//
// Stored in src/data/copy.json as { "text": { "<key>": "<wording>" } }. A key that is
// missing, empty or invalid falls back to `default`, which is the site's original wording,
// so an empty file renders the site exactly as it was.
//
// kind "line":       one line of plain text; whitespace collapses to single spaces.
// kind "paragraphs": plain text paragraphs separated by a blank line.

export const PAGES = [
  { id: "home", label: "Home", path: "/" },
  { id: "work", label: "Photo & Video", path: "/photo-video/" },
  { id: "categories", label: "Categories", path: "/photo-video/" },
  { id: "about", label: "About", path: "/about/" },
  { id: "contact", label: "Contact", path: "/contact/" },
  { id: "call", label: "Call", path: "/call/" },
  { id: "thanks", label: "Thanks", path: "/thanks/" },
  { id: "footer", label: "Footer", path: "/" },
];

const line = (page, key, label, max, def, extra = {}) => ({ page, key, label, kind: "line", max, default: def, ...extra });

export const FIELDS = [
  line("home", "home.hero.kicker", "Small heading above your name", 28, "Freelance Photographer"),
  line("home", "home.hero.intro", "Intro next to your photo", 120, "A collection of creativity, passion & perspective — a look at the shots I love most."),
  line("home", "home.statement.label", "Statement label", 24, "The approach", { help: "The small heading above the big statement." }),
  line("home", "home.statement.lead", "Statement, first part (grey)", 90, "Nothing beats freezing the moment everyone's going to remember —"),
  line("home", "home.statement.emphasis", "Statement, middle part (dark)", 90, "the big plays, the real emotion, the stuff you'll want to look back on."),
  line("home", "home.statement.tail", "Statement, last part (grey)", 60, "Shot clean. That's what I'm here for."),

  line("work", "work.intro", "Intro under “My Work”", 120, "Pick a category to dive in — every gallery is a real moment, frozen."),

  ...[
    ["sports", "Sports", "Where I Do My Best Work — Game On The Line, Everything To Play For."],
    ["portraits", "Portraits", "Real People, Real Personality — Let's Make You Look Good."],
    ["landscape", "Landscape", "When The Scenery's Too Good Not To Shoot."],
    ["cars", "Cars", "Clean Builds And Good Light — My Kind Of Detail Work."],
    ["graphics", "Graphics", "Commitments, Game Day, Senior Night — I'll Design It For You."],
  ].map(([slug, title, def]) => line("categories", `categories.${slug}.blurb`, title, 90, def, {
    help: "Shown on the category tile and at the top of its page. Tiles fit about two lines.",
    path: slug === "sports" ? "/work/sports/" : `/work/${slug}/`,
  })),

  line("about", "about.headline.muted", "Headline, grey part", 70, "Jacob Combs is a sports photographer who turns"),
  line("about", "about.headline.strong", "Headline, dark part", 70, "split-seconds into shots worth keeping."),
  line("about", "about.bio.heading", "Bio heading", 100, "I know how much a single picture can truly mean to someone."),
  {
    page: "about", key: "about.bio.body", label: "Bio", kind: "paragraphs", max: 600, maxParagraphs: 6,
    help: "Leave an empty line between paragraphs.",
    default: [
      "It started with my mom's camera. I picked it up, started shooting some of my buddies' games, and one thing led to another — a few clients turned into more, and it's grown from there.",
      "I love shooting sports because I grew up an athlete, so I know how much a single picture can truly mean to someone. That's what keeps me chasing the moment every time I'm out there.",
      "Working with me is easy — I keep the mood light and I want you smiling the whole time. I'm always trying to learn more about my clients to make a real connection, because to me it's more than just pictures. It's the human side of it, and getting a genuine smile out of you.",
      "Off the clock, I'm a sophomore at Michigan State in the Eli Broad College of Business, majoring in marketing.",
    ].join("\n\n"),
  },
  line("about", "about.lens.label", "Photo caption label", 24, "Behind the lens"),
  line("about", "about.lens.muted", "Photo caption, grey part", 50, "Camera in hand,"),
  line("about", "about.lens.strong", "Photo caption, dark part", 50, "right where I belong."),

  line("contact", "contact.headline.muted", "Headline, grey part", 50, "Ready to create something?"),
  line("contact", "contact.headline.strong", "Headline, dark part", 30, "Let's talk."),
  line("contact", "contact.call.lead", "Call box heading", 40, "Prefer a quick chat?"),
  line("contact", "contact.call.body", "Call box text", 140, "Pick a time that works and we'll hop on a quick call about your shoot."),
  line("contact", "contact.call.duration", "Call length", 20, "≈ 15 minutes", { help: "Keep this matching the length of your booking calendar's call." }),
  line("contact", "site.responseTime", "Reply time", 30, "within 24 hours", {
    help: "Finishes “I reply …” here and “I'll get back to you …” on the Thanks page.",
    also: ["/thanks/"],
  }),
  line("contact", "site.coverage", "Where you work", 60, "Metro Detroit & East Lansing, MI"),

  line("call", "call.headline.muted", "Headline, grey part", 40, "Let's hop on a"),
  line("call", "call.headline.strong", "Headline, dark part", 30, "quick call."),
  line("call", "call.intro", "Intro", 140, "Pick a time that works for you — about 15 minutes to talk through your shoot."),

  line("thanks", "thanks.headline.muted", "Headline, grey part", 30, "Nice shot."),
  line("thanks", "thanks.headline.strong", "Headline, dark part", 30, "Got it."),
  line("thanks", "thanks.body.start", "Message, before the reply time", 120, "Thanks for reaching out — I'll get back to you", {
    help: "Your reply time from the Contact section goes right after this.",
  }),
  line("thanks", "thanks.body.end", "Message, after the reply time", 120, "Can't wait to hear what you have in mind."),

  line("footer", "footer.cta.label", "Small heading", 30, "Got a shoot in mind?", { help: "Shown at the bottom of every page." }),
  line("footer", "footer.cta.muted", "Big line, grey part", 24, "Let's tell"),
  line("footer", "footer.cta.strong", "Big line, dark part", 24, "your story."),
];

export const FIELD_BY_KEY = new Map(FIELDS.map((f) => [f.key, f]));
const PAGE_BY_ID = new Map(PAGES.map((p) => [p.id, p]));

/** Every public page a field shows up on (used to confirm a publish really went live). */
export function fieldPaths(field) {
  return [field.path || PAGE_BY_ID.get(field.page).path, ...(field.also || [])];
}

// C0/C1 control characters (tab and newline are handled separately) and the
// invisible bidirectional overrides that can make text display differently than typed.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g;

/** Plain-text clean-up for one field. Returns null for anything that isn't a string. */
export function cleanText(value, field) {
  if (typeof value !== "string") return null;
  const s = value.replace(/\r\n?|\u2028|\u2029/g, "\n").replace(/\t/g, " ").replace(CONTROL, "");
  if (field.kind === "paragraphs") {
    return s.split(/\n[^\S\n]*\n\s*/).map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n\n");
  }
  return s.replace(/\s+/g, " ").trim();
}

export const charCount = (s) => [...s].length;

/** Human problem with an already-cleaned value, or null if it's fine. */
export function problemWith(cleaned, field) {
  if (!cleaned) return "can't be empty";
  if (field.kind === "paragraphs") {
    const paras = cleaned.split("\n\n");
    if (paras.length > field.maxParagraphs) return `has ${paras.length} paragraphs (at most ${field.maxParagraphs})`;
    const long = paras.findIndex((p) => charCount(p) > field.max);
    if (long !== -1) return `paragraph ${long + 1} is too long (${charCount(paras[long])} of ${field.max} characters)`;
    return null;
  }
  const n = charCount(cleaned);
  return n > field.max ? `is too long (${n} of ${field.max} characters)` : null;
}

/** The wording the site shows for `key`, given the parsed copy.json (or anything else). */
export function effectiveText(data, key) {
  const field = FIELD_BY_KEY.get(key);
  if (!field) throw new Error(`Unknown site text field: ${key}`);
  const stored = data && typeof data === "object" && data.text && typeof data.text === "object" ? data.text[key] : undefined;
  const cleaned = cleanText(stored, field);
  return cleaned !== null && !problemWith(cleaned, field) ? cleaned : field.default;
}

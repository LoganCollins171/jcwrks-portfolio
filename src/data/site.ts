// Global site info. Swap placeholders for Jacob's real details when ready.
export const site = {
  name: "Jacob Combs",
  brand: "jc_wrks",
  role: "Freelance Photographer",
  email: "jacobcombsphotography@gmail.com",
  // Reply time and coverage area are site text Jacob edits in /admin
  // (src/lib/site-text.mjs: site.responseTime, site.coverage).
  socials: {
    instagram: { label: "Instagram", handle: "jc_wrks", url: "https://instagram.com/jc_wrks" },
    tiktok: { label: "TikTok", handle: "jc_wrks1", url: "https://tiktok.com/@jc_wrks1" },
    x: { label: "X", handle: "jc_wrks", url: "https://x.com/jc_wrks" },
    linkedin: { label: "LinkedIn", handle: "Jacob Combs", url: "https://www.linkedin.com/in/jacob-combs1127/" },
  },
} as const;

// The "moments captured" number in the footer.
//
// It used to just count the photos uploaded to the site, which Jacob felt was
// misleading — it's a fraction of what he's actually shot. So he can now type
// his real career total in /admin (Moments Captured) and that wins instead.
//
// 0 (the default) means "no figure set, just count what's on the site", so the
// footer still does something sensible if he never touches it.

import { getTotalPhotos } from "./galleries";
import stats from "../data/stats.json";

export function getMomentsCaptured(): number {
  const manual = Number((stats as { photosTaken?: number }).photosTaken ?? 0);
  return Number.isFinite(manual) && manual > 0 ? Math.round(manual) : getTotalPhotos();
}

// The portfolio structure.
//
// A Category is either:
//   - type "gallery": clicking the tile goes straight to its photos (Portraits, Cars, ...)
//   - type "group":   clicking the tile shows sub-galleries first (Sports -> Baseball -> photos)
//
// `count` is just how many placeholder photos to render for now. When real
// photos arrive we'll replace `count` with a real `photos: [...]` list.
// `cover` is the tile image, e.g. "/covers/soccer.jpg".
// `blurb` is site text Jacob can edit in /admin (src/lib/site-text.mjs has the original wording).

import { text } from "../lib/copy";

export interface Gallery {
  slug: string;
  title: string;
  count: number;
  cover?: string;
}

export interface Category {
  slug: string;
  title: string;
  blurb: string;
  type: "gallery" | "group";
  count?: number; // for type "gallery"
  sub?: Gallery[]; // for type "group"
  cover?: string;
}

export const categories: Category[] = [
  {
    slug: "sports",
    title: "Sports",
    blurb: text("categories.sports.blurb"),
    type: "group",
    cover: "/covers/sports.jpg",
    sub: [
      { slug: "basketball", title: "Basketball", count: 9, cover: "/covers/basketball.jpg" },
      { slug: "football", title: "Football", count: 9, cover: "/covers/football.jpg" },
      { slug: "soccer", title: "Soccer", count: 8, cover: "/covers/soccer.jpg" },
      { slug: "baseball", title: "Baseball", count: 8, cover: "/covers/baseball.jpg" },
      { slug: "softball", title: "Softball", count: 8, cover: "/covers/softball.jpg" },
      { slug: "hockey", title: "Hockey", count: 8, cover: "/covers/hockey.jpg" },
      { slug: "track", title: "Track", count: 6, cover: "/covers/track.jpg" },
    ],
  },
  {
    slug: "portraits",
    title: "Portraits",
    blurb: text("categories.portraits.blurb"),
    type: "gallery",
    count: 10,
    cover: "/covers/portraits.jpg",
  },
  {
    slug: "landscape",
    title: "Landscape",
    blurb: text("categories.landscape.blurb"),
    type: "gallery",
    count: 8,
    cover: "/covers/landscape.jpg",
  },
  {
    slug: "cars",
    title: "Cars",
    blurb: text("categories.cars.blurb"),
    type: "gallery",
    count: 8,
    cover: "/covers/cars.jpg",
  },
  {
    slug: "graphics",
    title: "Graphics",
    blurb: text("categories.graphics.blurb"),
    type: "gallery",
    count: 8,
    cover: "/covers/graphics.jpg",
  },
];

export function getCategory(slug: string) {
  return categories.find((c) => c.slug === slug);
}

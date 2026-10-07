// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
//
// The rating vocabulary every verdict speaks: four ratings, their severity order, the
// worst-wins fold, and whether a reason is physics or taste. Moved here from
// `@freemixer/catalog`'s `destination-suitability.ts`, which re-exports it
// (`docs/design/specs/2026-09-25-plugin-qualify.md` §3).

import type { VerdictRating } from "./measurement/vocabulary.js";

/**
 * How well a plugin fits a destination role. The four words are the interchange's
 * (`VERDICT_RATINGS`, `measurement/vocabulary.ts`), so a written verdict speaks this vocabulary.
 *
 * - `suitable` — every dimension resolved and inside its budget.
 * - `conditional` — nothing objectively disqualifies it, but something needs the operator's
 *   attention: a taste warning, a topology difference, a look-ahead control that can be
 *   turned up past the budget, a cost that eats most of the allowance.
 * - `unknown` — an OBJECTIVE dimension could not be decided because the measurement is
 *   missing or does not resolve at this rate. Not a pass and not a failure: an admission.
 * - `unsuitable` — an objective dimension failed on measured evidence.
 */
export type SuitabilityRating = VerdictRating;

/**
 * Severity order for folding several reasons into one verdict:
 * `unsuitable` > `unknown` > `conditional` > `suitable`.
 *
 * `unknown` outranks `conditional` on purpose. A conditional plugin is one the console has
 * fully measured and has an opinion about; an unknown one is a plugin the console cannot
 * vouch for at all. Reporting "there is a caution" while an objective dimension is
 * un-measured would present the smaller finding as the whole story.
 */
export const RATING_SEVERITY: Readonly<Record<SuitabilityRating, number>> = {
  suitable: 0,
  conditional: 1,
  unknown: 2,
  unsuitable: 3,
};

/** The worst (most severe) of some ratings; `suitable` for an empty list. */
export function worstRating(ratings: readonly SuitabilityRating[]): SuitabilityRating {
  let worst: SuitabilityRating = "suitable";
  for (const rating of ratings) {
    if (RATING_SEVERITY[rating] > RATING_SEVERITY[worst]) worst = rating;
  }
  return worst;
}

/**
 * Physics or taste. The distinction drives what a reason is ALLOWED to do
 * (`contributedRating` in the catalog, `contributedHostingRating` here) and, downstream, whether an operator override is a formality
 * or a decision — conflating them is how a tool becomes either nagging or dangerous.
 */
export type SuitabilityKind = "objective" | "advisory";

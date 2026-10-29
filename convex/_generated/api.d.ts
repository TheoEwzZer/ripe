/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as cooking from "../cooking.js";
import type * as crons from "../crons.js";
import type * as devices from "../devices.js";
import type * as ingredients from "../ingredients.js";
import type * as offers from "../offers.js";
import type * as pipeline from "../pipeline.js";
import type * as recipes from "../recipes.js";
import type * as scans from "../scans.js";
import type * as sessions from "../sessions.js";
import type * as spend from "../spend.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  cooking: typeof cooking;
  crons: typeof crons;
  devices: typeof devices;
  ingredients: typeof ingredients;
  offers: typeof offers;
  pipeline: typeof pipeline;
  recipes: typeof recipes;
  scans: typeof scans;
  sessions: typeof sessions;
  spend: typeof spend;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};

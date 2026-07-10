/**
 * Search result interface
 */
export interface SearchResult {
  /** 1-based rank of the result across all fetched pages */
  position: number;
  title: string;
  link: string;
  /** Hostname of the result link, e.g. "example.com" */
  domain: string;
  snippet: string;
}

/**
 * A single "People also ask" entry
 */
export interface RelatedQuestion {
  question: string;
}

/**
 * Google "answer box": the featured snippet, direct answer, weather/sports widget, or
 * knowledge panel that Google renders above the organic results. This is where
 * authoritative real-time facts (scores, weather, prices, "current X", quick facts)
 * live — organic result snippets frequently don't carry them. Best-effort and may be
 * absent depending on the query and Google's (shifting) layout.
 */
export interface AnswerBox {
  /** What kind of block matched: "featured_snippet" | "answer" | "weather" | "sports" | "knowledge_panel" */
  type: string;
  /** Optional heading/entity title for the block */
  title: string;
  /** The concise, direct answer text — the thing to lead with */
  answer: string;
  /** Attribution (a domain or short source label) when discoverable */
  source: string;
}

/**
 * A single fixture parsed from Google's sports "match widget" (the immersive
 * scores card rendered above the organic results for sports queries). Best-effort:
 * Google's DOM shifts, so any field beyond `teams` may be absent.
 */
export interface SportsMatch {
  /** The two sides, in display order, e.g. ["Spain", "Belgium"] */
  teams: string[];
  /** Per-team scores aligned with `teams`, when the match is live/finished */
  scores?: number[];
  /** Competition round/stage, e.g. "Quarter-finals" */
  stage?: string;
  /** Human-readable status/kickoff label, e.g. "Tomorrow 2:30 am" or "Full-time" */
  status?: string;
  /** ISO 8601 kickoff time (UTC) from the widget's data-start-time attribute */
  startTime?: string;
}

/**
 * A single day parsed from the weather widget's daily forecast strip.
 */
export interface WeatherForecastDay {
  /** Day name, e.g. "Friday" */
  day: string;
  /** Sky condition, e.g. "Sunny" */
  condition?: string;
  /** High temperature in the widget's active unit */
  high?: number;
  /** Low temperature in the widget's active unit */
  low?: number;
}

/**
 * Structured current conditions + forecast parsed from Google's weather widget
 * (#wob_wc, rendered above the organic results for weather queries). Best-effort:
 * Google's DOM shifts, so any field beyond `location`/`temperature` may be absent.
 */
export interface Weather {
  /** Resolved location, e.g. "Tokyo, Japan" */
  location: string;
  /** Current temperature in `unit` */
  temperature: number;
  /** Temperature unit shown, "C" or "F" */
  unit: "C" | "F";
  /** Current sky condition, e.g. "Clear" */
  condition: string;
  /** Chance of precipitation, e.g. "10%" */
  precipitation?: string;
  /** Relative humidity, e.g. "83%" */
  humidity?: string;
  /** Wind, e.g. "10 km/h" */
  wind?: string;
  /** Local observation time label, e.g. "Friday, 11:00 pm" */
  observedAt?: string;
  /** Multi-day forecast strip */
  forecast?: WeatherForecastDay[];
}

/**
 * Pagination metadata describing what was actually fetched
 */
export interface PaginationInfo {
  /** The page index requested by the caller (1-based) */
  page: number;
  /** Number of results requested (limit) */
  requestedLimit: number;
  /** Number of results actually returned */
  returned: number;
  /** How many result pages were visited to satisfy the request */
  pagesFetched: number;
  /** Whether more results are likely available beyond what was returned */
  hasMore: boolean;
}

/**
 * Search response interface
 */
export interface SearchResponse {
  query: string;
  results: SearchResult[];
  /** Google's answer box / featured snippet / widget, when present (best-effort) */
  answerBox?: AnswerBox;
  /** Structured fixtures parsed from Google's sports match widget (best-effort) */
  sportsMatches?: SportsMatch[];
  /** Structured current conditions + forecast from Google's weather widget (best-effort) */
  weather?: Weather;
  /** "People also ask" questions surfaced on the results page (best-effort) */
  peopleAlsoAsk?: string[];
  /** "Related searches" suggestions surfaced on the results page (best-effort) */
  relatedSearches?: string[];
  /** Pagination metadata */
  pagination?: PaginationInfo;
}

/**
 * Command line / programmatic options interface
 */
export interface CommandOptions {
  /** Maximum number of results to return (across pages). Default 10. */
  limit?: number;
  /** Starting page (1-based). Default 1. Combined with limit to compute the start offset. */
  page?: number;
  timeout?: number;
  headless?: boolean; // Deprecated, kept for backward compatibility with existing code
  stateFile?: string;
  noSaveState?: boolean;
  locale?: string; // Search result language, defaults to Chinese (zh-CN)
}

/**
 * HTML response interface - used for retrieving the raw search page HTML
 */
export interface HtmlResponse {
  query: string;    // Search query
  html: string;     // Page HTML content (cleaned, without CSS and JavaScript)
  url: string;      // Search result page URL
  savedPath?: string; // Optional, the saved path if the HTML was written to a file
  screenshotPath?: string; // Optional, the saved path of the page screenshot
  originalHtmlLength?: number; // Original HTML length (including CSS and JavaScript)
}

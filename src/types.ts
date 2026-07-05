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

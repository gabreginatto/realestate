/**
 * API client for the matching server
 */

import type {
  Session,
  SessionStats,
  NextListingResponse,
  CandidatesResponse,
  MatchResult,
  SkipResult,
  UndoResult,
  Progress,
  NormalizedVivaListing,
  NormalizedCandidate,
} from '../types';

// ============================================================================
// Configuration
// ============================================================================

export const API_BASE_URL = 'https://property-matcher-376125120681.us-central1.run.app';

// ============================================================================
// Error Handling
// ============================================================================

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let errorMessage = `HTTP ${response.status}`;
    try {
      const errorData = await response.json();
      errorMessage = errorData.error || errorMessage;
    } catch {
      // Ignore JSON parse errors
    }
    throw new ApiError(errorMessage, response.status);
  }
  return response.json();
}

// ============================================================================
// Normalization Helpers
// ============================================================================

function normalizeVivaListing(
  viva: NextListingResponse['viva'],
  mosaicPath: string,
  baseUrl: string = API_BASE_URL
): NormalizedVivaListing {
  const code = viva.propertyCode || viva.code || '';
  const specs = viva.specs || viva.detailedData?.specs || {};

  return {
    propertyCode: code,
    price: typeof viva.price === 'number' ? `R$ ${viva.price.toLocaleString('pt-BR')}` : String(viva.price || ''),
    area: specs.area_construida || viva.built || viva.area || 0,
    bedrooms: specs.dormitorios || viva.beds || viva.bedrooms || 0,
    suites: specs.suites || viva.suites || 0,
    address: viva.address || '',
    url: viva.url || '',
    mosaicPath: `${baseUrl}${mosaicPath}`,
  };
}

function normalizeCandidate(
  candidateData: CandidatesResponse['candidates'][number],
  baseUrl: string = API_BASE_URL
): NormalizedCandidate {
  const { code, candidate, ai_score, deltas, mosaic_path } = candidateData;

  return {
    propertyCode: code || candidate.propertyCode || candidate.code || '',
    price: typeof candidate.price === 'number'
      ? `R$ ${candidate.price.toLocaleString('pt-BR')}`
      : String(candidate.price || ''),
    area: candidate.built || candidate.area || 0,
    bedrooms: candidate.beds || candidate.bedrooms || 0,
    suites: candidate.suites || 0,
    url: candidate.url || '',
    mosaicPath: `${baseUrl}${mosaic_path}`,
    aiScore: ai_score,
    priceDelta: deltas.price_delta_pct,
    areaDelta: deltas.area_delta_pct,
  };
}

// ============================================================================
// API Functions
// ============================================================================

/**
 * Get current session info and stats
 */
export async function getSession(baseUrl: string = API_BASE_URL): Promise<SessionStats> {
  const response = await fetch(`${baseUrl}/api/session`);
  const data = await handleResponse<Session>(response);
  return data.stats;
}

/**
 * Get the next listing to review
 */
export async function getNextListing(
  reviewer: string,
  baseUrl: string = API_BASE_URL
): Promise<{ vivaCode: string; viva: NormalizedVivaListing; done?: boolean } | { done: true; message: string }> {
  const response = await fetch(`${baseUrl}/api/next?reviewer=${encodeURIComponent(reviewer)}`);
  const data = await handleResponse<NextListingResponse & { done?: boolean; message?: string }>(response);

  if (data.done) {
    return { done: true, message: data.message || 'All listings reviewed!' };
  }

  return {
    vivaCode: data.viva_code,
    viva: normalizeVivaListing(data.viva, data.mosaic_path),
  };
}

/**
 * Get candidates for a specific Viva listing
 */
export async function getCandidates(
  vivaCode: string,
  baseUrl: string = API_BASE_URL
): Promise<{ candidates: NormalizedCandidate[] }> {
  const response = await fetch(`${baseUrl}/api/candidates/${encodeURIComponent(vivaCode)}`);
  const data = await handleResponse<CandidatesResponse>(response);

  return {
    candidates: data.candidates.map(c => normalizeCandidate(c, baseUrl)),
  };
}

/**
 * Submit a confirmed match
 */
export async function submitMatch(
  vivaCode: string,
  coelhoCode: string,
  timeSpent: number,
  reviewer: string,
  baseUrl: string = API_BASE_URL
): Promise<MatchResult> {
  const response = await fetch(`${baseUrl}/api/match`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      viva_code: vivaCode,
      coelho_code: coelhoCode,
      time_spent_sec: timeSpent,
      reviewer,
    }),
  });

  return handleResponse<MatchResult>(response);
}

/**
 * Reject a specific candidate
 */
export async function rejectCandidate(
  vivaCode: string,
  coelhoCode: string,
  reviewer: string,
  reason: string = 'visual_mismatch',
  baseUrl: string = API_BASE_URL
): Promise<{ success: boolean; remaining: number }> {
  const response = await fetch(`${baseUrl}/api/reject`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      viva_code: vivaCode,
      coelho_code: coelhoCode,
      reviewer,
      reason,
    }),
  });

  return handleResponse<{ success: boolean; remaining: number }>(response);
}

/**
 * Skip to the next Viva listing (no good candidates)
 */
export async function skipListing(
  vivaCode: string,
  timeSpent: number,
  reviewer: string,
  baseUrl: string = API_BASE_URL
): Promise<SkipResult> {
  const response = await fetch(`${baseUrl}/api/skip`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      viva_code: vivaCode,
      time_spent_sec: timeSpent,
      reviewer,
      reason: 'no_good_candidates',
    }),
  });

  return handleResponse<SkipResult>(response);
}

/**
 * Undo the last decision for the current reviewer
 */
export async function undo(
  reviewer: string,
  baseUrl: string = API_BASE_URL
): Promise<UndoResult> {
  const response = await fetch(`${baseUrl}/api/undo`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ reviewer }),
  });

  return handleResponse<UndoResult>(response);
}

/**
 * Get progress stats
 */
export async function getProgress(baseUrl: string = API_BASE_URL): Promise<Progress> {
  const response = await fetch(`${baseUrl}/api/progress`);
  return handleResponse<Progress>(response);
}

/**
 * Get a specific listing by ID
 */
export async function getListing(
  vivaCode: string,
  baseUrl: string = API_BASE_URL
): Promise<NormalizedVivaListing> {
  const response = await fetch(`${baseUrl}/api/listing/${encodeURIComponent(vivaCode)}`);
  const data = await handleResponse<NextListingResponse>(response);

  return normalizeVivaListing(data.viva, data.mosaic_path);
}

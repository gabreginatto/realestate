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
  Notification,
  CompoundsResponse,
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
    fullMosaicPath: `${baseUrl}${mosaicPath}`.replace(/\.png$/, '_full.png'),
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
    fullMosaicPath: `${baseUrl}${mosaic_path}`.replace(/\.png$/, '_full.png'),
    aiScore: ai_score,
    priceDelta: deltas.price_delta_pct,
    areaDelta: deltas.area_delta_pct,
  };
}

// ============================================================================
// API Functions
// ============================================================================

/**
 * Get list of all compounds with their stats
 */
export async function getCompounds(baseUrl: string = API_BASE_URL): Promise<CompoundsResponse> {
  const response = await fetch(`${baseUrl}/api/compounds`);
  return handleResponse<CompoundsResponse>(response);
}

/**
 * Get current session info and stats
 */
export async function getSession(compoundId: string, baseUrl: string = API_BASE_URL): Promise<SessionStats> {
  const response = await fetch(`${baseUrl}/api/compounds/${encodeURIComponent(compoundId)}/session`);
  const data = await handleResponse<Session>(response);
  return data.stats;
}

/**
 * Get the next listing to review
 */
type NextListingResult =
  | { vivaCode: string; viva: NormalizedVivaListing; done?: false; current_pass?: number; pass_name?: string }
  | { done: true; message: string }
  | { pass_complete: true; current_pass: number; pass_name: string; stats: { matched: number; skipped: number; total_reviewed: number }; has_next_pass: boolean; next_pass: { number: number; name: string; price_tolerance: string; area_tolerance: string } | null };

export async function getNextListing(
  compoundId: string,
  reviewer: string,
  baseUrl: string = API_BASE_URL
): Promise<NextListingResult> {
  const response = await fetch(`${baseUrl}/api/compounds/${encodeURIComponent(compoundId)}/next?reviewer=${encodeURIComponent(reviewer)}`);
  const data = await handleResponse<NextListingResponse>(response);

  if (data.done) {
    return { done: true, message: data.message || 'All listings reviewed!' };
  }

  // Handle pass_complete response
  if (data.pass_complete) {
    return {
      pass_complete: true,
      current_pass: data.current_pass ?? 1,
      pass_name: data.pass_name ?? 'unknown',
      stats: data.stats!,
      has_next_pass: data.has_next_pass!,
      next_pass: data.next_pass ?? null,
    };
  }

  return {
    vivaCode: data.viva_code,
    viva: normalizeVivaListing(data.viva, data.mosaic_path, baseUrl),
    current_pass: data.current_pass,
    pass_name: data.pass_name,
  };
}

/**
 * Get candidates for a specific Viva listing
 */
export async function getCandidates(
  compoundId: string,
  vivaCode: string,
  baseUrl: string = API_BASE_URL
): Promise<{ candidates: NormalizedCandidate[] }> {
  const response = await fetch(`${baseUrl}/api/compounds/${encodeURIComponent(compoundId)}/candidates/${encodeURIComponent(vivaCode)}`);
  const data = await handleResponse<CandidatesResponse>(response);

  return {
    candidates: data.candidates.map(c => normalizeCandidate(c, baseUrl)),
  };
}

/**
 * Submit a confirmed match
 */
export async function submitMatch(
  compoundId: string,
  vivaCode: string,
  coelhoCode: string,
  timeSpent: number,
  reviewer: string,
  baseUrl: string = API_BASE_URL
): Promise<MatchResult> {
  const response = await fetch(`${baseUrl}/api/compounds/${encodeURIComponent(compoundId)}/match`, {
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
  compoundId: string,
  vivaCode: string,
  coelhoCode: string,
  reviewer: string,
  reason: string = 'visual_mismatch',
  baseUrl: string = API_BASE_URL
): Promise<{ success: boolean; remaining: number }> {
  const response = await fetch(`${baseUrl}/api/compounds/${encodeURIComponent(compoundId)}/reject`, {
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
  compoundId: string,
  vivaCode: string,
  timeSpent: number,
  reviewer: string,
  baseUrl: string = API_BASE_URL
): Promise<SkipResult> {
  const response = await fetch(`${baseUrl}/api/compounds/${encodeURIComponent(compoundId)}/skip`, {
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
  compoundId: string,
  reviewer: string,
  baseUrl: string = API_BASE_URL
): Promise<UndoResult> {
  const response = await fetch(`${baseUrl}/api/compounds/${encodeURIComponent(compoundId)}/undo`, {
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
export async function getProgress(compoundId: string, baseUrl: string = API_BASE_URL): Promise<Progress> {
  const response = await fetch(`${baseUrl}/api/compounds/${encodeURIComponent(compoundId)}/progress`);
  return handleResponse<Progress>(response);
}

/**
 * Get a specific listing by ID
 */
export async function getListing(
  compoundId: string,
  vivaCode: string,
  baseUrl: string = API_BASE_URL
): Promise<NormalizedVivaListing> {
  const response = await fetch(`${baseUrl}/api/compounds/${encodeURIComponent(compoundId)}/listing/${encodeURIComponent(vivaCode)}`);
  const data = await handleResponse<NextListingResponse>(response);

  return normalizeVivaListing(data.viva, data.mosaic_path, baseUrl);
}

// ============================================================================
// Notification API Functions
// ============================================================================

/**
 * Get unread notifications
 */
export async function getNotifications(compoundId: string, baseUrl: string = API_BASE_URL): Promise<{ notifications: Notification[]; unread_count: number }> {
  const response = await fetch(`${baseUrl}/api/compounds/${encodeURIComponent(compoundId)}/notifications`);
  return handleResponse(response);
}

/**
 * Dismiss notifications
 */
export async function dismissNotifications(compoundId: string, options: { id?: string; all?: boolean }, baseUrl: string = API_BASE_URL): Promise<{ success: boolean }> {
  const response = await fetch(`${baseUrl}/api/compounds/${encodeURIComponent(compoundId)}/notifications/dismiss`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  });
  return handleResponse(response);
}

/**
 * Advance to next matching pass
 */
export async function advancePass(compoundId: string, baseUrl: string = API_BASE_URL): Promise<{ success: boolean; current_pass: number; pass_name: string; pending: number }> {
  const response = await fetch(`${baseUrl}/api/compounds/${encodeURIComponent(compoundId)}/pass/advance`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  const data = await handleResponse<{ success: boolean; current_pass: number; pass_name: string; pending: number; message?: string }>(response);
  if (data.success === false) {
    throw new ApiError(data.message || 'Cannot advance to next pass', 200);
  }
  return data;
}

/**
 * Finish matching session
 */
export async function finishMatching(compoundId: string, reviewer: string, baseUrl: string = API_BASE_URL): Promise<{ success: boolean; summary: { total_matches: number; total_skipped: number; passes_completed: number } }> {
  const response = await fetch(`${baseUrl}/api/compounds/${encodeURIComponent(compoundId)}/pass/finish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reviewer }),
  });
  return handleResponse(response);
}

/**
 * Reset compound state (clear all matches, start over from Pass 1)
 */
export async function resetCompound(
  compoundId: string,
  reviewer: string,
  baseUrl: string = API_BASE_URL
): Promise<{ success: boolean; message: string; pending: number; current_pass: number }> {
  const response = await fetch(`${baseUrl}/api/compounds/${encodeURIComponent(compoundId)}/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reviewer }),
  });
  return handleResponse(response);
}

// ============================================================================
// Report API Functions
// ============================================================================

/**
 * Get unmatched properties report
 */
export async function getUnmatchedReport(compoundId: string, baseUrl: string = API_BASE_URL): Promise<{
  total_viva: number;
  total_matched: number;
  total_unmatched: number;
  listings: Array<{
    code: string;
    price?: string | number;
    address?: string;
    url?: string;
    beds?: number;
    built?: number;
  }>;
}> {
  const response = await fetch(`${baseUrl}/api/compounds/${encodeURIComponent(compoundId)}/report/unmatched`);
  return handleResponse(response);
}

/**
 * Send unmatched report via email
 */
export async function sendReportEmail(
  compoundId: string,
  email: string,
  baseUrl: string = API_BASE_URL
): Promise<{ success: boolean; message: string }> {
  const response = await fetch(`${baseUrl}/api/compounds/${encodeURIComponent(compoundId)}/report/send-email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: email }),
  });
  return handleResponse(response);
}

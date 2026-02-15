/**
 * TypeScript types for the React Native matcher app
 */

// ============================================================================
// Session Types
// ============================================================================

export type SessionStats = {
  total_viva_listings: number;
  matched: number;
  rejected: number;
  skipped: number;
  pending: number;
  in_progress: number;
};

export type PassCriteria = {
  name: string;
  price_tolerance: string;
  area_tolerance: string;
};

export type Session = {
  session_name: string;
  session_started: string | null;
  last_updated: string | null;
  version: number;
  stats: SessionStats;
  read_only: boolean;
  current_pass?: number;
  passes_completed?: number;
  max_passes?: number;
  pass_criteria?: PassCriteria;
};

// ============================================================================
// Listing Types
// ============================================================================

export type VivaSpecs = {
  area_construida?: number;
  dormitorios?: number;
  suites?: number;
};

export type VivaListing = {
  propertyCode: string;
  code?: string;
  price: string | number;
  area?: number;
  built?: number;
  bedrooms?: number;
  beds?: number;
  suites?: number;
  address?: string;
  url?: string;
  specs?: VivaSpecs;
  detailedData?: {
    specs?: VivaSpecs;
  };
};

export type Candidate = {
  propertyCode: string;
  code?: string;
  price: string | number;
  area?: number;
  built?: number;
  bedrooms?: number;
  beds?: number;
  suites?: number;
  url?: string;
  mosaicPath: string;
  aiScore: number | null;
  priceDelta: number | null;
  areaDelta: number | null;
  features?: string;
};

export type CandidateDeltas = {
  price_viva: number | null;
  price_coelho: number | null;
  price_delta_pct: number | null;
  area_viva: number | null;
  area_coelho: number | null;
  area_delta_pct: number | null;
};

// ============================================================================
// API Response Types
// ============================================================================

export type NextListingResponse = {
  viva_code: string;
  viva: VivaListing;
  remaining_candidates: number;
  mosaic_path: string;
  done?: boolean;
  message?: string;
  current_pass?: number;
  pass_name?: string;
  pending_in_pass?: number;
  final_stats?: {
    total_matches: number;
    total_skipped: number;
    passes_completed: number;
  };
  pass_complete?: boolean;
  stats?: { matched: number; skipped: number; total_reviewed: number };
  has_next_pass?: boolean;
  next_pass?: { number: number; name: string; price_tolerance: string; area_tolerance: string } | null;
};

export type CandidatesResponse = {
  viva_code: string;
  candidates: Array<{
    code: string;
    candidate: VivaListing & { features?: string };
    ai_score: number | null;
    deltas: CandidateDeltas;
    mosaic_path: string;
  }>;
  total_candidates: number;
};

export type MatchResult = {
  success: boolean;
  match?: {
    viva_code: string;
    coelho_code: string;
    matched_at: string;
    reviewer: string;
    time_spent_sec: number | null;
    ai_score: number | null;
    confidence: string;
    notes: string | null;
  };
  remaining: number;
  error?: string;
};

export type RejectResult = {
  success: boolean;
  rejection?: {
    viva_code: string;
    coelho_code: string;
    rejected_at: string;
    reviewer: string;
    reason: string;
  };
  remaining: number;
  error?: string;
};

export type SkipResult = {
  success: boolean;
  skip?: {
    viva_code: string;
    skipped_at: string;
    reviewer: string;
    reason: string;
  };
  remaining: number;
  error?: string;
};

export type UndoResult = {
  success: boolean;
  undone?: {
    type: 'match' | 'skip';
    viva_code: string;
    [key: string]: unknown;
  };
  remaining: number;
  error?: string;
};

export type Progress = {
  total_viva_listings: number;
  matched: number;
  skipped: number;
  pending: number;
  in_progress: number;
  completed: number;
  progress_pct: number;
  current_pass?: number;
  max_passes?: number;
  pass_name?: string;
  pass_criteria?: {
    price_tolerance: string;
    area_tolerance: string;
  };
};

// ============================================================================
// Normalized Types (for app use)
// ============================================================================

export type NormalizedVivaListing = {
  propertyCode: string;
  price: string;
  area: number;
  bedrooms: number;
  suites: number;
  address: string;
  url: string;
  mosaicPath: string;
  fullMosaicPath: string;  // Extended mosaic (4×4, 16 images)
};

export type NormalizedCandidate = {
  propertyCode: string;
  price: string;
  area: number;
  bedrooms: number;
  suites: number;
  url: string;
  mosaicPath: string;
  fullMosaicPath: string;  // Extended mosaic (4×4, 16 images)
  aiScore: number | null;
  priceDelta: number | null;
  areaDelta: number | null;
};

// ============================================================================
// Notification Types
// ============================================================================

export type Notification = {
  id: string;
  type: 'pipeline_complete' | 'pipeline_trigger';
  message: string;
  data: Record<string, unknown>;
  created_at: string;
  read: boolean;
};

// ============================================================================
// Compound Types
// ============================================================================

export type Compound = {
  id: string;
  displayName: string;
  stats: {
    matched: number;
    pending: number;
    total: number;
  } | null;
};

export type CompoundsResponse = {
  compounds: Compound[];
  defaultCompound: string;
};

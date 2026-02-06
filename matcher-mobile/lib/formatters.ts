/**
 * Formatting helper functions for the matcher app
 */

// ============================================================================
// Price Formatting
// ============================================================================

/**
 * Format a price value as BRL currency
 * Handles both string (already formatted) and number inputs
 */
export function formatPrice(price: string | number | null | undefined): string {
  if (price === null || price === undefined || price === '') {
    return 'N/A';
  }

  // If already formatted as BRL string, return as-is
  if (typeof price === 'string') {
    if (price.includes('R$')) {
      return price;
    }
    // Try to parse as number
    const parsed = parseFloat(price.replace(/[^\d.,]/g, '').replace(',', '.'));
    if (isNaN(parsed)) {
      return price;
    }
    price = parsed;
  }

  // Format as BRL currency
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(price);
}

// ============================================================================
// Delta Formatting
// ============================================================================

/**
 * Format a percentage delta value
 * Returns format like +12.5% or -8.3%
 */
export function formatDelta(delta: number | null | undefined): string {
  if (delta === null || delta === undefined) {
    return 'N/A';
  }

  const sign = delta >= 0 ? '+' : '';
  return `${sign}${delta.toFixed(1)}%`;
}

/**
 * Get the appropriate color for a delta value
 * Green for negative (lower price), red for positive (higher price)
 * For property comparisons, lower is usually better
 */
export function getDeltaColor(delta: number | null | undefined): string {
  if (delta === null || delta === undefined) {
    return '#888888'; // Gray for N/A
  }

  if (delta < -5) {
    return '#22C55E'; // Green - significantly lower
  } else if (delta < 0) {
    return '#86EFAC'; // Light green - slightly lower
  } else if (delta === 0) {
    return '#888888'; // Gray - same
  } else if (delta <= 5) {
    return '#FCA5A5'; // Light red - slightly higher
  } else {
    return '#EF4444'; // Red - significantly higher
  }
}

// ============================================================================
// Area Formatting
// ============================================================================

/**
 * Format area in square meters
 */
export function formatArea(area: number | null | undefined): string {
  if (area === null || area === undefined || area === 0) {
    return 'N/A';
  }

  return `${area.toLocaleString('pt-BR')} m²`;
}

// ============================================================================
// Features Formatting
// ============================================================================

/**
 * Format property features as a summary string
 */
export function formatFeatures(
  area: number | null | undefined,
  bedrooms: number | null | undefined,
  suites: number | null | undefined
): string {
  const parts: string[] = [];

  if (area && area > 0) {
    parts.push(`${area}m²`);
  }

  if (bedrooms && bedrooms > 0) {
    parts.push(`${bedrooms} dorm`);
  }

  if (suites && suites > 0) {
    parts.push(`${suites} suíte${suites > 1 ? 's' : ''}`);
  }

  return parts.length > 0 ? parts.join(' | ') : 'N/A';
}

// ============================================================================
// Score Formatting
// ============================================================================

/**
 * Format AI confidence score
 */
export function formatScore(score: number | null | undefined): string {
  if (score === null || score === undefined) {
    return 'N/A';
  }

  // Score is typically 0-1, convert to percentage
  if (score <= 1) {
    return `${(score * 100).toFixed(0)}%`;
  }

  // Already in percentage form
  return `${score.toFixed(0)}%`;
}

/**
 * Get color for AI score
 */
export function getScoreColor(score: number | null | undefined): string {
  if (score === null || score === undefined) {
    return '#888888'; // Gray
  }

  // Normalize to 0-1 if needed
  const normalized = score > 1 ? score / 100 : score;

  if (normalized >= 0.8) {
    return '#22C55E'; // Green - high confidence
  } else if (normalized >= 0.6) {
    return '#EAB308'; // Yellow - medium confidence
  } else {
    return '#EF4444'; // Red - low confidence
  }
}

// ============================================================================
// Time Formatting
// ============================================================================

/**
 * Format time spent in seconds to a readable format
 */
export function formatTimeSpent(seconds: number): string {
  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);

  if (remainingSeconds === 0) {
    return `${minutes}m`;
  }

  return `${minutes}m ${remainingSeconds}s`;
}

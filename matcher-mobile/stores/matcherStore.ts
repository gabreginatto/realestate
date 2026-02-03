import { create } from 'zustand';
import * as Haptics from 'expo-haptics';

import type { SessionStats, NormalizedVivaListing, NormalizedCandidate } from '../types';
import {
  getSession,
  getNextListing,
  getCandidates,
  submitMatch,
  skipListing as apiSkipListing,
  undo as apiUndo,
} from '../lib/api';

// ============================================================================
// State Interface
// ============================================================================

interface MatcherState {
  // Data
  sessionStats: SessionStats | null;
  reviewer: string;
  currentListing: NormalizedVivaListing | null;
  candidates: NormalizedCandidate[];

  // UI State
  isLoading: boolean;
  canUndo: boolean;
  decisionStartTime: number | null;
  error: string | null;
}

interface MatcherActions {
  // Actions
  setReviewer: (name: string) => void;
  loadSession: () => Promise<void>;
  loadNextListing: () => Promise<void>;
  confirmMatch: (coelhoCode: string) => Promise<void>;
  skipListing: () => Promise<void>;
  undo: () => Promise<void>;
  clearError: () => void;
}

type MatcherStore = MatcherState & MatcherActions;

// ============================================================================
// Initial State
// ============================================================================

const initialState: MatcherState = {
  sessionStats: null,
  reviewer: '',
  currentListing: null,
  candidates: [],
  isLoading: false,
  canUndo: false,
  decisionStartTime: null,
  error: null,
};

// ============================================================================
// Haptic Feedback Helpers
// ============================================================================

async function triggerSuccessHaptic(): Promise<void> {
  try {
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  } catch {
    // Haptics may not be available on all devices
  }
}

async function triggerLightHaptic(): Promise<void> {
  try {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  } catch {
    // Haptics may not be available on all devices
  }
}

async function triggerErrorHaptic(): Promise<void> {
  try {
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
  } catch {
    // Haptics may not be available on all devices
  }
}

// ============================================================================
// Store
// ============================================================================

export const useMatcherStore = create<MatcherStore>((set, get) => ({
  ...initialState,

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  setReviewer: (name: string) => {
    set({ reviewer: name });
  },

  loadSession: async () => {
    set({ isLoading: true, error: null });

    try {
      const sessionStats = await getSession();
      set({ sessionStats, isLoading: false });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load session';
      set({ error: message, isLoading: false });
    }
  },

  loadNextListing: async () => {
    const { reviewer } = get();

    set({ isLoading: true, error: null });

    try {
      const result = await getNextListing(reviewer);

      if ('done' in result && result.done) {
        // All listings have been reviewed
        set({
          currentListing: null,
          candidates: [],
          decisionStartTime: null,
          isLoading: false,
        });
        return;
      }

      // Fetch candidates for this listing
      const candidatesResult = await getCandidates(result.vivaCode);

      set({
        currentListing: result.viva,
        candidates: candidatesResult.candidates,
        decisionStartTime: Date.now(),
        isLoading: false,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load listing';
      set({ error: message, isLoading: false });
      await triggerErrorHaptic();
    }
  },

  confirmMatch: async (coelhoCode: string) => {
    const { currentListing, reviewer, decisionStartTime } = get();

    if (!currentListing) {
      set({ error: 'No listing to match' });
      return;
    }

    const timeSpentSec = decisionStartTime
      ? Math.floor((Date.now() - decisionStartTime) / 1000)
      : 0;

    set({ isLoading: true, error: null });

    try {
      await submitMatch(
        currentListing.propertyCode,
        coelhoCode,
        timeSpentSec,
        reviewer
      );

      await triggerSuccessHaptic();

      set({ canUndo: true });

      // Reload session stats and load next listing
      await get().loadSession();
      await get().loadNextListing();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to submit match';
      set({ error: message, isLoading: false });
      await triggerErrorHaptic();
    }
  },

  skipListing: async () => {
    const { currentListing, reviewer, decisionStartTime } = get();

    if (!currentListing) {
      set({ error: 'No listing to skip' });
      return;
    }

    const timeSpentSec = decisionStartTime
      ? Math.floor((Date.now() - decisionStartTime) / 1000)
      : 0;

    set({ isLoading: true, error: null });

    try {
      await apiSkipListing(
        currentListing.propertyCode,
        timeSpentSec,
        reviewer
      );

      await triggerLightHaptic();

      set({ canUndo: true });

      // Reload session stats and load next listing
      await get().loadSession();
      await get().loadNextListing();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to skip listing';
      set({ error: message, isLoading: false });
      await triggerErrorHaptic();
    }
  },

  undo: async () => {
    const { reviewer } = get();

    set({ isLoading: true, error: null });

    try {
      await apiUndo(reviewer);

      await triggerLightHaptic();

      set({ canUndo: false });

      // Reload session stats and current listing
      await get().loadSession();
      await get().loadNextListing();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to undo';
      set({ error: message, isLoading: false });
      await triggerErrorHaptic();
    }
  },

  clearError: () => {
    set({ error: null });
  },
}));

// ============================================================================
// Selectors (for minimal re-renders)
// ============================================================================

// Session stats selector
export const useSessionStats = () => useMatcherStore((state) => state.sessionStats);

// Reviewer selector
export const useReviewer = () => useMatcherStore((state) => state.reviewer);

// Current listing selector
export const useCurrentListing = () => useMatcherStore((state) => state.currentListing);

// Candidates selector
export const useCandidates = () => useMatcherStore((state) => state.candidates);

// Loading state selector
export const useIsLoading = () => useMatcherStore((state) => state.isLoading);

// Undo availability selector
export const useCanUndo = () => useMatcherStore((state) => state.canUndo);

// Error selector
export const useError = () => useMatcherStore((state) => state.error);

// Time spent selector (computed)
export const useTimeSpent = (): number => {
  const decisionStartTime = useMatcherStore((state) => state.decisionStartTime);

  if (!decisionStartTime) return 0;
  return Math.floor((Date.now() - decisionStartTime) / 1000);
};

// Computed helper: get time spent (non-hook version for use in actions)
export const getTimeSpent = (): number => {
  const { decisionStartTime } = useMatcherStore.getState();

  if (!decisionStartTime) return 0;
  return Math.floor((Date.now() - decisionStartTime) / 1000);
};

// Progress computed selector
export const useProgress = () =>
  useMatcherStore((state) => {
    if (!state.sessionStats) {
      return { completed: 0, total: 0, percentage: 0 };
    }

    const { matched, skipped, total_viva_listings } = state.sessionStats;
    const completed = matched + skipped;
    const percentage = total_viva_listings > 0
      ? Math.round((completed / total_viva_listings) * 100)
      : 0;

    return { completed, total: total_viva_listings, percentage };
  });

// Has current listing selector
export const useHasListing = () =>
  useMatcherStore((state) => state.currentListing !== null);

// Candidate count selector
export const useCandidateCount = () =>
  useMatcherStore((state) => state.candidates.length);

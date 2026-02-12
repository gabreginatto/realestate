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
  getNotifications,
  dismissNotifications,
  advancePass as advancePassApi,
  finishMatching as finishMatchingApi,
  getCompounds,
} from '../lib/api';

// ============================================================================
// State Interface
// ============================================================================

interface MatcherState {
  // Compound
  compoundId: string | null;
  compoundName: string | null;

  // Data
  sessionStats: SessionStats | null;
  reviewer: string;
  currentListing: NormalizedVivaListing | null;
  candidates: NormalizedCandidate[];

  // Pass tracking
  currentPass: number;
  maxPasses: number;
  passName: string;
  allPassesComplete: boolean;
  passComplete: boolean;
  passStats: { matched: number; skipped: number; total_reviewed: number } | null;
  hasNextPass: boolean;
  nextPassInfo: { number: number; name: string; price_tolerance: string; area_tolerance: string } | null;
  userFinished: boolean;

  // Notifications
  hasNewProperties: boolean;
  notificationMessage: string | null;

  // UI State
  isLoading: boolean;
  canUndo: boolean;
  decisionStartTime: number | null;
  error: string | null;
}

interface MatcherActions {
  // Actions
  setCompound: (id: string, name: string) => void;
  setReviewer: (name: string) => void;
  loadSession: () => Promise<void>;
  loadNextListing: () => Promise<void>;
  confirmMatch: (coelhoCode: string) => Promise<void>;
  skipListing: () => Promise<void>;
  undo: () => Promise<void>;
  advancePass: () => Promise<void>;
  finishMatching: () => Promise<void>;
  checkNotifications: () => Promise<void>;
  dismissNotification: () => Promise<void>;
  clearError: () => void;
}

type MatcherStore = MatcherState & MatcherActions;

// ============================================================================
// Initial State
// ============================================================================

const initialState: MatcherState = {
  compoundId: null,
  compoundName: null,
  sessionStats: null,
  reviewer: '',
  currentListing: null,
  candidates: [],
  currentPass: 1,
  maxPasses: 5,
  passName: 'strict',
  allPassesComplete: false,
  passComplete: false,
  passStats: null,
  hasNextPass: false,
  nextPassInfo: null,
  userFinished: false,
  hasNewProperties: false,
  notificationMessage: null,
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

  setCompound: (id: string, name: string) => {
    set({ compoundId: id, compoundName: name });
  },

  setReviewer: (name: string) => {
    set({ reviewer: name });
  },

  loadSession: async () => {
    const { compoundId } = get();
    if (!compoundId) { set({ error: 'No compound selected', isLoading: false }); return; }

    set({ isLoading: true, error: null });

    try {
      const sessionStats = await getSession(compoundId);
      set({ sessionStats, isLoading: false });

      // Check for new property notifications after loading session
      await get().checkNotifications();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load session';
      set({ error: message, isLoading: false });
    }
  },

  loadNextListing: async () => {
    const { reviewer, compoundId } = get();
    if (!compoundId) { set({ error: 'No compound selected', isLoading: false }); return; }

    set({ isLoading: true, error: null });

    try {
      const result = await getNextListing(compoundId, reviewer);

      if ('done' in result && result.done) {
        // All listings have been reviewed (all passes complete)
        set({
          currentListing: null,
          candidates: [],
          decisionStartTime: null,
          isLoading: false,
          allPassesComplete: true,
        });
        return;
      }

      // Handle pass complete (no more tasks in current pass)
      if ('pass_complete' in result && result.pass_complete) {
        set({
          currentListing: null,
          candidates: [],
          decisionStartTime: null,
          isLoading: false,
          passComplete: true,
          passStats: result.stats,
          hasNextPass: result.has_next_pass,
          nextPassInfo: result.next_pass,
          currentPass: result.current_pass,
          passName: result.pass_name,
        });
        return;
      }

      // Update pass tracking from the response
      if ('current_pass' in result) {
        set({
          currentPass: result.current_pass ?? 1,
          passName: result.pass_name ?? 'strict',
        });
      }

      // After early returns above, result must be the listing variant
      const listing = result as { vivaCode: string; viva: NormalizedVivaListing; current_pass?: number; pass_name?: string };

      // Fetch candidates for this listing
      const candidatesResult = await getCandidates(compoundId, listing.vivaCode);

      set({
        currentListing: listing.viva,
        candidates: candidatesResult.candidates,
        decisionStartTime: Date.now(),
        isLoading: false,
        allPassesComplete: false,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load listing';
      set({ error: message, isLoading: false });
      await triggerErrorHaptic();
    }
  },

  confirmMatch: async (coelhoCode: string) => {
    const { currentListing, reviewer, decisionStartTime, compoundId } = get();

    if (!compoundId) return;
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
        compoundId,
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
    const { currentListing, reviewer, decisionStartTime, compoundId } = get();

    if (!compoundId) return;
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
        compoundId,
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
    const { reviewer, compoundId } = get();
    if (!compoundId) return;

    set({ isLoading: true, error: null });

    try {
      await apiUndo(compoundId, reviewer);

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

  advancePass: async () => {
    const { compoundId } = get();
    if (!compoundId) return;

    set({ isLoading: true, error: null });
    try {
      await advancePassApi(compoundId);
      await triggerSuccessHaptic();
      set({
        passComplete: false,
        passStats: null,
        hasNextPass: false,
        nextPassInfo: null,
      });
      await get().loadSession();
      await get().loadNextListing();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to advance pass';
      set({ error: message, isLoading: false });
      await triggerErrorHaptic();
    }
  },

  finishMatching: async () => {
    const { reviewer, compoundId } = get();
    if (!compoundId) return;

    set({ isLoading: true, error: null });
    try {
      await finishMatchingApi(compoundId, reviewer);
      await triggerSuccessHaptic();
      set({
        passComplete: false,
        passStats: null,
        userFinished: true,
        allPassesComplete: true,
        currentListing: null,
        candidates: [],
        isLoading: false,
      });
      await get().loadSession();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to finish matching';
      set({ error: message, isLoading: false });
      await triggerErrorHaptic();
    }
  },

  checkNotifications: async () => {
    const { compoundId } = get();
    if (!compoundId) return;

    try {
      const result = await getNotifications(compoundId);
      if (result.unread_count > 0) {
        set({
          hasNewProperties: true,
          notificationMessage: result.notifications[0]?.message || 'New properties available!',
        });
      } else {
        set({ hasNewProperties: false, notificationMessage: null });
      }
    } catch {
      // Silently ignore notification check failures
    }
  },

  dismissNotification: async () => {
    const { compoundId } = get();
    if (!compoundId) return;

    try {
      await dismissNotifications(compoundId, { all: true });
      set({ hasNewProperties: false, notificationMessage: null });
    } catch {
      // Silently ignore dismiss failures
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

// Pass info selector
export const usePassInfo = () =>
  useMatcherStore((state) => ({
    currentPass: state.currentPass,
    maxPasses: state.maxPasses,
    passName: state.passName,
  }));

// All passes complete selector
export const useAllPassesComplete = () =>
  useMatcherStore((state) => state.allPassesComplete);

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  StyleSheet,
  ScrollView,
  Modal,
  Alert,
  RefreshControl,
  TextInput,
  Pressable,
  Text,
  Dimensions,
} from 'react-native';
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, router } from 'expo-router';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  Easing,
  runOnJS,
} from 'react-native-reanimated';

import { Header } from '../../components/Header';
import { PropertyCard } from '../../components/PropertyCard';
import { CandidateList } from '../../components/CandidateList';
import { BottomActionBar } from '../../components/BottomActionBar';
import { Toast } from '../../components/Toast';
import { EmptyState } from '../../components/EmptyState';
import { TransitionOverlay } from '../../components/TransitionOverlay';
import { useMatcherStore } from '../../stores/matcherStore';

// Default API URL - change this for your network
const API_BASE_URL = 'http://localhost:3000';

const SCREEN_WIDTH = Dimensions.get('window').width;
const EASING_SMOOTH = Easing.bezier(0.4, 0, 0.2, 1);

// Animation durations
const EXIT_DURATION = 250;
const ENTER_DURATION = 250;

export default function MatcherScreen() {
  const { compoundId, compoundName } = useLocalSearchParams<{ compoundId: string; compoundName: string }>();
  const insets = useSafeAreaInsets();

  // Compound store state
  const setCompound = useMatcherStore((s) => s.setCompound);
  const storeCompoundId = useMatcherStore((s) => s.compoundId);

  // Store state and actions
  const sessionStats = useMatcherStore((s) => s.sessionStats);
  const reviewer = useMatcherStore((s) => s.reviewer);
  const currentListing = useMatcherStore((s) => s.currentListing);
  const candidates = useMatcherStore((s) => s.candidates);
  const isLoading = useMatcherStore((s) => s.isLoading);
  const canUndo = useMatcherStore((s) => s.canUndo);
  const error = useMatcherStore((s) => s.error);
  const currentPass = useMatcherStore((s) => s.currentPass);
  const maxPasses = useMatcherStore((s) => s.maxPasses);
  const passName = useMatcherStore((s) => s.passName);
  const allPassesComplete = useMatcherStore((s) => s.allPassesComplete);

  const passComplete = useMatcherStore((s) => s.passComplete);
  const passStats = useMatcherStore((s) => s.passStats);
  const hasNextPass = useMatcherStore((s) => s.hasNextPass);
  const nextPassInfo = useMatcherStore((s) => s.nextPassInfo);
  const userFinished = useMatcherStore((s) => s.userFinished);

  const hasNewProperties = useMatcherStore((s) => s.hasNewProperties);
  const notificationMessage = useMatcherStore((s) => s.notificationMessage);

  const setReviewer = useMatcherStore((s) => s.setReviewer);
  const loadSession = useMatcherStore((s) => s.loadSession);
  const loadNextListing = useMatcherStore((s) => s.loadNextListing);
  const confirmMatch = useMatcherStore((s) => s.confirmMatch);
  const skipListing = useMatcherStore((s) => s.skipListing);
  const undo = useMatcherStore((s) => s.undo);
  const advancePass = useMatcherStore((s) => s.advancePass);
  const finishMatching = useMatcherStore((s) => s.finishMatching);
  const resetCompound = useMatcherStore((s) => s.resetCompound);
  const clearError = useMatcherStore((s) => s.clearError);
  const dismissNotification = useMatcherStore((s) => s.dismissNotification);

  // Local UI state
  const [showNamePrompt, setShowNamePrompt] = useState(false);
  const [nameInput, setNameInput] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [lightboxImage, setLightboxImage] = useState<{
    standard: string;
    full: string | null;
  } | null>(null);
  const [showFullMosaic, setShowFullMosaic] = useState(true);
  const [showEmailModal, setShowEmailModal] = useState(false);
  const [emailInput, setEmailInput] = useState('');
  const [isSendingReport, setIsSendingReport] = useState(false);
  const [toast, setToast] = useState<{
    message: string;
    type: 'success' | 'error' | 'info';
  } | null>(null);

  // Animation state
  const [overlayType, setOverlayType] = useState<'match' | 'skip' | 'undo'>(
    'match'
  );
  const [overlayVisible, setOverlayVisible] = useState(false);
  const isAnimating = useRef(false);

  // Shared values for content slide animation
  const contentTranslateX = useSharedValue(0);
  const contentOpacity = useSharedValue(1);
  const contentRotate = useSharedValue(0);
  const contentScale = useSharedValue(1);

  const contentAnimatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: contentTranslateX.value },
      { rotate: `${contentRotate.value}deg` },
      { scale: contentScale.value },
    ],
    opacity: contentOpacity.value,
  }));

  // ScrollView ref to scroll to top on new content
  const scrollViewRef = useRef<ScrollView>(null);

  // Set compound in store when route params change
  useEffect(() => {
    if (compoundId && compoundId !== storeCompoundId) {
      setCompound(compoundId, compoundName || compoundId);
    }
  }, [compoundId, compoundName, storeCompoundId, setCompound]);

  // Initialize on mount (after compound is set)
  useEffect(() => {
    if (!storeCompoundId) return;
    const init = async () => {
      if (!reviewer) {
        setShowNamePrompt(true);
      } else {
        await loadSession();
        await loadNextListing();
      }
    };
    init();
  }, [reviewer, storeCompoundId]);

  // Show toast on error
  useEffect(() => {
    if (error) {
      setToast({ message: error, type: 'error' });
      clearError();
    }
  }, [error]);

  // Handle reviewer name submission
  // Note: loadSession/loadNextListing are handled by the useEffect on `reviewer`
  const handleNameSubmit = useCallback(() => {
    if (nameInput.trim()) {
      setReviewer(nameInput.trim());
      setShowNamePrompt(false);
    }
  }, [nameInput, setReviewer]);

  // Handle pull-to-refresh
  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadSession();
    if (!currentListing) {
      await loadNextListing();
    }
    setRefreshing(false);
  }, [loadSession, loadNextListing, currentListing]);

  // Handle notification dismiss
  const handleDismissNotification = useCallback(async () => {
    await dismissNotification();
    await loadNextListing();
  }, [dismissNotification, loadNextListing]);

  // Handle sending unmatched report via email
  const handleSendReport = useCallback(async () => {
    if (!emailInput.trim() || !emailInput.includes('@')) {
      setToast({ message: 'Please enter a valid email', type: 'error' });
      return;
    }
    setIsSendingReport(true);
    try {
      const { sendReportEmail } = await import('../../lib/api');
      await sendReportEmail(storeCompoundId!, emailInput.trim());
      setShowEmailModal(false);
      setEmailInput('');
      setToast({ message: 'Report sent successfully!', type: 'success' });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to send report';
      setToast({ message, type: 'error' });
    } finally {
      setIsSendingReport(false);
    }
  }, [emailInput, storeCompoundId]);

  // Handle reset compound
  const handleReset = useCallback(() => {
    Alert.alert(
      'Reset All Matches?',
      'This will clear all matching decisions for this compound. You\'ll start over from Pass 1. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reset',
          style: 'destructive',
          onPress: async () => {
            await resetCompound();
            setToast({ message: 'Compound reset — starting fresh', type: 'info' });
          },
        },
      ]
    );
  }, [resetCompound]);

  // ---- Animation helpers ----

  // Promise wrapper for reanimated withTiming
  const animateOut = (
    type: 'match' | 'skip' | 'undo'
  ): Promise<void> => {
    return new Promise((resolve) => {
      const direction = type === 'undo' ? 1 : -1; // undo slides right, others slide left
      const targetX = direction * SCREEN_WIDTH;
      const targetRotation = type === 'skip' ? -3 : 0; // slight rotation on skip
      const duration = type === 'match' ? EXIT_DURATION + 50 : EXIT_DURATION;

      if (type === 'match') {
        // Match: scale down slightly then slide out
        contentScale.value = withTiming(0.95, {
          duration: 100,
          easing: EASING_SMOOTH,
        });
      }

      contentTranslateX.value = withTiming(targetX, {
        duration,
        easing: EASING_SMOOTH,
      });
      contentOpacity.value = withTiming(0.2, {
        duration,
        easing: EASING_SMOOTH,
      });
      contentRotate.value = withTiming(targetRotation, {
        duration: duration * 0.6,
        easing: EASING_SMOOTH,
        // Use the last animation to resolve the promise
      });

      // Resolve after the exit animation completes
      setTimeout(resolve, duration + 20);
    });
  };

  const animateIn = (
    type: 'match' | 'skip' | 'undo'
  ): Promise<void> => {
    return new Promise((resolve) => {
      const direction = type === 'undo' ? -1 : 1; // undo enters from left, others from right
      const startX = direction * SCREEN_WIDTH * 0.4;

      // Set starting position immediately (no animation)
      contentTranslateX.value = startX;
      contentOpacity.value = 0;
      contentRotate.value = 0;
      contentScale.value = 1;

      // Animate to final position
      contentTranslateX.value = withTiming(0, {
        duration: ENTER_DURATION,
        easing: EASING_SMOOTH,
      });
      contentOpacity.value = withTiming(1, {
        duration: ENTER_DURATION,
        easing: EASING_SMOOTH,
      });

      setTimeout(resolve, ENTER_DURATION + 20);
    });
  };

  const resetAnimationValues = () => {
    contentTranslateX.value = 0;
    contentOpacity.value = 1;
    contentRotate.value = 0;
    contentScale.value = 1;
  };

  // ---- Action handlers with animations ----

  // Handle match confirmation
  const handleMatch = useCallback(
    async (coelhoCode: string) => {
      if (isAnimating.current) return;
      isAnimating.current = true;

      // 1. Show overlay flash
      setOverlayType('match');
      setOverlayVisible(true);

      // 2. Run exit animation
      await animateOut('match');

      // 3. Perform the store action (loads next listing)
      await confirmMatch(coelhoCode);

      // 4. Scroll to top
      scrollViewRef.current?.scrollTo({ y: 0, animated: false });

      // 5. Run entrance animation
      await animateIn('match');

      // 6. Clean up
      setOverlayVisible(false);
      const matchError = useMatcherStore.getState().error;
      if (matchError) {
        clearError();
        setToast({ message: matchError, type: 'error' });
      } else {
        setToast({ message: 'Match confirmed!', type: 'success' });
      }
      isAnimating.current = false;
    },
    [confirmMatch, clearError, contentTranslateX, contentOpacity, contentRotate, contentScale]
  );

  // Handle skip
  const handleSkip = useCallback(async () => {
    if (isAnimating.current) return;
    isAnimating.current = true;

    // 1. Show overlay flash
    setOverlayType('skip');
    setOverlayVisible(true);

    // 2. Run exit animation
    await animateOut('skip');

    // 3. Perform the store action
    await skipListing();

    // 4. Scroll to top
    scrollViewRef.current?.scrollTo({ y: 0, animated: false });

    // 5. Run entrance animation
    await animateIn('skip');

    // 6. Clean up
    setOverlayVisible(false);
    const skipError = useMatcherStore.getState().error;
    if (skipError) {
      clearError();
      setToast({ message: skipError, type: 'error' });
    } else {
      setToast({ message: 'Listing skipped', type: 'info' });
    }
    isAnimating.current = false;
  }, [skipListing, clearError, contentTranslateX, contentOpacity, contentRotate, contentScale]);

  // Handle undo
  const handleUndo = useCallback(async () => {
    if (isAnimating.current) return;
    isAnimating.current = true;

    // 1. Show overlay flash
    setOverlayType('undo');
    setOverlayVisible(true);

    // 2. Run exit animation (reverse direction)
    await animateOut('undo');

    // 3. Perform the store action
    await undo();

    // 4. Scroll to top
    scrollViewRef.current?.scrollTo({ y: 0, animated: false });

    // 5. Run entrance animation (from left)
    await animateIn('undo');

    // 6. Clean up
    setOverlayVisible(false);
    const undoError = useMatcherStore.getState().error;
    if (undoError) {
      clearError();
      setToast({ message: undoError, type: 'error' });
    } else {
      setToast({ message: 'Decision undone', type: 'info' });
    }
    isAnimating.current = false;
  }, [undo, clearError, contentTranslateX, contentOpacity, contentRotate, contentScale]);

  // Handle image press for lightbox
  const handleImagePress = useCallback((standardUrl: string, fullUrl?: string) => {
    setLightboxImage({ standard: standardUrl, full: fullUrl || null });
    setShowFullMosaic(!!fullUrl);
  }, []);

  // Calculate progress
  const progress = sessionStats
    ? {
        completed: sessionStats.matched + sessionStats.skipped,
        total: sessionStats.total_viva_listings,
        percentage:
          sessionStats.total_viva_listings > 0
            ? ((sessionStats.matched + sessionStats.skipped) /
                sessionStats.total_viva_listings) *
              100
            : 0,
      }
    : { completed: 0, total: 0, percentage: 0 };

  // Check if all done (all passes complete or user finished)
  const allDone =
    (allPassesComplete || userFinished) &&
    currentListing === null &&
    !isLoading &&
    sessionStats !== null;

  return (
    <View style={styles.container}>
      {/* Back button */}
      <Pressable style={styles.backButton} onPress={() => router.back()}>
        <Text style={styles.backButtonText}>{'\u2190'} {compoundName || compoundId}</Text>
      </Pressable>

      {/* Header */}
      <Header
        reviewedCount={progress.completed}
        totalCount={progress.total}
        matchedCount={sessionStats?.matched ?? 0}
        skippedCount={sessionStats?.skipped ?? 0}
        canUndo={canUndo}
        onUndo={handleUndo}
        currentPass={currentPass}
        maxPasses={maxPasses}
        passName={passName}
        onHelp={() => {
          Alert.alert(
            'How to Match',
            '1. Compare the source property with candidates below\n\n' +
              '2. Tap any image to zoom in\n\n' +
              '3. Tap "Match" when you find the same property\n\n' +
              '4. Tap "Skip" if no candidate matches\n\n' +
              '5. Use "Undo" to revert your last decision\n\n' +
              'Passes: Each pass uses broader matching criteria.\n' +
              'Skipped listings are reconsidered in later passes.'
          );
        }}
      />

      {/* Notification Banner */}
      {hasNewProperties && notificationMessage && (
        <Pressable
          style={styles.notificationBanner}
          onPress={handleDismissNotification}
        >
          <View style={styles.notificationContent}>
            <Text style={styles.notificationText}>{notificationMessage}</Text>
            <Text style={styles.notificationDismiss}>Tap to dismiss</Text>
          </View>
        </Pressable>
      )}

      {/* Main Content */}
      {allDone ? (
        <EmptyState
          totalReviewed={progress.completed}
          totalMatched={sessionStats?.matched ?? 0}
          totalSkipped={sessionStats?.skipped ?? 0}
          passesCompleted={maxPasses}
          onSendReport={() => setShowEmailModal(true)}
          onReset={handleReset}
        />
      ) : (
        <Animated.View style={[styles.animatedContentWrapper, contentAnimatedStyle]}>
          <ScrollView
            ref={scrollViewRef}
            style={styles.scrollView}
            contentContainerStyle={[
              styles.scrollContent,
              { paddingBottom: 100 + insets.bottom },
            ]}
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={handleRefresh}
                tintColor={colors.textSecondary}
                colors={[colors.accentBlue]}
              />
            }
          >
            {/* Source Property */}
            {currentListing && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Source Property</Text>
                <PropertyCard
                  listing={currentListing}
                  onImagePress={() =>
                    handleImagePress(currentListing.mosaicPath, currentListing.fullMosaicPath)
                  }
                />
              </View>
            )}

            {/* Candidates */}
            <View style={styles.section}>
              <CandidateList
                candidates={candidates}
                onMatch={handleMatch}
                onImagePress={handleImagePress}
                totalReviewed={progress.completed}
                totalMatched={sessionStats?.matched ?? 0}
                totalSkipped={sessionStats?.skipped ?? 0}
              />
            </View>
          </ScrollView>
        </Animated.View>
      )}

      {/* Bottom Action Bar */}
      {!allDone && (
        <BottomActionBar
          onSkip={handleSkip}
          onUndo={handleUndo}
          canUndo={canUndo}
        />
      )}

      {/* Transition Overlay (match/skip/undo flash) */}
      <TransitionOverlay type={overlayType} visible={overlayVisible} />

      {/* Image Lightbox */}
      <Modal
        visible={lightboxImage !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setLightboxImage(null)}
      >
        <Pressable
          style={styles.lightbox}
          onPress={() => setLightboxImage(null)}
        >
          {lightboxImage && (
            <Image
              source={{
                uri: showFullMosaic && lightboxImage.full
                  ? lightboxImage.full
                  : lightboxImage.standard,
              }}
              style={styles.lightboxImage}
              contentFit="contain"
              onError={() => {
                if (showFullMosaic) setShowFullMosaic(false);
              }}
            />
          )}
          <Pressable
            style={styles.lightboxClose}
            onPress={() => setLightboxImage(null)}
          >
            <Text style={styles.lightboxCloseText}>{'\u2715'}</Text>
          </Pressable>
          {lightboxImage?.full && (
            <Pressable
              style={styles.mosaicToggle}
              onPress={(e) => {
                e.stopPropagation();
                setShowFullMosaic((prev) => !prev);
              }}
            >
              <Text style={styles.mosaicToggleText}>
                {showFullMosaic ? 'Standard (8)' : 'All Photos (16)'}
              </Text>
            </Pressable>
          )}
        </Pressable>
      </Modal>

      {/* Reviewer Name Prompt */}
      <Modal visible={showNamePrompt} transparent animationType="slide">
        <View style={styles.promptOverlay}>
          <View style={styles.promptCard}>
            <Text style={styles.promptTitle}>Welcome!</Text>
            <Text style={styles.promptSubtitle}>
              Enter your name to track your matching decisions
            </Text>
            <TextInput
              style={styles.promptInput}
              placeholder="Your name"
              placeholderTextColor={colors.textMuted}
              value={nameInput}
              onChangeText={setNameInput}
              autoFocus
              autoCapitalize="words"
              returnKeyType="done"
              onSubmitEditing={handleNameSubmit}
            />
            <Pressable
              style={[
                styles.promptButton,
                !nameInput.trim() && styles.promptButtonDisabled,
              ]}
              onPress={handleNameSubmit}
              disabled={!nameInput.trim()}
            >
              <Text style={styles.promptButtonText}>Start Matching</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* Email Report Modal */}
      <Modal visible={showEmailModal} transparent animationType="slide">
        <View style={styles.promptOverlay}>
          <View style={styles.promptCard}>
            <Text style={styles.promptTitle}>Send Report</Text>
            <Text style={styles.promptSubtitle}>
              Send the unmatched properties report to your email
            </Text>
            <TextInput
              style={styles.promptInput}
              placeholder="email@example.com"
              placeholderTextColor={colors.textMuted}
              value={emailInput}
              onChangeText={setEmailInput}
              autoFocus
              keyboardType="email-address"
              autoCapitalize="none"
              returnKeyType="send"
              onSubmitEditing={handleSendReport}
            />
            <Pressable
              style={[
                styles.promptButton,
                (!emailInput.trim() || isSendingReport) && styles.promptButtonDisabled,
              ]}
              onPress={handleSendReport}
              disabled={!emailInput.trim() || isSendingReport}
            >
              <Text style={styles.promptButtonText}>
                {isSendingReport ? 'Sending...' : 'Send Report'}
              </Text>
            </Pressable>
            <Pressable
              style={styles.emailCancelButton}
              onPress={() => setShowEmailModal(false)}
            >
              <Text style={styles.emailCancelText}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* Pass Complete Modal */}
      <Modal visible={passComplete} transparent animationType="slide">
        <View style={styles.promptOverlay}>
          <View style={styles.passCompleteCard}>
            <Text style={styles.passCompleteIcon}>{'\uD83C\uDFAF'}</Text>
            <Text style={styles.passCompleteTitle}>Pass {currentPass} Complete!</Text>
            <Text style={styles.passCompleteSubtitle}>
              {passName === 'hail_mary' ? 'Hail Mary' : passName.charAt(0).toUpperCase() + passName.slice(1)} matching pass finished
            </Text>

            {passStats && (
              <View style={styles.passStatsContainer}>
                <View style={styles.passStatBox}>
                  <Text style={[styles.passStatValue, { color: '#00e676' }]}>{passStats.matched}</Text>
                  <Text style={styles.passStatLabel}>Matched</Text>
                </View>
                <View style={styles.passStatDivider} />
                <View style={styles.passStatBox}>
                  <Text style={[styles.passStatValue, { color: '#ffab40' }]}>{passStats.skipped}</Text>
                  <Text style={styles.passStatLabel}>Skipped</Text>
                </View>
              </View>
            )}

            {hasNextPass && nextPassInfo && (
              <Pressable style={styles.advanceButton} onPress={advancePass}>
                <Text style={styles.advanceButtonText}>
                  {nextPassInfo.hail_mary
                    ? 'Hail Mary Pass'
                    : `Continue to Pass ${nextPassInfo.number}`}
                </Text>
                <Text style={styles.advanceButtonSubtext}>
                  {nextPassInfo.hail_mary
                    ? `All remaining properties \u2013 ${nextPassInfo.listings_to_review} to review`
                    : `${nextPassInfo.name} (${nextPassInfo.price_tolerance} price, ${nextPassInfo.area_tolerance} area)`}
                </Text>
              </Pressable>
            )}

            <Pressable style={styles.finishButton} onPress={finishMatching}>
              <Text style={styles.finishButtonText}>I'm Finished - Generate Report</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* Toast Notification */}
      {toast && (
        <Toast
          message={toast.message}
          type={toast.type}
          onDismiss={() => setToast(null)}
        />
      )}
    </View>
  );
}

// Color palette
const colors = {
  background: '#0c0f1a',
  surface: '#161b2e',
  surfaceElevated: '#1e2540',
  border: '#2a3154',
  borderSubtle: '#1e2540',
  textPrimary: '#e8ecf4',
  textSecondary: '#8892b0',
  textMuted: '#5a6380',
  accentGreen: '#00e676',
  accentAmber: '#ffab40',
  accentBlue: '#448aff',
  accentRed: '#ff5252',
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  backButton: {
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  backButtonText: {
    color: colors.accentBlue,
    fontSize: 15,
    fontWeight: '600',
  },
  animatedContentWrapper: {
    flex: 1,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    padding: 16,
  },
  section: {
    marginBottom: 24,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 12,
    fontFamily: 'System',
  },
  lightbox: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.95)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  lightboxImage: {
    width: '100%',
    height: '100%',
  },
  lightboxClose: {
    position: 'absolute',
    top: 60,
    right: 20,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  lightboxCloseText: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '600',
  },
  mosaicToggle: {
    position: 'absolute',
    bottom: 60,
    alignSelf: 'center',
    backgroundColor: 'rgba(0,0,0,0.7)',
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 20,
  },
  mosaicToggleText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  promptOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  promptCard: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: 24,
    width: '100%',
    maxWidth: 340,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
  },
  promptTitle: {
    fontSize: 24,
    fontWeight: '800',
    color: colors.textPrimary,
    marginBottom: 8,
    fontFamily: 'System',
  },
  promptSubtitle: {
    fontSize: 15,
    color: colors.textSecondary,
    textAlign: 'center',
    marginBottom: 24,
    fontWeight: '300',
    fontFamily: 'System',
  },
  promptInput: {
    width: '100%',
    height: 48,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 16,
    fontSize: 16,
    marginBottom: 16,
    backgroundColor: colors.surfaceElevated,
    color: colors.textPrimary,
  },
  promptButton: {
    width: '100%',
    height: 48,
    backgroundColor: colors.accentBlue,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
  },
  promptButtonDisabled: {
    backgroundColor: colors.textMuted,
  },
  promptButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
    fontFamily: 'System',
  },
  passCompleteCard: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: 24,
    width: '100%',
    maxWidth: 340,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
  },
  passCompleteIcon: {
    fontSize: 48,
    marginBottom: 16,
  },
  passCompleteTitle: {
    fontSize: 22,
    fontWeight: '800',
    color: colors.textPrimary,
    marginBottom: 4,
  },
  passCompleteSubtitle: {
    fontSize: 14,
    color: colors.textSecondary,
    marginBottom: 20,
  },
  passStatsContainer: {
    flexDirection: 'row',
    backgroundColor: colors.surfaceElevated,
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 20,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: colors.border,
  },
  passStatBox: {
    alignItems: 'center',
    paddingHorizontal: 16,
  },
  passStatValue: {
    fontSize: 24,
    fontWeight: '800',
  },
  passStatLabel: {
    fontSize: 11,
    color: colors.textSecondary,
    marginTop: 2,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  passStatDivider: {
    width: 1,
    backgroundColor: colors.border,
  },
  advanceButton: {
    width: '100%',
    backgroundColor: colors.accentBlue,
    borderRadius: 10,
    paddingVertical: 14,
    paddingHorizontal: 16,
    alignItems: 'center',
    marginBottom: 10,
  },
  advanceButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  advanceButtonSubtext: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 12,
    marginTop: 2,
  },
  finishButton: {
    width: '100%',
    backgroundColor: colors.surfaceElevated,
    borderRadius: 10,
    paddingVertical: 14,
    paddingHorizontal: 16,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
  },
  finishButtonText: {
    color: colors.accentAmber,
    fontSize: 15,
    fontWeight: '600',
  },
  notificationBanner: {
    backgroundColor: '#1a3a2a',
    borderBottomWidth: 1,
    borderBottomColor: '#00e676' + '40',
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  notificationContent: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  notificationText: {
    color: '#00e676',
    fontSize: 14,
    fontWeight: '600',
    flex: 1,
  },
  notificationDismiss: {
    color: '#8892b0',
    fontSize: 12,
    fontWeight: '400',
    marginLeft: 12,
  },
  emailCancelButton: {
    marginTop: 8,
    paddingVertical: 12,
    alignItems: 'center',
  },
  emailCancelText: {
    color: colors.textSecondary,
    fontSize: 15,
  },
});

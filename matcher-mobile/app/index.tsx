import { useCallback, useEffect, useState } from 'react';
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
} from 'react-native';
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Header } from '../components/Header';
import { PropertyCard } from '../components/PropertyCard';
import { CandidateList } from '../components/CandidateList';
import { BottomActionBar } from '../components/BottomActionBar';
import { Toast } from '../components/Toast';
import { EmptyState } from '../components/EmptyState';
import { useMatcherStore } from '../stores/matcherStore';

// Default API URL - change this for your network
const API_BASE_URL = 'http://localhost:3000';

export default function MatcherScreen() {
  const insets = useSafeAreaInsets();

  // Store state and actions
  const sessionStats = useMatcherStore((s) => s.sessionStats);
  const reviewer = useMatcherStore((s) => s.reviewer);
  const currentListing = useMatcherStore((s) => s.currentListing);
  const candidates = useMatcherStore((s) => s.candidates);
  const isLoading = useMatcherStore((s) => s.isLoading);
  const canUndo = useMatcherStore((s) => s.canUndo);
  const error = useMatcherStore((s) => s.error);

  const setReviewer = useMatcherStore((s) => s.setReviewer);
  const loadSession = useMatcherStore((s) => s.loadSession);
  const loadNextListing = useMatcherStore((s) => s.loadNextListing);
  const confirmMatch = useMatcherStore((s) => s.confirmMatch);
  const skipListing = useMatcherStore((s) => s.skipListing);
  const undo = useMatcherStore((s) => s.undo);
  const clearError = useMatcherStore((s) => s.clearError);

  // Local UI state
  const [showNamePrompt, setShowNamePrompt] = useState(false);
  const [nameInput, setNameInput] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);

  // Initialize on mount
  useEffect(() => {
    const init = async () => {
      // Check if we have a reviewer name
      if (!reviewer) {
        setShowNamePrompt(true);
      } else {
        await loadSession();
        await loadNextListing();
      }
    };
    init();
  }, [reviewer]);

  // Show toast on error
  useEffect(() => {
    if (error) {
      setToast({ message: error, type: 'error' });
      clearError();
    }
  }, [error]);

  // Handle reviewer name submission
  const handleNameSubmit = useCallback(async () => {
    if (nameInput.trim()) {
      setReviewer(nameInput.trim());
      setShowNamePrompt(false);
      await loadSession();
      await loadNextListing();
    }
  }, [nameInput, setReviewer, loadSession, loadNextListing]);

  // Handle pull-to-refresh
  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadSession();
    if (!currentListing) {
      await loadNextListing();
    }
    setRefreshing(false);
  }, [loadSession, loadNextListing, currentListing]);

  // Handle match confirmation
  const handleMatch = useCallback(async (coelhoCode: string) => {
    await confirmMatch(coelhoCode);
    setToast({ message: `Match confirmed!`, type: 'success' });
  }, [confirmMatch]);

  // Handle skip
  const handleSkip = useCallback(async () => {
    await skipListing();
    setToast({ message: 'Listing skipped', type: 'info' });
  }, [skipListing]);

  // Handle undo
  const handleUndo = useCallback(async () => {
    await undo();
    setToast({ message: 'Decision undone', type: 'info' });
  }, [undo]);

  // Handle image press for lightbox
  const handleImagePress = useCallback((imageUrl: string) => {
    setLightboxImage(imageUrl);
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

  // Check if all done
  const allDone = currentListing === null && !isLoading && sessionStats !== null;

  return (
    <View style={styles.container}>
      {/* Header */}
      <Header
        reviewedCount={progress.completed}
        totalCount={progress.total}
        matchedCount={sessionStats?.matched ?? 0}
        skippedCount={sessionStats?.skipped ?? 0}
        canUndo={canUndo}
        onUndo={handleUndo}
        onHelp={() => {
          Alert.alert(
            'How to Match',
            '1. Compare the source property with candidates below\n\n' +
            '2. Tap any image to zoom in\n\n' +
            '3. Tap "Match" when you find the same property\n\n' +
            '4. Tap "Skip" if no candidate matches\n\n' +
            '5. Use "Undo" to revert your last decision'
          );
        }}
      />

      {/* Main Content */}
      {allDone ? (
        <EmptyState
          totalReviewed={progress.completed}
          totalMatched={sessionStats?.matched ?? 0}
          totalSkipped={sessionStats?.skipped ?? 0}
        />
      ) : (
        <ScrollView
          style={styles.scrollView}
          contentContainerStyle={[
            styles.scrollContent,
            { paddingBottom: 100 + insets.bottom },
          ]}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />
          }
        >
          {/* Source Property */}
          {currentListing && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Source Property</Text>
              <PropertyCard
                listing={currentListing}
                onImagePress={() => handleImagePress(currentListing.mosaicPath)}
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
      )}

      {/* Bottom Action Bar */}
      {!allDone && (
        <BottomActionBar
          onSkip={handleSkip}
          onUndo={handleUndo}
          canUndo={canUndo}
        />
      )}

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
              source={{ uri: lightboxImage }}
              style={styles.lightboxImage}
              contentFit="contain"
            />
          )}
          <Pressable
            style={styles.lightboxClose}
            onPress={() => setLightboxImage(null)}
          >
            <Text style={styles.lightboxCloseText}>✕</Text>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Reviewer Name Prompt */}
      <Modal
        visible={showNamePrompt}
        transparent
        animationType="slide"
      >
        <View style={styles.promptOverlay}>
          <View style={styles.promptCard}>
            <Text style={styles.promptTitle}>Welcome!</Text>
            <Text style={styles.promptSubtitle}>
              Enter your name to track your matching decisions
            </Text>
            <TextInput
              style={styles.promptInput}
              placeholder="Your name"
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

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f8fafc',
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
    color: '#64748b',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 12,
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
  promptOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  promptCard: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 24,
    width: '100%',
    maxWidth: 340,
    alignItems: 'center',
  },
  promptTitle: {
    fontSize: 24,
    fontWeight: '700',
    color: '#0f172a',
    marginBottom: 8,
  },
  promptSubtitle: {
    fontSize: 15,
    color: '#64748b',
    textAlign: 'center',
    marginBottom: 24,
  },
  promptInput: {
    width: '100%',
    height: 48,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    paddingHorizontal: 16,
    fontSize: 16,
    marginBottom: 16,
  },
  promptButton: {
    width: '100%',
    height: 48,
    backgroundColor: '#3b82f6',
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
  },
  promptButtonDisabled: {
    backgroundColor: '#94a3b8',
  },
  promptButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
});

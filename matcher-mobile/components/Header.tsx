import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  Modal,
  ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { ProgressBar } from './ProgressBar';

// Color palette
const colors = {
  primary: '#3b82f6',
  success: '#10b981',
  warning: '#f59e0b',
  danger: '#ef4444',
  background: '#f8fafc',
  backgroundDark: '#0f172a',
  text: '#0f172a',
  textDark: '#f1f5f9',
  textSecondary: '#64748b',
  border: '#e2e8f0',
  white: '#ffffff',
};

type HeaderProps = {
  reviewedCount: number;
  matchedCount: number;
  skippedCount: number;
  totalCount: number;
  canUndo: boolean;
  onUndo: () => void;
  onHelp?: () => void;
};

/**
 * Header - App header with progress badges and action buttons
 */
export function Header({
  reviewedCount,
  matchedCount,
  skippedCount,
  totalCount,
  canUndo,
  onUndo,
  onHelp,
}: HeaderProps) {
  const [helpModalVisible, setHelpModalVisible] = useState(false);

  const progress = totalCount > 0 ? (reviewedCount / totalCount) * 100 : 0;

  const handleUndo = useCallback(async () => {
    if (!canUndo) return;
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    onUndo();
  }, [canUndo, onUndo]);

  const handleHelp = useCallback(async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (onHelp) {
      onHelp();
    } else {
      setHelpModalVisible(true);
    }
  }, [onHelp]);

  return (
    <SafeAreaView edges={['top']} style={styles.safeArea}>
      <View style={styles.container}>
        {/* Top row with title and buttons */}
        <View style={styles.topRow}>
          <Text style={styles.title}>Property Matcher</Text>
          <View style={styles.buttons}>
            <Pressable
              onPress={handleUndo}
              style={[styles.iconButton, !canUndo && styles.iconButtonDisabled]}
              disabled={!canUndo}
            >
              <Ionicons
                name="arrow-undo"
                size={22}
                color={canUndo ? colors.primary : colors.textSecondary}
              />
            </Pressable>
            <Pressable onPress={handleHelp} style={styles.iconButton}>
              <Ionicons name="help-circle-outline" size={24} color={colors.primary} />
            </Pressable>
          </View>
        </View>

        {/* Progress badges */}
        <View style={styles.badgeRow}>
          <View style={styles.badge}>
            <Text style={styles.badgeValue}>{reviewedCount}</Text>
            <Text style={styles.badgeLabel}>Reviewed</Text>
          </View>
          <View style={[styles.badge, styles.badgeSuccess]}>
            <Text style={[styles.badgeValue, styles.badgeValueSuccess]}>{matchedCount}</Text>
            <Text style={[styles.badgeLabel, styles.badgeLabelSuccess]}>Matched</Text>
          </View>
          <View style={[styles.badge, styles.badgeWarning]}>
            <Text style={[styles.badgeValue, styles.badgeValueWarning]}>{skippedCount}</Text>
            <Text style={[styles.badgeLabel, styles.badgeLabelWarning]}>Skipped</Text>
          </View>
          <View style={styles.badge}>
            <Text style={styles.badgeValue}>{totalCount - reviewedCount}</Text>
            <Text style={styles.badgeLabel}>Remaining</Text>
          </View>
        </View>

        {/* Progress bar */}
        <View style={styles.progressContainer}>
          <ProgressBar progress={progress} height={4} />
          <Text style={styles.progressText}>{progress.toFixed(0)}% complete</Text>
        </View>
      </View>

      {/* Help Modal */}
      <Modal
        visible={helpModalVisible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setHelpModalVisible(false)}
      >
        <SafeAreaView style={styles.modalContainer}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>How to Use</Text>
            <Pressable onPress={() => setHelpModalVisible(false)} style={styles.closeButton}>
              <Ionicons name="close" size={28} color={colors.text} />
            </Pressable>
          </View>
          <ScrollView style={styles.modalContent}>
            <View style={styles.helpSection}>
              <Text style={styles.helpTitle}>Match Properties</Text>
              <Text style={styles.helpText}>
                Review property listings from VivaReal and find matching listings from Coelho da
                Fonseca. Compare images, prices, and specifications.
              </Text>
            </View>

            <View style={styles.helpSection}>
              <Text style={styles.helpTitle}>Actions</Text>
              <View style={styles.helpItem}>
                <View style={[styles.helpIcon, { backgroundColor: colors.success }]}>
                  <Ionicons name="checkmark" size={18} color={colors.white} />
                </View>
                <Text style={styles.helpText}>
                  <Text style={styles.helpBold}>Match</Text> - Properties are the same listing
                </Text>
              </View>
              <View style={styles.helpItem}>
                <View style={[styles.helpIcon, { backgroundColor: colors.danger }]}>
                  <Ionicons name="close" size={18} color={colors.white} />
                </View>
                <Text style={styles.helpText}>
                  <Text style={styles.helpBold}>Reject</Text> - Properties are different
                </Text>
              </View>
              <View style={styles.helpItem}>
                <View style={[styles.helpIcon, { backgroundColor: colors.warning }]}>
                  <Ionicons name="arrow-forward" size={18} color={colors.white} />
                </View>
                <Text style={styles.helpText}>
                  <Text style={styles.helpBold}>Skip</Text> - Unsure, review later
                </Text>
              </View>
            </View>

            <View style={styles.helpSection}>
              <Text style={styles.helpTitle}>Tips</Text>
              <Text style={styles.helpText}>
                {'\u2022'} Look for matching room layouts and furniture{'\n'}
                {'\u2022'} Check price and area differences (shown as %){'\n'}
                {'\u2022'} Tap images to see them full-size{'\n'}
                {'\u2022'} Use Undo to reverse your last decision
              </Text>
            </View>
          </ScrollView>
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    backgroundColor: colors.white,
  },
  container: {
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  topRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: colors.text,
  },
  buttons: {
    flexDirection: 'row',
    gap: 8,
  },
  iconButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconButtonDisabled: {
    opacity: 0.5,
  },
  badgeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 12,
    gap: 8,
  },
  badge: {
    flex: 1,
    backgroundColor: colors.background,
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 8,
    alignItems: 'center',
  },
  badgeSuccess: {
    backgroundColor: `${colors.success}15`,
  },
  badgeWarning: {
    backgroundColor: `${colors.warning}15`,
  },
  badgeValue: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.text,
  },
  badgeValueSuccess: {
    color: colors.success,
  },
  badgeValueWarning: {
    color: colors.warning,
  },
  badgeLabel: {
    fontSize: 10,
    fontWeight: '500',
    color: colors.textSecondary,
    marginTop: 2,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  badgeLabelSuccess: {
    color: colors.success,
  },
  badgeLabelWarning: {
    color: colors.warning,
  },
  progressContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  progressText: {
    fontSize: 12,
    color: colors.textSecondary,
    fontWeight: '500',
    minWidth: 80,
    textAlign: 'right',
  },
  // Modal styles
  modalContainer: {
    flex: 1,
    backgroundColor: colors.white,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.text,
  },
  closeButton: {
    padding: 4,
  },
  modalContent: {
    flex: 1,
    padding: 20,
  },
  helpSection: {
    marginBottom: 24,
  },
  helpTitle: {
    fontSize: 17,
    fontWeight: '600',
    color: colors.text,
    marginBottom: 8,
  },
  helpText: {
    fontSize: 15,
    color: colors.textSecondary,
    lineHeight: 22,
  },
  helpBold: {
    fontWeight: '600',
    color: colors.text,
  },
  helpItem: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 10,
    gap: 12,
  },
  helpIcon: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

export default Header;

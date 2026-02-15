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

type HeaderProps = {
  reviewedCount: number;
  matchedCount: number;
  skippedCount: number;
  totalCount: number;
  canUndo: boolean;
  onUndo: () => void;
  onHelp?: () => void;
  currentPass?: number;
  maxPasses?: number;
  passName?: string;
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
  currentPass = 1,
  maxPasses = 5,
  passName = 'strict',
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
          <View style={styles.titleContainer}>
            <Text style={styles.title}>Property Matcher</Text>
            <View style={styles.passBadge}>
              <Text style={styles.passText}>
                Pass {currentPass}/{maxPasses} ({passName === 'hail_mary' ? 'Hail Mary' : passName})
              </Text>
            </View>
          </View>
          <View style={styles.buttons}>
            <Pressable
              onPress={handleUndo}
              style={[styles.iconButton, !canUndo && styles.iconButtonDisabled]}
              disabled={!canUndo}
            >
              <Ionicons
                name="arrow-undo"
                size={22}
                color={canUndo ? colors.accentBlue : colors.textMuted}
              />
            </Pressable>
            <Pressable onPress={handleHelp} style={styles.iconButton}>
              <Ionicons name="help-circle-outline" size={24} color={colors.accentBlue} />
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
          <ProgressBar progress={progress} height={6} />
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
              <Ionicons name="close" size={28} color={colors.textPrimary} />
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
                <View style={[styles.helpIcon, { backgroundColor: colors.accentGreen }]}>
                  <Ionicons name="checkmark" size={18} color={colors.background} />
                </View>
                <Text style={styles.helpText}>
                  <Text style={styles.helpBold}>Match</Text> - Properties are the same listing
                </Text>
              </View>
              <View style={styles.helpItem}>
                <View style={[styles.helpIcon, { backgroundColor: colors.accentRed }]}>
                  <Ionicons name="close" size={18} color={colors.background} />
                </View>
                <Text style={styles.helpText}>
                  <Text style={styles.helpBold}>Reject</Text> - Properties are different
                </Text>
              </View>
              <View style={styles.helpItem}>
                <View style={[styles.helpIcon, { backgroundColor: colors.accentAmber }]}>
                  <Ionicons name="arrow-forward" size={18} color={colors.background} />
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
    backgroundColor: colors.background,
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
  titleContainer: {
    flexDirection: 'column',
    gap: 2,
  },
  title: {
    fontSize: 26,
    fontWeight: '800',
    color: colors.textPrimary,
    letterSpacing: -0.5,
    fontFamily: 'System',
  },
  passBadge: {
    backgroundColor: colors.accentBlue + '15',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
    alignSelf: 'flex-start',
  },
  passText: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.accentBlue,
    textTransform: 'capitalize',
  },
  buttons: {
    flexDirection: 'row',
    gap: 8,
  },
  iconButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.surfaceElevated,
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
    backgroundColor: colors.surface,
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 8,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.borderSubtle,
  },
  badgeSuccess: {
    backgroundColor: '#00e67615',
    borderColor: '#00e67640',
  },
  badgeWarning: {
    backgroundColor: '#ffab4015',
    borderColor: '#ffab4040',
  },
  badgeValue: {
    fontSize: 18,
    fontWeight: '800',
    color: colors.textPrimary,
    fontFamily: 'System',
  },
  badgeValueSuccess: {
    color: colors.accentGreen,
  },
  badgeValueWarning: {
    color: colors.accentAmber,
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
    color: colors.accentGreen,
  },
  badgeLabelWarning: {
    color: colors.accentAmber,
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
    backgroundColor: colors.background,
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
    fontWeight: '800',
    color: colors.textPrimary,
    fontFamily: 'System',
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
    fontWeight: '800',
    color: colors.textPrimary,
    marginBottom: 8,
    fontFamily: 'System',
  },
  helpText: {
    fontSize: 15,
    color: colors.textSecondary,
    lineHeight: 22,
    fontWeight: '300',
    fontFamily: 'System',
  },
  helpBold: {
    fontWeight: '600',
    color: colors.textPrimary,
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

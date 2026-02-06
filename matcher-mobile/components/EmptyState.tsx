import React, { memo } from 'react';
import { View, Text, StyleSheet } from 'react-native';

// Color palette
const colors = {
  background: '#0c0f1a',
  surface: '#161b2e',
  surfaceElevated: '#1e2540',
  border: '#2a3154',
  textPrimary: '#e8ecf4',
  textSecondary: '#8892b0',
  textMuted: '#5a6380',
  accentGreen: '#00e676',
  accentAmber: '#ffab40',
  accentBlue: '#448aff',
};

type EmptyStateProps = {
  totalReviewed?: number;
  totalMatched?: number;
  totalSkipped?: number;
  passesCompleted?: number;
};

/**
 * Empty State component
 * Shown when all listings have been reviewed
 * Displays a celebration message with summary stats
 */
function EmptyStateComponent({
  totalReviewed = 0,
  totalMatched = 0,
  totalSkipped = 0,
  passesCompleted = 5,
}: EmptyStateProps) {
  return (
    <View style={styles.container}>
      <View style={styles.iconContainer}>
        <Text style={styles.icon}>&#x1F389;</Text>
      </View>

      <Text style={styles.title}>All Done!</Text>
      <Text style={styles.subtitle}>
        All {passesCompleted} matching passes completed
      </Text>

      {totalReviewed > 0 && (
        <View style={styles.statsContainer}>
          <View style={styles.statBox}>
            <Text style={styles.statValue}>{totalReviewed}</Text>
            <Text style={styles.statLabel}>Reviewed</Text>
          </View>
          <View style={styles.statDivider} />
          <View style={styles.statBox}>
            <Text style={[styles.statValue, styles.matchedValue]}>{totalMatched}</Text>
            <Text style={styles.statLabel}>Matched</Text>
          </View>
          <View style={styles.statDivider} />
          <View style={styles.statBox}>
            <Text style={[styles.statValue, styles.skippedValue]}>{totalSkipped}</Text>
            <Text style={styles.statLabel}>Skipped</Text>
          </View>
        </View>
      )}

      <Text style={styles.hint}>
        Pull down to refresh for new listings
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 32,
    paddingVertical: 48,
    backgroundColor: colors.background,
  },
  iconContainer: {
    width: 88,
    height: 88,
    borderRadius: 44,
    backgroundColor: colors.surface,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 24,
    borderWidth: 2,
    borderColor: colors.accentGreen + '40',
    shadowColor: colors.accentGreen,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.3,
    shadowRadius: 16,
    elevation: 8,
  },
  icon: {
    fontSize: 40,
  },
  title: {
    fontSize: 26,
    fontWeight: '800',
    color: colors.textPrimary,
    marginBottom: 8,
    fontFamily: 'System',
  },
  subtitle: {
    fontSize: 16,
    color: colors.textSecondary,
    textAlign: 'center',
    marginBottom: 32,
    fontWeight: '300',
    fontFamily: 'System',
  },
  statsContainer: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderRadius: 14,
    paddingVertical: 18,
    paddingHorizontal: 24,
    marginBottom: 32,
    borderWidth: 1,
    borderColor: colors.border,
  },
  statBox: {
    alignItems: 'center',
    paddingHorizontal: 16,
  },
  statValue: {
    fontSize: 26,
    fontWeight: '800',
    color: colors.textPrimary,
    fontFamily: 'System',
  },
  matchedValue: {
    color: colors.accentGreen,
  },
  skippedValue: {
    color: colors.accentAmber,
  },
  statLabel: {
    fontSize: 12,
    color: colors.textSecondary,
    marginTop: 4,
    fontWeight: '500',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  statDivider: {
    width: 1,
    backgroundColor: colors.border,
  },
  hint: {
    fontSize: 14,
    color: colors.textMuted,
    textAlign: 'center',
    fontWeight: '300',
    fontFamily: 'System',
  },
});

export const EmptyState = memo(EmptyStateComponent);

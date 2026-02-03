import React, { memo } from 'react';
import { View, Text, StyleSheet } from 'react-native';

type EmptyStateProps = {
  totalReviewed?: number;
  totalMatched?: number;
  totalSkipped?: number;
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
}: EmptyStateProps) {
  return (
    <View style={styles.container}>
      <View style={styles.iconContainer}>
        <Text style={styles.icon}>&#x1F389;</Text>
      </View>

      <Text style={styles.title}>All Done!</Text>
      <Text style={styles.subtitle}>
        You've reviewed all available listings
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
  },
  iconContainer: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: '#F0FDF4',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 24,
  },
  icon: {
    fontSize: 40,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: '#111827',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 16,
    color: '#6B7280',
    textAlign: 'center',
    marginBottom: 32,
  },
  statsContainer: {
    flexDirection: 'row',
    backgroundColor: '#F9FAFB',
    borderRadius: 12,
    paddingVertical: 16,
    paddingHorizontal: 24,
    marginBottom: 32,
  },
  statBox: {
    alignItems: 'center',
    paddingHorizontal: 16,
  },
  statValue: {
    fontSize: 24,
    fontWeight: '700',
    color: '#111827',
  },
  matchedValue: {
    color: '#22C55E',
  },
  skippedValue: {
    color: '#F59E0B',
  },
  statLabel: {
    fontSize: 12,
    color: '#6B7280',
    marginTop: 4,
  },
  statDivider: {
    width: 1,
    backgroundColor: '#E5E7EB',
  },
  hint: {
    fontSize: 14,
    color: '#9CA3AF',
    textAlign: 'center',
  },
});

export const EmptyState = memo(EmptyStateComponent);

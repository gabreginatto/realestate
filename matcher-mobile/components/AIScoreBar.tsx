import React, { memo } from 'react';
import { View, Text, StyleSheet } from 'react-native';

type AIScoreBarProps = {
  score: number; // 0-1
};

/**
 * AI Score Bar component
 * Shows a percentage label with a gradient fill bar (amber to green)
 */
function AIScoreBarComponent({ score }: AIScoreBarProps) {
  const percentage = Math.round(score * 100);

  // Interpolate color from amber (#F59E0B) to green (#22C55E)
  const getColor = (value: number): string => {
    // RGB values for amber: 245, 158, 11
    // RGB values for green: 34, 197, 94
    const r = Math.round(245 + (34 - 245) * value);
    const g = Math.round(158 + (197 - 158) * value);
    const b = Math.round(11 + (94 - 11) * value);
    return `rgb(${r}, ${g}, ${b})`;
  };

  const fillColor = getColor(score);

  return (
    <View style={styles.container}>
      <View style={styles.labelRow}>
        <Text style={styles.label}>AI Score</Text>
        <Text style={styles.percentage}>{percentage}%</Text>
      </View>
      <View style={styles.barBackground}>
        <View
          style={[
            styles.barFill,
            {
              width: `${percentage}%`,
              backgroundColor: fillColor,
            },
          ]}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  labelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  label: {
    fontSize: 12,
    color: '#6B7280',
    fontWeight: '500',
  },
  percentage: {
    fontSize: 14,
    color: '#111827',
    fontWeight: '600',
  },
  barBackground: {
    height: 8,
    backgroundColor: '#E5E7EB',
    borderRadius: 4,
    overflow: 'hidden',
  },
  barFill: {
    height: '100%',
    borderRadius: 4,
  },
});

export const AIScoreBar = memo(AIScoreBarComponent);

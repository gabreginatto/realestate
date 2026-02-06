import React, { memo } from 'react';
import { View, Text, StyleSheet } from 'react-native';

// Color palette
const colors = {
  surface: '#161b2e',
  surfaceElevated: '#1e2540',
  border: '#2a3154',
  textPrimary: '#e8ecf4',
  textSecondary: '#8892b0',
  accentAmber: '#ffab40',
  accentGreen: '#00e676',
};

type AIScoreBarProps = {
  score: number; // 0-1
};

/**
 * AI Score Bar component
 * Shows a percentage label with a gradient fill bar (amber to green)
 */
function AIScoreBarComponent({ score }: AIScoreBarProps) {
  const percentage = Math.round(score * 100);

  // Interpolate color from amber (#ffab40) to green (#00e676)
  const getColor = (value: number): string => {
    // RGB values for amber: 255, 171, 64
    // RGB values for green: 0, 230, 118
    const r = Math.round(255 + (0 - 255) * value);
    const g = Math.round(171 + (230 - 171) * value);
    const b = Math.round(64 + (118 - 64) * value);
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
    backgroundColor: colors.surface,
  },
  labelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  label: {
    fontSize: 12,
    color: colors.textSecondary,
    fontWeight: '500',
    fontFamily: 'System',
  },
  percentage: {
    fontSize: 14,
    color: colors.textPrimary,
    fontWeight: '600',
  },
  barBackground: {
    height: 8,
    backgroundColor: colors.border,
    borderRadius: 4,
    overflow: 'hidden',
  },
  barFill: {
    height: '100%',
    borderRadius: 4,
  },
});

export const AIScoreBar = memo(AIScoreBarComponent);

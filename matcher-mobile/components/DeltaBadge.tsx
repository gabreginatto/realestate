import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

// Color palette
const colors = {
  success: '#10b981',
  danger: '#ef4444',
  neutral: '#6b7280',
};

type DeltaBadgeProps = {
  delta: number;
};

/**
 * DeltaBadge - Shows formatted percentage with color coding
 * Green for negative (lower price is good), red for positive
 */
export function DeltaBadge({ delta }: DeltaBadgeProps) {
  const isPositive = delta > 0;
  const isNegative = delta < 0;
  const isNeutral = delta === 0;

  const backgroundColor = isNegative
    ? colors.success
    : isPositive
    ? colors.danger
    : colors.neutral;

  const formattedDelta = isPositive
    ? `+${delta.toFixed(1)}%`
    : isNeutral
    ? '0%'
    : `${delta.toFixed(1)}%`;

  return (
    <View style={[styles.badge, { backgroundColor }]}>
      <Text style={styles.text}>{formattedDelta}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
    minWidth: 60,
    alignItems: 'center',
  },
  text: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '600',
  },
});

export default DeltaBadge;

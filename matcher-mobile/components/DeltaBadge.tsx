import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

// Color palette
const colors = {
  accentGreen: '#00e676',
  accentRed: '#ff5252',
  neutral: '#5a6380',
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

  const bgColor = isNegative
    ? colors.accentGreen + '20'
    : isPositive
    ? colors.accentRed + '20'
    : colors.neutral + '20';

  const textColor = isNegative
    ? colors.accentGreen
    : isPositive
    ? colors.accentRed
    : colors.neutral;

  const formattedDelta = isPositive
    ? `+${delta.toFixed(1)}%`
    : isNeutral
    ? '0%'
    : `${delta.toFixed(1)}%`;

  return (
    <View style={[styles.badge, { backgroundColor: bgColor }]}>
      <Text style={[styles.text, { color: textColor }]}>{formattedDelta}</Text>
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
    fontSize: 12,
    fontWeight: '600',
  },
});

export default DeltaBadge;

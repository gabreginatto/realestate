import React, { useEffect } from 'react';
import { View, StyleSheet } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  Easing,
  interpolateColor,
} from 'react-native-reanimated';

// Color palette
const colors = {
  background: '#e2e8f0',
  gradientStart: '#3b82f6', // blue
  gradientEnd: '#10b981', // green
};

type ProgressBarProps = {
  progress: number; // 0-100
  height?: number;
};

/**
 * ProgressBar - Animated progress indicator with gradient colors
 */
export function ProgressBar({ progress, height = 6 }: ProgressBarProps) {
  const animatedProgress = useSharedValue(0);

  useEffect(() => {
    animatedProgress.value = withTiming(Math.min(100, Math.max(0, progress)), {
      duration: 500,
      easing: Easing.bezier(0.4, 0, 0.2, 1),
    });
  }, [progress, animatedProgress]);

  const animatedStyle = useAnimatedStyle(() => {
    // Interpolate color from blue to green based on progress
    const backgroundColor = interpolateColor(
      animatedProgress.value,
      [0, 50, 100],
      [colors.gradientStart, '#14b8a6', colors.gradientEnd]
    );

    return {
      width: `${animatedProgress.value}%`,
      backgroundColor,
    };
  });

  return (
    <View style={[styles.container, { height }]}>
      <Animated.View style={[styles.progress, { height }, animatedStyle]} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
    backgroundColor: colors.background,
    borderRadius: 3,
    overflow: 'hidden',
  },
  progress: {
    borderRadius: 3,
  },
});

export default ProgressBar;

import React, { useEffect } from 'react';
import { StyleSheet, Text } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withDelay,
  withSequence,
  Easing,
  runOnJS,
} from 'react-native-reanimated';

type TransitionType = 'match' | 'skip' | 'undo';

type TransitionOverlayProps = {
  type: TransitionType;
  visible: boolean;
  onComplete?: () => void;
};

const EASING = Easing.bezier(0.4, 0, 0.2, 1);

const overlayConfig: Record<
  TransitionType,
  { backgroundColor: string; label: string; fontSize: number }
> = {
  match: {
    backgroundColor: 'rgba(0, 230, 118, 0.2)',
    label: '\u2713',
    fontSize: 80,
  },
  skip: {
    backgroundColor: 'rgba(255, 171, 64, 0.15)',
    label: 'SKIPPED',
    fontSize: 32,
  },
  undo: {
    backgroundColor: 'rgba(68, 138, 255, 0.15)',
    label: '\u21B6',
    fontSize: 72,
  },
};

/**
 * TransitionOverlay - Full-screen flash overlay for match/skip/undo feedback.
 * Appears instantly, holds for ~200ms, then fades out over ~200ms.
 */
export function TransitionOverlay({
  type,
  visible,
  onComplete,
}: TransitionOverlayProps) {
  const opacity = useSharedValue(0);
  const scale = useSharedValue(0.7);

  useEffect(() => {
    if (visible) {
      // Appear instantly
      opacity.value = 1;
      scale.value = 0.7;

      // Scale the label in with a spring-like feel
      scale.value = withTiming(1, { duration: 200, easing: EASING });

      // Hold for 200ms, then fade out over 200ms
      opacity.value = withDelay(
        200,
        withTiming(0, { duration: 200, easing: EASING }, (finished) => {
          if (finished && onComplete) {
            runOnJS(onComplete)();
          }
        })
      );
    } else {
      opacity.value = 0;
      scale.value = 0.7;
    }
  }, [visible, type, opacity, scale, onComplete]);

  const containerStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    pointerEvents: opacity.value > 0 ? ('auto' as const) : ('none' as const),
  }));

  const labelStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const config = overlayConfig[type];

  return (
    <Animated.View
      style={[
        styles.overlay,
        { backgroundColor: config.backgroundColor },
        containerStyle,
      ]}
    >
      <Animated.View style={labelStyle}>
        <Text
          style={[
            styles.label,
            { fontSize: config.fontSize },
            type === 'skip' && styles.skipLabel,
          ]}
        >
          {config.label}
        </Text>
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 900,
    justifyContent: 'center',
    alignItems: 'center',
  },
  label: {
    color: '#ffffff',
    fontWeight: '800',
    textShadowColor: 'rgba(0, 0, 0, 0.3)',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 8,
  },
  skipLabel: {
    letterSpacing: 4,
    fontWeight: '900',
  },
});

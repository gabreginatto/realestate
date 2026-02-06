import React, { useEffect } from 'react';
import { Text, StyleSheet, Pressable } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withDelay,
  Easing,
  runOnJS,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

// Color palette
const colors = {
  background: '#0c0f1a',
  surface: '#161b2e',
  textPrimary: '#e8ecf4',
  success: '#00e676',
  successBg: '#00e67620',
  error: '#ff5252',
  errorBg: '#ff525220',
  info: '#448aff',
  infoBg: '#448aff20',
};

type ToastType = 'success' | 'error' | 'info';

type ToastProps = {
  message: string;
  type?: ToastType;
  onDismiss: () => void;
  duration?: number;
};

const typeBgColors: Record<ToastType, string> = {
  success: colors.successBg,
  error: colors.errorBg,
  info: colors.infoBg,
};

const typeBorderColors: Record<ToastType, string> = {
  success: colors.success,
  error: colors.error,
  info: colors.info,
};

const typeTextColors: Record<ToastType, string> = {
  success: colors.success,
  error: colors.error,
  info: colors.info,
};

const AUTO_DISMISS_DURATION = 3000;

/**
 * Toast - Notification component with animated slide in from top
 */
export function Toast({
  message,
  type = 'info',
  onDismiss,
  duration = AUTO_DISMISS_DURATION,
}: ToastProps) {
  const insets = useSafeAreaInsets();
  const translateY = useSharedValue(-100);
  const opacity = useSharedValue(0);

  useEffect(() => {
    // Slide in
    translateY.value = withTiming(0, {
      duration: 300,
      easing: Easing.bezier(0.4, 0, 0.2, 1),
    });
    opacity.value = withTiming(1, { duration: 300 });

    // Auto-dismiss after duration
    translateY.value = withDelay(
      duration,
      withTiming(-100, {
        duration: 300,
        easing: Easing.bezier(0.4, 0, 0.2, 1),
      })
    );
    opacity.value = withDelay(
      duration,
      withTiming(0, { duration: 300 }, (finished) => {
        if (finished) {
          runOnJS(onDismiss)();
        }
      })
    );
  }, [translateY, opacity, duration, onDismiss]);

  const handlePress = () => {
    translateY.value = withTiming(-100, {
      duration: 200,
      easing: Easing.bezier(0.4, 0, 0.2, 1),
    });
    opacity.value = withTiming(0, { duration: 200 }, (finished) => {
      if (finished) {
        runOnJS(onDismiss)();
      }
    });
  };

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
    opacity: opacity.value,
  }));

  return (
    <Animated.View
      style={[
        styles.container,
        {
          paddingTop: insets.top + 8,
          backgroundColor: typeBgColors[type],
          borderLeftColor: typeBorderColors[type],
        },
        animatedStyle,
      ]}
    >
      <Pressable onPress={handlePress} style={styles.pressable}>
        <Text style={[styles.message, { color: typeTextColors[type] }]}>{message}</Text>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 1000,
    paddingHorizontal: 16,
    paddingBottom: 16,
    borderLeftWidth: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
    elevation: 8,
  },
  pressable: {
    flex: 1,
  },
  message: {
    fontSize: 15,
    fontWeight: '600',
    textAlign: 'center',
    fontFamily: 'System',
  },
});

export default Toast;

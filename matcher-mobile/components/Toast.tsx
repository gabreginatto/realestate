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
  success: '#10b981',
  error: '#ef4444',
  info: '#3b82f6',
  white: '#ffffff',
};

type ToastType = 'success' | 'error' | 'info';

type ToastProps = {
  message: string;
  type?: ToastType;
  onDismiss: () => void;
  duration?: number;
};

const typeColors: Record<ToastType, string> = {
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
        { paddingTop: insets.top + 8, backgroundColor: typeColors[type] },
        animatedStyle,
      ]}
    >
      <Pressable onPress={handlePress} style={styles.pressable}>
        <Text style={styles.message}>{message}</Text>
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
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
    elevation: 8,
  },
  pressable: {
    flex: 1,
  },
  message: {
    color: colors.white,
    fontSize: 15,
    fontWeight: '500',
    textAlign: 'center',
  },
});

export default Toast;

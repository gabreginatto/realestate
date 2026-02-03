import React, { useCallback } from 'react';
import { Pressable, Text, StyleSheet, ViewStyle, TextStyle } from 'react-native';
import * as Haptics from 'expo-haptics';

// Color palette
const colors = {
  primary: '#3b82f6',
  primaryPressed: '#2563eb',
  success: '#10b981',
  successPressed: '#059669',
  warning: '#f59e0b',
  warningPressed: '#d97706',
  secondary: '#6b7280',
  secondaryPressed: '#4b5563',
  disabled: '#9ca3af',
  white: '#ffffff',
};

type ButtonVariant = 'primary' | 'success' | 'warning' | 'secondary';

type ActionButtonProps = {
  title: string;
  onPress: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  fullWidth?: boolean;
};

const variantColors: Record<ButtonVariant, { default: string; pressed: string }> = {
  primary: { default: colors.primary, pressed: colors.primaryPressed },
  success: { default: colors.success, pressed: colors.successPressed },
  warning: { default: colors.warning, pressed: colors.warningPressed },
  secondary: { default: colors.secondary, pressed: colors.secondaryPressed },
};

/**
 * ActionButton - Pressable button with variants and haptic feedback
 */
export function ActionButton({
  title,
  onPress,
  variant = 'primary',
  disabled = false,
  fullWidth = false,
}: ActionButtonProps) {
  const handlePress = useCallback(async () => {
    if (disabled) return;

    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    onPress();
  }, [disabled, onPress]);

  const buttonColors = variantColors[variant];

  return (
    <Pressable
      onPress={handlePress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.button,
        fullWidth && styles.fullWidth,
        {
          backgroundColor: disabled
            ? colors.disabled
            : pressed
            ? buttonColors.pressed
            : buttonColors.default,
        },
        pressed && !disabled && styles.pressed,
      ]}
    >
      <Text style={[styles.text, disabled && styles.textDisabled]}>{title}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 48,
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,
  fullWidth: {
    width: '100%',
  } as ViewStyle,
  pressed: {
    transform: [{ scale: 0.98 }],
  } as ViewStyle,
  text: {
    color: colors.white,
    fontSize: 16,
    fontWeight: '600',
  } as TextStyle,
  textDisabled: {
    color: 'rgba(255, 255, 255, 0.7)',
  } as TextStyle,
});

export default ActionButton;

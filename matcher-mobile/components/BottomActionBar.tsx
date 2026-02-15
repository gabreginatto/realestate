import React, { memo } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

// Color palette
const colors = {
  background: '#0c0f1a',
  surface: '#161b2e',
  surfaceElevated: '#1e2540',
  border: '#2a3154',
  textPrimary: '#e8ecf4',
  textSecondary: '#8892b0',
  textMuted: '#5a6380',
  accentAmber: '#ffab40',
  amberDark: '#3e2723',
};

type BottomActionBarProps = {
  onSkip: () => void;
  onUndo: () => void;
  canUndo: boolean;
  skipDisabled?: boolean;
};

/**
 * Bottom Action Bar component
 * Fixed at bottom with SafeAreaView
 * Contains Skip (warning) and Undo (secondary) buttons
 */
function BottomActionBarComponent({
  onSkip,
  onUndo,
  canUndo,
  skipDisabled = false,
}: BottomActionBarProps) {
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.container, { paddingBottom: Math.max(insets.bottom, 16) }]}>
      <Pressable
        style={[styles.button, styles.skipButton, skipDisabled && styles.buttonDisabled]}
        onPress={onSkip}
        disabled={skipDisabled}
      >
        <Text style={[styles.buttonText, styles.skipButtonText, skipDisabled && styles.buttonTextDisabled]}>
          {'\u2192'}  Skip
        </Text>
      </Pressable>

      <Pressable
        style={[styles.button, styles.undoButton, !canUndo && styles.buttonDisabled]}
        onPress={onUndo}
        disabled={!canUndo}
      >
        <Text style={[styles.buttonText, styles.undoButtonText, !canUndo && styles.buttonTextDisabled]}>
          {'\u21B6'}  Undo
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingTop: 12,
    backgroundColor: colors.background,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    gap: 12,
  },
  button: {
    flex: 1,
    height: 54,
    borderRadius: 14,
    justifyContent: 'center',
    alignItems: 'center',
  },
  skipButton: {
    backgroundColor: colors.accentAmber,
  },
  undoButton: {
    backgroundColor: colors.surfaceElevated,
  },
  buttonDisabled: {
    opacity: 0.4,
  },
  buttonText: {
    fontSize: 16,
    fontFamily: 'System',
  },
  skipButtonText: {
    color: colors.amberDark,
    fontWeight: '700',
  },
  undoButtonText: {
    color: colors.textSecondary,
    fontWeight: '600',
  },
  buttonTextDisabled: {
    color: colors.textMuted,
  },
});

export const BottomActionBar = memo(BottomActionBarComponent);

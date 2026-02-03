import React, { memo } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

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
      <TouchableOpacity
        style={[styles.button, styles.skipButton, skipDisabled && styles.buttonDisabled]}
        onPress={onSkip}
        disabled={skipDisabled}
        activeOpacity={0.7}
      >
        <Text style={[styles.buttonText, styles.skipButtonText, skipDisabled && styles.buttonTextDisabled]}>
          Skip
        </Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={[styles.button, styles.undoButton, !canUndo && styles.buttonDisabled]}
        onPress={onUndo}
        disabled={!canUndo}
        activeOpacity={0.7}
      >
        <Text style={[styles.buttonText, styles.undoButtonText, !canUndo && styles.buttonTextDisabled]}>
          Undo
        </Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingTop: 12,
    backgroundColor: '#FFFFFF',
    borderTopWidth: 1,
    borderTopColor: '#E5E7EB',
    gap: 12,
  },
  button: {
    flex: 1,
    height: 52,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  skipButton: {
    backgroundColor: '#FEF3C7',
    borderWidth: 1,
    borderColor: '#F59E0B',
  },
  undoButton: {
    backgroundColor: '#F3F4F6',
    borderWidth: 1,
    borderColor: '#D1D5DB',
  },
  buttonDisabled: {
    backgroundColor: '#F9FAFB',
    borderColor: '#E5E7EB',
    opacity: 0.5,
  },
  buttonText: {
    fontSize: 16,
    fontWeight: '600',
  },
  skipButtonText: {
    color: '#B45309',
  },
  undoButtonText: {
    color: '#374151',
  },
  buttonTextDisabled: {
    color: '#9CA3AF',
  },
});

export const BottomActionBar = memo(BottomActionBarComponent);

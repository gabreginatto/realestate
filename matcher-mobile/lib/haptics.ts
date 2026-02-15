/**
 * Haptic feedback utilities for the matcher app
 * Uses expo-haptics for native feedback
 */

import * as Haptics from 'expo-haptics';

/**
 * Light tap feedback for UI interactions
 * Use for button presses, selections, etc.
 */
export function lightTap(): void {
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
}

/**
 * Medium tap feedback for more significant interactions
 * Use for card swipes, tab switches, etc.
 */
export function mediumTap(): void {
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
}

/**
 * Heavy tap feedback for major actions
 * Use sparingly for emphasis
 */
export function heavyTap(): void {
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
}

/**
 * Success feedback for successful actions
 * Use when a match is confirmed, action completed, etc.
 */
export function successTap(): void {
  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
}

/**
 * Warning feedback for potentially destructive actions
 * Use for skip confirmations, undo prompts, etc.
 */
export function warningTap(): void {
  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
}

/**
 * Error feedback for errors or failed actions
 * Use when an operation fails
 */
export function errorTap(): void {
  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
}

/**
 * Selection changed feedback
 * Use when scrolling through options or changing selections
 */
export function selectionTap(): void {
  Haptics.selectionAsync();
}

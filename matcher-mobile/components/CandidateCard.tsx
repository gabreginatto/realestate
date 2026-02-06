import React, { memo, useCallback } from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { Image } from 'expo-image';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSequence,
  withTiming,
  Easing,
} from 'react-native-reanimated';
import { AIScoreBar } from './AIScoreBar';

// Color palette
const colors = {
  background: '#0c0f1a',
  surface: '#161b2e',
  surfaceElevated: '#1e2540',
  border: '#2a3154',
  borderSubtle: '#1e2540',
  textPrimary: '#e8ecf4',
  textSecondary: '#8892b0',
  textMuted: '#5a6380',
  accentGreen: '#00e676',
  accentAmber: '#ffab40',
  accentBlue: '#448aff',
  accentRed: '#ff5252',
};

type CandidateCardProps = {
  // Pass primitives for better memoization
  propertyCode: string;
  rank: number;
  mosaicPath: string;
  price: string;
  area: number;
  bedrooms: number;
  suites: number;
  aiScore: number | null;
  priceDelta: number | null;
  areaDelta: number | null;
  onMatch: (code: string) => void;
  onImagePress: (url: string) => void;
};

/**
 * Candidate Card component
 * Shows candidate info with mosaic image, AI score, metadata, and match button
 */
function CandidateCardComponent({
  propertyCode,
  rank,
  mosaicPath,
  price,
  area,
  bedrooms,
  suites,
  aiScore,
  priceDelta,
  areaDelta,
  onMatch,
  onImagePress,
}: CandidateCardProps) {
  const buttonScale = useSharedValue(1);
  const buttonGlow = useSharedValue(0);

  const handleMatch = useCallback(() => {
    // Scale-up + glow pulse, then trigger the parent callback
    buttonScale.value = withSequence(
      withTiming(1.08, {
        duration: 120,
        easing: Easing.bezier(0.4, 0, 0.2, 1),
      }),
      withTiming(1, {
        duration: 100,
        easing: Easing.bezier(0.4, 0, 0.2, 1),
      })
    );
    buttonGlow.value = withSequence(
      withTiming(1, { duration: 120 }),
      withTiming(0, { duration: 100 })
    );
    // Fire the match immediately (animation is cosmetic)
    onMatch(propertyCode);
  }, [onMatch, propertyCode, buttonScale, buttonGlow]);

  const matchButtonAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: buttonScale.value }],
    shadowOpacity: 0.3 + buttonGlow.value * 0.5,
    shadowRadius: 16 + buttonGlow.value * 12,
  }));

  const handleImagePress = useCallback(() => {
    onImagePress(mosaicPath);
  }, [onImagePress, mosaicPath]);

  const formatDelta = (delta: number | null): string => {
    if (delta === null) return 'N/A';
    const sign = delta >= 0 ? '+' : '';
    return `${sign}${delta.toFixed(1)}%`;
  };

  const getDeltaColor = (delta: number | null): string => {
    if (delta === null) return colors.textMuted;
    if (delta < -10) return colors.accentGreen;
    if (delta > 10) return colors.accentRed;
    return colors.accentAmber;
  };

  return (
    <View style={styles.container}>
      {/* Header with code and rank */}
      <View style={styles.header}>
        <Text style={styles.code}>{propertyCode}</Text>
        <View style={styles.rankBadge}>
          <Text style={styles.rankText}>#{rank}</Text>
        </View>
      </View>

      {/* Mosaic Image */}
      <Pressable onPress={handleImagePress} style={styles.imageContainer}>
        <Image
          source={{ uri: mosaicPath }}
          style={styles.image}
          contentFit="cover"
          transition={200}
          placeholder={{ blurhash: 'L6PZfSi_.AyE_3t7t7R**0o#DgR4' }}
        />
      </Pressable>

      {/* AI Score Bar */}
      {aiScore !== null && <AIScoreBar score={aiScore} />}

      {/* Metadata Panel */}
      <View style={styles.metadataPanel}>
        <View style={styles.metadataRow}>
          <View style={styles.metadataItem}>
            <Text style={styles.metadataLabel}>Price</Text>
            <Text style={styles.metadataValue}>{price}</Text>
          </View>
          <View style={styles.metadataItem}>
            <Text style={styles.metadataLabel}>Area</Text>
            <Text style={styles.metadataValue}>{area}m{'\u00B2'}</Text>
          </View>
        </View>

        <View style={styles.metadataRow}>
          <View style={styles.metadataItem}>
            <Text style={styles.metadataLabel}>Beds</Text>
            <Text style={styles.metadataValue}>{bedrooms}</Text>
          </View>
          <View style={styles.metadataItem}>
            <Text style={styles.metadataLabel}>Suites</Text>
            <Text style={styles.metadataValue}>{suites}</Text>
          </View>
        </View>

        {/* Delta badges */}
        <View style={styles.deltaRow}>
          <View style={styles.deltaBadge}>
            <Text style={styles.deltaLabel}>Price {'\u0394'}</Text>
            <Text style={[styles.deltaValue, { color: getDeltaColor(priceDelta) }]}>
              {formatDelta(priceDelta)}
            </Text>
          </View>
          <View style={styles.deltaBadge}>
            <Text style={styles.deltaLabel}>Area {'\u0394'}</Text>
            <Text style={[styles.deltaValue, { color: getDeltaColor(areaDelta) }]}>
              {formatDelta(areaDelta)}
            </Text>
          </View>
        </View>
      </View>

      {/* Match Button */}
      <Animated.View style={[styles.matchButtonWrapper, matchButtonAnimatedStyle]}>
        <Pressable
          style={styles.matchButton}
          onPress={handleMatch}
        >
          <Text style={styles.matchButtonText}>{'\u2713'}  Match</Text>
        </Pressable>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    marginHorizontal: 16,
    marginVertical: 8,
    borderWidth: 1,
    borderColor: colors.border,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    elevation: 6,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  code: {
    fontSize: 18,
    fontWeight: '800',
    color: colors.textPrimary,
    fontFamily: 'System',
  },
  rankBadge: {
    backgroundColor: colors.accentBlue,
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 12,
  },
  rankText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#ffffff',
  },
  imageContainer: {
    width: '100%',
    aspectRatio: 16 / 9,
  },
  image: {
    width: '100%',
    height: '100%',
  },
  metadataPanel: {
    padding: 16,
    backgroundColor: colors.surfaceElevated,
  },
  metadataRow: {
    flexDirection: 'row',
    marginBottom: 12,
  },
  metadataItem: {
    flex: 1,
  },
  metadataLabel: {
    fontSize: 12,
    color: colors.textSecondary,
    marginBottom: 2,
    fontWeight: '300',
    fontFamily: 'System',
  },
  metadataValue: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  deltaRow: {
    flexDirection: 'row',
    marginTop: 4,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  deltaBadge: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  deltaLabel: {
    fontSize: 12,
    color: colors.textSecondary,
    fontWeight: '300',
    fontFamily: 'System',
  },
  deltaValue: {
    fontSize: 14,
    fontWeight: '600',
  },
  matchButtonWrapper: {
    marginHorizontal: 16,
    marginBottom: 16,
    marginTop: 8,
    borderRadius: 14,
    shadowColor: 'rgba(0, 230, 118, 0.3)',
    shadowOffset: { width: 0, height: 4 },
  },
  matchButton: {
    backgroundColor: colors.accentGreen,
    height: 56,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: 'rgba(0, 230, 118, 0.3)',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 1,
    shadowRadius: 16,
    elevation: 8,
  },
  matchButtonText: {
    color: colors.background,
    fontSize: 18,
    fontWeight: '800',
    fontFamily: 'System',
  },
});

export const CandidateCard = memo(CandidateCardComponent);

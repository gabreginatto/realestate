import React, { memo, useCallback } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Pressable } from 'react-native';
import { Image } from 'expo-image';
import { AIScoreBar } from './AIScoreBar';

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
  const handleMatch = useCallback(() => {
    onMatch(propertyCode);
  }, [onMatch, propertyCode]);

  const handleImagePress = useCallback(() => {
    onImagePress(mosaicPath);
  }, [onImagePress, mosaicPath]);

  const formatDelta = (delta: number | null): string => {
    if (delta === null) return 'N/A';
    const sign = delta >= 0 ? '+' : '';
    return `${sign}${delta.toFixed(1)}%`;
  };

  const getDeltaColor = (delta: number | null): string => {
    if (delta === null) return '#6B7280';
    if (delta < -10) return '#22C55E'; // Good (cheaper/smaller)
    if (delta > 10) return '#EF4444'; // Bad (more expensive/larger)
    return '#F59E0B'; // Neutral
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
            <Text style={styles.metadataValue}>{area}m²</Text>
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
            <Text style={styles.deltaLabel}>Price Δ</Text>
            <Text style={[styles.deltaValue, { color: getDeltaColor(priceDelta) }]}>
              {formatDelta(priceDelta)}
            </Text>
          </View>
          <View style={styles.deltaBadge}>
            <Text style={styles.deltaLabel}>Area Δ</Text>
            <Text style={[styles.deltaValue, { color: getDeltaColor(areaDelta) }]}>
              {formatDelta(areaDelta)}
            </Text>
          </View>
        </View>
      </View>

      {/* Match Button */}
      <TouchableOpacity
        style={styles.matchButton}
        onPress={handleMatch}
        activeOpacity={0.8}
      >
        <Text style={styles.matchButtonText}>Match</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    marginHorizontal: 16,
    marginVertical: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 4,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  },
  code: {
    fontSize: 16,
    fontWeight: '600',
    color: '#111827',
  },
  rankBadge: {
    backgroundColor: '#EEF2FF',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  rankText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#4F46E5',
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
    backgroundColor: '#F9FAFB',
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
    color: '#6B7280',
    marginBottom: 2,
  },
  metadataValue: {
    fontSize: 16,
    fontWeight: '600',
    color: '#111827',
  },
  deltaRow: {
    flexDirection: 'row',
    marginTop: 4,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#E5E7EB',
  },
  deltaBadge: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  deltaLabel: {
    fontSize: 12,
    color: '#6B7280',
  },
  deltaValue: {
    fontSize: 14,
    fontWeight: '600',
  },
  matchButton: {
    backgroundColor: '#22C55E',
    marginHorizontal: 16,
    marginBottom: 16,
    marginTop: 8,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  matchButtonText: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '700',
  },
});

export const CandidateCard = memo(CandidateCardComponent);

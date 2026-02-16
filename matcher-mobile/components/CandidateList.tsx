import React, { memo, useCallback } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { CandidateCard } from './CandidateCard';
import { EmptyState } from './EmptyState';
import type { NormalizedCandidate } from '../types';

type CandidateListProps = {
  candidates: NormalizedCandidate[];
  onMatch: (code: string) => void;
  onImagePress: (url: string, fullUrl?: string) => void;
  // Optional stats for empty state
  totalReviewed?: number;
  totalMatched?: number;
  totalSkipped?: number;
};

/**
 * Candidate List component
 * Uses FlashList for performant rendering of large lists
 */
function CandidateListComponent({
  candidates,
  onMatch,
  onImagePress,
  totalReviewed,
  totalMatched,
  totalSkipped,
}: CandidateListProps) {
  // Hoist key extractor for performance
  const keyExtractor = useCallback(
    (item: NormalizedCandidate) => item.propertyCode,
    []
  );

  // Hoist render item for performance
  const renderItem = useCallback(
    ({ item, index }: { item: NormalizedCandidate; index: number }) => {
      // Format price for display
      const formatPrice = (price: string | number): string => {
        if (typeof price === 'string') return price;
        return new Intl.NumberFormat('pt-BR', {
          style: 'currency',
          currency: 'BRL',
          maximumFractionDigits: 0,
        }).format(price);
      };

      return (
        <CandidateCard
          propertyCode={item.propertyCode}
          rank={index + 1}
          mosaicPath={item.mosaicPath}
          fullMosaicPath={item.fullMosaicPath}
          price={formatPrice(item.price)}
          area={item.area}
          bedrooms={item.bedrooms}
          suites={item.suites}
          aiScore={item.aiScore}
          priceDelta={item.priceDelta}
          areaDelta={item.areaDelta}
          onMatch={onMatch}
          onImagePress={onImagePress}
        />
      );
    },
    [onMatch, onImagePress]
  );

  // Empty state component
  const ListEmptyComponent = useCallback(
    () => (
      <EmptyState
        totalReviewed={totalReviewed}
        totalMatched={totalMatched}
        totalSkipped={totalSkipped}
      />
    ),
    [totalReviewed, totalMatched, totalSkipped]
  );

  // Header showing candidate count
  const ListHeaderComponent = useCallback(() => {
    if (candidates.length === 0) return null;
    return (
      <View style={styles.header}>
        <Text style={styles.headerText}>
          {candidates.length} candidate{candidates.length !== 1 ? 's' : ''}
        </Text>
      </View>
    );
  }, [candidates.length]);

  return (
    <View style={styles.container}>
      <FlashList
        data={candidates}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        drawDistance={400}
        ListEmptyComponent={ListEmptyComponent}
        ListHeaderComponent={ListHeaderComponent}
        contentContainerStyle={styles.contentContainer}
        showsVerticalScrollIndicator={false}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  contentContainer: {
    paddingBottom: 16,
  },
  header: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 4,
  },
  headerText: {
    fontSize: 14,
    color: '#8892b0',
    fontWeight: '500',
    fontFamily: 'System',
  },
});

export const CandidateList = memo(CandidateListComponent);

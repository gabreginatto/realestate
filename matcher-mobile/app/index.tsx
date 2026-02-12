import { useCallback, useEffect, useState } from 'react';
import { View, StyleSheet, Pressable, Text, ActivityIndicator, RefreshControl, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';

import { getCompounds, API_BASE_URL } from '../lib/api';
import type { Compound } from '../types';

const colors = {
  background: '#0c0f1a',
  surface: '#161b2e',
  surfaceElevated: '#1e2540',
  border: '#2a3154',
  textPrimary: '#e8ecf4',
  textSecondary: '#8892b0',
  textMuted: '#5a6380',
  accentGreen: '#00e676',
  accentAmber: '#ffab40',
  accentBlue: '#448aff',
};

export default function CompoundSelectorScreen() {
  const insets = useSafeAreaInsets();
  const [compounds, setCompounds] = useState<Compound[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const loadCompounds = useCallback(async () => {
    try {
      setError(null);
      const data = await getCompounds();
      setCompounds(data.compounds);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load compounds');
    } finally {
      setIsLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadCompounds();
  }, [loadCompounds]);

  const handleSelectCompound = useCallback((compound: Compound) => {
    router.push({ pathname: '/matcher/[compoundId]', params: { compoundId: compound.id, compoundName: compound.displayName } });
  }, []);

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    loadCompounds();
  }, [loadCompounds]);

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Property Matcher</Text>
        <Text style={styles.headerSubtitle}>Select a compound to review</Text>
      </View>

      {isLoading && !refreshing ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={colors.accentBlue} />
          <Text style={styles.loadingText}>Loading compounds...</Text>
        </View>
      ) : error ? (
        <View style={styles.errorContainer}>
          <Text style={styles.errorText}>{error}</Text>
          <Pressable style={styles.retryButton} onPress={loadCompounds}>
            <Text style={styles.retryButtonText}>Retry</Text>
          </Pressable>
        </View>
      ) : (
        <ScrollView
          style={styles.scrollView}
          contentContainerStyle={styles.scrollContent}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={colors.textSecondary} />
          }
        >
          {compounds.map((compound) => (
            <Pressable
              key={compound.id}
              style={styles.compoundCard}
              onPress={() => handleSelectCompound(compound)}
            >
              <View style={styles.compoundCardContent}>
                <Text style={styles.compoundName}>{compound.displayName}</Text>
                {compound.stats ? (
                  <View style={styles.statsRow}>
                    <View style={styles.statItem}>
                      <Text style={[styles.statValue, { color: colors.accentGreen }]}>{compound.stats.matched}</Text>
                      <Text style={styles.statLabel}>Matched</Text>
                    </View>
                    <View style={styles.statDivider} />
                    <View style={styles.statItem}>
                      <Text style={[styles.statValue, { color: colors.accentAmber }]}>{compound.stats.pending}</Text>
                      <Text style={styles.statLabel}>Pending</Text>
                    </View>
                    <View style={styles.statDivider} />
                    <View style={styles.statItem}>
                      <Text style={[styles.statValue, { color: colors.textSecondary }]}>{compound.stats.total}</Text>
                      <Text style={styles.statLabel}>Total</Text>
                    </View>
                  </View>
                ) : (
                  <Text style={styles.noDataText}>No data yet</Text>
                )}
              </View>
              <Text style={styles.chevron}>{'\u203A'}</Text>
            </Pressable>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  header: {
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 24,
  },
  headerTitle: {
    fontSize: 28,
    fontWeight: '800',
    color: colors.textPrimary,
  },
  headerSubtitle: {
    fontSize: 15,
    color: colors.textSecondary,
    marginTop: 4,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    padding: 16,
    paddingBottom: 40,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    color: colors.textSecondary,
    marginTop: 12,
    fontSize: 15,
  },
  errorContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  errorText: {
    color: colors.textSecondary,
    fontSize: 15,
    textAlign: 'center',
    marginBottom: 16,
  },
  retryButton: {
    backgroundColor: colors.accentBlue,
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
  },
  retryButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
  compoundCard: {
    backgroundColor: colors.surface,
    borderRadius: 14,
    padding: 20,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: colors.border,
    flexDirection: 'row',
    alignItems: 'center',
  },
  compoundCardContent: {
    flex: 1,
  },
  compoundName: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.textPrimary,
    marginBottom: 12,
  },
  statsRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  statItem: {
    alignItems: 'center',
    paddingHorizontal: 12,
  },
  statValue: {
    fontSize: 20,
    fontWeight: '800',
  },
  statLabel: {
    fontSize: 10,
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 2,
  },
  statDivider: {
    width: 1,
    height: 28,
    backgroundColor: colors.border,
  },
  noDataText: {
    color: colors.textMuted,
    fontSize: 13,
    fontStyle: 'italic',
  },
  chevron: {
    color: colors.textMuted,
    fontSize: 28,
    fontWeight: '300',
    marginLeft: 12,
  },
});

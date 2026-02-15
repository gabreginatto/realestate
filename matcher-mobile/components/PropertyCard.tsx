import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { Image } from 'expo-image';
import { MetadataPanel } from './MetadataPanel';
import type { VivaListing, NormalizedVivaListing, Candidate, NormalizedCandidate } from '../types';

// Color palette
const colors = {
  background: '#161b2e',
  surface: '#1e2540',
  border: '#2a3154',
  textPrimary: '#e8ecf4',
  textSecondary: '#8892b0',
  textMuted: '#5a6380',
  accentBlue: '#448aff',
};

type PropertyCardProps = {
  listing: VivaListing | NormalizedVivaListing | Candidate | NormalizedCandidate;
  mosaicPath?: string;
  onImagePress?: () => void;
  showDeltas?: boolean;
};

/**
 * Formats a price value to a human-readable string
 */
function formatPrice(price: string | number): string {
  if (typeof price === 'string') {
    // If already formatted, return as is
    if (price.includes('R$')) return price;
    const num = parseFloat(price.replace(/[^\d.-]/g, ''));
    if (isNaN(num)) return price;
    return `R$ ${num.toLocaleString('pt-BR')}`;
  }
  return `R$ ${price.toLocaleString('pt-BR')}`;
}

/**
 * Formats area value
 */
function formatArea(area: number | undefined): string {
  if (!area) return '-';
  return `${area} m\u00B2`;
}

/**
 * Gets the property code from various listing formats
 */
function getPropertyCode(listing: PropertyCardProps['listing']): string {
  return listing.propertyCode || (listing as VivaListing).code || 'Unknown';
}

/**
 * Gets area from various listing formats
 */
function getArea(listing: PropertyCardProps['listing']): number | undefined {
  return (
    listing.area ||
    (listing as VivaListing).built ||
    (listing as VivaListing).specs?.area_construida ||
    (listing as VivaListing).detailedData?.specs?.area_construida
  );
}

/**
 * Gets bedrooms from various listing formats
 */
function getBedrooms(listing: PropertyCardProps['listing']): number | undefined {
  return (
    listing.bedrooms ||
    (listing as VivaListing).beds ||
    (listing as VivaListing).specs?.dormitorios ||
    (listing as VivaListing).detailedData?.specs?.dormitorios
  );
}

/**
 * Gets suites from various listing formats
 */
function getSuites(listing: PropertyCardProps['listing']): number | undefined {
  return (
    listing.suites ||
    (listing as VivaListing).specs?.suites ||
    (listing as VivaListing).detailedData?.specs?.suites
  );
}

/**
 * PropertyCard - Displays a property listing with image and metadata
 */
export function PropertyCard({
  listing,
  mosaicPath,
  onImagePress,
  showDeltas = false,
}: PropertyCardProps) {
  const propertyCode = getPropertyCode(listing);
  const area = getArea(listing);
  const bedrooms = getBedrooms(listing);
  const suites = getSuites(listing);

  // Get mosaic path from either prop or listing
  const imagePath =
    mosaicPath ||
    (listing as Candidate).mosaicPath ||
    (listing as NormalizedVivaListing).mosaicPath;

  // Build metadata items
  const metadataItems = [
    {
      label: 'Price',
      value: formatPrice(listing.price),
      delta: showDeltas ? (listing as Candidate).priceDelta ?? undefined : undefined,
    },
    {
      label: 'Area',
      value: formatArea(area),
      delta: showDeltas ? (listing as Candidate).areaDelta ?? undefined : undefined,
    },
    {
      label: 'Bedrooms',
      value: bedrooms?.toString() || '-',
    },
    {
      label: 'Suites',
      value: suites?.toString() || '-',
    },
  ];

  // Add address if available
  const address = (listing as VivaListing).address || (listing as NormalizedVivaListing).address;
  if (address) {
    metadataItems.push({
      label: 'Address',
      value: address,
    });
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <Text style={styles.title}>{propertyCode}</Text>
          <View style={styles.sourceTag}>
            <Text style={styles.sourceTagText}>Source Property</Text>
          </View>
        </View>
        {(listing as Candidate).aiScore !== undefined && (listing as Candidate).aiScore !== null && (
          <View style={styles.scoreBadge}>
            <Text style={styles.scoreText}>
              AI: {((listing as Candidate).aiScore! * 100).toFixed(0)}%
            </Text>
          </View>
        )}
      </View>

      {imagePath && (
        <Pressable onPress={onImagePress} style={styles.imageContainer}>
          <Image
            source={{ uri: imagePath }}
            style={styles.image}
            contentFit="cover"
            transition={200}
            cachePolicy="disk"
          />
          <View style={styles.imageBottomShadow} />
          {onImagePress && (
            <View style={styles.imageOverlay}>
              <Text style={styles.imageOverlayText}>Tap to enlarge</Text>
            </View>
          )}
        </Pressable>
      )}

      <MetadataPanel items={metadataItems} columns={2} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.background,
    borderRadius: 16,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    elevation: 6,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flex: 1,
  },
  title: {
    fontSize: 20,
    fontWeight: '800',
    color: colors.textPrimary,
    fontFamily: 'System',
  },
  sourceTag: {
    backgroundColor: colors.accentBlue + '20',
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.accentBlue + '40',
  },
  sourceTagText: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.accentBlue,
  },
  scoreBadge: {
    backgroundColor: colors.accentBlue,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  scoreText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '600',
  },
  imageContainer: {
    position: 'relative',
    aspectRatio: 16 / 9,
    width: '100%',
  },
  image: {
    width: '100%',
    height: '100%',
  },
  imageBottomShadow: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 60,
    backgroundColor: 'transparent',
    // Gradient-like shadow at bottom of image
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -20 },
    shadowOpacity: 0.4,
    shadowRadius: 20,
  },
  imageOverlay: {
    position: 'absolute',
    bottom: 8,
    right: 8,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
  },
  imageOverlayText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '500',
  },
});

export default PropertyCard;

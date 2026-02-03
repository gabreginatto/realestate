import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { DeltaBadge } from './DeltaBadge';

// Color palette
const colors = {
  background: '#f8fafc',
  backgroundDark: '#0f172a',
  text: '#0f172a',
  textDark: '#f1f5f9',
  textSecondary: '#64748b',
  border: '#e2e8f0',
};

type MetadataItem = {
  label: string;
  value: string | number;
  delta?: number;
};

type MetadataPanelProps = {
  items: MetadataItem[];
  columns?: 2 | 3;
};

/**
 * MetadataPanel - Reusable grid of label/value pairs
 * Shows delta badges when provided
 */
export function MetadataPanel({ items, columns = 2 }: MetadataPanelProps) {
  return (
    <View style={styles.container}>
      {items.map((item, index) => (
        <View
          key={item.label}
          style={[
            styles.item,
            columns === 2 ? styles.twoColumns : styles.threeColumns,
            index % columns !== columns - 1 && styles.itemBorder,
          ]}
        >
          <Text style={styles.label}>{item.label}</Text>
          <View style={styles.valueContainer}>
            <Text style={styles.value}>{item.value}</Text>
            {item.delta !== undefined && (
              <View style={styles.deltaContainer}>
                <DeltaBadge delta={item.delta} />
              </View>
            )}
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    backgroundColor: colors.background,
    borderRadius: 12,
    padding: 4,
    borderWidth: 1,
    borderColor: colors.border,
  },
  item: {
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  twoColumns: {
    width: '50%',
  },
  threeColumns: {
    width: '33.33%',
  },
  itemBorder: {
    borderRightWidth: 1,
    borderRightColor: colors.border,
  },
  label: {
    fontSize: 12,
    color: colors.textSecondary,
    marginBottom: 4,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    fontWeight: '500',
  },
  valueContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
  },
  value: {
    fontSize: 16,
    color: colors.text,
    fontWeight: '600',
  },
  deltaContainer: {
    marginLeft: 4,
  },
});

export default MetadataPanel;

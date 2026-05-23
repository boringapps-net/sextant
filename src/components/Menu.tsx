import React, { useEffect, useRef } from 'react';
import {
  Animated,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useScheme } from '@/lib/ui/scheme';
import { Glass } from '@/lib/ui/glass';
import { Icon } from '@/lib/ui/Icon';
import { Colors, Radii, Typography } from '@/lib/ui/theme';

export type MenuItemSpec =
  | {
      kind?: 'item';
      label: string;
      // Optional short description shown beneath the label.
      detail?: string;
      icon?: { ios: string; android: string };
      onPress?: () => void;
      destructive?: boolean;
      disabled?: boolean;
    }
  | { kind: 'separator' };

type Props = {
  visible: boolean;
  onClose: () => void;
  items: MenuItemSpec[];
  /** Where the popover anchors. `'top-right'` is the conventional ⋯-button spot. */
  position?: 'top-right' | 'top-left';
  /** Distance from the top of the safe area. Pass `useHeaderHeight()` to nest
   *  below a transparent nav bar. */
  topOffset?: number;
};

/**
 * Glass-effect popover menu — replacement for ActionSheetIOS where we want
 * something lighter and visually consistent with the rest of the app. Modal
 * backdrop swallows taps to dismiss; the card spring-scales in from its
 * anchor corner.
 */
export function Menu({
  visible,
  onClose,
  items,
  position = 'top-right',
  topOffset,
}: Props) {
  const scheme = useScheme();
  const c = Colors[scheme];
  const insets = useSafeAreaInsets();
  const opacity = useRef(new Animated.Value(0)).current;
  const scale = useRef(new Animated.Value(0.94)).current;

  useEffect(() => {
    if (!visible) return;
    opacity.setValue(0);
    scale.setValue(0.94);
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration: 140,
        useNativeDriver: true,
      }),
      Animated.spring(scale, {
        toValue: 1,
        damping: 18,
        stiffness: 240,
        useNativeDriver: true,
      }),
    ]).start();
  }, [visible, opacity, scale]);

  const horizontal = position === 'top-right' ? { right: 12 } : { left: 12 };
  const top = (topOffset ?? insets.top) + 6;

  return (
    <Modal
      transparent
      visible={visible}
      animationType="none"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose}>
        {/* The inner View needs `pointerEvents="box-none"` so taps that miss the
            card fall through to the backdrop Pressable above and dismiss. */}
        <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
          <Animated.View
            // Stop taps inside the card from bubbling to the backdrop.
            pointerEvents="box-none"
            style={[
              { position: 'absolute', top, opacity, transform: [{ scale }] },
              horizontal,
            ]}
          >
            <Pressable
              // Eat taps so the parent Pressable (backdrop) doesn't close us.
              onPress={() => {}}
            >
              <Glass
                radius={Radii.lg}
                style={{ paddingVertical: 4, minWidth: 240, maxWidth: 320 }}
              >
                {items.map((item, i) => {
                  if (item.kind === 'separator') {
                    return (
                      <View
                        key={`sep-${i}`}
                        style={{
                          height: StyleSheet.hairlineWidth,
                          backgroundColor: c.separator,
                          marginVertical: 4,
                          marginHorizontal: 8,
                        }}
                      />
                    );
                  }
                  return (
                    <Pressable
                      key={item.label}
                      disabled={item.disabled}
                      onPress={() => {
                        onClose();
                        // Defer so the modal can dismiss before the action runs;
                        // important for actions that themselves present UI (alerts, sheets).
                        requestAnimationFrame(() => item.onPress?.());
                      }}
                      style={({ pressed }) => ({
                        flexDirection: 'row',
                        alignItems: 'center',
                        paddingHorizontal: 14,
                        paddingVertical: 10,
                        gap: 12,
                        backgroundColor: pressed ? c.surfaceMuted : 'transparent',
                        opacity: item.disabled ? 0.4 : 1,
                      })}
                    >
                      {item.icon ? (
                        <Icon
                          ios={item.icon.ios}
                          android={item.icon.android}
                          size={16}
                          color={item.destructive ? c.danger : c.text}
                        />
                      ) : (
                        <View style={{ width: 16 }} />
                      )}
                      <View style={{ flex: 1 }}>
                        <Text
                          numberOfLines={1}
                          style={{
                            ...Typography.callout,
                            color: item.destructive ? c.danger : c.text,
                          }}
                        >
                          {item.label}
                        </Text>
                        {item.detail ? (
                          <Text
                            numberOfLines={1}
                            style={{
                              ...Typography.caption2,
                              color: c.textTertiary,
                              marginTop: 1,
                            }}
                          >
                            {item.detail}
                          </Text>
                        ) : null}
                      </View>
                    </Pressable>
                  );
                })}
              </Glass>
            </Pressable>
          </Animated.View>
        </View>
      </Pressable>
    </Modal>
  );
}

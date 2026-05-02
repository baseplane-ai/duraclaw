/**
 * AdvanceConfirmModalNative — RN port of AdvanceConfirmModal for the
 * Expo SDK 55 target (GH#157 §5).
 *
 * Same semantics as the web modal:
 *   - Title: "Advance '<arc title>' from <currentMode> to <nextMode>?"
 *   - Body: bullet list of effects (close current, start fresh, reset context).
 *   - Backlog branch: when worktree is null AND projectOptions are
 *     provided, render a simple list-style picker; confirm disabled
 *     until the user picks one.
 *   - Footer: Cancel / Advance →; Advance disabled while pending.
 *
 * Uses RN's built-in `Modal` (animationType='fade', transparent overlay)
 * rather than @react-navigation/native modals so the dialog doesn't
 * disturb the active screen's stack — matches the web modal's behaviour.
 */

import { useMemo } from 'react'
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'

export interface AdvanceConfirmModalNativeProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  arcTitle: string
  currentMode: string
  nextMode: string
  worktree: string | null
  worktreeReserved: boolean
  projectOptions?: readonly string[]
  selectedProject?: string | null
  onProjectChange?: (project: string) => void
  onConfirm: () => void
  pending?: boolean
}

export function AdvanceConfirmModalNative({
  open,
  onOpenChange,
  arcTitle,
  currentMode,
  nextMode,
  worktree,
  worktreeReserved,
  projectOptions,
  selectedProject,
  onProjectChange,
  onConfirm,
  pending,
}: AdvanceConfirmModalNativeProps) {
  const needsPicker = useMemo(
    () => worktree === null && projectOptions !== undefined && projectOptions.length > 0,
    [worktree, projectOptions],
  )
  const confirmDisabled = !!pending || (needsPicker && !selectedProject)

  return (
    <Modal
      animationType="fade"
      onRequestClose={() => onOpenChange(false)}
      statusBarTranslucent
      transparent
      visible={open}
    >
      <View style={s.scrim}>
        <View style={s.dialog}>
          <ScrollView contentContainerStyle={s.body}>
            <Text style={s.title}>
              Advance &apos;{arcTitle}&apos; from {currentMode} to {nextMode}?
            </Text>

            <Text style={s.muted}>This will:</Text>
            <View style={s.bullets}>
              <Text style={s.bullet}>• Close the current {currentMode} session</Text>
              <Text style={s.bullet}>• Start a fresh {nextMode} session</Text>
              <Text style={s.bullet}>• Reset context (new SDK session)</Text>
            </View>

            {needsPicker ? (
              <View style={s.pickerWrap}>
                <Text style={s.muted}>Project / worktree</Text>
                <FlatList
                  data={projectOptions ?? []}
                  keyExtractor={(p) => p}
                  scrollEnabled={false}
                  renderItem={({ item }) => {
                    const active = selectedProject === item
                    return (
                      <Pressable
                        accessibilityRole="button"
                        disabled={pending}
                        onPress={() => onProjectChange?.(item)}
                        style={({ pressed }) => [
                          s.pickerRow,
                          active ? s.pickerRowActive : null,
                          pressed ? s.pressed : null,
                        ]}
                      >
                        <Text style={[s.pickerLabel, active ? s.pickerLabelActive : null]}>
                          {item}
                        </Text>
                      </Pressable>
                    )
                  }}
                />
              </View>
            ) : worktree ? (
              <Text style={s.muted}>
                Worktree: {worktree}
                {worktreeReserved ? ' (reserved)' : ''}
              </Text>
            ) : null}
          </ScrollView>

          <View style={s.footer}>
            <Pressable
              accessibilityRole="button"
              disabled={pending}
              onPress={() => onOpenChange(false)}
              style={({ pressed }) => [s.btn, s.btnGhost, pressed ? s.pressed : null]}
            >
              <Text style={s.btnGhostLabel}>Cancel</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={confirmDisabled}
              onPress={onConfirm}
              style={({ pressed }) => [
                s.btn,
                s.btnPrimary,
                confirmDisabled ? s.btnDisabled : null,
                pressed ? s.pressed : null,
              ]}
              testID="advance-confirm"
            >
              {pending ? (
                <ActivityIndicator color="#0f172b" />
              ) : (
                <Text style={s.btnPrimaryLabel}>Advance →</Text>
              )}
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  )
}

const s = StyleSheet.create({
  scrim: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  dialog: {
    width: '100%',
    maxWidth: 480,
    maxHeight: '85%',
    backgroundColor: '#020919',
    borderColor: 'rgba(255,255,255,0.12)',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 16,
    overflow: 'hidden',
  },
  body: { padding: 20, gap: 12 },
  title: { fontSize: 18, fontWeight: '600', color: '#f8fafc' },
  muted: { fontSize: 13, color: '#90a1b9' },
  bullets: { gap: 4, paddingLeft: 8 },
  bullet: { fontSize: 14, color: '#f8fafc' },
  pickerWrap: { gap: 6, marginTop: 4 },
  pickerRow: {
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.18)',
    backgroundColor: 'rgba(255,255,255,0.04)',
    marginVertical: 3,
  },
  pickerRowActive: {
    backgroundColor: 'rgba(76,159,255,0.18)',
    borderColor: '#4c9fff',
  },
  pickerLabel: { fontSize: 14, color: '#f8fafc' },
  pickerLabelActive: { fontWeight: '600' },
  footer: {
    flexDirection: 'row',
    gap: 8,
    padding: 12,
    borderTopColor: 'rgba(255,255,255,0.08)',
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  btn: {
    flex: 1,
    minHeight: 44,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  btnGhost: {
    backgroundColor: 'transparent',
    borderColor: 'rgba(255,255,255,0.18)',
    borderWidth: StyleSheet.hairlineWidth,
  },
  btnGhostLabel: { color: '#f8fafc', fontSize: 14, fontWeight: '500' },
  btnPrimary: { backgroundColor: '#e2e8f0' },
  btnPrimaryLabel: { color: '#0f172b', fontSize: 14, fontWeight: '600' },
  btnDisabled: { opacity: 0.5 },
  pressed: { opacity: 0.7 },
})

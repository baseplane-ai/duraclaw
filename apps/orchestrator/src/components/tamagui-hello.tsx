import { Text, View } from '@tamagui/core'

export function TamaguiHello() {
  return (
    <View
      backgroundColor="$primary"
      padding="$3"
      borderRadius="$md"
      alignItems="center"
      justifyContent="center"
    >
      <Text color="$primaryForeground" fontSize={14}>
        Tamagui spike OK
      </Text>
    </View>
  )
}

module.exports = (api) => {
  api.cache(true)
  return {
    presets: ['babel-preset-expo'],
    plugins: [
      // react-native-worklets/plugin must come last per RN-Reanimated 4 docs.
      'react-native-worklets/plugin',
    ],
  }
}

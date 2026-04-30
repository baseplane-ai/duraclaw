// Expo entry — this file is referenced by package.json `main`. Metro
// bundles from here. The actual app shell lives in
// `apps/orchestrator/src/entry-rn.tsx`, which evolves the P2 smoke
// entry into the production AppRegistry root + NavigationContainer.
//
// Importing it here registers the 'main' component via
// AppRegistry.registerComponent('main', () => RootApp). On Android
// the native MainActivity calls into 'main' on cold start.
import 'react-native-gesture-handler' // must be first per RN-Navigation docs
import '../orchestrator/src/entry-rn.tsx'

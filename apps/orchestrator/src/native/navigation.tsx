/**
 * React Navigation tree for the Expo SDK 55 native target (GH#132 P3).
 *
 * Mirrors the 10 TanStack Router routes (apps/orchestrator/src/routes/**)
 * onto a native-stack + bottom-tabs hierarchy. Leaf screens are imported
 * from `./screens` — currently stubs (see file docstring), to be backed
 * by extracted feature components in the post-merge follow-up.
 *
 * Mapping (per spec §6 in planning/research/2026-04-30-gh132-p3-rn-native-target.md):
 *
 *   /login                              → AuthStack/Login
 *   /maintenance                        → AuthStack/Maintenance
 *   /_authenticated                     → BottomTabs (root of authenticated)
 *     /                                 → Tabs/Home
 *     /session/$id                      → HomeStack/SessionDetail
 *     /board                            → Tabs/Board
 *     /arc/$arcId                       → HomeStack/ArcDetail
 *     /projects                         → Tabs/Projects
 *     /projects/$projectId/docs         → ProjectsStack/Docs
 *     /deploys                          → Tabs/Deploys
 *     /settings                         → Tabs/Settings
 *     /admin.users                      → SettingsStack/AdminUsers
 *     /admin.codex-models               → SettingsStack/AdminCodexModels
 *     /admin.gemini-models              → SettingsStack/AdminGeminiModels
 *
 * Linking config: scheme `duraclaw://`. Cold-start universal links
 * arrive via `Linking.getInitialURL()`; React Navigation parses them
 * via the `linking.config` map.
 */

import { type BottomTabScreenProps, createBottomTabNavigator } from '@react-navigation/bottom-tabs'
import { NavigationContainer } from '@react-navigation/native'
import {
  createNativeStackNavigator,
  type NativeStackScreenProps,
} from '@react-navigation/native-stack'
import {
  AdminCodexModelsScreen,
  AdminGeminiModelsScreen,
  AdminUsersScreen,
  ArcDetailScreen,
  BoardScreen,
  DeploysScreen,
  HomeScreen,
  LoginScreen,
  MaintenanceScreen,
  ProjectDocsScreen,
  ProjectsScreen,
  SessionDetailScreen,
  SettingsScreen,
  SettingsTestScreen,
} from './screens'

// ---- Route param maps -------------------------------------------------

export type RootStackParamList = {
  Login: undefined
  Maintenance: undefined
  Authenticated: undefined
}

export type AuthenticatedTabsParamList = {
  Home: undefined
  Board: undefined
  Projects: undefined
  Deploys: undefined
  Settings: undefined
}

export type HomeStackParamList = {
  HomeIndex: undefined
  SessionDetail: { id: string }
  ArcDetail: { arcId: string }
}

export type ProjectsStackParamList = {
  ProjectsIndex: undefined
  ProjectDocs: { projectId: string }
}

export type SettingsStackParamList = {
  SettingsIndex: undefined
  SettingsTest: undefined
  AdminUsers: undefined
  AdminCodexModels: undefined
  AdminGeminiModels: undefined
}

export type SessionDetailScreenProps = NativeStackScreenProps<HomeStackParamList, 'SessionDetail'>
export type ArcDetailScreenProps = NativeStackScreenProps<HomeStackParamList, 'ArcDetail'>
export type ProjectDocsScreenProps = NativeStackScreenProps<ProjectsStackParamList, 'ProjectDocs'>
export type AuthenticatedTabsScreenProps = BottomTabScreenProps<AuthenticatedTabsParamList>

// ---- Navigators -------------------------------------------------------

const Tabs = createBottomTabNavigator<AuthenticatedTabsParamList>()
const RootStack = createNativeStackNavigator<RootStackParamList>()
const HomeStack = createNativeStackNavigator<HomeStackParamList>()
const ProjectsStack = createNativeStackNavigator<ProjectsStackParamList>()
const SettingsStack = createNativeStackNavigator<SettingsStackParamList>()

function HomeStackNavigator() {
  return (
    <HomeStack.Navigator>
      <HomeStack.Screen name="HomeIndex" component={HomeScreen} options={{ title: 'Duraclaw' }} />
      <HomeStack.Screen
        name="SessionDetail"
        component={SessionDetailScreen}
        options={{ title: 'Session' }}
      />
      <HomeStack.Screen name="ArcDetail" component={ArcDetailScreen} options={{ title: 'Arc' }} />
    </HomeStack.Navigator>
  )
}

function ProjectsStackNavigator() {
  return (
    <ProjectsStack.Navigator>
      <ProjectsStack.Screen
        name="ProjectsIndex"
        component={ProjectsScreen}
        options={{ title: 'Projects' }}
      />
      <ProjectsStack.Screen
        name="ProjectDocs"
        component={ProjectDocsScreen}
        options={{ title: 'Docs' }}
      />
    </ProjectsStack.Navigator>
  )
}

function SettingsStackNavigator() {
  return (
    <SettingsStack.Navigator>
      <SettingsStack.Screen
        name="SettingsIndex"
        component={SettingsScreen}
        options={{ title: 'Settings' }}
      />
      <SettingsStack.Screen
        name="SettingsTest"
        component={SettingsTestScreen}
        options={{ title: 'Settings · Test' }}
      />
      <SettingsStack.Screen
        name="AdminUsers"
        component={AdminUsersScreen}
        options={{ title: 'Admin · Users' }}
      />
      <SettingsStack.Screen
        name="AdminCodexModels"
        component={AdminCodexModelsScreen}
        options={{ title: 'Admin · Codex Models' }}
      />
      <SettingsStack.Screen
        name="AdminGeminiModels"
        component={AdminGeminiModelsScreen}
        options={{ title: 'Admin · Gemini Models' }}
      />
    </SettingsStack.Navigator>
  )
}

function AuthenticatedTabs() {
  return (
    <Tabs.Navigator screenOptions={{ headerShown: false }}>
      <Tabs.Screen name="Home" component={HomeStackNavigator} />
      <Tabs.Screen name="Board" component={BoardScreen} />
      <Tabs.Screen name="Projects" component={ProjectsStackNavigator} />
      <Tabs.Screen name="Deploys" component={DeploysScreen} />
      <Tabs.Screen name="Settings" component={SettingsStackNavigator} />
    </Tabs.Navigator>
  )
}

// ---- Linking ----------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const linking: any = {
  prefixes: ['duraclaw://', 'https://duraclaw.baseplane.ai'],
  config: {
    screens: {
      Login: 'login',
      Maintenance: 'maintenance',
      Authenticated: {
        screens: {
          Home: {
            screens: {
              HomeIndex: '',
              SessionDetail: 'session/:id',
              ArcDetail: 'arc/:arcId',
            },
          },
          Board: 'board',
          Projects: {
            screens: {
              ProjectsIndex: 'projects',
              ProjectDocs: 'projects/:projectId/docs',
            },
          },
          Deploys: 'deploys',
          Settings: {
            screens: {
              SettingsIndex: 'settings',
              SettingsTest: 'settings/test',
              AdminUsers: 'admin/users',
              AdminCodexModels: 'admin/codex-models',
              AdminGeminiModels: 'admin/gemini-models',
            },
          },
        },
      },
    },
  },
}

// ---- Root container ---------------------------------------------------

export type RootAppProps = {
  /**
   * Authenticated state — when the auth session resolves, swap from
   * the Login stack to the Authenticated tab tree. Wired up by
   * `entry-rn.tsx` (waits for `authClientReady` then reads
   * `useSession()` on mount).
   */
  isAuthenticated: boolean
}

export function NativeNavigationRoot({ isAuthenticated }: RootAppProps) {
  return (
    <NavigationContainer linking={linking}>
      <RootStack.Navigator screenOptions={{ headerShown: false }}>
        {isAuthenticated ? (
          <RootStack.Screen name="Authenticated" component={AuthenticatedTabs} />
        ) : (
          <>
            <RootStack.Screen name="Login" component={LoginScreen} />
            <RootStack.Screen name="Maintenance" component={MaintenanceScreen} />
          </>
        )}
      </RootStack.Navigator>
    </NavigationContainer>
  )
}

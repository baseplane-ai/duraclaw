import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface AppNotification {
  id: string
  type: 'gate' | 'completed' | 'error'
  sessionId: string
  sessionName: string
  /** Project name for tab creation on click */
  project?: string
  body: string
  timestamp: string
  read: boolean
  url: string
}

interface NotificationState {
  notifications: AppNotification[]
  addNotification: (n: Omit<AppNotification, 'id' | 'read' | 'timestamp'>) => void
  markRead: (id: string) => void
  markAllRead: () => void
  clearAll: () => void
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000

export const useNotificationStore = create<NotificationState>()(
  persist(
    (set) => ({
      notifications: [],
      addNotification: (n) =>
        set((state) => ({
          notifications: [
            {
              ...n,
              id: crypto.randomUUID(),
              read: false,
              timestamp: new Date().toISOString(),
            },
            ...state.notifications,
          ],
        })),
      markRead: (id) =>
        set((state) => ({
          notifications: state.notifications.map((n) => (n.id === id ? { ...n, read: true } : n)),
        })),
      markAllRead: () =>
        set((state) => ({
          notifications: state.notifications.map((n) => ({ ...n, read: true })),
        })),
      clearAll: () => set({ notifications: [] }),
    }),
    {
      name: 'duraclaw-notifications',
      onRehydrateStorage: () => (state) => {
        if (!state) return
        // Auto-prune entries older than 30 days
        const cutoff = Date.now() - THIRTY_DAYS_MS
        state.notifications = state.notifications.filter(
          (n) => new Date(n.timestamp).getTime() > cutoff,
        )
      },
    },
  ),
)

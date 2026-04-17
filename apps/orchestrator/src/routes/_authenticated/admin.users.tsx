import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useState } from 'react'
import { Header } from '~/components/layout/header'
import { Main } from '~/components/layout/main'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '~/components/ui/alert-dialog'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog'
import { Input } from '~/components/ui/input'
import { Label } from '~/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table'
import { authClient } from '~/lib/auth-client'

export const Route = createFileRoute('/_authenticated/admin/users')({
  component: AdminUsersPage,
})

interface AdminUser {
  id: string
  name: string
  email: string
  role: string
  banned: boolean
  createdAt: string
}

function AdminUsersPage() {
  const [users, setUsers] = useState<AdminUser[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [createOpen, setCreateOpen] = useState(false)
  const [createForm, setCreateForm] = useState({ name: '', email: '', password: '', role: 'user' })
  const [createError, setCreateError] = useState('')

  const [deleteTarget, setDeleteTarget] = useState<AdminUser | null>(null)

  const [passwordTarget, setPasswordTarget] = useState<AdminUser | null>(null)
  const [newPassword, setNewPassword] = useState('')
  const [passwordError, setPasswordError] = useState('')

  const fetchUsers = useCallback(async () => {
    setLoading(true)
    setError('')
    const { data, error: err } = await authClient.admin.listUsers({
      query: { limit: 100 },
    })
    if (err) {
      setError(err.message ?? 'Failed to load users')
    } else {
      setUsers(data?.users ?? [])
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    fetchUsers()
  }, [fetchUsers])

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    setCreateError('')

    const { error: err } = await authClient.admin.createUser({
      name: createForm.name,
      email: createForm.email,
      password: createForm.password,
      role: createForm.role,
    })

    if (err) {
      setCreateError(err.message ?? 'Failed to create user')
      return
    }

    setCreateOpen(false)
    setCreateForm({ name: '', email: '', password: '', role: 'user' })
    fetchUsers()
  }

  const handleRoleChange = async (userId: string, role: string) => {
    const { error: err } = await authClient.admin.setRole({
      userId,
      role,
    })
    if (err) {
      setError(err.message ?? 'Failed to update role')
      return
    }
    fetchUsers()
  }

  const handleSetPassword = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!passwordTarget) return
    setPasswordError('')

    const { error: err } = await authClient.admin.setUserPassword({
      userId: passwordTarget.id,
      newPassword,
    })

    if (err) {
      setPasswordError(err.message ?? 'Failed to set password')
      return
    }

    setPasswordTarget(null)
    setNewPassword('')
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    const { error: err } = await authClient.admin.removeUser({
      userId: deleteTarget.id,
    })
    if (err) {
      setError(err.message ?? 'Failed to delete user')
    }
    setDeleteTarget(null)
    fetchUsers()
  }

  return (
    <>
      <Header fixed>
        <h1 className="text-lg font-semibold">User Management</h1>
      </Header>

      <Main>
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              Manage user accounts and roles. Only admins can create new users.
            </p>
            <Button onClick={() => setCreateOpen(true)}>Create User</Button>
          </div>

          {error && (
            <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {error}
            </div>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Users</CardTitle>
            </CardHeader>
            <CardContent>
              {loading ? (
                <p className="text-sm text-muted-foreground">Loading users...</p>
              ) : users.length === 0 ? (
                <p className="text-sm text-muted-foreground">No users found.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Email</TableHead>
                      <TableHead>Role</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {users.map((user) => (
                      <TableRow key={user.id}>
                        <TableCell className="font-medium">{user.name}</TableCell>
                        <TableCell>{user.email}</TableCell>
                        <TableCell>
                          <Select
                            defaultValue={user.role ?? 'user'}
                            onValueChange={(value) => handleRoleChange(user.id, value)}
                          >
                            <SelectTrigger className="w-28">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="admin">Admin</SelectItem>
                              <SelectItem value="user">User</SelectItem>
                            </SelectContent>
                          </Select>
                        </TableCell>
                        <TableCell>
                          {user.banned ? (
                            <Badge variant="destructive">Banned</Badge>
                          ) : (
                            <Badge variant="secondary">Active</Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-right space-x-2">
                          <Button
                            onClick={() => setPasswordTarget(user)}
                            size="sm"
                            variant="outline"
                          >
                            Set Password
                          </Button>
                          <Button
                            onClick={() => setDeleteTarget(user)}
                            size="sm"
                            variant="destructive"
                          >
                            Delete
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>

        <Dialog onOpenChange={setCreateOpen} open={createOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create User</DialogTitle>
              <DialogDescription className="sr-only">
                Add a new user account with name, email, password, and role
              </DialogDescription>
            </DialogHeader>
            <form className="space-y-4" onSubmit={handleCreate}>
              <div>
                <Label htmlFor="create-name">Name</Label>
                <Input
                  id="create-name"
                  onChange={(e) =>
                    setCreateForm((f) => ({
                      ...f,
                      name: (e.target as unknown as { value: string }).value,
                    }))
                  }
                  required
                  value={createForm.name}
                />
              </div>
              <div>
                <Label htmlFor="create-email">Email</Label>
                <Input
                  id="create-email"
                  onChange={(e) =>
                    setCreateForm((f) => ({
                      ...f,
                      email: (e.target as unknown as { value: string }).value,
                    }))
                  }
                  required
                  type="email"
                  value={createForm.email}
                />
              </div>
              <div>
                <Label htmlFor="create-password">Password</Label>
                <Input
                  id="create-password"
                  minLength={8}
                  onChange={(e) =>
                    setCreateForm((f) => ({
                      ...f,
                      password: (e.target as unknown as { value: string }).value,
                    }))
                  }
                  required
                  type="password"
                  value={createForm.password}
                />
              </div>
              <div>
                <Label htmlFor="create-role">Role</Label>
                <Select
                  onValueChange={(value) => setCreateForm((f) => ({ ...f, role: value }))}
                  value={createForm.role}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="user">User</SelectItem>
                    <SelectItem value="admin">Admin</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {createError && (
                <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                  {createError}
                </div>
              )}
              <DialogFooter>
                <Button type="submit">Create</Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>

        <Dialog
          onOpenChange={(open) => {
            if (!open) {
              setPasswordTarget(null)
              setNewPassword('')
              setPasswordError('')
            }
          }}
          open={!!passwordTarget}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                Set password for {passwordTarget?.name ?? passwordTarget?.email}
              </DialogTitle>
              <DialogDescription className="sr-only">
                Replace the user's password with a new one
              </DialogDescription>
            </DialogHeader>
            <form className="space-y-4" onSubmit={handleSetPassword}>
              <div>
                <Label htmlFor="new-password">New Password</Label>
                <Input
                  id="new-password"
                  minLength={8}
                  onChange={(e) => setNewPassword((e.target as unknown as { value: string }).value)}
                  required
                  type="password"
                  value={newPassword}
                />
              </div>
              {passwordError && (
                <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                  {passwordError}
                </div>
              )}
              <DialogFooter>
                <Button type="submit">Set Password</Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>

        <AlertDialog onOpenChange={(open) => !open && setDeleteTarget(null)} open={!!deleteTarget}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete user</AlertDialogTitle>
              <AlertDialogDescription>
                Are you sure you want to delete{' '}
                <strong>{deleteTarget?.name ?? deleteTarget?.email}</strong>? This cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={handleDelete}>Delete</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </Main>
    </>
  )
}

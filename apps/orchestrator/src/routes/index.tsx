import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({
  component: Home,
})

function Home() {
  return (
    <div>
      <h1>NRW Orchestrator</h1>
      <p>Session management dashboard</p>
    </div>
  )
}

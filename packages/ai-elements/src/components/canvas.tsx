import type { ReactFlowProps } from '@xyflow/react'
import { Background, ReactFlow } from '@xyflow/react'
import type { ReactNode } from 'react'
import { Platform, Text } from 'react-native'

import '@xyflow/react/dist/style.css'

type CanvasProps = ReactFlowProps & {
  children?: ReactNode
}

const deleteKeyCode = ['Backspace', 'Delete']

export const Canvas = ({ children, ...props }: CanvasProps) => {
  // GH#132 P3.3 (B8): xyflow uses DOM-only APIs (SVG, document, window
  // event listeners) and is feature-gated to web-only on native. The
  // single production user (per Decision #10) has not yet asked for a
  // native diagram surface; this is a deferred follow-up issue.
  if (Platform.OS !== 'web') {
    return <Text>Diagram available on web only</Text>
  }
  return (
    <ReactFlow
      deleteKeyCode={deleteKeyCode}
      fitView
      panOnDrag={false}
      panOnScroll
      selectionOnDrag={true}
      zoomOnDoubleClick={false}
      {...props}
    >
      <Background bgColor="var(--sidebar)" />
      {children}
    </ReactFlow>
  )
}

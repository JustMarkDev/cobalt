import * as React from 'react'
import { EditProvider } from '@pierre/diffs/react'
import { useQuery } from '@tanstack/react-query'
import type { EditorFactory } from '@pierre/diffs/react'

export function useEditorFactory(wanted: boolean) {
  return useQuery({
    queryKey: ['pierre-editor'],
    queryFn: () =>
      import('@pierre/diffs/edit').then(
        ({ Editor }) =>
          ((type: 'file' | 'file-diff', options: object, key?: string) =>
            new Editor(type, options, key)) as EditorFactory<any, any>,
      ),
    enabled: wanted,
    staleTime: Infinity,
    gcTime: Infinity,
  }).data
}

export function EditingProvider({
  factory,
  children,
}: {
  factory: EditorFactory<any, any> | undefined
  children: React.ReactNode
}) {
  if (!factory) return <>{children}</>
  return <EditProvider createEditor={factory}>{children}</EditProvider>
}

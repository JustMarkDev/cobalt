import * as React from 'react'
import { EditProvider } from '@pierre/diffs/react'
import { useQuery } from '@tanstack/react-query'
import type { EditorFactory } from '@pierre/diffs/react'

/**
 * Pierre's editor is loaded the first time someone edits, not with the page.
 * Until it arrives `factory` is undefined and a diff should stay read-only.
 */
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
    // Code, not data: loaded once, kept for the page's life.
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

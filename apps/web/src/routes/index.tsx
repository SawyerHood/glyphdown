import { createFileRoute } from '@tanstack/react-router'
import FileBrowser from '../components/browser/FileBrowser.tsx'
import Landing from '../components/landing/Landing.tsx'
import WelcomeNux from '../components/WelcomeNux.tsx'

/**
 * `/` is the file browser for signed-in users and the public landing page for
 * everyone else (the root guard lets signed-out visitors through here only).
 *
 * The browser navigates folders via the validated `?folder=<id>` search param
 * (absent = root), so browser back/forward walks the folder history.
 */
export const Route = createFileRoute('/')({
  validateSearch: (search: Record<string, unknown>): { folder?: string } =>
    typeof search['folder'] === 'string' && search['folder'] !== '' ? { folder: search['folder'] } : {},
  component: Home,
})

function Home() {
  const { session } = Route.useRouteContext()
  const { folder } = Route.useSearch()
  if (!session) return <Landing />
  return (
    <>
      <FileBrowser folderId={folder ?? null} />
      <WelcomeNux userId={session.user.id} />
    </>
  )
}
